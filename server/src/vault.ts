import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import type { Store } from './store.ts';
import type { Secret } from './types.ts';
import { ApiError, badRequest, iso, notFound, uid } from './util.ts';

const REF = /\{\{\s*secret:([A-Za-z0-9_]+)\s*\}\}/g;
const MIN_VALUE = 4;
export const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

interface Sealed {
  iv: string;
  tag: string;
  data: string;
}

/**
 * Secrets the Stars can use without ever seeing them. Values are encrypted
 * with AES-256-GCM. The key comes from SKY_SECRET_KEY, or else from a key
 * file created next to the database (back it up: without it the secrets
 * can't be read).
 *
 * A Star writes {{secret:NAME}} in a tool input; the real value is swapped in
 * just before the tool runs, and any value that shows up in a result is
 * replaced with [secret:NAME] before the model, the timeline or the logs see it.
 */
export class Vault {
  store: Store;
  private key: Buffer;
  /** Where the key came from, for the Settings screen. */
  keySource: 'env' | 'file' | 'memory';

  constructor(store: Store, config: Config) {
    this.store = store;
    if (config.secretKey) {
      this.key = scryptSync(config.secretKey, 'sky-vault', 32);
      this.keySource = 'env';
    } else if (config.dbPath === ':memory:') {
      this.key = randomBytes(32);
      this.keySource = 'memory';
    } else {
      const file = join(config.dataDir, 'secret.key');
      if (!existsSync(file)) {
        mkdirSync(config.dataDir, { recursive: true });
        writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
        console.warn(`[vault] Created ${file}. Back it up: secrets can’t be read without it.`);
      }
      chmodSync(file, 0o600);
      this.key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
      this.keySource = 'file';
    }
  }

  list(starId?: string): Secret[] {
    return this.store.db.all<Secret>('secret')
      .filter((s) => !starId || !s.starIds || s.starIds.includes(starId))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  find(name: string): Secret | undefined {
    return this.store.db.all<Secret>('secret').find((s) => s.name.toLowerCase() === name.toLowerCase());
  }

  get(ref: string): Secret {
    const s = this.store.db.get<Secret>('secret', ref) ?? this.find(ref);
    if (!s) throw notFound('Secret', ref);
    return s;
  }

  create(input: { name: string; value: string; description?: string; starIds?: string[] | null }): Secret {
    if (!SECRET_NAME.test(input.name)) throw badRequest('A secret’s name uses letters, digits and underscores, like GITHUB_TOKEN');
    if (this.find(input.name)) throw new ApiError(409, 'conflict', `There’s already a secret called ${input.name}`);
    if (!input.value) throw badRequest('value is required');
    if (input.value.length < MIN_VALUE) throw badRequest(`A secret needs at least ${MIN_VALUE} characters, so Sky can reliably hide it wherever it shows up`);
    const now = iso();
    const s = this.store.db.put<Secret>('secret', {
      id: uid('sec'), name: input.name, description: input.description ?? '', starIds: input.starIds ?? null, lastUsedAt: null, createdAt: now, updatedAt: now,
    });
    this.store.db.setPrivate('secret', s.id, this.seal(input.value));
    return s;
  }

  patch(ref: string, input: { value?: string; description?: string; starIds?: string[] | null }): Secret {
    const s = this.get(ref);
    if (input.value !== undefined) {
      if (!input.value) throw badRequest('value can’t be empty');
      if (input.value.length < MIN_VALUE) throw badRequest(`A secret needs at least ${MIN_VALUE} characters, so Sky can reliably hide it wherever it shows up`);
      this.store.db.setPrivate('secret', s.id, this.seal(input.value));
    }
    return this.store.db.put<Secret>('secret', {
      ...s,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.starIds !== undefined ? { starIds: input.starIds } : {}),
      updatedAt: iso(),
    });
  }

  delete(ref: string) {
    this.store.db.delete('secret', this.get(ref).id);
  }

  /** Secret names a tool input refers to. */
  refs(input: unknown): string[] {
    const names = new Set<string>();
    walk(input, (s) => {
      for (const m of s.matchAll(REF)) names.add(m[1]);
      return s;
    });
    return [...names];
  }

  /** The input with every {{secret:NAME}} replaced by its value. Throws if a secret is unknown or not this Star's. */
  fill<T>(input: T, starId: string): T {
    const used = this.refs(input);
    if (!used.length) return input;
    const values = new Map<string, string>();
    for (const name of used) {
      const s = this.find(name);
      if (!s) throw new Error(`There’s no secret called ${name}. The person can add it under Settings → Secrets.`);
      if (s.starIds && !s.starIds.includes(starId)) throw new Error(`You aren’t allowed to use the secret ${name}.`);
      values.set(name, this.open(s.id));
      this.store.db.put('secret', { ...s, lastUsedAt: iso() });
    }
    return walk(input, (str) => str.replace(REF, (_m, name: string) => values.get(name) ?? '')) as T;
  }

  /** Fills secrets into settings the person wrote themselves (an MCP server's environment), with no Star limit. */
  fillAny<T>(input: T): T {
    return walk(input, (str) => str.replace(REF, (_m, name: string) => {
      const s = this.find(name);
      if (!s) throw new Error(`There’s no secret called ${name}`);
      return this.open(s.id);
    })) as T;
  }

  /** Replaces any secret value in text with [secret:NAME]. */
  redact(text: string): string {
    let out = text;
    for (const s of this.store.db.all<Secret>('secret')) {
      const value = this.open(s.id);
      if (value.length >= MIN_VALUE && out.includes(value)) out = out.split(value).join(`[secret:${s.name}]`);
    }
    return out;
  }

  private seal(value: string): Sealed {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  }

  private open(id: string): string {
    const sealed = this.store.db.getPrivate<Sealed>('secret', id);
    if (!sealed) return '';
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(sealed.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('A secret couldn’t be decrypted. The server’s secret key changed (SKY_SECRET_KEY or data/secret.key).');
    }
  }
}

/** Maps every string inside a JSON-like value. */
function walk(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === 'string') return f(v);
  if (Array.isArray(v)) return v.map((x) => walk(x, f));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, f)]));
  return v;
}
