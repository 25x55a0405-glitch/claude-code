import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import type { Runtime } from '../agent/runtime.ts';
import type { Config } from '../config.ts';
import type { Providers } from '../connections/providers.ts';
import type { Store } from '../store.ts';
import { ApiError } from '../util.ts';
import { Auth } from './auth.ts';
import { loginPage } from './login.ts';
import { registerRoutes } from './routes.ts';
import type { Vault } from '../vault.ts';
import type { Push } from '../push.ts';
import type { ModelRouter } from '../models/router.ts';
import type { BrowserManager } from '../browser/browser.ts';
import { Router, type Req } from './router.ts';

const API = '/api/v1';
const MAX_BODY = 1_000_000;
const PING_MS = 25_000;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

export function createHttpServer(config: Config, store: Store, runtime: Runtime, providers: Providers, models: ModelRouter, browser: BrowserManager, vault: Vault, push: Push): Server {
  const auth = new Auth(config, store.db);
  const router = new Router();
  registerRoutes(router, store, runtime, providers, models, browser, vault, push);
  const origins = new Set((config.webOrigin ?? '').split(',').map((s) => s.trim()).filter(Boolean));

  const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    if (body === undefined || status === 204) {
      res.writeHead(status === 200 && body === undefined ? 204 : status, headers).end();
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }).end(JSON.stringify(body));
  };
  const fail = (res: ServerResponse, status: number, code: string, message: string) => send(res, status, { error: { code, message } });

  async function readBody(req: IncomingMessage): Promise<unknown> {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') return undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new ApiError(413, 'too_large', 'That request is too large');
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      throw new ApiError(400, 'bad_json', 'The request body isn’t valid JSON');
    }
  }

  function events(req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const write = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    write('status', store.status());
    const unsubscribe = store.bus.subscribe((e) => write(e.type, e.data));
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
    const close = () => {
      clearInterval(ping);
      unsubscribe();
    };
    req.on('close', close);
    res.on('error', close);
  }

  function serveStatic(path: string, res: ServerResponse): boolean {
    if (!existsSync(config.webDist)) return false;
    const root = resolve(config.webDist);
    let file = normalize(join(root, decodeURIComponent(path)));
    if (!file.startsWith(root)) return false;
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    if (!existsSync(file)) return false;
    const immutable = file.includes(`${join(root, 'assets')}`);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
    res.end(readFileSync(file));
    return true;
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://local');
    const origin = req.headers.origin;
    if (origin && origins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '600',
      }).end();
      return;
    }
    const secure = config.publicUrl.startsWith('https://');

    if (!url.pathname.startsWith(`${API}/`) && url.pathname !== API) {
      if (url.pathname === '/login') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(loginPage(store.settings().agentName, config.webUrl));
        return;
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(url.pathname, res)) return;
      fail(res, 404, 'not_found', 'Nothing here. The API lives under /api/v1.');
      return;
    }
    const path = url.pathname.slice(API.length) || '/';

    // Endpoints that work before sign-in.
    if (path === '/health' && req.method === 'GET') {
      const first = runtime.brain.name === 'scripted' ? null : models.chain()[0];
      send(res, 200, { ok: true, brain: runtime.brain.name, model: first?.model ?? null, browser: browser.available() });
      return;
    }
    if (path === '/session') {
      if (req.method === 'GET') return send(res, 200, { signedIn: auth.isSignedIn(req), authRequired: auth.enabled });
      if (req.method === 'POST') {
        const body = (await readBody(req)) as { password?: unknown } | undefined;
        if (!auth.config.password) return fail(res, 400, 'no_password', 'Sign-in isn’t turned on for this server');
        if (!auth.checkPassword(body?.password)) return fail(res, 401, 'wrong_password', 'That password didn’t match');
        return send(res, 200, { signedIn: true }, { 'Set-Cookie': auth.sessionCookie(secure) });
      }
      if (req.method === 'DELETE') return send(res, 204, undefined, { 'Set-Cookie': auth.clearCookie() });
    }
    if (!auth.isSignedIn(req)) return fail(res, 401, 'unauthorized', 'Please sign in to Sky first');

    if (path === '/events' && req.method === 'GET') return events(req, res);
    const view = /^\/browser\/([^/]+)\/(screenshot|stream)$/.exec(path);
    if (view && req.method === 'GET') {
      const starId = decodeURIComponent(view[1]);
      if (view[2] === 'screenshot') {
        const frame = browser.frame(starId);
        if (!frame) return fail(res, 404, 'not_found', 'That Star hasn’t opened anything in the browser yet');
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }).end(frame);
        return;
      }
      // A live view an <img> can show directly (MJPEG): a new frame about once a second.
      res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const stop = browser.watch(starId, (jpeg) => {
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
        res.write(jpeg);
        res.write('\r\n');
      });
      req.on('close', stop);
      return;
    }
    if (path === '/oauth/callback' && req.method === 'GET') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      try {
        if (!code || !state) throw new ApiError(400, 'bad_request', url.searchParams.get('error') ?? 'Missing code');
        await providers.callback(code, state);
      } catch (err) {
        console.error('[oauth]', err instanceof Error ? err.message : err);
      }
      res.writeHead(302, { Location: `${config.webUrl}/#/connections` }).end();
      return;
    }

    const match = router.match(req.method ?? 'GET', path);
    if (!match) return fail(res, 404, 'not_found', `No endpoint at ${req.method} ${url.pathname}`);
    if (match === 'method') return fail(res, 405, 'method_not_allowed', `${req.method} isn’t supported on ${url.pathname}`);
    const r: Req = { raw: req, res, method: req.method ?? 'GET', path, params: match.params, query: url.searchParams, body: await readBody(req) };
    const out = await match.handler(r);
    send(res, out === undefined ? 204 : 200, out);
  }

  return createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return res.end();
      if (err instanceof ApiError) return fail(res, err.status, err.code, err.message);
      console.error('[http]', err);
      fail(res, 500, 'internal', 'Something went wrong on the server');
    });
  });
}
