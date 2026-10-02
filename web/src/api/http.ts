import type { SkyApi } from './client';
import type { AvatarCharacter, AvatarColor, LiveEvent, LiveEventType, Settings, StarView } from './types';

const LIVE_EVENT_TYPES: LiveEventType[] = [
  'status',
  'task.updated',
  'task.step',
  'approval.created',
  'approval.updated',
  'message.delta',
  'message.done',
  'activity',
  'memory.learned',
  'idea.created',
  'settings.updated',
  'provider.updated',
  'provider.deleted',
  'browser.frame',
  'star.updated',
  'star.deleted',
  'constellation.message',
  'star.activity',
  'skill.updated',
  'skill.deleted',
  'lesson.learned',
  'lesson.undone',
  'mcp.updated',
  'mcp.deleted',
  'messaging.updated',
  'browser.control',
  'recording.updated',
  'workspace.changed',
  'companion.updated',
  'companion.deleted',
];

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Fired on window whenever the server says the session is missing or expired. */
export const UNAUTHORIZED_EVENT = 'sky:unauthorized';

/**
 * The server's list of characters is cloud, dot and drop. The star characters are
 * newer: asked to save one, the server may refuse, so the app keeps that choice
 * in this browser and sends the closest plain shape instead. Once the server
 * takes the new names, they go through as they are and nothing is kept here.
 */
const LOOKS_KEY = 'sky.looks';
const PLAIN: AvatarCharacter[] = ['cloud', 'dot', 'drop'];
const looks = (): Record<string, AvatarCharacter> => { try { return JSON.parse(localStorage.getItem(LOOKS_KEY) || '{}'); } catch { return {}; } };
const remember = (key: string, c?: AvatarCharacter) => {
  try {
    const all = looks();
    if (c) all[key] = c; else delete all[key];
    localStorage.setItem(LOOKS_KEY, JSON.stringify(all));
  } catch { /* private window: the star falls back to a plain shape */ }
};
const dressStar = <T extends StarView>(s: T): T => { const c = looks()[`star:${s.id}`]; return c ? { ...s, avatar: { ...s.avatar, character: c } } : s; };
const dressSettings = (s: Settings): Settings => { const c = looks().settings; return c ? { ...s, avatar: { ...s.avatar, character: c } } : s; };
let serverTakesStars: boolean | null = null;

/** Send a write that carries an avatar; fall back to a plain shape if the server won't take a star one. */
async function sendLook<I extends { avatar?: { character: AvatarCharacter; color: AvatarColor } }, R>(input: I, send: (i: I) => Promise<R>): Promise<{ res: R; kept?: AvatarCharacter }> {
  const c = input.avatar?.character;
  if (!c || PLAIN.includes(c) || serverTakesStars === true) return { res: await send(input) };
  if (serverTakesStars !== false) {
    try { const res = await send(input); serverTakesStars = true; return { res }; } catch (e) {
      if (!(e instanceof HttpError && e.status === 400 && /avatar|character/i.test(`${e.code} ${e.message}`))) throw e;
      serverTakesStars = false;
    }
  }
  return { res: await send({ ...input, avatar: { ...input.avatar!, character: 'dot' } }), kept: c };
}

