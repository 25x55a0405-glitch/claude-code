import type { Runtime } from '../agent/runtime.ts';
import { validTimeZone, parseHHMM } from '../agent/time.ts';
import type { Providers } from '../connections/providers.ts';
import type { Store } from '../store.ts';
import type { Access, ApprovalStatus, Autonomy, AvatarCharacter, AvatarColor, MemoryCategory, Message, Settings, TaskStatus, Tone } from '../types.ts';
import { badRequest, firstLine, iso, uid } from '../util.ts';
import type { Router } from './router.ts';

const TASK_STATUSES: TaskStatus[] = ['active', 'scheduled', 'waiting_approval', 'blocked', 'paused', 'done', 'failed'];
const CATEGORIES: MemoryCategory[] = ['preference', 'fact', 'person', 'goal', 'style'];
const TONES: Tone[] = ['warm', 'concise', 'playful', 'formal'];
const AUTONOMY: Autonomy[] = ['ask', 'balanced', 'autonomous'];
const ACCESS: Access[] = ['read', 'read_write'];
const CHARACTERS: AvatarCharacter[] = ['cloud', 'dot', 'drop'];
const COLORS: AvatarColor[] = ['sky', 'peach', 'mint', 'lilac', 'sun'];

const text = (v: unknown, field: string, max = 10_000): string => {
  if (typeof v !== 'string' || !v.trim()) throw badRequest(`${field} is required`);
  if (v.length > max) throw badRequest(`${field} is too long`);
  return v.trim();
};
const oneOf = <T extends string>(v: unknown, allowed: T[], field: string): T => {
  if (!allowed.includes(v as T)) throw badRequest(`${field} must be one of ${allowed.join(', ')}`);
  return v as T;
};
const boolean = (v: unknown, field: string): boolean => {
  if (typeof v !== 'boolean') throw badRequest(`${field} must be true or false`);
  return v;
};
const hhmm = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || parseHHMM(v) === null) throw badRequest(`${field} must be a time like 08:00`);
  return v;
};

/** Every endpoint in docs/API.md, under /api/v1. */
export function registerRoutes(r: Router, store: Store, runtime: Runtime, providers: Providers) {
  // ---- status and briefing ----
  r.get('/status', () => store.status());
  r.post('/status', ({ body }) => runtime.setPaused(boolean(body?.paused, 'paused')));
  r.get('/briefing', () => runtime.briefing());

  // ---- tasks ----
  r.get('/tasks', ({ query }) => {
    const raw = query.get('status');
    const statuses = raw ? raw.split(',').map((s) => oneOf(s.trim(), TASK_STATUSES, 'status')) : undefined;
    return store.listTasks(statuses);
  });
  r.get('/tasks/:id', ({ params }) => store.taskDetail(params.id));
  r.post('/tasks', ({ body }) => runtime.createTask({
    title: text(body?.title, 'title', 200),
    description: typeof body?.description === 'string' ? body.description : '',
    kind: oneOf(body?.kind, ['one_off', 'recurring', 'watch'], 'kind'),
    schedule: typeof body?.schedule === 'string' ? body.schedule : undefined,
  }));
  for (const command of ['pause', 'resume', 'run_now', 'cancel'] as const) {
    r.post(`/tasks/:id/${command}`, ({ params }) => runtime.commandTask(params.id, command));
  }

  // ---- approvals ----
  r.get('/approvals', ({ query }) => {
    const s = query.get('status');
    return store.listApprovals(s ? oneOf(s, ['pending', 'approved', 'rejected', 'expired'] as ApprovalStatus[], 'status') : undefined);
  });
  r.post('/approvals/:id/decision', ({ params, body }) => runtime.decide(params.id, {
    decision: oneOf(body?.decision, ['approve', 'reject'], 'decision'),
    editedPreview: typeof body?.editedPreview === 'string' ? body.editedPreview : undefined,
    note: typeof body?.note === 'string' ? body.note : undefined,
  }));

  // ---- conversations ----
  r.get('/conversations', () => store.listConversations());
  r.post('/conversations', () => store.createConversation());
  r.get('/conversations/:id/messages', ({ params }) => {
    store.getConversation(params.id);
    return store.messages(params.id);
  });
  r.post('/conversations/:id/messages', ({ params, body }) => {
    const conv = store.getConversation(params.id);
    const content = text(body?.content, 'content', 20_000);
    const m: Message = { id: uid('msg'), conversationId: conv.id, role: 'user', content, createdAt: iso(), status: 'done' };
    store.saveMessage(m);
    store.patchConversation(conv.id, {
      updatedAt: m.createdAt, preview: firstLine(content, 120),
      ...(!conv.main && (conv.title === 'New chat' || conv.title === 'New conversation') ? { title: firstLine(content, 40) } : {}),
    });
    store.log('message', `You said: ${firstLine(content, 100)}`);
    void runtime.chat.reply(conv.id);
    return m;
  });

  // ---- memory ----
  r.get('/memory', () => store.listMemory());
  r.post('/memory', ({ body }) => store.addMemory(oneOf(body?.category, CATEGORIES, 'category'), text(body?.content, 'content', 1000), 'Added by you'));
  r.patch('/memory/:id', ({ params, body }) => store.patchMemory(params.id, {
    ...(body?.content !== undefined ? { content: text(body.content, 'content', 1000) } : {}),
    ...(body?.pinned !== undefined ? { pinned: boolean(body.pinned, 'pinned') } : {}),
    ...(body?.category !== undefined ? { category: oneOf(body.category, CATEGORIES, 'category') } : {}),
  }));
  r.delete('/memory/:id', ({ params }) => store.deleteMemory(params.id));

  // ---- connections ----
  r.get('/connections', () => store.listConnections());
  r.patch('/connections/:id', ({ params, body }) => {
    const c = store.getConnection(params.id);
    return store.putConnection({ ...c, access: oneOf(body?.access, ACCESS, 'access') });
  });
  r.post('/connections/:id/connect', ({ params }) => providers.connect(params.id));
  r.post('/connections/:id/disconnect', ({ params }) => providers.disconnect(params.id));

  // ---- rules ----
  r.get('/rules', () => store.listRules());
  r.post('/rules', ({ body }) => store.addRule(text(body?.text, 'text', 500)));
  r.patch('/rules/:id', ({ params, body }) => store.patchRule(params.id, {
    ...(body?.text !== undefined ? { text: text(body.text, 'text', 500) } : {}),
    ...(body?.enabled !== undefined ? { enabled: boolean(body.enabled, 'enabled') } : {}),
  }));
  r.delete('/rules/:id', ({ params }) => store.deleteRule(params.id));

  // ---- ideas ----
  r.get('/ideas', () => store.listIdeas());
  r.post('/ideas/:id/dismiss', ({ params }) => store.dismissIdea(params.id));

  // ---- activity ----
  r.get('/activity', ({ query }) => store.activity(query.get('cursor')));

  // ---- settings ----
  r.get('/settings', () => store.settings());
  r.patch('/settings', ({ body }) => {
    const patch = validateSettings(body ?? {});
    const before = store.settings();
    const next = store.updateSettings(patch);
    if (patch.agentName) store.patchConversation(store.mainConversation().id, { title: patch.agentName });
    if (patch.timezone && patch.timezone !== before.timezone) {
      // Wall-clock schedules move with the person's time zone.
      for (const t of store.listTasks(['scheduled'])) store.patchTask(t.id, { nextRunAt: runtime.nextRunAt({ ...t, lastRunAt: undefined }, new Date()) });
    }
    return next;
  });
}

