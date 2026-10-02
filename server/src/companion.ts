import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Config } from './config.ts';
import type { Providers } from './connections/providers.ts';
import type { Store } from './store.ts';
import type { CompanionAllow, Connection, CompanionDevice, CompanionPairing } from './types.ts';
import { ApiError, badRequest, firstLine, iso, notFound, uid } from './util.ts';

export const COMPANION_PATH = '/api/v1/companion/socket';
const PAIR_MS = 10 * 60_000;
/** How long a Star waits for the computer, including the person confirming on it. */
const CALL_TIMEOUT_MS = 3 * 60_000;
const MAX_MESSAGE = 2 * 1024 * 1024;
const MAX_MISSES = 5;

export type CompanionAction = 'open_url' | 'list_files' | 'read_file' | 'write_file' | 'run';

interface Pending {
  deviceId: string;
  resolve: (out: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * The person's own computer, through the Sky companion (companion/sky-companion.mjs).
 * The companion dials in over a WebSocket, so the computer needs no open port.
 * It pairs once with a one-time code from the app and then keeps a token.
 *
 * What Stars can do there is limited three times over:
 *  - the companion's own allowlist (folders, programs, opening pages), which
 *    only the person can change, on that computer;
 *  - two on/off switches: one in the app, one in the companion (press o);
 *  - every action is an approval in Sky, and by default the companion also
 *    asks on the computer before doing it.
 * The server checks the allowlist too, for clear errors, but the companion's
 * check is the one that counts.
 */
export class Companion {
  store: Store;
  config: Config;
  providers: Providers;
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  private sockets = new Map<string, WebSocket>();
  private pending = new Map<string, Pending>();

  constructor(store: Store, config: Config, providers: Providers) {
    this.store = store;
    this.config = config;
    this.providers = providers;
    // Nothing is connected after a restart until the companion dials back in.
    for (const d of this.devices()) if (d.connected) this.put({ ...d, connected: false });
    this.syncConnection();
  }

  devices(): CompanionDevice[] {
    return this.store.db.all<CompanionDevice>('device');
  }

  get(id: string): CompanionDevice {
    const d = this.store.db.get<CompanionDevice>('device', id);
    if (!d) throw notFound('Computer', id);
    return d;
  }

  /** A one-time code for `node sky-companion.mjs pair <server> <code>`. */
  pair(): CompanionPairing {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('');
    const expiresAt = iso(Date.now() + PAIR_MS);
    this.store.db.setKv('companionPair', { hash: hash(code), expiresAt });
    return { code, expiresAt, command: `node sky-companion.mjs pair ${this.config.publicUrl} ${code}` };
  }

  patch(id: string, input: { enabled?: unknown; name?: unknown }): CompanionDevice {
    const d = this.get(id);
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw badRequest('enabled must be true or false');
    if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim())) throw badRequest('name must be text');
    const next = this.put({
      ...d,
      ...(input.enabled !== undefined ? { enabled: input.enabled as boolean } : {}),
      ...(input.name !== undefined ? { name: firstLine(String(input.name).trim(), 60) } : {}),
    });
    this.send(id, { type: 'switch', enabled: next.enabled });
    if (input.enabled !== undefined) this.store.log('message', `Stars ${next.enabled ? 'may now use' : 'can no longer use'} ${next.name}`);
    return next;
  }

  /** Unpairs a computer: its token stops working. */
  remove(id: string) {
    const d = this.get(id);
    this.send(id, { type: 'unpaired' });
    this.sockets.get(id)?.close(4001, 'unpaired');
    this.sockets.delete(id);
    this.store.db.delete('device', d.id);
    this.store.bus.emit({ type: 'companion.deleted', data: { id } });
    this.syncConnection();
  }