/** Talks to the Sky back end over the contract in docs/API.md. */
export function createHttpApi(baseUrl: string): SkyApi {
  const root = baseUrl.replace(/\/$/, '') + '/api/v1';

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(root + path, {
      method,
      credentials: 'include',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 401 && path !== '/session') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
      throw new HttpError(res.status, json?.error?.code ?? 'unknown', json?.error?.message ?? res.statusText);
    }
    return json as T;
  }

  const qs = (params: Record<string, string | undefined | null>) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) s.set(k, v);
    const str = s.toString();
    return str ? `?${str}` : '';
  };

  // One EventSource for the whole app, shared by every subscriber. Browsers
  // allow about six connections per host, and each open stream holds one.
  const handlers = new Set<(e: LiveEvent) => void>();
  let source: EventSource | null = null;
  const openStream = () => {
    source = new EventSource(root + '/events', { withCredentials: true });
    for (const type of LIVE_EVENT_TYPES) {
      source.addEventListener(type, (e) => {
        const event = { type, data: JSON.parse((e as MessageEvent).data) } as LiveEvent;
        if (event.type === 'star.updated') event.data = dressStar(event.data);
        else if (event.type === 'settings.updated') event.data = dressSettings(event.data);
        for (const h of [...handlers]) h(event);
      });
    }
  };
  const closeStream = () => {
    source?.close();
    source = null;
  };

  return {
    getSession: () => call('GET', '/session'),
    signIn: async (password) => {
      await call('POST', '/session', { password });
      // Reconnect so the stream carries the new session cookie.
      if (source) { closeStream(); openStream(); }
    },
    signOut: async () => {
      await call('DELETE', '/session');
      closeStream();
    },

    getStatus: () => call('GET', '/status'),
    setPaused: (paused) => call('POST', '/status', { paused }),
    getBriefing: () => call('GET', '/briefing'),

    listStars: async () => (await call<StarView[]>('GET', '/stars')).map(dressStar),
    createStar: async (input) => {
      const { res, kept } = await sendLook(input, (i) => call<StarView>('POST', '/stars', i));
      remember(`star:${res.id}`, kept);
      return dressStar(res);
    },
    updateStar: async (id, patch) => {
      const { res, kept } = await sendLook(patch, (i) => call<StarView>('PATCH', `/stars/${id}`, i));
      if (patch.avatar) remember(`star:${id}`, kept);
      return dressStar(res);
    },
    deleteStar: async (id) => { await call('DELETE', `/stars/${id}`); remember(`star:${id}`); },
    pauseStar: (id, paused) => call('POST', `/stars/${id}/pause`, { paused }),
    listConstellationMessages: (starId) => call('GET', '/constellation/messages' + qs({ starId })),

    listProviders: () => call('GET', '/providers'),
    listProviderPresets: () => call('GET', '/providers/presets'),
    createProvider: (input) => call('POST', '/providers', input),
    updateProvider: (id, patch) => call('PATCH', `/providers/${id}`, patch),
    deleteProvider: (id) => call('DELETE', `/providers/${id}`),
    testProvider: (id) => call('POST', `/providers/${id}/test`),
    setProviderOrder: async (ids) => (await call<{ providerIds: string[] }>('PUT', '/providers/order', { providerIds: ids })).providerIds,

    getBrowser: () => call('GET', '/browser'),
    browserFrameUrl: (starId, frameId) => `${root}/browser/${encodeURIComponent(starId)}/screenshot${frameId ? `?f=${encodeURIComponent(frameId)}` : ''}`,
    browserInput: (starId, input) => call('POST', `/browser/${encodeURIComponent(starId)}/input`, input),
    closeBrowserTab: (starId) => call('POST', `/browser/${encodeURIComponent(starId)}/close`),
    takeOverBrowser: (starId, note) => call('POST', `/browser/${encodeURIComponent(starId)}/takeover`, note ? { note } : {}),
    handBackBrowser: (starId, note) => call('POST', `/browser/${encodeURIComponent(starId)}/handback`, note ? { note } : {}),

    startRecording: (starId, input) => call('POST', `/browser/${encodeURIComponent(starId)}/record`, input ?? {}),
    stopRecording: (starId) => call('POST', `/browser/${encodeURIComponent(starId)}/record/stop`),
    listRecordings: (starId) => call('GET', '/recordings' + qs({ starId })),
    getRecording: (id) => call('GET', `/recordings/${id}`),
    deleteRecording: (id) => call('DELETE', `/recordings/${id}`),
    saveRecordingAsSkill: (id, input) => call('POST', `/recordings/${id}/skill`, input),

    getWorkspace: () => call('GET', '/workspace'),
    listFiles: (starId, path, recursive) => call('GET', `/stars/${encodeURIComponent(starId)}/files` + qs({ path, recursive: recursive ? '1' : undefined })),
    fileUrl: (starId, path, download) => `${root}/stars/${encodeURIComponent(starId)}/files/content` + qs({ path, download: download ? '1' : undefined }),
    async uploadFile(starId, path, file) {
      // The raw file is the body. The server refuses text/plain and form types (a page on another
      // site could send those without asking), so plain text goes up as octet-stream.
      const own = file.type && !/^(text\/plain|application\/x-www-form-urlencoded|multipart\/form-data)\b/i.test(file.type) ? file.type : 'application/octet-stream';
      const res = await fetch(`${root}/stars/${encodeURIComponent(starId)}/files/content` + qs({ path }), { method: 'PUT', credentials: 'include', headers: { 'Content-Type': own }, body: file });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
        throw new HttpError(res.status, json?.error?.code ?? 'unknown', json?.error?.message ?? res.statusText);
      }
      return json;
    },
    deleteFile: (starId, path) => call('DELETE', `/stars/${encodeURIComponent(starId)}/files` + qs({ path })),

    getVoice: () => call('GET', '/voice'),
    setVoice: (patch) => call('PUT', '/voice', patch),
    async sendVoice(conversationId, audio) {
      const res = await fetch(`${root}/conversations/${conversationId}/voice`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': audio.type.split(';')[0] || 'audio/webm' }, body: audio });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
        throw new HttpError(res.status, json?.error?.code ?? 'unknown', json?.error?.message ?? res.statusText);
      }
      return json;
    },
    async speak(text, starId) {
      const res = await fetch(`${root}/voice/speak`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, starId }) });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new HttpError(res.status, json?.error?.code ?? 'unknown', json?.error?.message ?? res.statusText);
      }
      return res.blob();
    },

    listCompanion: () => call('GET', '/companion'),
    pairCompanion: () => call('POST', '/companion/pair'),
    updateCompanionDevice: (id, patch) => call('PATCH', `/companion/devices/${id}`, patch),
    deleteCompanionDevice: (id) => call('DELETE', `/companion/devices/${id}`),

    listLogins: () => call('GET', '/logins'),
    createLogin: (input) => call('POST', '/logins', input),
    updateLogin: (id, patch) => call('PATCH', `/logins/${id}`, patch),
    deleteLogin: (id) => call('DELETE', `/logins/${id}`),

    listSkills: (starId) => call('GET', '/skills' + qs({ starId })),
    createSkill: (input) => call('POST', '/skills', input),
    updateSkill: (id, patch) => call('PATCH', `/skills/${id}`, patch),
    deleteSkill: (id) => call('DELETE', `/skills/${id}`),
    listLessons: (starId) => call('GET', '/lessons' + qs({ starId })),
    undoLesson: (id) => call('POST', `/lessons/${id}/undo`),

    listSecrets: (starId) => call('GET', '/secrets' + qs({ starId })),
    createSecret: (input) => call('POST', '/secrets', input),
    updateSecret: (name, patch) => call('PATCH', `/secrets/${encodeURIComponent(name)}`, patch),
    deleteSecret: (name) => call('DELETE', `/secrets/${encodeURIComponent(name)}`),

    getPushKey: () => call('GET', '/push/key'),
    listPushSubscriptions: () => call('GET', '/push/subscriptions'),
    addPushSubscription: (subscription, label) => call('POST', '/push/subscriptions', { subscription, label }),
    deletePushSubscription: (id) => call('DELETE', `/push/subscriptions/${id}`),
    testPush: () => call('POST', '/push/test'),

    getTrigger: (id) => call('GET', `/tasks/${id}/trigger`),
    setTrigger: (id, trigger) => call('PUT', `/tasks/${id}/trigger`, { trigger }),
    rotateTrigger: (id) => call('POST', `/tasks/${id}/trigger/rotate`),
    listTriggerEvents: (id) => call('GET', `/tasks/${id}/events`),
    checkMail: () => call('POST', '/triggers/check-mail'),

    listMessaging: () => call('GET', '/messaging'),
    connectTelegram: (botToken) => call('POST', '/messaging/telegram', { botToken }),
    connectSlack: (botToken, appToken) => call('POST', '/messaging/slack', { botToken, appToken }),
    disconnectMessaging: (app) => call('DELETE', `/messaging/${app}`),
    newPairCode: (app) => call('POST', `/messaging/${app}/code`),
    slackManifest: async () => {
      const m = await call<unknown>('GET', '/messaging/slack/manifest');
      return typeof m === 'string' ? m : JSON.stringify(m, null, 2);
    },

    listMcp: () => call('GET', '/mcp'),
    createMcp: (input) => call('POST', '/mcp', input),
    updateMcp: (id, patch) => call('PATCH', `/mcp/${id}`, patch),
    deleteMcp: (id) => call('DELETE', `/mcp/${id}`),
    reconnectMcp: (id) => call('POST', `/mcp/${id}/reconnect`),

    createGroupChat: (starIds, title) => call('POST', '/conversations', { starIds, title }),
    updateConversation: (id, patch) => call('PATCH', `/conversations/${id}`, patch),

    listTemplates: () => call('GET', '/templates'),
    starTemplate: (id) => call('GET', `/stars/${id}/template`),
    previewTemplate: (from) => call('POST', '/templates/preview', from),
    importTemplate: (from) => call('POST', '/templates/import', from),

    listTasks: (filter) => call('GET', '/tasks' + qs({ status: filter?.status?.join(','), starId: filter?.starId })),
    getTask: (id) => call('GET', `/tasks/${id}`),
    createTask: (input) => call('POST', '/tasks', input),
    commandTask: (id, command) => call('POST', `/tasks/${id}/${command}`),

    listApprovals: (status) => call('GET', '/approvals' + qs({ status })),
    decideApproval: (id, decision) => call('POST', `/approvals/${id}/decision`, decision),

    listConversations: () => call('GET', '/conversations'),
    createConversation: (starId) => call('POST', '/conversations', starId ? { starId } : {}),
    listMessages: (id) => call('GET', `/conversations/${id}/messages`),
    sendMessage: (id, content, via) => call('POST', `/conversations/${id}/messages`, via ? { content, via } : { content }),

    listMemory: () => call('GET', '/memory'),
    addMemory: (input) => call('POST', '/memory', input),
    updateMemory: (id, patch) => call('PATCH', `/memory/${id}`, patch),
    deleteMemory: (id) => call('DELETE', `/memory/${id}`),

    listConnections: () => call('GET', '/connections'),
    updateConnection: (id, patch) => call('PATCH', `/connections/${id}`, patch),
    connect: (id) => call('POST', `/connections/${id}/connect`),
    disconnect: (id) => call('POST', `/connections/${id}/disconnect`),

    listRules: (starId) => call('GET', '/rules' + qs({ starId })),
    addRule: (text, starId) => call('POST', '/rules', starId ? { text, starId } : { text }),
    updateRule: (id, patch) => call('PATCH', `/rules/${id}`, patch),
    deleteRule: (id) => call('DELETE', `/rules/${id}`),

    listIdeas: () => call('GET', '/ideas'),
    dismissIdea: (id) => call('POST', `/ideas/${id}/dismiss`),

    listActivity: (cursor) => call('GET', '/activity' + qs({ cursor })),

    getSettings: async () => dressSettings(await call<Settings>('GET', '/settings')),
    updateSettings: async (patch) => {
      const { res, kept } = await sendLook(patch, (i) => call<Settings>('PATCH', '/settings', i));
      if (patch.avatar) remember('settings', kept);
      return dressSettings(res);
    },

    subscribe(handler) {
      handlers.add(handler);
      if (!source) openStream();
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) closeStream();
      };
    },
  };
}
