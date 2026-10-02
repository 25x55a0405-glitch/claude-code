import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from '../util.ts';

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new ApiError(400, 'bad_request', 'That address isn’t valid');
  }
};

export interface Req {
  raw: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
}

export type Handler = (req: Req) => unknown | Promise<unknown>;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

/** A minimal router: "/tasks/:id/pause" style paths, one handler per method and path. */
export class Router {
  private routes: Route[] = [];

  on(method: string, path: string, handler: Handler) {
    this.routes.push({ method, parts: path.split('/').filter(Boolean), handler });
    return this;
  }

  get = (p: string, h: Handler) => this.on('GET', p, h);
  post = (p: string, h: Handler) => this.on('POST', p, h);
  patch = (p: string, h: Handler) => this.on('PATCH', p, h);
  delete = (p: string, h: Handler) => this.on('DELETE', p, h);

  /** Returns the handler and params, "method" when the path exists under another method, or null. */
  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | 'method' | null {
    const parts = path.split('/').filter(Boolean);
    let pathMatched = false;
    for (const r of this.routes) {
      if (r.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      const ok = r.parts.every((p, i) => {
        if (p.startsWith(':')) {
          params[p.slice(1)] = decode(parts[i]);
          return true;
        }
        return p === parts[i];
      });
      if (!ok) continue;
      pathMatched = true;
      if (r.method === method) return { handler: r.handler, params };
    }
    return pathMatched ? 'method' : null;
  }
}
