import type { Config } from './config.ts';
import type { Db } from './db/db.ts';
import { builtInRules, connectionCatalog, defaultSettings } from './db/seed.ts';
import type { EventBus } from './events.ts';
import { startOfLocalDay } from './agent/time.ts';
import type {
  ActivityEvent, ActivityKind, AgentStatus, Approval, ApprovalStatus, Briefing, Connection, ConstellationMessage, Conversation, Idea,
  MemoryCategory, MemoryItem, Message, MessageCard, Page, Rule, Settings, Star, StarStatus, StarView, Task, TaskDetail, TaskStatus, TaskStep,
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
  private live = { activity: null as string | null, taskId: null as string | null, starId: null as string | null, since: iso(), offline: false };
  private lastStatusJson = '';
  private userName: string;

  constructor(db: Db, bus: EventBus, config: Pick<Config, 'userName'>) {
    this.db = db;
    this.bus = bus;
    this.userName = config.userName;
    this.seed(config.userName);
  }

  private seed(userName: string) {
    if (!this.db.getKv('settings')) this.db.setKv('settings', defaultSettings(userName));
    if (!this.db.getKv('mainConversation')) {
      const main = this.db.put<Conversation>('conversation', { id: uid('c'), main: true, title: this.settings().agentName, updatedAt: iso(), preview: '' });
      this.db.setKv('mainConversation', main.id);
    }
    const now = iso();
    if (!this.db.getKv('mainStar')) {
      // The original single agent becomes the first Star, keeping the main chat.
      const s = this.settings();
      const star = this.db.put<Star>('star', {
        id: uid('star'), name: s.agentName, role: 'Your main Star: talks with you, runs your tasks and coordinates the others',
        instructions: '', avatar: s.avatar, main: true, autonomy: null, connectionIds: null, paused: false,
        conversationId: this.db.getKv<string>('mainConversation')!, createdAt: now, updatedAt: now,
      });
      this.db.setKv('mainStar', star.id);
      // Records from before Stars existed belong to the main Star.
      for (const kind of ['task', 'approval', 'conversation'] as const) {
        for (const doc of this.db.all<{ id: string; starId?: string }>(kind)) if (!doc.starId) this.db.put(kind, { ...doc, starId: star.id });
      }
    }
    for (const r of builtInRules(now)) if (!this.db.get('rule', r.id)) this.db.put('rule', r);
    for (const c of connectionCatalog) {
      if (!this.db.get('connection', c.id)) {
        this.db.put<Connection>('connection', { ...c, status: c.id === 'web' ? 'connected' : 'disconnected' });
      }
    }
  }

  // ---- settings and status ---------------------------------------------

  settings(): Settings {
    // Defaults first, so settings saved by an older version gain new fields.
    return { ...defaultSettings(this.userName), ...this.db.getKv<Settings>('settings') };
  }

  updateSettings(patch: Partial<Settings>): Settings {
    if (patch.agentName) this.assertNameFree(patch.agentName, this.mainStarId());
    const next = { ...this.settings(), ...patch };
    this.db.setKv('settings', next);
    this.bus.emit({ type: 'settings.updated', data: next });
    // The main Star's name and look are the agent name and avatar in Settings; keep them in step.
    const main = this.mainStar();
    const sync: Partial<Star> = {};
    if (patch.agentName && patch.agentName !== main.name) sync.name = patch.agentName;
    if (patch.avatar && JSON.stringify(patch.avatar) !== JSON.stringify(main.avatar)) sync.avatar = patch.avatar;
    if (Object.keys(sync).length) this.patchStar(main.id, sync);
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
    if (paused) this.live = { ...this.live, activity: null, taskId: null, starId: null };
    this.emitStatus();
  }

  setActivity(activity: string | null, taskId: string | null = null) {
    if (this.live.activity === activity && this.live.taskId === taskId) return;
    const stateChanged = Boolean(this.live.activity) !== Boolean(activity);
    const task = taskId ? this.findTask(taskId) : undefined;
    const starId = task ? this.starIdOf(task) : activity ? this.mainStarId() : null;
    this.live = { ...this.live, activity, taskId, starId, since: stateChanged ? iso() : this.live.since };
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
      starId: working ? this.live.starId : null,
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

  listTasks(statuses?: TaskStatus[], starId?: string): Task[] {
    return this.db.all<Task>('task')
      .filter((t) => (!statuses || statuses.includes(t.status)) && (!starId || this.starIdOf(t) === starId))
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

  listApprovals(status?: ApprovalStatus, starId?: string): Approval[] {
    return this.db.all<Approval>('approval')
      .filter((a) => (!status || a.status === status) && (!starId || (a.starId ?? this.mainStarId()) === starId))
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
    this.log('approval_requested', `Asked you: ${a.action} to ${a.target}`, a.taskId, a.starId);
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

  listConversations(starId?: string): Conversation[] {
    return this.db.all<Conversation>('conversation').filter((c) => !starId || c.starId === starId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getConversation(id: string): Conversation {
    const c = this.db.get<Conversation>('conversation', id);
    if (!c) throw notFound('Conversation', id);
    return c;
  }

  /** The one long chat the app opens to, where proactive messages go. */
  mainConversation(): Conversation {
    return this.getConversation(this.db.getKv<string>('mainConversation')!);
  }

  createConversation(title = 'New chat', starId = this.mainStarId()): Conversation {
    this.getStar(starId);
    return this.db.put<Conversation>('conversation', { id: uid('c'), main: false, title, updatedAt: iso(), preview: '', starId });
  }

  /** Posts a finished agent message (not a streamed reply) and tells the UI. */
  postAgentMessage(conversationId: string, content: string, opts: { proactive?: boolean; cards?: MessageCard[] } = {}): Message {
    const starId = this.getConversation(conversationId).starId;
    const m: Message = {
      id: uid('msg'), conversationId, role: 'agent', content, createdAt: iso(), status: 'done', ...(starId ? { starId } : {}),
      ...(opts.proactive ? { proactive: true } : {}), ...(opts.cards?.length ? { cards: opts.cards } : {}),
    };
    this.saveMessage(m);
    this.patchConversation(conversationId, { updatedAt: m.createdAt, preview: content.split('\n')[0].slice(0, 120) });
    this.bus.emit({ type: 'message.done', data: m });
    return m;
  }

  patchConversation(id: string, patch: Partial<Conversation>): Conversation {
    return this.db.put('conversation', { ...this.getConversation(id), ...patch });
  }

  messages(conversationId: string): Message[] {
    const rows = this.db.sql.prepare('SELECT data FROM messages WHERE conversation_id = ? ORDER BY seq')
      .all(conversationId) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Message);
  }

  /** Agent replies still marked streaming, left behind if the server stopped mid-reply. */
  interruptedMessages(): Message[] {
    const rows = this.db.sql.prepare(`SELECT data FROM messages WHERE json_extract(data, '$.status') = 'streaming'`).all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Message);
  }

  saveMessage(m: Message): Message {
    this.db.sql.prepare(
      'INSERT INTO messages (id, conversation_id, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
    ).run(m.id, m.conversationId, JSON.stringify(m));
    return m;
  }

  // ---- memory ------------------------------------------------------------

  /** Every memory, or with a Star, the ones it can see: shared plus its own. */
  listMemory(starId?: string): MemoryItem[] {
    return this.db.all<MemoryItem>('memory')
      .filter((m) => !starId || !m.starId || m.starId === starId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getMemory(id: string): MemoryItem {
    const m = this.db.get<MemoryItem>('memory', id);
    if (!m) throw notFound('Memory', id);
    return m;
  }

  /** Adds a memory. `learned` marks ones the agent saved on its own, which the UI hears about live. */
  addMemory(category: MemoryCategory, content: string, source: string, learned = false, taskId?: string, starId: string | null = null): MemoryItem {
    if (starId) this.getStar(starId);
    const m: MemoryItem = { id: uid('m'), category, content, source, createdAt: iso(), pinned: false, starId };
    this.db.put('memory', m);
    if (learned) {
      this.bus.emit({ type: 'memory.learned', data: m });
      this.log('memory_learned', `Learned: ${content}`, taskId, starId ?? undefined);
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

  /** Every rule, or with a Star, the ones that bind it: global plus its own. */
  listRules(starId?: string): Rule[] {
    return this.db.all<Rule>('rule').filter((r) => !starId || !r.starId || r.starId === starId);
  }

  getRule(id: string): Rule {
    const r = this.db.get<Rule>('rule', id);
    if (!r) throw notFound('Rule', id);
    return r;
  }

  addRule(text: string, starId: string | null = null): Rule {
    if (starId) this.getStar(starId);
    return this.db.put<Rule>('rule', { id: uid('r'), text, enabled: true, builtIn: false, createdAt: iso(), starId });
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

  log(kind: ActivityKind, summary: string, taskId?: string, starId?: string): ActivityEvent {
    const task = taskId ? this.findTask(taskId) : undefined;
    const who = starId ?? (task ? this.starIdOf(task) : undefined);
    const ev: ActivityEvent = { id: uid('e'), at: iso(), kind, summary, ...(taskId ? { taskId } : {}), ...(who ? { starId: who } : {}) };
    this.db.sql.prepare('INSERT INTO activity (id, at, kind, data) VALUES (?, ?, ?, ?)')
      .run(ev.id, ev.at, ev.kind, JSON.stringify(ev));
    this.bus.emit({ type: 'activity', data: ev });
    if (kind === 'task_completed') this.emitStatus();
    return ev;
  }

  activity(cursor?: string | null, limit = PAGE_SIZE): Page<ActivityEvent> {
    const decoded = cursor ? Buffer.from(cursor, 'base64url').toString() : null;
    const before = decoded === null ? Number.MAX_SAFE_INTEGER : /^[1-9]\d*$/.test(decoded) ? Number(decoded) : NaN;
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

  // ---- stars -------------------------------------------------------------

  mainStarId(): string {
    return this.db.getKv<string>('mainStar')!;
  }

  mainStar(): Star {
    return this.getStar(this.mainStarId());
  }

  /** The main Star first, then the others in the order they were made. */
  listStars(): Star[] {
    return this.db.all<Star>('star').sort((a, b) => Number(b.main) - Number(a.main) || a.createdAt.localeCompare(b.createdAt));
  }

  getStar(id: string): Star {
    const s = this.db.get<Star>('star', id);
    if (!s) throw notFound('Star', id);
    return s;
  }

  /** Finds a Star by id or by name, ignoring case and a trailing "Star". */
  findStar(ref: string): Star | undefined {
    const byId = this.db.get<Star>('star', ref);
    if (byId) return byId;
    const norm = (n: string) => n.trim().toLowerCase().replace(/\s+star$/, '');
    return this.listStars().find((s) => norm(s.name) === norm(ref));
  }

  starIdOf(task: Pick<Task, 'starId'>): string {
    return task.starId ?? this.mainStarId();
  }

  /** Paused on its own or because everything is paused. */
  isStarPaused(starId: string): boolean {
    return this.isPaused() || Boolean(this.db.get<Star>('star', starId)?.paused);
  }

  starStatus(star: Star): StarStatus {
    const paused = this.isPaused() || star.paused;
    const tasks = this.listTasks(ACTIVE, star.id);
    const pending = this.listApprovals('pending', star.id).length;
    const working = !paused && Boolean(this.live.activity) && this.live.starId === star.id;
    return {
      state: paused ? 'paused' : this.live.offline ? 'offline' : working ? 'working' : pending ? 'waiting' : 'idle',
      activity: working ? this.live.activity : null,
      taskId: working ? this.live.taskId : null,
      activeTasks: tasks.length,
      pendingApprovals: pending,
    };
  }

  starView(star: Star): StarView {
    return { ...star, status: this.starStatus(star) };
  }

  assertNameFree(name: string, exceptId?: string) {
    const clash = this.findStar(name);
    if (clash && clash.id !== exceptId) throw new ApiError(409, 'conflict', `There’s already a Star called ${clash.name}`);
  }

  createStar(input: Pick<Star, 'name' | 'role' | 'instructions' | 'avatar' | 'autonomy' | 'connectionIds'>): Star {
    this.assertNameFree(input.name);
    const now = iso();
    const id = uid('star');
    const conv = this.db.put<Conversation>('conversation', { id: uid('c'), main: false, title: input.name, updatedAt: now, preview: '', starId: id });
    const star = this.db.put<Star>('star', { id, ...input, main: false, paused: false, conversationId: conv.id, createdAt: now, updatedAt: now });
    this.emitStar(star);
    this.log('message', `New Star: ${star.name}, ${star.role}`, undefined, star.id);
    return star;
  }

  patchStar(id: string, patch: Partial<Pick<Star, 'name' | 'role' | 'instructions' | 'avatar' | 'autonomy' | 'connectionIds' | 'paused'>>): Star {
    const current = this.getStar(id);
    if (patch.name && patch.name !== current.name) this.assertNameFree(patch.name, id);
    const star = this.db.put<Star>('star', { ...current, ...patch, updatedAt: iso() });
    if (patch.name && patch.name !== current.name) {
      this.patchConversation(star.conversationId, { title: patch.name });
      if (star.main && this.settings().agentName !== patch.name) this.updateSettings({ agentName: patch.name });
    }
    if (star.main && patch.avatar && JSON.stringify(this.settings().avatar) !== JSON.stringify(patch.avatar)) this.updateSettings({ avatar: patch.avatar });
    this.emitStar(star);
    this.emitStatus();
    return star;
  }

  emitStar(star: Star) {
    this.bus.emit({ type: 'star.updated', data: this.starView(star) });
  }

  /** Removes a Star with its private memory, its own rules and its chats. Tasks stay as history. */
  removeStar(id: string) {
    const star = this.getStar(id);
    for (const m of this.db.all<MemoryItem>('memory')) if (m.starId === id) this.db.delete('memory', m.id);
    for (const r of this.db.all<Rule>('rule')) if (r.starId === id) this.db.delete('rule', r.id);
    for (const c of this.listConversations(id)) {
      this.db.sql.prepare('DELETE FROM messages WHERE conversation_id = ?').run(c.id);
      this.db.delete('conversation', c.id);
    }
    this.db.delete('star', id);
    this.bus.emit({ type: 'star.deleted', data: { id } });
    this.log('message', `Removed Star: ${star.name}`);
    this.emitStatus();
  }

  // ---- constellation messages -------------------------------------------

  sendTeamMessage(input: Omit<ConstellationMessage, 'id' | 'createdAt' | 'read'> & { read?: boolean }): ConstellationMessage {
    const m: ConstellationMessage = { id: uid('tm'), createdAt: iso(), read: false, ...input };
    this.db.sql.prepare('INSERT INTO team_messages (id, to_star, from_star, data) VALUES (?, ?, ?, ?)').run(m.id, m.toStarId, m.fromStarId, JSON.stringify(m));
    this.bus.emit({ type: 'constellation.message', data: m });
    return m;
  }

  /** Messages between Stars, oldest first; with a Star, only those it sent or received. */
  teamMessages(starId?: string, limit = 100): ConstellationMessage[] {
    const rows = (starId
      ? this.db.sql.prepare('SELECT data FROM team_messages WHERE to_star = ? OR from_star = ? ORDER BY seq DESC LIMIT ?').all(starId, starId, limit)
      : this.db.sql.prepare('SELECT data FROM team_messages ORDER BY seq DESC LIMIT ?').all(limit)) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as ConstellationMessage).reverse();
  }

  /** A Star's unread messages, marked read as they're handed over. */
  takeUnread(starId: string): ConstellationMessage[] {
    const rows = this.db.sql.prepare(`SELECT id, data FROM team_messages WHERE to_star = ? AND json_extract(data, '$.read') = 0 ORDER BY seq`)
      .all(starId) as { id: string; data: string }[];
    const update = this.db.sql.prepare('UPDATE team_messages SET data = ? WHERE id = ?');
    return rows.map((r) => {
      const m = { ...(JSON.parse(r.data) as ConstellationMessage), read: true };
      update.run(JSON.stringify(m), r.id);
      return m;
    });
  }

  // ---- ideas -------------------------------------------------------------

  listIdeas(): Idea[] {
    return this.db.all<Idea>('idea').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Titles already offered, so dismissed ideas don't come back. */
  seenIdeaTitles(): Set<string> {
    return new Set(this.db.getKv<string[]>('seenIdeas') ?? []);
  }

  addIdea(input: Omit<Idea, 'id' | 'createdAt'>): Idea | null {
    const seen = this.seenIdeaTitles();
    const key = input.title.trim().toLowerCase();
    if (seen.has(key)) return null;
    this.db.setKv('seenIdeas', [...seen, key].slice(-500));
    const idea = this.db.put<Idea>('idea', { id: uid('i'), createdAt: iso(), ...input });
    this.bus.emit({ type: 'idea.created', data: idea });
    return idea;
  }

  dismissIdea(id: string) {
    if (!this.db.delete('idea', id)) throw notFound('Idea', id);
  }

  // ---- briefing ----------------------------------------------------------

  latestBriefing(): Briefing | undefined {
    return this.db.getKv<Briefing>('briefing');
  }

  saveBriefing(b: Briefing) {
    this.db.setKv('briefing', b);
  }
}
