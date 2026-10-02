import type { Config } from './config.ts';
import type { Db } from './db/db.ts';
import { builtInRules, connectionCatalog, defaultSettings } from './db/seed.ts';
import type { EventBus } from './events.ts';
import { startOfLocalDay } from './agent/time.ts';
import type {
  ActivityEvent, ActivityKind, AgentStatus, Approval, ApprovalStatus, Briefing, Connection, Conversation,
  MemoryCategory, MemoryItem, Message, Page, Rule, Settings, Task, TaskDetail, TaskStatus, TaskStep,
} from './types.ts';
import { ApiError, iso, notFound, uid } from './util.ts';

const ACTIVE: TaskStatus[] = ['active', 'waiting_approval', 'blocked'];
const PAGE_SIZE = 50;

/**
 * The domain layer: every read and write the API and the agent make goes
 * through here, so persistence and live events can't drift apart. Each
 * mutation saves first, then emits the matching event from docs/API.md.
 */
export class Store {
  db: Db;
  bus: EventBus;
  /** What the runtime is doing right now; drives AgentStatus. */
  private live = { activity: null as string | null, taskId: null as string | null, since: iso(), offline: false };
  private lastStatusJson = '';

  constructor(db: Db, bus: EventBus, config: Pick<Config, 'userName'>) {
    this.db = db;
    this.bus = bus;
    this.seed(config.userName);
  }

  private seed(userName: string) {
    if (!this.db.getKv('settings')) this.db.setKv('settings', defaultSettings(userName));
    const now = iso();
    for (const r of builtInRules(now)) if (!this.db.get('rule', r.id)) this.db.put('rule', r);
    for (const c of connectionCatalog) {
      if (!this.db.get('connection', c.id)) {
        this.db.put<Connection>('connection', { ...c, status: c.id === 'web' ? 'connected' : 'disconnected' });
      }
    }
  }

  // ---- settings and status ---------------------------------------------

