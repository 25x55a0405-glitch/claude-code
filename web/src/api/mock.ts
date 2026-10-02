import type { SkysApi } from './client';
import type {
  ActivityEvent,
  AgentStatus,
  Approval,
  LiveEvent,
  Message,
  Task,
  TaskDetail,
  TaskStatus,
} from './types';
import * as seed from './mockData';

const uid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const iso = () => new Date().toISOString();
const wait = (ms = 180) => new Promise((r) => setTimeout(r, ms + Math.random() * 120));
const clone = <T>(v: T): T => structuredClone(v);

/** In-memory back end that behaves like the real one, including live events. */
export function createMockApi(): SkysApi {
  const db = {
    settings: clone(seed.seedSettings),
    tasks: clone(seed.seedTasks),
    approvals: clone(seed.seedApprovals),
    briefing: clone(seed.seedBriefing),
    memory: clone(seed.seedMemory),
    connections: clone(seed.seedConnections),
    rules: clone(seed.seedRules),
    activity: clone(seed.seedActivity),
    conversations: clone(seed.seedConversations),
    messages: clone(seed.seedMessages),
    paused: false,
    activity_line: 'Watching Lisbon fares' as string | null,
    activityTask: 't_flights' as string | null,
    since: iso(),
  };
  const handlers = new Set<(e: LiveEvent) => void>();
  const emit = (e: LiveEvent) => handlers.forEach((h) => h(e));

  const summary = (t: TaskDetail): Task => {
    const { steps: _steps, ...rest } = t;
    return clone(rest);
  };

  const status = (): AgentStatus => {
    const pending = db.approvals.filter((a) => a.status === 'pending').length;
    const state = db.paused ? 'paused' : db.activity_line ? 'working' : pending ? 'waiting' : 'idle';
    return {
      state,
      activity: db.paused ? null : db.activity_line,
      taskId: db.paused ? null : db.activityTask,
      since: db.since,
      autonomy: db.settings.autonomy,
      counts: {
        activeTasks: db.tasks.filter((t) => ['active', 'waiting_approval', 'blocked'].includes(t.status)).length,
        pendingApprovals: pending,
        completedToday: db.activity.filter((a) => a.kind === 'task_completed').length,
      },
    };
  };

  const logActivity = (kind: ActivityEvent['kind'], text: string, taskId?: string) => {
    const ev: ActivityEvent = { id: uid('e'), at: iso(), kind, summary: text, taskId };
    db.activity.unshift(ev);
    emit({ type: 'activity', data: ev });
  };

  const findTask = (id: string) => {
    const t = db.tasks.find((x) => x.id === id);
    if (!t) throw new Error(`Task ${id} not found`);
    return t;
  };

  // Ambient "always-on" behaviour: Skys keeps working on its own.
  const ambient = [
    { task: 't_flights', line: 'Comparing Lisbon fares on Kayak', step: 'Checked Kayak and Skyscanner: still $642 at best' },
    { task: 't_prs', line: 'Checking your pull requests', step: 'No new reviews; CI green on all 3 PRs' },
    { task: 't_inbox', line: 'Reading 3 new emails', step: 'Archived 2 notifications, 1 receipt filed to Drive' },
    { task: null, line: null, step: null },
    { task: 't_flights', line: 'Researching Lisbon neighbourhoods', step: 'Shortlisted Alfama and Príncipe Real for your stay' },
  ];
  let tick = 0;
  setInterval(() => {
    if (db.paused || handlers.size === 0) return;
    const next = ambient[tick++ % ambient.length];
    db.activity_line = next.line;
    db.activityTask = next.task;
    db.since = iso();
    if (next.task && next.step) {
      const t = findTask(next.task);
      const step = { id: uid('s'), at: iso(), kind: 'result' as const, summary: next.step };
      t.steps.push(step);
      t.updatedAt = iso();
      t.lastOutcome = next.step;
      emit({ type: 'task.step', data: { taskId: t.id, step } });
      emit({ type: 'task.updated', data: summary(t) });
      logActivity('research', next.step, t.id);
    }
    emit({ type: 'status', data: status() });
  }, 9000);

  const replyTo = (conversationId: string, text: string) => {
    const lower = text.toLowerCase();
    let reply = 'Got it. I’ll take care of that and let you know when it’s done.';
    let taskIds: string[] | undefined;
    if (/remind|every|each|daily|weekly/.test(lower)) {
      const t: TaskDetail = {
        id: uid('t'), title: text.length > 60 ? text.slice(0, 57) + '…' : text, description: text,
        status: 'scheduled', kind: 'recurring', schedule: 'As you described', createdAt: iso(), updatedAt: iso(),
        connectionIds: [], steps: [{ id: uid('s'), at: iso(), kind: 'plan', summary: 'Set up schedule from your request' }],
      };
      db.tasks.unshift(t);
      emit({ type: 'task.updated', data: summary(t) });
      taskIds = [t.id];
      reply = 'Done. I set that up as a recurring task. You can change the schedule any time from **Tasks**.';
    } else if (/find|book|research|look|watch|search|track/.test(lower)) {
      const t: TaskDetail = {
        id: uid('t'), title: text.length > 60 ? text.slice(0, 57) + '…' : text, description: text,
        status: 'active', kind: 'one_off', progress: 0.05, createdAt: iso(), updatedAt: iso(),
        connectionIds: ['web'], steps: [{ id: uid('s'), at: iso(), kind: 'plan', summary: 'Break the request into steps and start searching' }],
      };
      db.tasks.unshift(t);
      emit({ type: 'task.updated', data: summary(t) });
      logActivity('task_started', `Started: ${t.title}`, t.id);
      taskIds = [t.id];
      reply = 'On it. I started a task for this and I’ll keep working while you do other things. I’ll come back with what I find.';
    } else if (/hi|hello|hey/.test(lower)) {
      reply = `Hey ${db.settings.userName}. Everything’s running smoothly. One email is waiting for your OK, and Lisbon fares are trending down.`;
    } else if (/what.*(doing|up)|status/.test(lower)) {
      reply = db.activity_line ? `Right now I’m ${db.activity_line.toLowerCase()}. ${status().counts.activeTasks} tasks are active.` : 'Nothing urgent at the moment. I’m idle and watching for changes.';
    }

    const msg: Message = { id: uid('msg'), conversationId, role: 'agent', content: '', createdAt: iso(), status: 'streaming', taskIds };
    db.messages.push(msg);
    const words = reply.split(/(\s+)/);
    let i = 0;
    const timer = setInterval(() => {
      if (i >= words.length) {
        clearInterval(timer);
        msg.status = 'done';
        const conv = db.conversations.find((c) => c.id === conversationId);
        if (conv) { conv.updatedAt = iso(); conv.preview = reply.replace(/\*\*/g, ''); }
        emit({ type: 'message.done', data: clone(msg) });
        return;
      }
      const delta = words.slice(i, i + 2).join('');
      i += 2;
      msg.content += delta;
      emit({ type: 'message.delta', data: { conversationId, messageId: msg.id, delta } });
    }, 45);
  };

  return {
    async getStatus() { await wait(); return status(); },
    async setPaused(paused) {
      await wait();
      db.paused = paused;
      db.since = iso();
      const s = status();
      emit({ type: 'status', data: s });
      return s;
    },
    async getBriefing() { await wait(); return clone(db.briefing); },

    async listTasks(filter) {
      await wait();
      const want = filter?.status;
      return db.tasks.filter((t) => !want || want.includes(t.status)).map(summary);
    },
    async getTask(id) { await wait(); return clone(findTask(id)); },
    async createTask(input) {
      await wait();
      const t: TaskDetail = {
        id: uid('t'), ...input, status: input.kind === 'one_off' ? 'active' : 'scheduled',
        createdAt: iso(), updatedAt: iso(), connectionIds: [],
        steps: [{ id: uid('s'), at: iso(), kind: 'plan', summary: 'Task created. Planning first steps.' }],
      };
      db.tasks.unshift(t);
      emit({ type: 'task.updated', data: summary(t) });
      logActivity('task_started', `Started: ${t.title}`, t.id);
      return summary(t);
    },
    async commandTask(id, command) {
      await wait();
      const t = findTask(id);
      const map: Record<string, TaskStatus> = { pause: 'paused', resume: 'active', run_now: 'active', cancel: 'done' };
      t.status = map[command];
      t.updatedAt = iso();
      const step = { id: uid('s'), at: iso(), kind: 'note' as const, summary: { pause: 'Paused by you', resume: 'Resumed by you', run_now: 'Run started by you', cancel: 'Cancelled by you' }[command] };
      t.steps.push(step);
      emit({ type: 'task.step', data: { taskId: id, step } });
      emit({ type: 'task.updated', data: summary(t) });
      emit({ type: 'status', data: status() });
      return summary(t);
    },

    async listApprovals(s) { await wait(); return clone(db.approvals.filter((a) => !s || a.status === s)); },
    async decideApproval(id, d) {
      await wait(300);
      const a = db.approvals.find((x) => x.id === id) as Approval;
      a.status = d.decision === 'approve' ? 'approved' : 'rejected';
      if (d.editedPreview) a.preview = d.editedPreview;
      emit({ type: 'approval.updated', data: clone(a) });
      logActivity('approval_resolved', `${a.status === 'approved' ? 'Approved' : 'Declined'}: ${a.action} to ${a.target}`, a.taskId);
      if (a.taskId) {
        const t = findTask(a.taskId);
        const step = { id: uid('s'), at: iso(), kind: 'action' as const, summary: a.status === 'approved' ? `${a.action}: done` : `${a.action}: skipped as you asked` };
        t.steps.push(step);
        emit({ type: 'task.step', data: { taskId: t.id, step } });
      }
      emit({ type: 'status', data: status() });
      return clone(a);
    },

    async listConversations() { await wait(); return clone([...db.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))); },
    async createConversation() {
      await wait();
      const c = { id: uid('c'), title: 'New conversation', updatedAt: iso(), preview: '' };
      db.conversations.unshift(c);
      return clone(c);
    },
    async listMessages(cid) { await wait(); return clone(db.messages.filter((m) => m.conversationId === cid)); },
    async sendMessage(cid, content) {
      await wait(80);
      const m: Message = { id: uid('msg'), conversationId: cid, role: 'user', content, createdAt: iso(), status: 'done' };
      db.messages.push(m);
      const conv = db.conversations.find((c) => c.id === cid);
      if (conv && conv.title === 'New conversation') conv.title = content.slice(0, 40);
      setTimeout(() => replyTo(cid, content), 600);
      return clone(m);
    },

    async listMemory() { await wait(); return clone(db.memory); },
    async addMemory(input) {
      await wait();
      const m = { id: uid('m'), ...input, source: 'Added by you', createdAt: iso(), pinned: false };
      db.memory.unshift(m);
      return clone(m);
    },
    async updateMemory(id, patch) {
      await wait();
      const m = db.memory.find((x) => x.id === id)!;
      Object.assign(m, patch);
      return clone(m);
    },
    async deleteMemory(id) { await wait(); db.memory = db.memory.filter((m) => m.id !== id); },

    async listConnections() { await wait(); return clone(db.connections); },
    async updateConnection(id, patch) {
      await wait();
      const c = db.connections.find((x) => x.id === id)!;
      Object.assign(c, patch);
      return clone(c);
    },
    async connect(id) {
      await wait(600);
      const c = db.connections.find((x) => x.id === id)!;
      c.status = 'connected';
      c.lastSyncAt = iso();
      return { authorizeUrl: null, connection: clone(c) };
    },
    async disconnect(id) {
      await wait();
      const c = db.connections.find((x) => x.id === id)!;
      c.status = 'disconnected';
      return clone(c);
    },

    async listRules() { await wait(); return clone(db.rules); },
    async addRule(text) {
      await wait();
      const r = { id: uid('r'), text, enabled: true, builtIn: false, createdAt: iso() };
      db.rules.push(r);
      return clone(r);
    },
    async updateRule(id, patch) {
      await wait();
      const r = db.rules.find((x) => x.id === id)!;
      if (!r.builtIn) Object.assign(r, patch);
      return clone(r);
    },
    async deleteRule(id) { await wait(); db.rules = db.rules.filter((r) => r.id !== id || r.builtIn); },

    async listActivity() { await wait(); return { items: clone(db.activity), nextCursor: null }; },

    async getSettings() { await wait(); return clone(db.settings); },
    async updateSettings(patch) {
      await wait();
      Object.assign(db.settings, patch);
      emit({ type: 'status', data: status() });
      return clone(db.settings);
    },

    subscribe(h) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
  };
}
