import type { Config } from '../config.ts';
import type { Store } from '../store.ts';
import type { ModelProvider, ProviderHealth, ProviderKind, ProviderPreset } from '../types.ts';
import { ApiError, badRequest, iso, notFound, uid } from '../util.ts';

export const ENV_PROVIDER = 'p_anthropic_env';

const FRESH: ProviderHealth = { state: 'unknown', lastOkAt: null, lastError: null, lastErrorAt: null, cooldownUntil: null, failures: 0, latencyMs: null };

/** Starting points for the "Add a model" screen. Model ids are examples: providers change their lists often. */
export const PRESETS: ProviderPreset[] = [
  { name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', exampleModel: 'claude-opus-5-5', needsKey: true, keyUrl: 'https://console.anthropic.com/settings/keys', note: 'Claude with thinking, web search and caching.' },
  { name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', exampleModel: 'meta-llama/llama-3.3-70b-instruct:free', needsKey: true, keyUrl: 'https://openrouter.ai/keys', note: 'Hundreds of models; ids ending in :free cost nothing, with daily limits.' },
  { name: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', exampleModel: 'llama-3.3-70b-versatile', needsKey: true, keyUrl: 'https://console.groq.com/keys', note: 'Very fast; free tier with per-minute limits.' },
  { name: 'Google Gemini', kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', exampleModel: 'gemini-2.5-flash', needsKey: true, keyUrl: 'https://aistudio.google.com/apikey', note: 'Free tier through Google AI Studio.' },
  { name: 'Mistral', kind: 'openai', baseUrl: 'https://api.mistral.ai/v1', exampleModel: 'mistral-small-latest', needsKey: true, keyUrl: 'https://console.mistral.ai/api-keys', note: 'Free experiment plan.' },
  { name: 'Cerebras', kind: 'openai', baseUrl: 'https://api.cerebras.ai/v1', exampleModel: 'llama-3.3-70b', needsKey: true, keyUrl: 'https://cloud.cerebras.ai', note: 'Free tier with daily token limits.' },
  { name: 'GitHub Models', kind: 'openai', baseUrl: 'https://models.github.ai/inference', exampleModel: 'openai/gpt-4.1-mini', needsKey: true, keyUrl: 'https://github.com/settings/tokens', note: 'Free with a GitHub token, rate limited.' },
  { name: 'Together', kind: 'openai', baseUrl: 'https://api.together.xyz/v1', exampleModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free', needsKey: true, keyUrl: 'https://api.together.xyz/settings/api-keys', note: 'Some free models.' },
  { name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', exampleModel: 'deepseek-chat', needsKey: true, keyUrl: 'https://platform.deepseek.com/api_keys', note: 'Low cost.' },
  { name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', exampleModel: 'gpt-4.1-mini', needsKey: true, keyUrl: 'https://platform.openai.com/api-keys', note: '' },
  { name: 'Ollama (this computer)', kind: 'openai', baseUrl: 'http://localhost:11434/v1', exampleModel: 'llama3.1', needsKey: false, keyUrl: null, note: 'Free and private; runs models on your own machine.' },
  { name: 'LM Studio (this computer)', kind: 'openai', baseUrl: 'http://localhost:1234/v1', exampleModel: 'local-model', needsKey: false, keyUrl: null, note: 'Free and private; runs models on your own machine.' },
];

export interface ProviderInput {
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey?: string | null;
  enabled?: boolean;
}

interface Secret {
  apiKey?: string;
}

/**
 * The person's model providers, their order, and how healthy each one is.
 * Keys sit in the private column and are never returned by the API.
 */
export class ModelRegistry {
  store: Store;
  config: Config;

  constructor(store: Store, config: Config) {
    this.store = store;
    this.config = config;
    this.syncEnvProvider();
  }

  /** ANTHROPIC_API_KEY in the server's environment shows up as a built-in provider. */
  private syncEnvProvider() {
    const existing = this.store.db.get<ModelProvider>('provider', ENV_PROVIDER);
    if (!this.config.anthropicKey) {
      if (existing) this.store.db.delete('provider', ENV_PROVIDER);
      return;
    }
    const now = iso();
    this.store.db.put<ModelProvider>('provider', {
      ...(existing ?? { id: ENV_PROVIDER, enabled: true, health: FRESH, createdAt: now }),
      name: 'Anthropic (server key)', kind: 'anthropic', baseUrl: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
      model: this.config.model, hasKey: true, keyHint: null, builtIn: true, updatedAt: now,
    } as ModelProvider);
    if (!existing) this.setOrder([ENV_PROVIDER, ...this.order()]);
  }

  /** Every provider, in the global order (ones not in the order go last). */
  list(): ModelProvider[] {
    const order = this.order();
    const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
    return this.store.db.all<ModelProvider>('provider').sort((a, b) => rank(a.id) - rank(b.id) || a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): ModelProvider {
    const p = this.store.db.get<ModelProvider>('provider', id);
    if (!p) throw notFound('Provider', id);
    return p;
  }

  find(id: string): ModelProvider | undefined {
    return this.store.db.get<ModelProvider>('provider', id);
  }

  apiKey(id: string): string | undefined {
    return this.store.db.getPrivate<Secret>('provider', id)?.apiKey;
  }

  /** The global order, as provider ids. */
  order(): string[] {
    return (this.store.db.getKv<string[]>('providerOrder') ?? []).filter((id) => this.find(id));
  }

  setOrder(ids: string[]): string[] {
    const known = new Set(this.store.db.all<ModelProvider>('provider').map((p) => p.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) throw badRequest(`Unknown provider ${unknown.join(', ')}`);
    const unique = [...new Set(ids)];
    // Anything left out keeps its place after the ones named.
    const rest = this.store.db.all<ModelProvider>('provider').map((p) => p.id).filter((id) => !unique.includes(id));
    this.store.db.setKv('providerOrder', [...unique, ...rest]);
    return this.order();
  }

  create(input: ProviderInput): ModelProvider {
    const now = iso();
    const key = input.apiKey?.trim() || undefined;
    const p = this.store.db.put<ModelProvider>('provider', {
      id: uid('p'), name: input.name, kind: input.kind, baseUrl: cleanUrl(input.baseUrl), model: input.model,
      enabled: input.enabled ?? true, hasKey: Boolean(key), keyHint: hint(key), builtIn: false, health: FRESH, createdAt: now, updatedAt: now,
    });
    this.store.db.setPrivate('provider', p.id, { apiKey: key } satisfies Secret);
    this.store.db.setKv('providerOrder', [...this.order(), p.id]);
    this.emit(p);
    return p;
  }

  patch(id: string, input: Partial<ProviderInput>): ModelProvider {
    const current = this.get(id);
    if (current.builtIn && (input.baseUrl !== undefined || input.apiKey !== undefined || input.kind !== undefined)) {
      throw new ApiError(403, 'forbidden', 'This provider comes from the server’s ANTHROPIC_API_KEY. Change it in the server’s environment.');
    }
    const next: ModelProvider = {
      ...current,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: cleanUrl(input.baseUrl) } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      updatedAt: iso(),
    };
    if (input.apiKey !== undefined) {
      const key = input.apiKey?.trim() || undefined;
      this.store.db.setPrivate('provider', id, { apiKey: key } satisfies Secret);
      next.hasKey = Boolean(key);
      next.keyHint = hint(key);
    }
    // A changed key, URL or model deserves a fresh start.
    if (input.apiKey !== undefined || input.baseUrl !== undefined || input.model !== undefined || input.kind !== undefined) next.health = FRESH;
    this.store.db.put('provider', next);
    this.emit(next);
    return next;
  }

  delete(id: string) {
    const p = this.get(id);
    if (p.builtIn) throw new ApiError(403, 'forbidden', 'This provider comes from the server’s ANTHROPIC_API_KEY. Remove the key from the server’s environment instead.');
    this.store.db.delete('provider', id);
    this.store.db.setKv('providerOrder', this.order().filter((x) => x !== id));
    for (const s of this.store.listStars()) {
      if (s.providerIds?.includes(id)) this.store.patchStar(s.id, { providerIds: s.providerIds.filter((x) => x !== id) });
    }
    this.store.bus.emit({ type: 'provider.deleted', data: { id } });
  }

  recordOk(id: string, latencyMs: number) {
    const p = this.find(id);
    if (!p) return;
    const health: ProviderHealth = { ...p.health, state: 'ok', lastOkAt: iso(), cooldownUntil: null, failures: 0, latencyMs };
    const changed = p.health.state !== 'ok' || p.health.failures !== 0;
    this.store.db.put('provider', { ...p, health });
    if (changed) this.emit({ ...p, health });
  }

  /** Records a failure and decides how long to leave the provider alone. */
  recordFailure(id: string, failure: Failure) {
    const p = this.find(id);
    if (!p) return;
    const failures = p.health.failures + 1;
    const health: ProviderHealth = {
      ...p.health,
      state: failure.permanent ? 'failing' : failure.cooldownMs ? 'cooling' : p.health.state === 'unknown' ? 'unknown' : p.health.state,
      lastError: failure.message.slice(0, 300), lastErrorAt: iso(), failures,
      cooldownUntil: failure.cooldownMs ? iso(Date.now() + failure.cooldownMs) : p.health.cooldownUntil,
    };
    this.store.db.put('provider', { ...p, health });
    this.emit({ ...p, health });
  }

  private emit(p: ModelProvider) {
    this.store.bus.emit({ type: 'provider.updated', data: p });
  }
}

export interface Failure {
  message: string;
  /** Skip this provider for this long. 0: just move on for this request. */
  cooldownMs: number;
  /** Won't fix itself (bad key, unknown model): shown as "failing". */
  permanent: boolean;
}

/**
 * What a provider's error means for the chain. Rate limits and outages cool
 * the provider down (longer each time); a used-up quota for an hour; a bad
 * key or unknown model for six hours, since those need the person.
 */
const UNKNOWN_MODEL = /\b(unknown|invalid|unsupported) model\b|\bmodel_not_found\b|no such model|model\b[^.]{0,60}\b(not found|does ?n[o’']t exist|is not available|isn[’']t available|decommissioned|deprecated|retired|no longer (available|supported)|unknown)/i;

export function classify(err: unknown, failuresBefore: number): Failure {
  const status = (err as { status?: number | null }).status ?? null;
  const retryAfter = (err as { retryAfter?: number }).retryAfter;
  const message = err instanceof Error ? err.message : String(err);
  const backoff = (base: number, cap: number) => Math.min(base * 2 ** Math.min(failuresBefore, 10), cap);
  if ((err as Error).name === 'AbortError' || /timed? ?out/i.test(message)) return { message: `Timed out: ${message}`, cooldownMs: backoff(30_000, 600_000), permanent: false };
  if (status === 402 || /quota|credit|insufficient|billing|exceeded your/i.test(message)) return { message, cooldownMs: 3_600_000, permanent: false };
  if (status === 429) return { message, cooldownMs: retryAfter ? retryAfter * 1000 : backoff(60_000, 900_000), permanent: false };
  if (status === 401 || status === 403) return { message, cooldownMs: 6 * 3_600_000, permanent: true };
  // Only a model name the provider doesn't know benches it; "not supported with this model" or "too large for this model"
  // is a request that model can't do, which moves on below without benching.
  if ((status === 404 || status === 400) && UNKNOWN_MODEL.test(message)) {
    return { message, cooldownMs: 6 * 3_600_000, permanent: true };
  }
  if (status === null || status >= 500 || status === 408 || status === 409) return { message, cooldownMs: backoff(30_000, 600_000), permanent: false };
  // Other 4xx: this request didn't suit this provider (tools unsupported, too long); try the next without benching it.
  return { message, cooldownMs: 0, permanent: false };
}

function cleanUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** The last 4 characters, only for a key long enough that they don't give it away. */
function hint(key: string | undefined): string | null {
  return key && key.length >= 12 ? key.slice(-4) : null;
}