  settings(): Settings {
    return this.db.getKv<Settings>('settings')!;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.settings(), ...patch };
    this.db.setKv('settings', next);
    this.emitStatus();
    return next;
  }

  isPaused(): boolean {
    return this.db.getKv<boolean>('paused') ?? false;
  }

  setPaused(paused: boolean) {
    if (paused === this.isPaused()) return;
    this.db.setKv('paused', paused);
    this.live.since = iso();
    if (paused) this.live = { ...this.live, activity: null, taskId: null };
    this.emitStatus();
  }

  setActivity(activity: string | null, taskId: string | null = null) {
    if (this.live.activity === activity && this.live.taskId === taskId) return;
    const stateChanged = Boolean(this.live.activity) !== Boolean(activity);
    this.live = { ...this.live, activity, taskId, since: stateChanged ? iso() : this.live.since };
    this.emitStatus();
  }

  setOffline(offline: boolean) {
    if (this.live.offline === offline) return;
    this.live = { ...this.live, offline, since: iso() };
    this.emitStatus();
  }

  status(): AgentStatus {
    const settings = this.settings();
    const paused = this.isPaused();
    const pending = this.listApprovals('pending').length;
    const tasks = this.db.all<Task>('task');
    const working = !paused && Boolean(this.live.activity);
    const state = paused ? 'paused' : this.live.offline ? 'offline' : working ? 'working' : pending ? 'waiting' : 'idle';
    const midnight = startOfLocalDay(Date.now(), settings.timezone).toISOString();
    const completedToday = Number((this.db.sql
      .prepare("SELECT COUNT(*) AS n FROM activity WHERE kind = 'task_completed' AND at >= ?")
      .get(midnight) as { n: number }).n);
    return {
      state,
      activity: working ? this.live.activity : null,
      taskId: working ? this.live.taskId : null,
      since: this.live.since,
      autonomy: settings.autonomy,
      counts: {
        activeTasks: tasks.filter((t) => ACTIVE.includes(t.status)).length,
        pendingApprovals: pending,
        completedToday,
      },
    };
  }

  /** Emits a status event when anything the UI shows has changed. */
  emitStatus() {
    const s = this.status();
    const json = JSON.stringify(s);
    if (json === this.lastStatusJson) return;
    this.lastStatusJson = json;
    this.bus.emit({ type: 'status', data: s });
  }

  // ---- tasks -------------------------------------------------------------

  listTasks(statuses?: TaskStatus[]): Task[] {
    return this.db.all<Task>('task')
      .filter((t) => !statuses || statuses.includes(t.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getTask(id: string): Task {
    const t = this.db.get<Task>('task', id);
    if (!t) throw notFound('Task', id);
    return t;
  }

  findTask(id: string): Task | undefined {
    return this.db.get<Task>('task', id);
  }

  taskDetail(id: string): TaskDetail {
    return { ...this.getTask(id), steps: this.steps(id) };
  }

  steps(taskId: string, limit?: number): TaskStep[] {
    const rows = limit
      ? (this.db.sql.prepare('SELECT data FROM (SELECT seq, data FROM steps WHERE task_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq')
        .all(taskId, limit) as { data: string }[])
      : (this.db.sql.prepare('SELECT data FROM steps WHERE task_id = ? ORDER BY seq').all(taskId) as { data: string }[]);
    return rows.map((r) => JSON.parse(r.data) as TaskStep);
  }

  insertTask(task: Task): Task {
    this.db.put('task', task);
    this.bus.emit({ type: 'task.updated', data: task });
    this.emitStatus();
    return task;
  }

  patchTask(id: string, patch: Partial<Task>): Task {
    const task = { ...this.getTask(id), ...patch, updatedAt: iso() };
    for (const k of Object.keys(task) as (keyof Task)[]) if (task[k] === undefined) delete task[k];
    this.db.put('task', task);
    this.bus.emit({ type: 'task.updated', data: task });
    this.emitStatus();
    return task;
  }

  addStep(taskId: string, step: Omit<TaskStep, 'id' | 'at'>): TaskStep {
    const full: TaskStep = { id: uid('s'), at: iso(), ...step };
    this.db.sql.prepare('INSERT INTO steps (task_id, data) VALUES (?, ?)').run(taskId, JSON.stringify(full));
    this.bus.emit({ type: 'task.step', data: { taskId, step: full } });
    return full;
  }

  // ---- approvals ---------------------------------------------------------

  listApprovals(status?: ApprovalStatus): Approval[] {
    return this.db.all<Approval>('approval')
      .filter((a) => !status || a.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getApproval(id: string): Approval {
    const a = this.db.get<Approval>('approval', id);
    if (!a) throw notFound('Approval', id);
    return a;
  }

  createApproval(input: Omit<Approval, 'id' | 'status' | 'createdAt'>, internal?: unknown): Approval {
    const a: Approval = { id: uid('a'), status: 'pending', createdAt: iso(), ...input };
    this.db.put('approval', a);
    if (internal !== undefined) this.db.setPrivate('approval', a.id, internal);
    this.bus.emit({ type: 'approval.created', data: a });
    this.log('approval_requested', `Asked you: ${a.action} to ${a.target}`, a.taskId);
    this.emitStatus();
    return a;
  }

  setApprovalStatus(id: string, status: ApprovalStatus, preview?: string): Approval {
    const a = { ...this.getApproval(id), status, ...(preview !== undefined ? { preview } : {}) };
    this.db.put('approval', a);
    this.bus.emit({ type: 'approval.updated', data: a });
    this.emitStatus();
    return a;
  }

  // ---- conversations -----------------------------------------------------

  listConversations(): Conversation[] {
    return this.db.all<Conversation>('conversation').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getConversation(id: string): Conversation {
    const c = this.db.get<Conversation>('conversation', id);
    if (!c) throw notFound('Conversation', id);
    return c;
  }

  createConversation(title = 'New conversation'): Conversation {
    return this.db.put<Conversation>('conversation', { id: uid('c'), title, updatedAt: iso(), preview: '' });
  }

  patchConversation(id: string, patch: Partial<Conversation>): Conversation {
    return this.db.put('conversation', { ...this.getConversation(id), ...patch });
  }

  messages(conversationId: string): Message[] {
    const rows = this.db.sql.prepare('SELECT data FROM messages WHERE conversation_id = ? ORDER BY seq')
      .all(conversationId) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Message);
  }

  saveMessage(m: Message): Message {
    this.db.sql.prepare(
      'INSERT INTO messages (id, conversation_id, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
    ).run(m.id, m.conversationId, JSON.stringify(m));
    return m;
  }

  // ---- memory ------------------------------------------------------------

  listMemory(): MemoryItem[] {
    return this.db.all<MemoryItem>('memory').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getMemory(id: string): MemoryItem {
    const m = this.db.get<MemoryItem>('memory', id);
    if (!m) throw notFound('Memory', id);
    return m;
  }

  /** Adds a memory. `learned` marks ones the agent saved on its own, which the UI hears about live. */
  addMemory(category: MemoryCategory, content: string, source: string, learned = false, taskId?: string): MemoryItem {
    const m: MemoryItem = { id: uid('m'), category, content, source, createdAt: iso(), pinned: false };
    this.db.put('memory', m);
    if (learned) {
      this.bus.emit({ type: 'memory.learned', data: m });
      this.log('memory_learned', `Learned: ${content}`, taskId);
    }
    return m;
  }

  patchMemory(id: string, patch: Partial<Pick<MemoryItem, 'content' | 'pinned' | 'category'>>): MemoryItem {
    return this.db.put('memory', { ...this.getMemory(id), ...patch });
  }

  deleteMemory(id: string) {
    if (!this.db.delete('memory', id)) throw notFound('Memory', id);
  }

  // ---- connections -------------------------------------------------------

  listConnections(): Connection[] {
    const order = connectionCatalog.map((c) => c.id);
    return this.db.all<Connection>('connection').sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  }

  getConnection(id: string): Connection {
    const c = this.db.get<Connection>('connection', id);
    if (!c) throw notFound('Connection', id);
    return c;
  }

  putConnection(c: Connection): Connection {
    return this.db.put('connection', c);
  }

  // ---- rules -------------------------------------------------------------

  listRules(): Rule[] {
    return this.db.all<Rule>('rule');
  }

  getRule(id: string): Rule {
    const r = this.db.get<Rule>('rule', id);
    if (!r) throw notFound('Rule', id);
    return r;
  }

  addRule(text: string): Rule {
    return this.db.put<Rule>('rule', { id: uid('r'), text, enabled: true, builtIn: false, createdAt: iso() });
  }

  patchRule(id: string, patch: Partial<Pick<Rule, 'text' | 'enabled'>>): Rule {
    const r = this.getRule(id);
    if (r.builtIn) throw new ApiError(403, 'forbidden', 'Built-in safety rules can’t be changed');
    return this.db.put('rule', { ...r, ...patch });
  }

  deleteRule(id: string) {
    const r = this.getRule(id);
    if (r.builtIn) throw new ApiError(403, 'forbidden', 'Built-in safety rules can’t be deleted');
    this.db.delete('rule', id);
  }

  // ---- activity ----------------------------------------------------------

  log(kind: ActivityKind, summary: string, taskId?: string): ActivityEvent {
    const ev: ActivityEvent = { id: uid('e'), at: iso(), kind, summary, ...(taskId ? { taskId } : {}) };
    this.db.sql.prepare('INSERT INTO activity (id, at, kind, data) VALUES (?, ?, ?, ?)')
      .run(ev.id, ev.at, ev.kind, JSON.stringify(ev));
    this.bus.emit({ type: 'activity', data: ev });
    if (kind === 'task_completed') this.emitStatus();
    return ev;
  }

  activity(cursor?: string | null, limit = PAGE_SIZE): Page<ActivityEvent> {
    const before = cursor ? Number(Buffer.from(cursor, 'base64url').toString()) : Number.MAX_SAFE_INTEGER;
    if (!Number.isFinite(before)) throw new ApiError(400, 'bad_request', 'That page cursor is not valid');
    const rows = this.db.sql.prepare('SELECT seq, data FROM activity WHERE seq < ? ORDER BY seq DESC LIMIT ?')
      .all(before, limit + 1) as { seq: number; data: string }[];
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => JSON.parse(r.data) as ActivityEvent),
      nextCursor: more ? Buffer.from(String(page[page.length - 1].seq)).toString('base64url') : null,
    };
  }

  activitySince(since: string): ActivityEvent[] {
    const rows = this.db.sql.prepare('SELECT data FROM activity WHERE at >= ? ORDER BY seq DESC').all(since) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as ActivityEvent);
  }

  // ---- briefing ----------------------------------------------------------

  latestBriefing(): Briefing | undefined {
    return this.db.getKv<Briefing>('briefing');
  }

  saveBriefing(b: Briefing) {
    this.db.setKv('briefing', b);
  }
}