  /** The computer a Star should use: the one named, or the only usable one. */
  pick(name?: string): CompanionDevice {
    const usable = this.devices().filter((d) => d.connected);
    const d = name ? usable.find((x) => x.name.toLowerCase() === name.trim().toLowerCase() || x.id === name) : usable.length === 1 ? usable[0] : undefined;
    if (!d) {
      throw new Error(usable.length ? `Say which computer: ${usable.map((x) => x.name).join(', ')}.` : 'No computer is connected. The person runs the Sky companion on their computer to connect it.');
    }
    if (!d.enabled) throw new Error(`Using ${d.name} is switched off in Sky.`);
    if (!d.localEnabled) throw new Error(`Using ${d.name} is switched off on the computer itself.`);
    return d;
  }

  /** Runs one action on the computer and returns its output. */
  async call(device: CompanionDevice, action: CompanionAction, args: Record<string, unknown>, meta: { star: string; why: string }): Promise<string> {
    const ws = this.sockets.get(device.id);
    if (!ws) throw new Error(`${device.name} isn’t connected right now.`);
    const id = uid('call');
    const out = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${device.name} didn’t answer within ${CALL_TIMEOUT_MS / 60_000} minutes (it may be waiting for the person to confirm).`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { deviceId: device.id, resolve, reject, timer });
    });
    ws.send(JSON.stringify({ type: 'call', id, action, args, star: meta.star, why: firstLine(meta.why, 200) }));
    return out;
  }

  /** Hooks the WebSocket endpoint into the HTTP server. */
  attach(server: Server) {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (new URL(req.url ?? '/', 'http://local').pathname !== COMPANION_PATH) return;
      // The companion is a program, not a web page: a browser tab (which always sends Origin) can't dial in.
      if (req.headers.origin) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
    });
  }

  close() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Sky is shutting down.'));
    }
    this.pending.clear();
    for (const ws of this.sockets.values()) ws.terminate();
    this.sockets.clear();
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }

  // ---- the socket ------------------------------------------------------------

  private accept(ws: WebSocket) {
    let deviceId: string | null = null;
    // The first message must pair or say hello, quickly.
    const deadline = setTimeout(() => ws.close(4000, 'say hello first'), 10_000);
    ws.on('message', (raw) => {
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return ws.close(4000, 'bad message');
      }
      if (!deviceId) {
        clearTimeout(deadline);
        try {
          deviceId = msg.type === 'pair' ? this.claim(ws, msg) : msg.type === 'hello' ? this.hello(ws, msg) : null;
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: (err as Error).message }));
          return ws.close(4003, 'refused');
        }
        if (!deviceId) ws.close(4000, 'say hello first');
        return;
      }
      if (msg.type === 'result') this.result(msg);
      else if (msg.type === 'state') this.state(deviceId, msg);
    });
    ws.on('close', () => {
      clearTimeout(deadline);
      if (!deviceId || this.sockets.get(deviceId) !== ws) return;
      this.sockets.delete(deviceId);
      for (const [id, p] of this.pending) {
        if (p.deviceId !== deviceId) continue;
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new Error('The computer disconnected before it finished.'));
      }
      const d = this.store.db.get<CompanionDevice>('device', deviceId);
      if (d) this.put({ ...d, connected: false, lastSeenAt: iso() });
    });
    ws.on('error', () => ws.terminate());
  }

  /** A new computer pairs with a one-time code and gets its token. */
  private claim(ws: WebSocket, msg: Record<string, any>): string {
    const pending = this.store.db.getKv<{ hash: string; expiresAt: string; misses?: number }>('companionPair');
    const code = String(msg.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!pending || pending.hash !== hash(code) || Date.parse(pending.expiresAt) < Date.now()) {
      // A few wrong guesses use the code up, so it can't be guessed.
      if (pending) {
        const misses = (pending.misses ?? 0) + 1;
        this.store.db.setKv('companionPair', misses >= MAX_MISSES ? undefined : { ...pending, misses });
      }
      throw new ApiError(403, 'bad_code', 'That pairing code is wrong or expired. Make a new one in Sky (Settings → Your computer).');
    }
    this.store.db.setKv('companionPair', undefined);
    const token = randomBytes(32).toString('base64url');
    const device: CompanionDevice = {
      id: uid('dev'), name: deviceName(msg.device?.name), platform: firstLine(String(msg.device?.platform ?? 'unknown'), 30),
      enabled: true, localEnabled: true, connected: true, allow: allowList(msg.allow), confirmLocally: msg.confirmLocally !== false,
      pairedAt: iso(), lastSeenAt: iso(),
    };
    this.store.db.put('device', device);
    this.store.db.setPrivate('device', device.id, { tokenHash: hash(token) });
    this.connected(device.id, ws);
    ws.send(JSON.stringify({ type: 'paired', token, deviceId: device.id, enabled: true }));
    this.store.log('message', `${device.name} is connected to Sky`);
    this.put(device);
    return device.id;
  }

  /** A paired computer dials back in with its token. */
  private hello(ws: WebSocket, msg: Record<string, any>): string {
    const device = this.store.db.get<CompanionDevice>('device', String(msg.deviceId ?? ''));
    const saved = device && this.store.db.getPrivate<{ tokenHash: string }>('device', device.id);
    if (!device || !saved || typeof msg.token !== 'string' || saved.tokenHash !== hash(msg.token)) {
      throw new ApiError(403, 'unknown_device', 'This computer isn’t paired with Sky any more. Pair it again with a new code.');
    }
    this.connected(device.id, ws);
    this.put({
      ...device, connected: true, lastSeenAt: iso(), allow: allowList(msg.allow), localEnabled: msg.enabled !== false,
      confirmLocally: msg.confirmLocally !== false, platform: firstLine(String(msg.device?.platform ?? device.platform), 30),
    });
    ws.send(JSON.stringify({ type: 'ready', deviceId: device.id, enabled: device.enabled }));
    return device.id;
  }

  private connected(id: string, ws: WebSocket) {
    const old = this.sockets.get(id);
    if (old && old !== ws) old.close(4002, 'replaced by a newer connection');
    this.sockets.set(id, ws);
  }

  /** The companion's own switch or allowlist changed. */
  private state(id: string, msg: Record<string, any>) {
    const d = this.store.db.get<CompanionDevice>('device', id);
    if (!d) return;
    const next = this.put({ ...d, localEnabled: msg.enabled !== false, allow: msg.allow ? allowList(msg.allow) : d.allow, lastSeenAt: iso() });
    if (d.localEnabled !== next.localEnabled) this.store.log('message', `${d.name} was switched ${next.localEnabled ? 'on' : 'off'} on the computer`);
  }

  private result(msg: Record<string, any>) {
    const p = this.pending.get(String(msg.id));
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(String(msg.id));
    if (msg.ok) p.resolve(String(msg.output ?? ''));
    else p.reject(new Error(String(msg.error ?? 'The computer refused.')));
  }

  private send(id: string, msg: unknown) {
    const ws = this.sockets.get(id);
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private put(d: CompanionDevice): CompanionDevice {
    this.store.db.put('device', d);
    this.store.bus.emit({ type: 'companion.updated', data: d });
    this.syncConnection();
    return d;
  }

  /** The "Your computer" connection is connected while some computer can be used. */
  private syncConnection() {
    const conn = this.store.db.get<Connection>('connection', 'computer');
    if (!conn) return;
    const on = this.devices().some((d) => d.connected && d.enabled && d.localEnabled);
    if (on && conn.status !== 'connected') this.providers.markConnected('computer');
    else if (!on && conn.status === 'connected') this.store.putConnection({ ...conn, status: 'disconnected' });
  }
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

function deviceName(v: unknown): string {
  return typeof v === 'string' && v.trim() ? firstLine(v.trim(), 60) : 'My computer';
}

/** The allowlist as the companion reports it, cleaned up. */
function allowList(v: unknown): CompanionAllow {
  const a = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length < 500).slice(0, 50) : []);
  return { folders: strings(a.folders), commands: strings(a.commands), openUrls: a.openUrls === true };
}
