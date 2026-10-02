import type { AddressInfo } from 'node:net';
import { loadConfig, type Config } from '../src/config.ts';
import { createApp, type App } from '../src/main.ts';
import type { LiveEvent } from '../src/types.ts';

export interface TestServer {
  app: App;
  base: string;
  call<T = any>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T; headers: Headers }>;
  events: LiveEvent[];
  waitFor<T extends LiveEvent['type']>(type: T, pred?: (e: Extract<LiveEvent, { type: T }>) => boolean, ms?: number): Promise<Extract<LiveEvent, { type: T }>>;
  close(): Promise<void>;
}

/** Starts a server on a random port with an in-memory database and the scripted brain. */
export async function startServer(overrides: Partial<Config> = {}, env: NodeJS.ProcessEnv = {}): Promise<TestServer> {
  const config = loadConfig({ SKYS_USER_NAME: 'd', ...env }, { dbPath: ':memory:', brain: 'scripted', tickMs: 60_000, webDist: '/nonexistent', ...overrides });
  const app = createApp(config);
  app.store.updateSettings({ timezone: 'UTC', briefingTime: null, quietHours: { enabled: false, start: '22:00', end: '07:00' } });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/v1`;
  const events: LiveEvent[] = [];
  const waiters = new Set<() => void>();
  const unsubscribe = app.store.bus.subscribe((e) => {
    events.push(e);
    for (const w of [...waiters]) w();
  });

  return {
    app, base, events,
    async call(method, path, body, headers = {}) {
      const res = await fetch(base + path, {
        method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
    },
    waitFor(type, pred = () => true, ms = 3000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const hit = events.find((e) => e.type === type && pred(e as never));
          if (hit) {
            waiters.delete(check);
            clearTimeout(timer);
            resolve(hit as never);
          }
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`Timed out waiting for ${type}`));
        }, ms);
        waiters.add(check);
        check();
      });
    },
    async close() {
      unsubscribe();
      await app.close();
    },
  };
}

const HOSTS: Record<string, string> = {
  gmail: 'gmail.googleapis.com', calendar: 'googleapis.com/calendar', drive: 'googleapis.com/drive',
  github: 'api.github.com', notion: 'api.notion.com', slack: 'slack.com',
};

/** Marks an app as connected with a fake token, and answers its API calls with `handler`. */
export function fakeConnection(s: TestServer, id: string, handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  s.app.store.putConnection({ ...s.app.store.getConnection(id), status: 'connected', access: 'read_write' });
  s.app.store.db.setPrivate('connection', id, { accessToken: 'test-token' });
  const previous = s.app.providers.fetch;
  s.app.providers.fetch = async (input, init = {}) => {
    const url = String(input);
    if (!url.includes(HOSTS[id] ?? id)) return previous(input, init);
    calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = handler(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

export const decodeRaw = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');
