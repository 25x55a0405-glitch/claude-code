import type { SkyApi } from './client';
import type { LiveEvent, LiveEventType } from './types';

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
  'star.updated',
  'star.deleted',
  'constellation.message',
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

    listStars: () => call('GET', '/stars'),
    createStar: (input) => call('POST', '/stars', input),
    updateStar: (id, patch) => call('PATCH', `/stars/${id}`, patch),
    deleteStar: (id) => call('DELETE', `/stars/${id}`),
    pauseStar: (id, paused) => call('POST', `/stars/${id}/pause`, { paused }),
    listConstellationMessages: (starId) => call('GET', '/constellation/messages' + qs({ starId })),

    listTasks: (filter) => call('GET', '/tasks' + qs({ status: filter?.status?.join(','), starId: filter?.starId })),
    getTask: (id) => call('GET', `/tasks/${id}`),
    createTask: (input) => call('POST', '/tasks', input),
    commandTask: (id, command) => call('POST', `/tasks/${id}/${command}`),

    listApprovals: (status) => call('GET', '/approvals' + qs({ status })),
    decideApproval: (id, decision) => call('POST', `/approvals/${id}/decision`, decision),

    listConversations: () => call('GET', '/conversations'),
    createConversation: (starId) => call('POST', '/conversations', starId ? { starId } : {}),
    listMessages: (id) => call('GET', `/conversations/${id}/messages`),
    sendMessage: (id, content) => call('POST', `/conversations/${id}/messages`, { content }),

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

    getSettings: () => call('GET', '/settings'),
    updateSettings: (patch) => call('PATCH', '/settings', patch),

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
