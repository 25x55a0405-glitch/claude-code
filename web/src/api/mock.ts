import type { SkyApi } from './client';
import type {
  ActivityEvent,
  AgentStatus,
  Approval,
  ConstellationMessage,
  LiveEvent,
  Message,
  Task,
  TaskDetail,
  TaskStatus,
  Star,
  StarView,
} from './types';
import * as seed from './mockData';

const uid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const iso = () => new Date().toISOString();
const wait = (ms = 180) => new Promise((r) => setTimeout(r, ms + Math.random() * 120));
const clone = <T>(v: T): T => structuredClone(v);

/** In-memory back end that behaves like the real one, including live events. */
export function createMockApi(): SkyApi {
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
    ideas: clone(seed.seedIdeas),
    messages: clone(seed.seedMessages),
    stars: clone(seed.seedStars),
    constellation: clone(seed.seedConstellation),
    paused: false,
    activity_line: 'Watching Lisbon fares' as string | null,
    activityTask: 't_flights' as string | null,
    since: iso(),
  };
  const handlers = new Set<(e: LiveEvent) => void>();
  const emit = (e: LiveEvent) => handlers.forEach((h) => h(e));

  const MAIN = 'star_sky';
  const findStar = (id: string) => {
    const s = db.stars.find((x) => x.id === id);
    if (!s) throw new Error('That Star no longer exists');
    return s;
  };
  const starOfConv = (cid: string) => db.conversations.find((c) => c.id === cid)?.starId ?? MAIN;
  const starView = (star: Star): StarView => {
    const mine = db.tasks.filter((t) => (t.starId ?? MAIN) === star.id);
    const pending = db.approvals.filter((a) => a.status === 'pending' && (a.starId ?? MAIN) === star.id).length;
    const task = db.activityTask ? db.tasks.find((t) => t.id === db.activityTask) : undefined;
    const busy = !!db.activity_line && (task?.starId ?? MAIN) === star.id;
    const held = db.paused || star.paused;
    return {
      ...clone(star),
      status: {
        state: held ? 'paused' : busy ? 'working' : pending ? 'waiting' : 'idle',
        activity: held || !busy ? null : db.activity_line,
        taskId: held || !busy ? null : db.activityTask,
        activeTasks: mine.filter((t) => ['active', 'waiting_approval', 'blocked'].includes(t.status)).length,
        pendingApprovals: pending,
      },
    };
  };
  const emitStars = () => db.stars.forEach((s) => emit({ type: 'star.updated', data: starView(s) }));
  const tell = (from: string, to: string, kind: ConstellationMessage['kind'], content: string, taskId?: string) => {
    const m: ConstellationMessage = { id: uid('cm'), fromStarId: from, toStarId: to, kind, content, taskId, createdAt: iso(), read: false };
    db.constellation.push(m);
    emit({ type: 'constellation.message', data: clone(m) });
    return m;
  };

  const summary = (t: TaskDetail): Task => {
    const { steps: _steps, ...rest } = t;
    return clone(rest);
  };

  const status = (): AgentStatus => {
    const pending = db.approvals.filter((a) => a.status === 'pending').length;
    const state = db.paused ? 'paused' : db.activity_line ? 'working' : pending ? 'waiting' : 'idle';
    const task = db.activityTask ? db.tasks.find((t) => t.id === db.activityTask) : undefined;
    return {
      state,
      starId: db.paused || !db.activity_line ? null : task?.starId ?? MAIN,
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

  // Ambient "always-on" behaviour: Sky keeps working on its own.
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
      if (t.id === 't_flights' && tick % 10 === 1) tell('star_scout', MAIN, 'message', next.step, t.id);
    }
    emit({ type: 'status', data: status() });
    emitStars();
  }, 9000);

  const replyTo = (conversationId: string, text: string) => {
    const lower = text.toLowerCase();
    const me = findStar(starOfConv(conversationId));
    let reply = 'Got it. I’ll take care of that and let you know when it’s done.';
    let cards: Message['cards'];
    const other = db.stars.find((s) => s.id !== me.id && new RegExp(`\\b${s.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower));
    if (other) {
      const t: TaskDetail = {
        id: uid('t'), title: text.length > 60 ? text.slice(0, 57) + '…' : text, description: text,
        status: other.paused || db.paused ? 'paused' : 'active', kind: 'one_off', progress: 0.05, createdAt: iso(), updatedAt: iso(),
        connectionIds: [], starId: other.id, requestedBy: { starId: me.id },
        steps: [{ id: uid('s'), at: iso(), kind: 'plan', summary: `Handed over by ${me.name}` }],
      };
      db.tasks.unshift(t);
      emit({ type: 'task.updated', data: summary(t) });
      tell(me.id, other.id, 'handoff', text, t.id);
      cards = [{ kind: 'task', taskId: t.id }];
      reply = `I handed that to **${other.name}**, who ${other.role.charAt(0).toLowerCase() + other.role.slice(1)}. You can follow along in ${other.name}’s chat.`;
    } else if (/remind|every|each|daily|weekly/.test(lower)) {
      const t: TaskDetail = {
        id: uid('t'), title: text.length > 60 ? text.slice(0, 57) + '…' : text, description: text,
        status: 'scheduled', kind: 'recurring', schedule: 'As you described', createdAt: iso(), updatedAt: iso(),
        connectionIds: [], starId: me.id, steps: [{ id: uid('s'), at: iso(), kind: 'plan', summary: 'Set up schedule from your request' }],
      };
      db.tasks.unshift(t);
      emit({ type: 'task.updated', data: summary(t) });
      cards = [{ kind: 'task', taskId: t.id }];
      reply = 'Done. I set that up to run on its own. You can change the schedule any time from **Goals**.';
    } else if (/find|book|research|look|watch|search|track/.test(lower)) {
      const t: TaskDetail = {
        id: uid('t'), title: text.length > 60 ? text.slice(0, 57) + '…' : text, description: text,
        status: 'active', kind: 'one_off', progress: 0.05, createdAt: iso(), updatedAt: iso(),
        connectionIds: ['web'], starId: me.id, steps: [{ id: uid('s'), at: iso(), kind: 'plan', summary: 'Break the request into steps and start searching' }],
      };
      db.tasks.unshift(t);
      emit({ type: 'task.updated', data: summary(t) });
      logActivity('task_started', `Started: ${t.title}`, t.id);
      cards = [{ kind: 'task', taskId: t.id }];
      reply = 'On it. I started a task for this and I’ll keep working while you do other things. I’ll come back with what I find.';
    } else if (/hi|hello|hey/.test(lower)) {
      reply = me.main
        ? `Hey ${db.settings.userName}. Everything’s running smoothly. Post has an email waiting for your OK, and Scout says Lisbon fares are trending down.`
        : `Hey ${db.settings.userName}, ${me.name} here. I ${me.role.charAt(0).toLowerCase() + me.role.slice(1)}. What can I take on?`;
    } else if (/what.*(doing|up)|status/.test(lower)) {
      reply = db.activity_line ? `Right now I’m ${db.activity_line.toLowerCase()}. ${status().counts.activeTasks} tasks are active.` : 'Nothing urgent at the moment. I’m idle and watching for changes.';
    }

    const msg: Message = { id: uid('msg'), conversationId, role: 'agent', content: '', createdAt: iso(), status: 'streaming', cards, starId: me.id };
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
    async getSession() { return { signedIn: true, authRequired: false }; },
    async signIn() {},
    async signOut() {},
    async getStatus() { await wait(); return status(); },
    async setPaused(paused) {
      await wait();
      db.paused = paused;
      db.since = iso();
      const s = status();
      emit({ type: 'status', data: s });
      emitStars();
      return s;
    },

    async listStars() { await wait(); return db.stars.map(starView); },
    async createStar(input) {
      await wait();
      const name = input.name.trim();
      if (db.stars.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new Error(`There’s already a Star called ${name}`);
      const colors = ['peach', 'mint', 'lilac', 'sun'] as const;
      const id = uid('star');
      const conv = { id: uid('c'), main: false, title: name, updatedAt: iso(), preview: '', starId: id };
      db.conversations.unshift(conv);
      const star: Star = {
        id, name, role: input.role, instructions: input.instructions ?? '',
        avatar: input.avatar ?? { character: 'dot', color: colors[db.stars.length % colors.length] },
        main: false, autonomy: input.autonomy ?? null, connectionIds: input.connectionIds ?? null, paused: false,
        conversationId: conv.id, createdAt: iso(), updatedAt: iso(),
      };
      db.stars.push(star);
      emit({ type: 'star.updated', data: starView(star) });
      logActivity('message', `New Star: ${star.name}, ${star.role}`);
      return starView(star);
    },
    async updateStar(id, patch) {
      await wait();
      const star = findStar(id);
      if (patch.name !== undefined) {
        const name = patch.name.trim();
        if (db.stars.some((s) => s.id !== id && s.name.toLowerCase() === name.toLowerCase())) throw new Error(`There’s already a Star called ${name}`);
        patch = { ...patch, name };
        const conv = db.conversations.find((c) => c.id === star.conversationId);
        if (conv && !conv.main) conv.title = name;
      }
      Object.assign(star, patch, { updatedAt: iso() });
      if (star.main && (patch.name !== undefined || patch.avatar)) {
        db.settings.agentName = star.name;
        db.settings.avatar = clone(star.avatar);
        emit({ type: 'settings.updated', data: clone(db.settings) });
      }
      emit({ type: 'star.updated', data: starView(star) });
      return starView(star);
    },
    async deleteStar(id) {
      await wait();
      const star = findStar(id);
      if (star.main) throw new Error('Your main Star can’t be removed');
      db.stars = db.stars.filter((s) => s.id !== id);
      db.conversations = db.conversations.filter((c) => c.starId !== id);
      db.rules = db.rules.filter((r) => r.starId !== id);
      db.memory = db.memory.filter((m) => m.starId !== id);
      for (const t of db.tasks) if (t.starId === id && !['done', 'failed'].includes(t.status)) { t.status = 'done'; emit({ type: 'task.updated', data: summary(t) }); }
      for (const a of db.approvals) if (a.starId === id && a.status === 'pending') { a.status = 'expired'; emit({ type: 'approval.updated', data: clone(a) }); }
      emit({ type: 'star.deleted', data: { id } });
      logActivity('message', `Removed Star: ${star.name}`);
    },
    async pauseStar(id, paused) {
      await wait();
      const star = findStar(id);
      star.paused = paused;
      star.updatedAt = iso();
      for (const t of db.tasks) {
        if ((t.starId ?? MAIN) !== id) continue;
        if (paused && t.status === 'active') { t.status = 'paused'; emit({ type: 'task.updated', data: summary(t) }); }
      }
      emit({ type: 'star.updated', data: starView(star) });
      emit({ type: 'status', data: status() });
      return starView(star);
    },
    async listConstellationMessages(starId) {
      await wait();
      return clone(db.constellation.filter((m) => !starId || m.fromStarId === starId || m.toStarId === starId).slice(-100));
    },
    async getBriefing() { await wait(); return clone(db.briefing); },

    async listTasks(filter) {
      await wait();
      const want = filter?.status;
      return db.tasks.filter((t) => (!want || want.includes(t.status)) && (!filter?.starId || (t.starId ?? MAIN) === filter.starId)).map(summary);
    },
    async getTask(id) { await wait(); return clone(findTask(id)); },
    async createTask(input) {
      await wait();
      const t: TaskDetail = {
        id: uid('t'), ...input, status: input.kind === 'one_off' ? 'active' : 'scheduled',
        createdAt: iso(), updatedAt: iso(), connectionIds: [], starId: input.starId ?? MAIN,
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
      setTimeout(() => {
        const text = a.status === 'approved'
          ? `Done. ${a.action === 'Send email' ? 'Sent to ' + a.target + '.' : a.action + ' is done.'} I’ll let you know when there’s a reply.`
          : 'Okay, I won’t. Tell me if you want me to try something else.';
        const who = findStar(a.starId ?? MAIN);
        const m: Message = { id: uid('msg'), conversationId: who.conversationId, role: 'agent', content: text, createdAt: iso(), status: 'done', starId: who.id };
        db.messages.push(m);
        emit({ type: 'message.done', data: clone(m) });
      }, 900);
      return clone(a);
    },

    async listConversations() { await wait(); return clone([...db.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))); },
    async createConversation(starId) {
      await wait();
      const c = { id: uid('c'), main: false, title: 'New chat', updatedAt: iso(), preview: '', starId: starId ?? MAIN };
      db.conversations.unshift(c);
      return clone(c);
    },
    async listMessages(cid) { await wait(); return clone(db.messages.filter((m) => m.conversationId === cid)); },
    async sendMessage(cid, content) {
      await wait(80);
      const m: Message = { id: uid('msg'), conversationId: cid, role: 'user', content, createdAt: iso(), status: 'done' };
      db.messages.push(m);
      const conv = db.conversations.find((c) => c.id === cid);
      if (conv && conv.title === 'New chat') conv.title = content.slice(0, 40);
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

    async listRules(starId) { await wait(); return clone(db.rules.filter((r) => !starId || !r.starId || r.starId === starId)); },
    async addRule(text, starId) {
      await wait();
      const r = { id: uid('r'), text, enabled: true, builtIn: false, createdAt: iso(), starId: starId ?? null };
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

    async listIdeas() { await wait(); return clone(db.ideas); },
    async dismissIdea(id) { await wait(); db.ideas = db.ideas.filter((i) => i.id !== id); },

    async listActivity() { await wait(); return { items: clone(db.activity), nextCursor: null }; },

    async getSettings() { await wait(); return clone(db.settings); },
    async updateSettings(patch) {
      await wait();
      Object.assign(db.settings, patch);
      const main = findStar(MAIN);
      main.name = db.settings.agentName;
      main.avatar = clone(db.settings.avatar);
      emit({ type: 'settings.updated', data: clone(db.settings) });
      emit({ type: 'star.updated', data: starView(main) });
      emit({ type: 'status', data: status() });
      return clone(db.settings);
    },

    subscribe(h) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
  };
}
