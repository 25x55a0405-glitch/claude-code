import type { Runtime } from '../agent/runtime.ts';
import { validTimeZone, parseHHMM } from '../agent/time.ts';
import type { Providers } from '../connections/providers.ts';
import type { Store } from '../store.ts';
import type { Access, ApprovalStatus, Autonomy, AvatarCharacter, AvatarColor, MemoryCategory, Message, Settings, Star, TaskStatus, Tone } from '../types.ts';
import { badRequest, firstLine, iso, uid } from '../util.ts';
import type { Router } from './router.ts';
import type { ModelRouter } from '../models/router.ts';
import { PRESETS, type ProviderInput } from '../models/registry.ts';
import type { BrowserManager, ViewInput } from '../browser/browser.ts';

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

/** Every endpoint in docs/API.md, plus the Star endpoints in docs/BACKEND.md, under /api/v1. */
export function registerRoutes(r: Router, store: Store, runtime: Runtime, providers: Providers, models: ModelRouter, browser: BrowserManager) {
  const registry = models.registry;
  /** An optional Star id from a query or body; an unknown one is a 400. */
  const starRef = (v: unknown, field = 'starId'): string | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string' || !store.findStar(v) || store.findStar(v)!.id !== v) throw badRequest(`${field} must be the id of one of your Stars`);
    return v;
  };
  const avatar = (v: unknown) => {
    const a = v as Record<string, unknown>;
    if (!a || typeof a !== 'object') throw badRequest('avatar must be an object');
    return { character: oneOf(a.character, CHARACTERS, 'avatar.character'), color: oneOf(a.color, COLORS, 'avatar.color') };
  };
  const starFields = (b: Record<string, unknown>) => {
    const p: Partial<Pick<Star, 'name' | 'role' | 'instructions' | 'avatar' | 'autonomy' | 'connectionIds' | 'providerIds'>> = {};
    if (b.name !== undefined) p.name = text(b.name, 'name', 40);
    if (b.role !== undefined) p.role = text(b.role, 'role', 200);
    if (b.instructions !== undefined) {
      if (typeof b.instructions !== 'string' || b.instructions.length > 4000) throw badRequest('instructions must be text up to 4000 characters');
      p.instructions = b.instructions.trim();
    }
    if (b.avatar !== undefined) p.avatar = avatar(b.avatar);
    if (b.autonomy !== undefined) p.autonomy = b.autonomy === null ? null : oneOf(b.autonomy, AUTONOMY, 'autonomy');
    if (b.connectionIds !== undefined) {
      const known = store.listConnections().map((c) => c.id);
      if (b.connectionIds !== null && (!Array.isArray(b.connectionIds) || b.connectionIds.some((c) => !known.includes(c)))) {
        throw badRequest(`connectionIds must be null (every app) or a list of: ${known.join(', ')}`);
      }
      p.connectionIds = b.connectionIds === null ? null : [...new Set(b.connectionIds as string[])];
    }
    if (b.providerIds !== undefined) {
      if (b.providerIds !== null && (!Array.isArray(b.providerIds) || b.providerIds.some((id) => typeof id !== 'string' || !registry.find(id)))) {
        throw badRequest('providerIds must be null (the global order) or a list of model provider ids');
      }
      p.providerIds = b.providerIds === null ? null : [...new Set(b.providerIds as string[])];
    }
    return p;
  };
  const object = (body: unknown) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Send a JSON object');
    return body as Record<string, unknown>;
  };

  // ---- model providers ----
  const providerFields = (b: Record<string, unknown>, creating: boolean): Partial<ProviderInput> => {
    const p: Partial<ProviderInput> = {};
    if (b.name !== undefined || creating) p.name = text(b.name, 'name', 60);
    if (b.kind !== undefined || creating) p.kind = oneOf(b.kind, ['anthropic', 'openai'] as const as ('anthropic' | 'openai')[], 'kind');
    if (b.baseUrl !== undefined || creating) {
      const url = text(b.baseUrl, 'baseUrl', 500);
      try {
        if (!/^https?:$/.test(new URL(url).protocol)) throw new Error();
      } catch {
        throw badRequest('baseUrl must be an http or https address, like https://openrouter.ai/api/v1');
      }
      p.baseUrl = url;
    }
    if (b.model !== undefined || creating) p.model = text(b.model, 'model', 200);
    if (b.apiKey !== undefined) {
      if (b.apiKey !== null && typeof b.apiKey !== 'string') throw badRequest('apiKey must be text, or null to remove it');
      p.apiKey = b.apiKey as string | null;
    }
    if (b.enabled !== undefined) p.enabled = boolean(b.enabled, 'enabled');
    return p;
  };
  r.get('/providers', () => registry.list());
  r.get('/providers/presets', () => PRESETS);
  r.post('/providers', ({ body }) => registry.create(providerFields(object(body), true) as ProviderInput));
  r.get('/providers/order', () => ({ providerIds: registry.order() }));
  r.put('/providers/order', ({ body }) => {
    const ids = object(body).providerIds;
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) throw badRequest('providerIds must be a list of provider ids');
    return { providerIds: registry.setOrder(ids as string[]) };
  });
  r.get('/providers/:id', ({ params }) => registry.get(params.id));
  r.patch('/providers/:id', ({ params, body }) => registry.patch(params.id, providerFields(object(body), false)));
  r.delete('/providers/:id', ({ params }) => registry.delete(params.id));
  r.post('/providers/:id/test', ({ params }) => models.test(params.id));

  // ---- the browser ----
  r.get('/browser', () => ({ ...browser.available(), sessions: browser.sessions() }));
  r.post('/browser/:starId/input', async ({ params, body }) => {
    store.getStar(params.starId);
    const b = object(body);
    const type = oneOf(b.type, ['click', 'type', 'key', 'scroll', 'navigate', 'back'], 'type');
    const num = (v: unknown, f: string) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw badRequest(`${f} must be a number`);
      return v;
    };
    const input: ViewInput = type === 'click' ? { type, x: num(b.x, 'x'), y: num(b.y, 'y') }
      : type === 'type' ? { type, text: text(b.text, 'text', 2000) }
      : type === 'key' ? { type, key: text(b.key, 'key', 40) }
      : type === 'scroll' ? { type, dy: num(b.dy, 'dy') }
      : type === 'navigate' ? { type, url: text(b.url, 'url', 2000) }
      : { type };
    return browser.input(params.starId, input);
  });
  r.post('/browser/:starId/close', async ({ params }) => { await browser.closeTab(params.starId); });

  // ---- stars and the constellation ----
  r.get('/stars', () => store.listStars().map((s) => store.starView(s)));
  r.post('/stars', ({ body }) => {
    const b = object(body);
    const f = starFields(b);
    if (!f.name) throw badRequest('name is required');
    if (!f.role) throw badRequest('role is required');
    const colors = COLORS.filter((c) => c !== 'sky');
    const star = runtime.createStar({
      name: f.name, role: f.role, instructions: f.instructions ?? '',
      avatar: f.avatar ?? { character: 'dot', color: colors[store.listStars().length % colors.length] },
      autonomy: f.autonomy ?? null, connectionIds: f.connectionIds ?? null, providerIds: f.providerIds ?? null,
    });
    return store.starView(star);
  });
  r.get('/stars/:id', ({ params }) => store.starView(store.getStar(params.id)));
  r.patch('/stars/:id', ({ params, body }) => store.starView(store.patchStar(params.id, starFields(object(body)))));
  r.delete('/stars/:id', ({ params }) => runtime.deleteStar(params.id));
  r.post('/stars/:id/pause', ({ params, body }) => store.starView(runtime.setStarPaused(params.id, boolean(body?.paused, 'paused'))));
  r.get('/constellation', () => ({ stars: store.listStars().map((s) => store.starView(s)), messages: store.teamMessages(undefined, 50) }));
  r.get('/constellation/messages', ({ query }) => store.teamMessages(starRef(query.get('starId'))));

  // ---- status and briefing ----
  r.get('/status', () => store.status());
  r.post('/status', ({ body }) => runtime.setPaused(boolean(body?.paused, 'paused')));
  r.get('/briefing', () => runtime.briefing());

  // ---- tasks ----
  r.get('/tasks', ({ query }) => {
    const raw = query.get('status');
    const statuses = raw ? raw.split(',').map((s) => oneOf(s.trim(), TASK_STATUSES, 'status')) : undefined;
    return store.listTasks(statuses, starRef(query.get('starId')));
  });
  r.get('/tasks/:id', ({ params }) => store.taskDetail(params.id));
  r.post('/tasks', ({ body }) => runtime.createTask({
    title: text(body?.title, 'title', 200),
    description: typeof body?.description === 'string' ? body.description : '',
    kind: oneOf(body?.kind, ['one_off', 'recurring', 'watch'], 'kind'),
    schedule: typeof body?.schedule === 'string' ? body.schedule : undefined,
    starId: starRef(body?.starId),
  }));
  for (const command of ['pause', 'resume', 'run_now', 'cancel'] as const) {
    r.post(`/tasks/:id/${command}`, ({ params }) => runtime.commandTask(params.id, command));
  }

  // ---- approvals ----
  r.get('/approvals', ({ query }) => {
    const s = query.get('status');
    return store.listApprovals(s ? oneOf(s, ['pending', 'approved', 'rejected', 'expired'] as ApprovalStatus[], 'status') : undefined, starRef(query.get('starId')));
  });
  r.post('/approvals/:id/decision', ({ params, body }) => runtime.decide(params.id, {
    decision: oneOf(body?.decision, ['approve', 'reject'], 'decision'),
    editedPreview: typeof body?.editedPreview === 'string' ? body.editedPreview : undefined,
    note: typeof body?.note === 'string' ? body.note : undefined,
  }));

  // ---- conversations ----
  r.get('/conversations', ({ query }) => store.listConversations(starRef(query.get('starId'))));
  r.post('/conversations', ({ body }) => store.createConversation('New chat', starRef(body?.starId)));
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
  r.get('/memory', ({ query }) => store.listMemory(starRef(query.get('starId'))));
  r.post('/memory', ({ body }) => store.addMemory(
    oneOf(body?.category, CATEGORIES, 'category'), text(body?.content, 'content', 1000), 'Added by you', false, undefined, starRef(body?.starId) ?? null,
  ));
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
  r.get('/rules', ({ query }) => store.listRules(starRef(query.get('starId'))));
  r.post('/rules', ({ body }) => store.addRule(text(body?.text, 'text', 500), starRef(body?.starId) ?? null));
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
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Send the settings to change as a JSON object');
    const patch = validateSettings(body);
    const before = store.settings();
    const next = store.updateSettings(patch);
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
