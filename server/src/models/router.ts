import { ClaudeBrain, BrainUnavailable, type Brain, type TurnRequest, type TurnResult } from '../agent/brain.ts';
import { OpenAICompatBrain } from '../agent/openai.ts';
import { ScriptedBrain } from '../agent/scripted.ts';
import type { Config } from '../config.ts';
import type { ModelProvider } from '../types.ts';
import { classify, ENV_PROVIDER, type ModelRegistry } from './registry.ts';

/** Longest a single provider gets before the chain moves on. */
const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * The Brain every Star uses. It walks an ordered chain of providers (a
 * Star's own, or the global order): the first healthy one answers; on an
 * error, rate limit, used-up quota or timeout it records the failure, benches
 * that provider for a while, and tries the next. Providers on cooldown are
 * skipped, unless every provider is cooling, in which case the one that cools
 * down soonest is tried anyway rather than giving up.
 *
 * With no providers set up at all it falls back to the scripted stand-in, so
 * the server still runs.
 */
export class ModelRouter implements Brain {
  registry: ModelRegistry;
  config: Config;
  fetch?: typeof fetch;
  private scripted = new ScriptedBrain();
  private cache = new Map<string, { stamp: string; brain: Brain }>();
  timeoutMs: number;

  constructor(registry: ModelRegistry, config: Config, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.registry = registry;
    this.config = config;
    this.fetch = opts.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get name(): string {
    return this.registry.list().some((p) => p.enabled) ? 'models' : 'scripted';
  }

  /** The providers to try, in order: the given chain, or the global order. */
  chain(ids?: string[] | null): ModelProvider[] {
    const all = this.registry.list().filter((p) => p.enabled);
    if (!ids) return all;
    return ids.map((id) => all.find((p) => p.id === id)).filter((p): p is ModelProvider => Boolean(p));
  }

  /** Healthy providers first in chain order; if all are cooling, the soonest to recover. */
  private plan(ids?: string[] | null): ModelProvider[] {
    const chain = this.chain(ids);
    const now = new Date().toISOString();
    const ready = chain.filter((p) => !p.health.cooldownUntil || p.health.cooldownUntil <= now);
    if (ready.length) return ready;
    return [...chain].sort((a, b) => (a.health.cooldownUntil ?? '').localeCompare(b.health.cooldownUntil ?? '')).slice(0, 1);
  }

  brainFor(p: ModelProvider): Brain {
    const hit = this.cache.get(p.id);
    if (hit && hit.stamp === p.updatedAt) return hit.brain;
    const apiKey = p.id === ENV_PROVIDER ? undefined : this.registry.apiKey(p.id);
    const brain: Brain = p.kind === 'anthropic'
      ? new ClaudeBrain({
        model: p.model, effort: this.config.effort, fallbacks: this.config.fallbacks,
        // The server's own key reads its environment (including ANTHROPIC_BASE_URL); others carry their own.
        ...(p.id === ENV_PROVIDER ? {} : { apiKey: apiKey ?? 'none', baseURL: p.baseUrl }),
        official: p.id === ENV_PROVIDER || /(^|\.)anthropic\.com$/.test(new URL(p.baseUrl).hostname),
      })
      : new OpenAICompatBrain({ baseUrl: p.baseUrl, apiKey, model: p.model, fetch: this.fetch });
    this.cache.set(p.id, { stamp: p.updatedAt, brain });
    return brain;
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    if (this.name === 'scripted') return this.scripted.turn(req);
    return this.walk(req.chain, async (brain, p, signal) => {
      let wrote = false;
      const official = brain instanceof ClaudeBrain && p.kind === 'anthropic' && (p.id === ENV_PROVIDER || /anthropic\.com/.test(p.baseUrl));
      try {
        return await brain.turn({
          ...req, signal, web: req.web && official,
          onText: req.onText ? (d) => { wrote = true; req.onText!(d); } : undefined,
        });
      } catch (err) {
        // Part of a reply already streamed: start the next model's answer on a fresh line.
        if (wrote) req.onText?.('\n\n');
        throw err;
      }
    });
  }

  async complete(system: string, prompt: string, maxTokens?: number, chain?: string[] | null): Promise<string> {
    if (this.name === 'scripted') return this.scripted.complete(system, prompt);
    return this.walk(chain, (brain, _p, signal) => brain.complete(system, prompt, maxTokens, null, signal));
  }

  /** Tries one provider directly, for the "Test" button. Records the outcome like any call. */
  async test(id: string): Promise<{ ok: boolean; latencyMs: number; reply?: string; error?: string }> {
    const p = this.registry.get(id);
    const started = Date.now();
    try {
      const reply = await this.withTimeout(p, (signal) => this.brainFor(p).turn({
        system: 'Reply with one short sentence.', messages: [{ role: 'user', content: 'Say hello.' }], tools: [], web: false, maxTokens: 64, signal,
      }));
      const latencyMs = Date.now() - started;
      this.registry.recordOk(id, latencyMs);
      return { ok: true, latencyMs, reply: reply.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('').trim() };
    } catch (err) {
      const f = this.failure(err, p);
      this.registry.recordFailure(id, f);
      return { ok: false, latencyMs: Date.now() - started, error: f.message };
    }
  }

  private async walk<T>(ids: string[] | null | undefined, call: (brain: Brain, p: ModelProvider, signal: AbortSignal) => Promise<T>): Promise<T> {
    const plan = this.plan(ids);
    if (!plan.length) {
      throw new BrainUnavailable(ids ? 'None of this Star’s model providers are turned on.' : 'No model providers are turned on.');
    }
    const errors: string[] = [];
    for (const p of plan) {
      const started = Date.now();
      try {
        const out = await this.withTimeout(p, (signal) => call(this.brainFor(p), p, signal));
        this.registry.recordOk(p.id, Date.now() - started);
        return out;
      } catch (err) {
        const f = this.failure(err, p);
        this.registry.recordFailure(p.id, f);
        errors.push(`${p.name}: ${f.message}`);
      }
    }
    throw new BrainUnavailable(`No model could answer. ${errors.join(' | ')}`);
  }

  /**
   * What went wrong, with the provider's key taken out: some providers repeat
   * the key in their errors ("Invalid API key: sk-..."), and the message is
   * stored, shown on the Models screen, sent in events and logged.
   */
  private failure(err: unknown, p: ModelProvider) {
    const f = classify(err, p.health.failures);
    return { ...f, message: scrubKey(f.message, p.id === ENV_PROVIDER ? process.env.ANTHROPIC_API_KEY : this.registry.apiKey(p.id)) };
  }

  /**
   * Gives one provider timeoutMs. The signal stops the request, and the race
   * makes sure a call that ignores it still can't hold up the work queue.
   */
  private async withTimeout<T>(p: ModelProvider, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ctrl = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        ctrl.abort(new Error(`${p.name} timed out`));
        reject(new Error('timeout'));
      }, this.timeoutMs);
    });
    try {
      const call = run(ctrl.signal);
      call.catch(() => {}); // a late failure after the timeout has nowhere to go
      return await Promise.race([call, expired]);
    } catch (err) {
      if (ctrl.signal.aborted) {
        const e = new Error(`${p.name} timed out after ${Math.round(this.timeoutMs / 1000)}s`);
        e.name = 'AbortError';
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Replaces an API key (and any long piece of it) in text with "…" and its last 4 characters. */
export function scrubKey(text: string, key: string | undefined | null): string {
  if (!key || key.length < 4) return text;
  const tail = key.length >= 12 ? `…${key.slice(-4)}` : '…';
  let out = text.split(key).join(tail);
  // Providers sometimes echo a shortened key ("sk-live-SUPE...9999"); hide any 8+ character run of it too.
  if (key.length >= 16) {
    for (let len = Math.min(key.length - 1, 40); len >= 8; len--) {
      for (let i = 0; i + len <= key.length; i++) {
        const piece = key.slice(i, i + len);
        if (out.includes(piece)) out = out.split(piece).join(tail);
      }
    }
  }
  return out;
}
