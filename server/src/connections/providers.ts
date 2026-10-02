import { randomBytes } from 'node:crypto';
import type { Config } from '../config.ts';
import type { Store } from '../store.ts';
import type { Connection } from '../types.ts';
import { ApiError, iso } from '../util.ts';

/** Server-only credentials for a connection, stored beside it and never returned by the API. */
export interface Credentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  extra?: Record<string, string>;
}

interface OAuthSpec {
  client: 'google' | 'github' | 'notion' | 'slack';
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Extra query params on the authorize URL. */
  params?: Record<string, string>;
  /** Notion wants the client credentials as HTTP Basic auth. */
  basicAuth?: boolean;
}

const GOOGLE = { authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', params: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' } };

const OAUTH: Record<string, OAuthSpec> = {
  gmail: { client: 'google', ...GOOGLE, scopes: ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.send'] },
  calendar: { client: 'google', ...GOOGLE, scopes: ['https://www.googleapis.com/auth/calendar'] },
  drive: { client: 'google', ...GOOGLE, scopes: ['https://www.googleapis.com/auth/drive.readonly'] },
  github: { client: 'github', authorizeUrl: 'https://github.com/login/oauth/authorize', tokenUrl: 'https://github.com/login/oauth/access_token', scopes: ['repo', 'notifications', 'read:user'] },
  notion: { client: 'notion', authorizeUrl: 'https://api.notion.com/v1/oauth/authorize', tokenUrl: 'https://api.notion.com/v1/oauth/token', scopes: [], params: { owner: 'user' }, basicAuth: true },
  slack: { client: 'slack', authorizeUrl: 'https://slack.com/oauth/v2/authorize', tokenUrl: 'https://slack.com/api/oauth.v2.access', scopes: ['chat:write', 'channels:read', 'channels:history'] },
};

/** A failed call to a connected app, reported back to the model as a tool error. */
export class ConnectionError extends Error {}

/**
 * Connecting, authorizing and calling the apps Skys works with. OAuth
 * providers need client credentials in the environment (see server/README.md);
 * GitHub can also use a personal token and Telegram a bot token.
 */
export class Providers {
  store: Store;
  config: Config;
  /** Swappable for tests. */
  fetch: typeof fetch = (...args) => fetch(...args);

  constructor(store: Store, config: Config) {
    this.store = store;
    this.config = config;
  }

  get redirectUri() {
    return `${this.config.publicUrl}/api/v1/oauth/callback`;
  }

  credentials(id: string): Credentials | undefined {
    return this.store.db.getPrivate<Credentials>('connection', id);
  }

  isUsable(id: string): boolean {
    const c = this.store.db.get<Connection>('connection', id);
    return c?.status === 'connected';
  }

  /** Starts connecting. Returns an authorize URL for OAuth, or null when connected directly. */
  connect(id: string): { authorizeUrl: string | null; connection: Connection } {
    const conn = this.store.getConnection(id);
    if (id === 'web') return { authorizeUrl: null, connection: this.markConnected(id) };
    if (id === 'github' && this.config.providers.githubToken) {
      this.store.db.setPrivate('connection', id, { accessToken: this.config.providers.githubToken } satisfies Credentials);
      return { authorizeUrl: null, connection: this.markConnected(id) };
    }
    if (id === 'telegram') {
      const tg = this.config.providers.telegram;
      if (!tg) throw new ApiError(400, 'not_configured', 'Telegram isn’t set up on the server yet. Add SKYS_TELEGRAM_BOT_TOKEN and SKYS_TELEGRAM_CHAT_ID.');
      this.store.db.setPrivate('connection', id, { accessToken: tg.botToken, extra: { chatId: tg.chatId } } satisfies Credentials);
      return { authorizeUrl: null, connection: this.markConnected(id) };
    }
    const spec = OAUTH[id];
    const client = spec && this.config.providers[spec.client];
    if (!spec || !client) {
      const env = spec ? `${spec.client.toUpperCase()}_CLIENT_ID and ${spec.client.toUpperCase()}_CLIENT_SECRET` : 'its credentials';
      throw new ApiError(400, 'not_configured', `${conn.name} isn’t set up on the server yet. Add ${env} to the server’s environment.`);
    }
    const state = randomBytes(16).toString('base64url');
    this.store.db.setKv(`oauth:${state}`, { id, at: Date.now() });
    const url = new URL(spec.authorizeUrl);
    url.searchParams.set('client_id', client.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    if (spec.scopes.length) url.searchParams.set('scope', spec.scopes.join(spec.client === 'slack' ? ',' : ' '));
    for (const [k, v] of Object.entries(spec.params ?? {})) url.searchParams.set(k, v);
    return { authorizeUrl: url.toString(), connection: conn };
  }

  /** Finishes OAuth: exchanges the code and stores the tokens. Returns the connection id. */
  async callback(code: string, state: string): Promise<string> {
    const pending = this.store.db.getKv<{ id: string; at: number }>(`oauth:${state}`);
    this.store.db.sql.prepare('DELETE FROM kv WHERE key = ?').run(`oauth:${state}`);
    if (!pending || Date.now() - pending.at > 15 * 60_000) throw new ApiError(400, 'bad_state', 'That sign-in link expired. Try connecting again.');
    const spec = OAUTH[pending.id];
    const client = this.config.providers[spec.client]!;
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri });
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' };
    if (spec.basicAuth) headers.Authorization = `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`;
    else { body.set('client_id', client.clientId); body.set('client_secret', client.clientSecret); }
    const res = await this.fetch(spec.tokenUrl, { method: 'POST', headers, body });
    const json = (await res.json().catch(() => ({}))) as Record<string, any>;
    const accessToken = json.access_token ?? json.authed_user?.access_token;
    if (!res.ok || !accessToken) throw new ApiError(502, 'oauth_failed', `Couldn’t finish connecting: ${json.error_description ?? json.error ?? res.statusText}`);
    this.store.db.setPrivate('connection', pending.id, {
      accessToken,
      refreshToken: json.refresh_token,
      expiresAt: json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : undefined,
    } satisfies Credentials);
    this.markConnected(pending.id);
    return pending.id;
  }

  disconnect(id: string): Connection {
    const conn = this.store.getConnection(id);
    this.store.db.setPrivate('connection', id, undefined);
    return this.store.putConnection({ ...conn, status: 'disconnected' });
  }

  private markConnected(id: string): Connection {
    const conn = this.store.putConnection({ ...this.store.getConnection(id), status: 'connected', lastSyncAt: iso() });
    // Tasks that were blocked on this connection can carry on.
    for (const t of this.store.listTasks(['blocked'])) {
      if (!t.connectionIds.includes(id)) continue;
      this.store.patchTask(t.id, { status: t.kind === 'one_off' ? 'active' : 'scheduled' });
      this.store.addStep(t.id, { kind: 'note', summary: `${conn.name} reconnected, carrying on`, connectionId: id });
    }
    return conn;
  }

  /** A token stopped working: mark it expired and block the tasks that depend on it. */
  markExpired(id: string) {
    const conn = this.store.getConnection(id);
    if (conn.status === 'expired') return;
    this.store.putConnection({ ...conn, status: 'expired' });
    for (const t of this.store.listTasks()) {
      if (!t.connectionIds.includes(id) || ['done', 'failed', 'paused'].includes(t.status)) continue;
      this.store.patchTask(t.id, { status: 'blocked', lastOutcome: `Waiting for you to reconnect ${conn.name}` });
      this.store.addStep(t.id, { kind: 'error', summary: `${conn.name} access expired. Reconnect it to continue.`, connectionId: id });
    }
  }

  private async token(id: string): Promise<Credentials> {
    const creds = this.credentials(id);
    if (!creds || !this.isUsable(id)) throw new ConnectionError(`${id} is not connected`);
    if (creds.expiresAt && creds.expiresAt - 60_000 < Date.now() && creds.refreshToken) {
      const spec = OAUTH[id];
      const client = spec && this.config.providers[spec.client];
      if (!client) throw new ConnectionError(`${id} can’t refresh its token`);
      const res = await this.fetch(spec.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: creds.refreshToken, client_id: client.clientId, client_secret: client.clientSecret }),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, any>;
      if (!res.ok || !json.access_token) {
        this.markExpired(id);
        throw new ConnectionError(`${id} access expired`);
      }
      const next = { ...creds, accessToken: json.access_token, expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000 };
      this.store.db.setPrivate('connection', id, next);
      return next;
    }
    return creds;
  }

  /** Calls a connected app's API as the user. Expired tokens block dependent tasks. */
  async api<T = any>(id: string, url: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; raw?: boolean } = {}): Promise<T> {
    const creds = await this.token(id);
    const headers: Record<string, string> = { Authorization: `Bearer ${creds.accessToken}`, Accept: 'application/json', ...init.headers };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers['Content-Type'] ??= 'application/json';
      body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
    }
    const res = await this.fetch(url, { method: init.method ?? 'GET', headers, body });
    if (res.status === 401) {
      this.markExpired(id);
      throw new ConnectionError(`${this.store.getConnection(id).name} access expired`);
    }
    const text = await res.text();
    if (!res.ok) throw new ConnectionError(`${id} API ${res.status}: ${text.slice(0, 300)}`);
    this.store.putConnection({ ...this.store.getConnection(id), lastSyncAt: iso() });
    if (init.raw) return text as T;
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      return text as T;
    }
  }
}