function validateSettings(b: Record<string, unknown>): Partial<Settings> {
  const p: Partial<Settings> = {};
  if (b.userName !== undefined) p.userName = text(b.userName, 'userName', 80);
  if (b.agentName !== undefined) p.agentName = text(b.agentName, 'agentName', 40);
  if (b.avatar !== undefined) {
    const a = b.avatar as Record<string, unknown>;
    if (!a || typeof a !== 'object') throw badRequest('avatar must be an object');
    p.avatar = { character: oneOf(a.character, CHARACTERS, 'avatar.character'), color: oneOf(a.color, COLORS, 'avatar.color') };
  }
  if (b.tone !== undefined) p.tone = oneOf(b.tone, TONES, 'tone');
  if (b.autonomy !== undefined) p.autonomy = oneOf(b.autonomy, AUTONOMY, 'autonomy');
  if (b.timezone !== undefined) {
    if (typeof b.timezone !== 'string' || !validTimeZone(b.timezone)) throw badRequest('timezone must be an IANA time zone like Europe/Lisbon');
    p.timezone = b.timezone;
  }
  if (b.briefingTime !== undefined) p.briefingTime = b.briefingTime === null ? null : hhmm(b.briefingTime, 'briefingTime');
  if (b.proactiveResearch !== undefined) p.proactiveResearch = boolean(b.proactiveResearch, 'proactiveResearch');
  if (b.quietHours !== undefined) {
    const q = b.quietHours as Record<string, unknown>;
    if (!q || typeof q !== 'object') throw badRequest('quietHours must be an object');
    p.quietHours = { enabled: boolean(q.enabled, 'quietHours.enabled'), start: hhmm(q.start, 'quietHours.start'), end: hhmm(q.end, 'quietHours.end') };
  }
  if (b.channels !== undefined) {
    const c = b.channels as Record<string, unknown>;
    if (!c || typeof c !== 'object') throw badRequest('channels must be an object');
    p.channels = {
      web: boolean(c.web, 'channels.web'), email: boolean(c.email, 'channels.email'), push: boolean(c.push, 'channels.push'),
      slack: boolean(c.slack, 'channels.slack'), telegram: boolean(c.telegram, 'channels.telegram'),
    };
  }
  return p;
}
