import type { SkysApi } from './client';
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

/** Talks to the Skys back end over the contract in docs/API.md. */
export function createHttpApi(baseUrl: string): SkysApi {
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

  return {
    getStatus: () => call('GET', '/status'),
    setPaused: (paused) => call('POST', '/status', { paused }),
    getBriefing: () => call('GET', '/briefing'),

    listTasks: (filter) => call('GET', '/tasks' + qs({ status: filter?.status?.join(',') })),
    getTask: (id) => call('GET', `/tasks/${id}`),
    createTask: (input) => call('POST', '/tasks', input),
    commandTask: (id, command) => call('POST', `/tasks/${id}/${command}`),

    listApprovals: (status) => call('GET', '/approvals' + qs({ status })),
    decideApproval: (id, decision) => call('POST', `/approvals/${id}/decision`, decision),

    listConversations: () => call('GET', '/conversations'),
    createConversation: () => call('POST', '/conversations', {}),
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

    listRules: () => call('GET', '/rules'),
    addRule: (text) => call('POST', '/rules', { text }),
    updateRule: (id, patch) => call('PATCH', `/rules/${id}`, patch),
    deleteRule: (id) => call('DELETE', `/rules/${id}`),

    listActivity: (cursor) => call('GET', '/activity' + qs({ cursor })),

    getSettings: () => call('GET', '/settings'),
    updateSettings: (patch) => call('PATCH', '/settings', patch),

    subscribe(handler) {
      const source = new EventSource(root + '/events', { withCredentials: true });
      const listeners = LIVE_EVENT_TYPES.map((type) => {
        const fn = (e: MessageEvent) => handler({ type, data: JSON.parse(e.data) } as LiveEvent);
        source.addEventListener(type, fn);
        return [type, fn] as const;
      });
      return () => {
        for (const [type, fn] of listeners) source.removeEventListener(type, fn);
        source.close();
      };
    },
  };
}
