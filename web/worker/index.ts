/**
 * Sky on Cloudflare: serves the built web app from Workers static assets and
 * passes /api and /login through to the Sky back end (SKY_BACKEND_URL), so the
 * app and the API share one address. That keeps the sign-in cookie, the live
 * event stream and the browser live view working without any CORS setup.
 *
 * The back end itself (Node, SQLite, Chromium) can't run inside a Worker; run
 * it on a machine of your own and reach it through a Cloudflare Tunnel.
 * See docs/DEPLOY.md.
 */
interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** Where the Sky server answers, e.g. https://sky-api.example.com (no trailing slash needed). */
  SKY_BACKEND_URL?: string;
}

const PROXIED = /^\/(api(\/|$)|login$)/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!PROXIED.test(url.pathname)) return env.ASSETS.fetch(request);

    if (!env.SKY_BACKEND_URL) {
      return Response.json(
        { error: { code: 'backend_not_set', message: 'This Sky web app has no back end yet. Set SKY_BACKEND_URL on the Worker (see docs/DEPLOY.md).' } },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    let target: URL;
    try {
      const base = new URL(env.SKY_BACKEND_URL);
      target = new URL(base.origin + (base.pathname.replace(/\/+$/, '') + url.pathname) + url.search);
    } catch {
      return Response.json({ error: { code: 'backend_invalid', message: 'SKY_BACKEND_URL isn’t a valid address.' } }, { status: 503 });
    }

    // Same request, new address. Streams (events, live view) pass through untouched.
    const headers = new Headers(request.headers);
    headers.set('X-Forwarded-Host', url.host);
    headers.set('X-Forwarded-Proto', url.protocol.replace(':', ''));
    try {
      return await fetch(new Request(target, { method: request.method, headers, body: request.body, redirect: 'manual' }));
    } catch {
      return Response.json(
        { error: { code: 'backend_unreachable', message: 'Sky’s back end didn’t answer. Check that the server and its tunnel are running.' } },
        { status: 502, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  },
};
