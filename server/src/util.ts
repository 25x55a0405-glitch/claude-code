import { randomBytes } from 'node:crypto';

export const iso = (d: Date | number = new Date()) => new Date(d).toISOString();

export const uid = (prefix: string) => `${prefix}_${randomBytes(6).toString('base64url')}`;

/** An error that maps straight onto the API error body in docs/API.md. */
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const notFound = (what: string, id: string) => new ApiError(404, 'not_found', `${what} ${id} not found`);
export const badRequest = (message: string) => new ApiError(400, 'bad_request', message);

export const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** First line of free text, trimmed for titles and previews. */
export const firstLine = (s: string, n = 60) => truncate(s.trim().split('\n')[0].replace(/\*\*/g, ''), n);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
