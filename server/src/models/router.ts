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
    return this.walk(chain, (brain) => brain.complete(system, prompt, maxTokens));
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
      const f = classify(err, p.health.failures);
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
        const f = classify(err, p.health.failures);
        this.registry.recordFailure(p.id, f);
        errors.push(`${p.name}: ${f.message}`);
      }
    }
    throw new BrainUnavailable(`No model could answer. ${errors.join(' | ')}`);
  }

  private async withTimeout<T>(p: ModelProvider, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`${p.name} timed out`)), this.timeoutMs);
    try {
      return await run(ctrl.signal);
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
