import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import type { Config } from '../config.ts';
import { ApiError } from '../util.ts';
import { Auth } from './auth.ts';
import { loginPage } from './login.ts';
import { RawBody, registerRoutes, type Services } from './routes.ts';
import { MAX_FILE } from '../workspace.ts';
import { Router, type Req } from './router.ts';

const API = '/api/v1';
const MAX_BODY = 1_000_000;
const PING_MS = 25_000;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

export function createHttpServer(config: Config, services: Services): Server {
  const { store, runtime, models, browser, triggers, providers } = services;
  const auth = new Auth(config, store.db);
  const router = new Router();
  registerRoutes(router, services);
  const origins = new Set((config.webOrigin ?? '').split(',').map((s) => s.trim()).filter(Boolean));

  const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    if (body === undefined || status === 204) {
      res.writeHead(status === 200 && body === undefined ? 204 : status, headers).end();
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }).end(JSON.stringify(body));
  };
  const fail = (res: ServerResponse, status: number, code: string, message: string) => send(res, status, { error: { code, message } });

  async function readRaw(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new ApiError(413, 'too_large', 'That request is too large');
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async function readRawBuffer(req: IncomingMessage, max: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > max) throw new ApiError(413, 'too_large', `Files can be up to ${Math.round(max / 1024 / 1024)} MB`);
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  async function readBody(req: IncomingMessage): Promise<unknown> {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') return undefined;
    const raw = (await readRaw(req)).trim();
    if (!raw) return undefined;
    // A page on another site can only send text/plain or form bodies without the browser asking first.
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      throw new ApiError(415, 'json_only', 'Send the body as JSON, with Content-Type: application/json');
    }
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

  // Where the web app may call from, besides this server itself.
  const trusted = new Set([...origins, originOf(config.publicUrl), originOf(config.webUrl)].filter(Boolean) as string[]);
  const localNames = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  const knownHosts = new Set([...trusted].map((o) => new URL(o).host));

  /**
   * Stops other websites from using the API through the person's browser.
   *  - Writes from a browser must come from this server's own pages or a
   *    configured web app (SKY_WEB_ORIGIN). Browsers mark every request with
   *    Sec-Fetch-Site and Origin, which pages can't fake; tools like curl send
   *    neither and are let through (they still need the password, if set).
   *  - With no password, the Host must be this machine or a configured
   *    address, so a site can't point its own name at 127.0.0.1 (DNS rebinding).
   */
  function crossSite(req: IncomingMessage): string | null {
    const host = req.headers.host ?? '';
    if (!auth.enabled && host && !localNames.has(host.replace(/:\d+$/, '')) && !knownHosts.has(host)) {
      return `Requests for ${host} aren’t accepted. Set SKY_PUBLIC_URL to the address you use for Sky.`;
    }
    if (!WRITES.has(req.method ?? '')) return null;
    const site = req.headers['sec-fetch-site'];
    if (site === 'same-origin' || site === 'none') return null;
    const origin = req.headers.origin;
    if (!origin && !site) return null;
    if (origin && origin !== 'null' && (trusted.has(origin) || origin === `http://${host}` || origin === `https://${host}`)) return null;
    return `Requests from ${origin && origin !== 'null' ? origin : 'another site'} aren’t allowed. If that’s your Sky web app, add it to SKY_WEB_ORIGIN.`;
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
    if (!/^\/hooks\//.test(path)) {
      const refused = crossSite(req);
      if (refused) return fail(res, 403, 'cross_site', refused);
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
    // Webhook triggers: the secret token in the URL is the sign-in.
    const hook = /^\/hooks\/([\w-]{16,64})$/.exec(path);
    if (hook && req.method === 'POST') {
      const out = triggers.webhook(hook[1], req.headers, await readRaw(req));
      return send(res, out.status, out.body);
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

    // Uploading into a Star's workspace: the raw file as the body (not JSON, so it can be up to 10 MB).
    const upload = /^\/stars\/([^/]+)\/files\/content$/.exec(path);
    if (upload && req.method === 'PUT') {
      const star = store.getStar(decodeURIComponent(upload[1]));
      const target = url.searchParams.get('path');
      if (!target) return fail(res, 400, 'bad_request', 'path is required');
      if (/^(text\/plain|application\/x-www-form-urlencoded|multipart\/form-data)\b/i.test(req.headers['content-type'] ?? '')) {
        return fail(res, 415, 'raw_only', 'Send the file as the body with Content-Type: application/octet-stream (or its own type)');
      }
      return send(res, 200, services.workspaces.write(star.id, target, await readRawBuffer(req, MAX_FILE)));
    }

    const match = router.match(req.method ?? 'GET', path);
    if (!match) return fail(res, 404, 'not_found', `No endpoint at ${req.method} ${url.pathname}`);
    if (match === 'method') return fail(res, 405, 'method_not_allowed', `${req.method} isn’t supported on ${url.pathname}`);
    const r: Req = { raw: req, res, method: req.method ?? 'GET', path, params: match.params, query: url.searchParams, body: await readBody(req) };
    const out = await match.handler(r);
    if (out instanceof RawBody) {
      // Files a Star made are never run as a page on Sky's own address: a fixed type, no sniffing, and a sandbox.
      res.writeHead(200, {
        'Content-Type': out.type, 'Content-Length': String(out.data.length), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'", 'Content-Disposition': `${r.query.get('download') === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(out.filename)}`,
      }).end(out.data);
      return;
    }
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

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function originOf(url: string | null | undefined): string | null {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
}
