import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Config } from '../config.ts';
import type { Db } from '../db/db.ts';

const COOKIE = 'sky_session';
const MAX_AGE_S = 60 * 60 * 24 * 30;

/**
 * Single-person sign-in. With SKY_PASSWORD unset the server trusts everyone
 * who can reach it, so it only listens on localhost by default. With it set,
 * the browser signs in once and gets a signed, HttpOnly session cookie;
 * scripts can send SKY_API_TOKEN as a bearer token instead.
 */
export class Auth {
  private secret: Buffer;
  config: Config;

  constructor(config: Config, db: Db) {
    this.config = config;
    let secret = config.sessionSecret ?? db.getKv<string>('sessionSecret');
    if (!secret) {
      secret = randomBytes(32).toString('base64url');
      db.setKv('sessionSecret', secret);
    }
    this.secret = Buffer.from(secret);
  }

  get enabled() {
    return Boolean(this.config.password || this.config.apiToken);
  }

  private sign(value: string) {
    return createHmac('sha256', this.secret).update(value).digest('base64url');
  }

  checkPassword(password: unknown): boolean {
    return typeof password === 'string' && Boolean(this.config.password) && safeEqual(password, this.config.password!);
  }

  /** A Set-Cookie value for a fresh session. */
  sessionCookie(secure: boolean): string {
    const expires = Math.floor(Date.now() / 1000) + MAX_AGE_S;
    const value = `${expires}.${this.sign(String(expires))}`;
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}${secure ? '; Secure' : ''}`;
  }

  clearCookie(): string {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  isSignedIn(req: IncomingMessage): boolean {
    if (!this.enabled) return true;
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (bearer && this.config.apiToken && safeEqual(bearer, this.config.apiToken)) return true;
    const cookie = parseCookies(req.headers.cookie)[COOKIE];
    if (!cookie) return false;
    const [expires, sig] = cookie.split('.');
    return Boolean(expires && sig) && Number(expires) * 1000 > Date.now() && safeEqual(sig, this.sign(expires));
  }
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header?.split(';') ?? []) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
