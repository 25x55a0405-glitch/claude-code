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
import type { BrowserSession, RecordedStep, Recording, SavedLogin, WorkspaceFile, Lesson, McpServer, MessagingStatus, ModelProvider, PushSubscriptionInfo, Secret, Skill, TriggerInput, TriggerSetup } from './types';

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A stand-in screenshot of a Star's tab: a simple page drawn as SVG at 1280×800. */
function mockFrame(s: BrowserSession, clicks: { x: number; y: number }[]): string {
  let host = s.url;
  try { host = new URL(s.url).hostname.replace(/^www\./, ''); } catch { /* keep the raw text */ }
  const flights = /kayak|flights|skyscanner/.test(host);
  const rows = flights
    ? [['TAP Air Portugal', '1 stop · EWR', '8h 05m', '$642'], ['United', 'Nonstop', '6h 50m', '$711'], ['Iberia', '1 stop · MAD', '10h 20m', '$658'], ['Delta', 'Nonstop', '6h 55m', '$733']]
    : [['Result one', 'A page Sky found', '', ''], ['Result two', 'Another source', '', ''], ['Result three', 'Worth a look', '', '']];
  const cards = rows.map(([a, b, c, d], i) => {
    const y = 250 + i * 120;
    return `<rect x="80" y="${y}" width="1120" height="100" rx="14" fill="#fff" stroke="#e6e6e6"/>
      <text x="112" y="${y + 44}" font-size="24" font-weight="600" fill="#111">${esc(a)}</text>
      <text x="112" y="${y + 76}" font-size="18" fill="#777">${esc(b)}</text>
      <text x="760" y="${y + 58}" font-size="20" fill="#555">${esc(c)}</text>
      ${d ? `<rect x="1010" y="${y + 26}" width="160" height="48" rx="10" fill="#ff690f"/><text x="1090" y="${y + 58}" font-size="22" font-weight="700" fill="#fff" text-anchor="middle">${esc(d)}</text>` : ''}`;
  }).join('');
  const dots = clicks.slice(-3).map((c) => `<circle cx="${c.x}" cy="${c.y}" r="18" fill="none" stroke="#ff690f" stroke-width="3" opacity=".8"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800" font-family="Helvetica, Arial, sans-serif">
    <rect width="1280" height="800" fill="#f5f6f7"/>
    <rect width="1280" height="84" fill="${flights ? '#1d1d1f' : '#fff'}"/>
    <text x="80" y="54" font-size="30" font-weight="800" fill="${flights ? '#ff690f' : '#111'}">${esc(host.split('.')[0].toUpperCase())}</text>
    <text x="80" y="160" font-size="34" font-weight="700" fill="#111">${esc(s.title.split(' · ')[0])}</text>
    <text x="80" y="200" font-size="18" fill="#888">${esc(s.url.slice(0, 90))}</text>
    ${cards}${dots}
  </svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

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
    providers: clone(seed.seedProviders),
    browser: clone(seed.seedBrowser),
    skills: clone(seed.seedSkills),
    lessons: clone(seed.seedLessons),
    secrets: clone(seed.seedSecrets),
    pushSubs: clone(seed.seedPushSubs),
    triggerEvents: clone(seed.seedTriggerEvents),
    hookTokens: {} as Record<string, string>,
    messaging: clone(seed.seedMessaging),
    mcp: clone(seed.seedMcp),
    clicks: {} as Record<string, { x: number; y: number }[]>,
    recordings: clone(seed.seedRecordings),
    files: clone(seed.seedFiles),
    logins: clone(seed.seedLogins),
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
    const gmail = db.connections.some((c) => c.id === 'gmail' && c.status === 'connected');
    return {
      ...clone(star),
      email: gmail ? (star.main ? 'd@gmail.com' : `d+${star.name.toLowerCase().replace(/[^a-z0-9]/g, '')}@gmail.com`) : null,
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

  const findProvider = (id: string) => {
    const p = db.providers.find((x) => x.id === id);
    if (!p) throw new Error('That model is no longer set up');
    return p;
  };
  const freshHealth = (): ModelProvider['health'] => ({ state: 'unknown', lastOkAt: null, lastError: null, lastErrorAt: null, cooldownUntil: null, failures: 0, latencyMs: null });
  const tab = (starId: string) => {
    let s = db.browser.find((b) => b.starId === starId);
    if (!s) {
      s = { starId, url: 'about:blank', title: 'New tab', frameId: null, updatedAt: iso(), control: 'star', controlNote: null, waitingTaskId: null, recordingId: null };
      db.browser.push(s);
    }
    return s;
  };
  const frame = (s: BrowserSession) => {
    s.frameId = uid('f');
    s.updatedAt = iso();
    emit({ type: 'browser.frame', data: clone(s) });
  };

  const idle: Record<string, boolean> = {};
  const idleTimers: Record<string, number> = {};
  const starName = (id: string) => db.stars.find((x) => x.id === id)?.name ?? 'The Star';
  const setControl = (s: BrowserSession, who: 'star' | 'person', note: string | null) => {
    const was = s.control;
    s.control = who;
    s.controlNote = who === 'person' ? note : null;
    if (who === 'star') s.waitingTaskId = null;
    s.updatedAt = iso();
    emit({ type: 'browser.control', data: clone(s) });
    if (was !== who) logActivity('browser', who === 'person' ? `You took over ${starName(s.starId)}’s browser${note ? `: ${note}` : ''}` : `${starName(s.starId)} has the browser back${note ? `: ${note}` : ''}`, undefined, s.starId);
  };
  const recordStep = (starId: string, step: Omit<RecordedStep, 'at' | 'url'>, url: string) => {
    const r = db.recordings.find((x) => x.starId === starId && x.status === 'recording');
    if (!r) return;
    r.steps.push({ at: iso(), url, ...step });
    emit({ type: 'recording.updated', data: clone(r) });
  };
  const finishRecording = (r: Recording) => {
    r.status = 'done';
    r.endedAt = iso();
    const s = db.browser.find((b) => b.starId === r.starId);
    if (s) s.recordingId = null;
    const words = r.steps.map((st, i) => `${i + 1}. ${st.kind === 'open' ? `Open ${st.value ?? st.url}` : st.kind === 'click' ? `Click “${st.target ?? 'the button'}”` : st.kind === 'type' ? `Type ${st.value === '[password]' ? 'the password' : `“${st.value}”`} into ${st.target ?? 'the field'}` : st.kind === 'key' ? `Press ${st.value}` : st.kind === 'back' ? 'Go back' : 'Scroll down'}.`);
    r.draft = r.steps.length ? { name: r.title, whenToUse: `When d asks to ${r.title.charAt(0).toLowerCase()}${r.title.slice(1)}`, steps: words.join('\n') } : null;
    emit({ type: 'recording.updated', data: clone(r) });
  };
  const filesOf = (starId: string) => (db.files[starId] ??= {});
  const listing = (starId: string, path: string, recursive: boolean): WorkspaceFile[] => {
    const all = filesOf(starId);
    const prefix = path ? `${path.replace(/\/$/, '')}/` : '';
    const out = new Map<string, WorkspaceFile>();
    for (const [p, f] of Object.entries(all)) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const parts = rest.split('/');
      if (parts.length === 1 || recursive) out.set(p, { path: p, kind: 'file', size: new Blob([f.text]).size, updatedAt: f.at });
      if (parts.length > 1) {
        const folder = prefix + parts[0];
        const prev = out.get(folder);
        const size = (prev?.size ?? 0) + new Blob([f.text]).size;
        out.set(folder, { path: folder, kind: 'folder', size, updatedAt: prev && prev.updatedAt > f.at ? prev.updatedAt : f.at });
      }
    }
    return [...out.values()].sort((a, b) => (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'folder' ? -1 : 1));
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

  const logActivity = (kind: ActivityEvent['kind'], text: string, taskId?: string, starId?: string) => {
    const ev: ActivityEvent = { id: uid('e'), at: iso(), kind, summary: text, taskId, starId };
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
      if (t.id === 't_flights') { const b = db.browser.find((x) => x.starId === 'star_scout'); if (b) frame(b); }
    }
    emit({ type: 'status', data: status() });
    const who = next.task ? findTask(next.task).starId ?? MAIN : null;
    db.stars.forEach((st) => emit({ type: 'star.activity', data: { starId: st.id, activity: st.id === who ? next.line : null, taskId: st.id === who ? next.task : null, at: iso() } }));
    emitStars();
  }, 9000);

  /** A correction in chat becomes a lesson and a "Got it" message, like the server. */
  const learn = (starId: string, conversationId: string, text: string) => {
    const lessonText = text.trim().replace(/^(no[,.]?\s*|actually[,.]?\s*)/i, '').replace(/^./, (c) => c.toUpperCase());
    const memoryId = uid('m');
    db.memory.unshift({ id: memoryId, category: 'preference', content: lessonText, source: 'Learned from a correction', createdAt: iso(), pinned: false });
    const lesson: Lesson = { id: uid('l'), starId, lesson: lessonText, trigger: 'chat', memoryId, undone: false, createdAt: iso() };
    db.lessons.unshift(lesson);
    const m: Message = { id: uid('msg'), conversationId, role: 'agent', starId, content: `Got it. I’ll remember: ${lessonText.charAt(0).toLowerCase() + lessonText.slice(1)}`, createdAt: iso(), status: 'done', lessonId: lesson.id };
    db.messages.push(m);
    setTimeout(() => { emit({ type: 'message.done', data: clone(m) }); emit({ type: 'lesson.learned', data: clone(lesson) }); }, 500);
  };


  const triggerSetup = (taskId: string): TriggerSetup => {
    const t = findTask(taskId);
    if (!t.trigger) throw new Error('This goal has no trigger');
    const token = (db.hookTokens[taskId] ??= Math.random().toString(36).slice(2, 14));
    const hook = t.trigger.kind === 'webhook' || t.trigger.kind === 'github';
    return { ...clone(t.trigger), url: hook ? `${location.origin}/api/v1/hooks/${token}` : null, secret: t.trigger.kind === 'github' ? `ghs_${token}${token.slice(0, 6)}` : null };
  };
  const setMessaging = (m: MessagingStatus) => {
    db.messaging = db.messaging.map((x) => (x.app === m.app ? m : x));
    emit({ type: 'messaging.updated', data: clone(m) });
    return clone(m);
  };
  const toolsFor = (name: string): McpServer['tools'] => [
    { name: 'search', toolName: `mcp_${name}_search`, description: 'Search', effect: 'read' },
    { name: 'create_item', toolName: `mcp_${name}_create_item`, description: 'Create something', effect: 'write' },
  ];

  const replyTo = (conversationId: string, text: string, as?: string) => {
    const group = db.conversations.find((c) => c.id === conversationId)?.starIds;
    if (group && group.length > 1 && !as) {
      // Named Stars answer in order, at most two; otherwise the first member does.
      const named = group.map((id) => findStar(id)).filter((st) => new RegExp(`(^|\\s)@?${st.name}\\b`, 'i').test(text)).slice(0, 2);
      const who = named.length ? named : [findStar(group[0])];
      who.forEach((st, i) => setTimeout(() => replyTo(conversationId, text, st.id), i * 2200));
      return;
    }
    const lower = text.toLowerCase();
    const me = findStar(as ?? starOfConv(conversationId));
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

    emit({ type: 'star.activity', data: { starId: me.id, activity: 'Writing', taskId: null, at: iso() } });
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
        emit({ type: 'star.activity', data: { starId: me.id, activity: null, taskId: null, at: iso() } });
        if (/^(no\b|actually|don[’']?t)/i.test(text.trim())) learn(me.id, conversationId, text);
        return;
      }
      const delta = words.slice(i, i + 2).join('');
      i += 2;
      msg.content += delta;
      emit({ type: 'message.delta', data: { conversationId, messageId: msg.id, delta } });
    }, 45);
  };

  const api: SkyApi = {
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
        providerIds: input.providerIds ?? null,
        personality: input.personality ?? '', replyStyle: input.replyStyle ?? '', notify: { whenDone: false, whenNeedsYou: true, ...input.notify },
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
      if (patch.notify) patch = { ...patch, notify: { whenDone: false, whenNeedsYou: true, ...star.notify, ...patch.notify } };
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

    async listSkills(starId) { await wait(); return clone(db.skills.filter((k) => !starId || k.starId === null || k.starId === starId)); },
    async createSkill(input) {
      await wait();
      if (db.skills.some((k) => k.name.toLowerCase() === input.name.trim().toLowerCase())) throw new Error(`There’s already a skill called ${input.name.trim()}`);
      const k: Skill = { id: uid('sk'), name: input.name.trim(), whenToUse: input.whenToUse, steps: input.steps, starId: input.starId ?? null, source: 'you', uses: 0, lastUsedAt: null, createdAt: iso(), updatedAt: iso() };
      db.skills.unshift(k);
      emit({ type: 'skill.updated', data: clone(k) });
      return clone(k);
    },
    async updateSkill(id, patch) {
      await wait();
      const k = db.skills.find((x) => x.id === id);
      if (!k) throw new Error('That skill is gone');
      if (k.source === 'builtIn') throw new Error('Built-in skills can’t be changed');
      Object.assign(k, patch, { updatedAt: iso() });
      emit({ type: 'skill.updated', data: clone(k) });
      return clone(k);
    },
    async deleteSkill(id) {
      await wait();
      const k = db.skills.find((x) => x.id === id);
      if (k?.source === 'builtIn') throw new Error('Built-in skills can’t be removed');
      db.skills = db.skills.filter((x) => x.id !== id);
      emit({ type: 'skill.deleted', data: { id } });
    },
    async listLessons(starId) { await wait(); return clone(db.lessons.filter((l) => !starId || l.starId === starId)); },
    async undoLesson(id) {
      await wait();
      const l = db.lessons.find((x) => x.id === id);
      if (!l) throw new Error('That lesson is gone');
      l.undone = true;
      if (l.memoryId) db.memory = db.memory.filter((m) => m.id !== l.memoryId);
      if (l.skillId) { const k = db.skills.find((x) => x.id === l.skillId); if (k) { k.steps = k.steps.split('\n').filter((line) => line !== `- Lesson: ${l.lesson}`).join('\n'); emit({ type: 'skill.updated', data: clone(k) }); } }
      emit({ type: 'lesson.undone', data: clone(l) });
      return clone(l);
    },

    async listSecrets(starId) { await wait(); return { keySource: 'file', secrets: clone(db.secrets.filter((x) => !starId || x.starIds === null || x.starIds.includes(starId))) }; },
    async createSecret(input) {
      await wait();
      const name = input.name.trim();
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) throw new Error('Use letters, digits and _ for the name, starting with a letter');
      if (db.secrets.some((x) => x.name === name)) throw new Error(`There’s already a secret called ${name}`);
      const sec: Secret = { id: uid('sec'), name, description: input.description ?? '', starIds: input.starIds ?? null, lastUsedAt: null, createdAt: iso(), updatedAt: iso() };
      db.secrets.push(sec);
      return clone(sec);
    },
    async updateSecret(name, patch) {
      await wait();
      const sec = db.secrets.find((x) => x.name === name || x.id === name);
      if (!sec) throw new Error('That secret is gone');
      const { value: _value, ...rest } = patch;
      Object.assign(sec, rest, { updatedAt: iso() });
      return clone(sec);
    },
    async deleteSecret(name) { await wait(); db.secrets = db.secrets.filter((x) => x.name !== name && x.id !== name); },

    async getPushKey() { await wait(); return { publicKey: 'BMockPublicKeyForThePreviewOnly0000000000000000000000000000000000000000000000000000000' }; },
    async listPushSubscriptions() { await wait(); return clone(db.pushSubs); },
    async addPushSubscription(_sub, label) {
      await wait();
      const p: PushSubscriptionInfo = { id: uid('ps'), label: label ?? 'This browser', createdAt: iso(), lastSentAt: null };
      db.pushSubs.push(p);
      return clone(p);
    },
    async deletePushSubscription(id) { await wait(); db.pushSubs = db.pushSubs.filter((p) => p.id !== id); },
    async testPush() {
      await wait(500);
      const delivered = [...(db.settings.channels.push ? db.pushSubs.map((p) => p.label) : []), ...(db.settings.ntfyTopic ? [`ntfy: ${db.settings.ntfyTopic}`] : [])];
      if (!delivered.length) throw new Error('There’s nowhere to send yet. Turn on push here or add an ntfy topic.');
      db.pushSubs.forEach((p) => (p.lastSentAt = iso()));
      return { delivered, failed: [] };
    },

    async getTrigger(id) { await wait(); return triggerSetup(id); },
    async setTrigger(id, trigger: TriggerInput | null) {
      await wait();
      const t = findTask(id);
      if (t.kind === 'one_off') throw new Error('Only repeating goals can have a trigger');
      t.trigger = trigger ? { ...trigger, fired: t.trigger?.fired ?? 0, lastFiredAt: t.trigger?.lastFiredAt ?? null } : undefined;
      t.updatedAt = iso();
      emit({ type: 'task.updated', data: summary(t) });
      return trigger ? triggerSetup(id) : null;
    },
    async rotateTrigger(id) { await wait(); delete db.hookTokens[id]; return triggerSetup(id); },
    async listTriggerEvents(id) { await wait(); return clone(db.triggerEvents.filter((e) => e.taskId === id)); },
    async checkMail() { await wait(600); },

    async listMessaging() { await wait(); return clone(db.messaging); },
    async connectTelegram(botToken) {
      await wait(500);
      if (!/^\d+:[\w-]{20,}$/.test(botToken.trim())) throw new Error('Telegram didn’t accept that token. Copy it again from @BotFather.');
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const m = setMessaging({ app: 'telegram', state: 'pairing', pairCode: code, pairLink: `https://t.me/my_sky_bot?start=${code}`, botName: 'my_sky_bot', error: null });
      setTimeout(() => setMessaging({ ...m, state: 'on', pairCode: null, pairLink: null }), 15000);
      return m;
    },
    async connectSlack(botToken, appToken) {
      await wait(500);
      if (!botToken.startsWith('xoxb-') || !appToken.startsWith('xapp-')) throw new Error('The bot token starts with xoxb- and the app token with xapp-.');
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const m = setMessaging({ app: 'slack', state: 'pairing', pairCode: code, pairLink: null, botName: 'Acme workspace', error: null });
      setTimeout(() => setMessaging({ ...m, state: 'on', pairCode: null }), 15000);
      return m;
    },
    async disconnectMessaging(app) { await wait(); return setMessaging({ app, state: 'off', pairCode: null, pairLink: null, botName: null, error: null }); },
    async slackManifest() {
      await wait();
      return JSON.stringify({ display_information: { name: db.settings.agentName }, features: { bot_user: { display_name: db.settings.agentName, always_online: true } }, oauth_config: { scopes: { bot: ['chat:write', 'im:history', 'im:read', 'im:write', 'channels:history', 'groups:history', 'users:read'] } }, settings: { event_subscriptions: { bot_events: ['message.im', 'message.channels', 'message.groups'] }, interactivity: { is_enabled: true }, socket_mode_enabled: true } }, null, 2);
    },

    async listMcp() { await wait(); return clone(db.mcp); },
    async createMcp(input) {
      await wait();
      const m: McpServer = {
        id: uid('mcp'), name: input.name.trim(), transport: input.transport, command: input.command ?? null, args: input.args ?? [], url: input.url ?? null,
        envKeys: Object.keys(input.env ?? {}), headerKeys: Object.keys(input.headers ?? {}), enabled: input.enabled ?? true, toolEffects: input.toolEffects ?? {},
        status: 'connecting', error: null, tools: [], createdAt: iso(), updatedAt: iso(),
      };
      db.mcp.push(m);
      setTimeout(() => { Object.assign(m, { status: 'ready', tools: toolsFor(m.name) }); emit({ type: 'mcp.updated', data: clone(m) }); }, 1500);
      return clone(m);
    },
    async updateMcp(id, patch) {
      await wait();
      const m = db.mcp.find((x) => x.id === id);
      if (!m) throw new Error('That server is gone');
      const { env, headers, ...rest } = patch;
      Object.assign(m, rest, { updatedAt: iso() });
      if (env) m.envKeys = Object.keys(env);
      if (headers) m.headerKeys = Object.keys(headers);
      emit({ type: 'mcp.updated', data: clone(m) });
      return clone(m);
    },
    async deleteMcp(id) {
      await wait();
      db.mcp = db.mcp.filter((x) => x.id !== id);
      db.stars.forEach((st) => { if (st.mcpServerIds) st.mcpServerIds = st.mcpServerIds.filter((x) => x !== id); });
      emit({ type: 'mcp.deleted', data: { id } });
    },
    async reconnectMcp(id) {
      await wait(400);
      const m = db.mcp.find((x) => x.id === id)!;
      Object.assign(m, { status: 'connecting', error: null });
      setTimeout(() => { Object.assign(m, m.headerKeys.length && m.status !== 'ready' && m.name === 'linear' ? { status: 'error', error: '401 Unauthorized: check the Authorization header' } : { status: 'ready', tools: m.tools.length ? m.tools : toolsFor(m.name) }); emit({ type: 'mcp.updated', data: clone(m) }); }, 1200);
      return clone(m);
    },

    async createGroupChat(starIds, title) {
      await wait();
      if (starIds.length < 2) throw new Error('Pick at least two Stars');
      const c = { id: uid('c'), main: false, title: title?.trim() || starIds.map((id) => findStar(id).name).join(', '), updatedAt: iso(), preview: '', starIds };
      db.conversations.unshift(c);
      return clone(c);
    },
    async updateConversation(id, patch) {
      await wait();
      const c = db.conversations.find((x) => x.id === id);
      if (!c) throw new Error('That chat is gone');
      if (patch.starIds && patch.starIds.length < 2) throw new Error('A group needs at least two Stars');
      Object.assign(c, patch, { updatedAt: iso() });
      return clone(c);
    },

    async listTemplates() { await wait(); return { templates: clone(seed.seedTemplates.filter((t) => t.source === 'builtIn' || db.settings.templateGallery !== '')), galleryError: null }; },
    async starTemplate(id) {
      await wait();
      const st = findStar(id);
      return {
        format: 'sky.star', version: 1, name: st.name, role: st.role, instructions: st.instructions, personality: st.personality ?? '', replyStyle: st.replyStyle ?? '',
        avatar: clone(st.avatar), autonomy: st.autonomy, apps: st.connectionIds ? [...st.connectionIds] : null,
        skills: db.skills.filter((k) => k.starId === id).map(({ name, whenToUse, steps }) => ({ name, whenToUse, steps })),
        rules: db.rules.filter((r) => r.starId === id).map((r) => r.text),
      };
    },
    async importTemplate(from) {
      await wait(500);
      let template;
      if ('template' in from) template = from.template;
      else if ('id' in from) template = seed.seedTemplates.find((t) => t.id === from.id)?.template;
      else throw new Error('The preview can’t fetch links. Try a file instead.');
      if (!template || template.format !== 'sky.star') throw new Error('That isn’t a Sky Star template');
      let name = template.name;
      for (let n = 2; db.stars.some((x) => x.name.toLowerCase() === name.toLowerCase()); n++) name = `${template.name} ${n}`;
      const apps = template.apps;
      const known = apps?.filter((a) => db.connections.some((c) => c.id === a)) ?? null;
      const skipped = apps?.filter((a) => !db.connections.some((c) => c.id === a)) ?? [];
      const star = await api.createStar({ name, role: template.role, instructions: template.instructions, avatar: template.avatar, autonomy: template.autonomy, connectionIds: known, personality: template.personality, replyStyle: template.replyStyle });
      template.skills.forEach((k) => db.skills.push({ id: uid('sk'), ...k, starId: star.id, source: 'you', uses: 0, lastUsedAt: null, createdAt: iso(), updatedAt: iso() }));
      template.rules.forEach((text) => db.rules.push({ id: uid('r'), text, enabled: true, builtIn: false, starId: star.id, createdAt: iso() }));
      return { star, skipped };
    },

    async listProviders() { await wait(); return clone(db.providers); },
    async listProviderPresets() { await wait(); return clone(seed.seedPresets); },
    async createProvider(input) {
      await wait();
      const { apiKey, ...rest } = input;
      const p: ModelProvider = {
        id: uid('p'), ...rest, enabled: input.enabled ?? true, hasKey: !!apiKey, keyHint: apiKey ? apiKey.slice(-4) : null,
        builtIn: false, health: freshHealth(), createdAt: iso(), updatedAt: iso(),
      };
      db.providers.push(p);
      emit({ type: 'provider.updated', data: clone(p) });
      return clone(p);
    },
    async updateProvider(id, patch) {
      await wait();
      const p = findProvider(id);
      const { apiKey, ...rest } = patch;
      if (p.builtIn && Object.keys(rest).some((k) => k !== 'name' && k !== 'enabled')) throw new Error('The server’s own model can only be renamed or turned off');
      const resets = apiKey !== undefined || ['kind', 'baseUrl', 'model'].some((k) => k in rest && (rest as Record<string, unknown>)[k] !== (p as unknown as Record<string, unknown>)[k]);
      Object.assign(p, rest, { updatedAt: iso() });
      if (apiKey !== undefined) { p.hasKey = !!apiKey; p.keyHint = apiKey ? apiKey.slice(-4) : null; }
      if (resets) p.health = freshHealth();
      emit({ type: 'provider.updated', data: clone(p) });
      return clone(p);
    },
    async deleteProvider(id) {
      await wait();
      const p = findProvider(id);
      if (p.builtIn) throw new Error('The server’s own model can’t be removed, only turned off');
      db.providers = db.providers.filter((x) => x.id !== id);
      for (const s of db.stars) if (s.providerIds) s.providerIds = s.providerIds.filter((x) => x !== id);
      emit({ type: 'provider.deleted', data: { id } });
    },
    async testProvider(id) {
      const p = findProvider(id);
      const started = Date.now();
      await wait(500 + Math.random() * 600);
      const latencyMs = Date.now() - started;
      const broken = !p.hasKey && !/localhost|127\.0\.0\.1/.test(p.baseUrl);
      const local = /localhost/.test(p.baseUrl);
      const result = broken
        ? { ok: false, latencyMs, error: '401 Unauthorized: missing API key' }
        : local ? { ok: false, latencyMs, error: 'Couldn’t reach http://localhost:11434. Is it running?' }
        : { ok: true, latencyMs, reply: 'Hello! Ready when you are.' };
      p.health = result.ok
        ? { ...p.health, state: 'ok', lastOkAt: iso(), latencyMs, failures: 0, cooldownUntil: null }
        : { ...p.health, state: broken ? 'failing' : 'cooling', lastError: result.error!, lastErrorAt: iso(), failures: p.health.failures + 1, cooldownUntil: broken ? null : new Date(Date.now() + 30_000).toISOString() };
      emit({ type: 'provider.updated', data: clone(p) });
      return result;
    },
    async setProviderOrder(ids) {
      await wait();
      const named = ids.map((id) => db.providers.find((p) => p.id === id)).filter((p): p is ModelProvider => !!p);
      db.providers = [...named, ...db.providers.filter((p) => !ids.includes(p.id))];
      return db.providers.map((p) => p.id);
    },

    async getBrowser() { await wait(); return { ok: true, running: true, reason: null, sessions: clone(db.browser.filter((b) => b.frameId)) }; },
    browserFrameUrl(starId) {
      const s = db.browser.find((b) => b.starId === starId);
      return s ? mockFrame(s, db.clicks[starId] ?? []) : '';
    },
    async browserInput(starId, input) {
      await wait(120);
      const s = tab(starId);
      // Using the live view takes the tab; it goes back by itself after 2 quiet minutes.
      if (s.control !== 'person') { setControl(s, 'person', null); idle[starId] = true; }
      if (idle[starId]) {
        window.clearTimeout(idleTimers[starId]);
        idleTimers[starId] = window.setTimeout(() => { if (idle[starId] && s.control === 'person' && !s.recordingId) { idle[starId] = false; setControl(s, 'star', null); } }, 120_000);
      }
      const at = s.url;
      if (input.type === 'navigate') recordStep(starId, { kind: 'open', value: /^[a-z]+:\/\//i.test(input.url) ? input.url : `https://${input.url}` }, at);
      else if (input.type === 'click') recordStep(starId, { kind: 'click', target: ['Search', 'Sign in', 'Continue', 'My account', 'Add to cart'][(db.recordings.find((r) => r.status === 'recording')?.steps.length ?? 0) % 5] }, at);
      else if (input.type === 'type') recordStep(starId, { kind: 'type', target: 'Search', value: input.text }, at);
      else if (input.type === 'key') recordStep(starId, { kind: 'key', value: input.key }, at);
      else if (input.type === 'back') recordStep(starId, { kind: 'back' }, at);
      if (input.type === 'navigate') {
        const url = /^[a-z]+:\/\//i.test(input.url) ? input.url : `https://${input.url}`;
        s.url = url;
        try { s.title = new URL(url).hostname.replace(/^www\./, ''); } catch { s.title = url; }
        db.clicks[starId] = [];
      } else if (input.type === 'click') {
        (db.clicks[starId] ??= []).push({ x: input.x, y: input.y });
      } else if (input.type === 'back') {
        db.clicks[starId] = [];
      }
      frame(s);
      return clone(s);
    },
    async closeBrowserTab(starId) {
      await wait();
      db.browser = db.browser.filter((b) => b.starId !== starId);
    },
    async takeOverBrowser(starId, note) {
      await wait(100);
      const s = tab(starId);
      idle[starId] = false;
      setControl(s, 'person', note ?? null);
      return clone(s);
    },
    async handBackBrowser(starId, note) {
      await wait(100);
      const s = db.browser.find((b) => b.starId === starId);
      if (!s) throw new Error('That Star’s browser isn’t open.');
      const r = db.recordings.find((x) => x.starId === starId && x.status === 'recording');
      if (r) finishRecording(r);
      setControl(s, 'star', note ?? null);
      return clone(s);
    },

    async startRecording(starId, input) {
      await wait();
      if (db.recordings.some((r) => r.starId === starId && r.status === 'recording')) throw new Error('Already recording for this Star');
      const s = tab(starId);
      const r: Recording = { id: uid('rec'), starId, title: input?.title?.trim() || 'A task I showed you', status: 'recording', startedAt: iso(), endedAt: null, steps: [], draft: null, skillId: null };
      db.recordings.unshift(r);
      s.recordingId = r.id;
      if (input?.url) {
        s.url = /^[a-z]+:\/\//i.test(input.url) ? input.url : `https://${input.url}`;
        try { s.title = new URL(s.url).hostname.replace(/^www\./, ''); } catch { s.title = s.url; }
        r.steps.push({ at: iso(), kind: 'open', url: s.url, value: s.url });
        db.clicks[starId] = [];
      }
      idle[starId] = false;
      setControl(s, 'person', `Recording: ${r.title}`);
      frame(s);
      emit({ type: 'recording.updated', data: clone(r) });
      return clone(r);
    },
    async stopRecording(starId) {
      await wait(500);
      const r = db.recordings.find((x) => x.starId === starId && x.status === 'recording');
      if (!r) throw new Error('Nothing is recording');
      finishRecording(r);
      // Stopping hands the tab back, like the real server.
      const s = db.browser.find((b) => b.starId === starId);
      if (s) setControl(s, 'star', null);
      return clone(r);
    },
    async listRecordings(starId) { await wait(); return clone(db.recordings.filter((r) => !starId || r.starId === starId)); },
    async getRecording(id) {
      await wait();
      const r = db.recordings.find((x) => x.id === id);
      if (!r) throw new Error('That recording is gone');
      return clone(r);
    },
    async deleteRecording(id) { await wait(); db.recordings = db.recordings.filter((r) => r.id !== id); },
    async saveRecordingAsSkill(id, input) {
      await wait();
      const r = db.recordings.find((x) => x.id === id);
      if (!r) throw new Error('That recording is gone');
      if (r.skillId) throw new Error('That recording is already a skill');
      const d = r.draft ?? { name: r.title, whenToUse: '', steps: '' };
      const k: Skill = { id: uid('sk'), name: (input.name ?? d.name).trim(), whenToUse: (input.whenToUse ?? d.whenToUse).trim(), steps: (input.steps ?? d.steps).trim(), starId: input.shared ? null : r.starId, source: 'taught', uses: 0, lastUsedAt: null, createdAt: iso(), updatedAt: iso() };
      db.skills.unshift(k);
      r.skillId = k.id;
      emit({ type: 'skill.updated', data: clone(k) });
      emit({ type: 'recording.updated', data: clone(r) });
      const task = input.schedule?.trim() ? await api.createTask({ title: k.name, description: `Use the skill “${k.name}”.`, kind: 'recurring', schedule: input.schedule.trim(), starId: r.starId }) : null;
      return { recording: clone(r), skill: clone(k), task };
    },

    async getWorkspace() { await wait(); return { sandbox: 'bwrap', reason: null, root: '~/.sky/workspaces' }; },
    async listFiles(starId, path, recursive) {
      await wait();
      const files = listing(starId, path ?? '', !!recursive);
      const usage = Object.values(filesOf(starId)).reduce((n, f) => n + new Blob([f.text]).size, 0);
      return { files, usage };
    },
    fileUrl(starId, path) {
      const f = filesOf(starId)[path];
      return f ? `data:text/plain;charset=utf-8,${encodeURIComponent(f.text)}` : '';
    },
    async uploadFile(starId, path, file) {
      await wait(300);
      if (file.size > 10 * 1024 * 1024) throw new Error('Files can be up to 10 MB');
      const text = await file.text();
      filesOf(starId)[path] = { text, at: iso() };
      emit({ type: 'workspace.changed', data: { starId, path } });
      return { path, kind: 'file', size: file.size, updatedAt: iso() };
    },
    async deleteFile(starId, path) {
      await wait();
      const all = filesOf(starId);
      for (const p of Object.keys(all)) if (p === path || p.startsWith(`${path}/`)) delete all[p];
      emit({ type: 'workspace.changed', data: { starId, path } });
    },

    async listLogins() { await wait(); return { enabled: db.settings.passwordFill === true, logins: clone(db.logins) }; },
    async createLogin(input) {
      await wait();
      let origin: string;
      try { origin = new URL(input.origin.includes('://') ? input.origin : `https://${input.origin}`).origin; } catch { throw new Error('That isn’t a web address'); }
      if (!origin.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin)) throw new Error('Logins only work on https sites');
      if (db.logins.some((l) => l.origin === origin && l.username === input.username)) throw new Error('That login is already saved');
      const l: SavedLogin = { id: uid('lg'), origin, username: input.username, starIds: input.starIds ?? null, autoFill: !!input.autoFill, lastUsedAt: null, createdAt: iso(), updatedAt: iso() };
      db.logins.push(l);
      return clone(l);
    },
    async updateLogin(id, patch) {
      await wait();
      const l = db.logins.find((x) => x.id === id);
      if (!l) throw new Error('That login is gone');
      if (patch.username !== undefined) l.username = patch.username;
      if (patch.starIds !== undefined) l.starIds = patch.starIds;
      if (patch.autoFill !== undefined) l.autoFill = patch.autoFill;
      l.updatedAt = iso();
      return clone(l);
    },
    async deleteLogin(id) { await wait(); db.logins = db.logins.filter((l) => l.id !== id); },

    async listTasks(filter) {
      await wait();
      const want = filter?.status;
      return db.tasks.filter((t) => (!want || want.includes(t.status)) && (!filter?.starId || (t.starId ?? MAIN) === filter.starId)).map(summary);
    },
    async getTask(id) { await wait(); return clone(findTask(id)); },
    async createTask(input) {
      await wait();
      const t: TaskDetail = {
        id: uid('t'), ...input, trigger: input.trigger ? { ...input.trigger, fired: 0, lastFiredAt: null } : undefined, status: input.kind === 'one_off' ? 'active' : 'scheduled',
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
  return api;
}
