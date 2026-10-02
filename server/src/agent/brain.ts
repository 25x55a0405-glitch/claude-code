import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlock, BetaMessageParam, BetaStopReason, BetaToolUnion,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { Config } from '../config.ts';

export type { BetaContentBlock, BetaMessageParam };

export interface ClientToolSpec {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export interface TurnRequest {
  system: string;
  messages: BetaMessageParam[];
  tools: ClientToolSpec[];
  /** Adds Claude's server-side web search and fetch (only where the provider is Anthropic's own API). */
  web: boolean;
  /** Model providers to try, in order (a Star's own chain). Omitted: the global order. */
  chain?: string[] | null;
  /** Streams visible reply text as it is generated. */
  onText?: (delta: string) => void;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface TurnResult {
  content: BetaContentBlock[];
  stopReason: BetaStopReason | null;
}

/**
 * The model behind every Star. ModelRouter (router.ts) tries the person's
 * providers in order; each provider is a ClaudeBrain (Anthropic-compatible)
 * or an OpenAICompatBrain. ScriptedBrain (scripted.ts) is a deterministic
 * stand-in so the whole server runs and is testable without any provider.
 */
export interface Brain {
  /** "scripted" for the offline stand-in; anything else is a real model. */
  readonly name: string;
  turn(req: TurnRequest): Promise<TurnResult>;
  /** One short, tool-free completion (briefing copy, rule checks). */
  /** `chain` picks the providers to use, like TurnRequest.chain. */
  complete(system: string, prompt: string, maxTokens?: number, chain?: string[] | null): Promise<string>;
}

/** Thrown when the model can't be reached at all, so the runtime can show "offline" and retry later. */
export class BrainUnavailable extends Error {}

export interface ClaudeBrainOptions extends Pick<Config, 'model' | 'effort' | 'fallbacks'> {
  /** Omitted: the SDK reads ANTHROPIC_API_KEY. */
  apiKey?: string;
  baseURL?: string;
  /**
   * Anthropic's own API: adaptive thinking, effort, server-side web tools and
   * refusal fallbacks. Other Anthropic-compatible servers get a plain request.
   */
  official: boolean;
}

/** Anthropic's API, or any server that speaks the Anthropic Messages format. */
export class ClaudeBrain implements Brain {
  readonly name = 'claude';
  private client: Anthropic;
  private config: ClaudeBrainOptions;

  constructor(config: Pick<Config, 'model' | 'effort' | 'fallbacks'> & Partial<ClaudeBrainOptions>) {
    this.config = { official: true, ...config };
    this.client = new Anthropic({
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      maxRetries: 0,
    });
  }

  private tools(req: TurnRequest): BetaToolUnion[] {
    if (!this.config.official) return req.tools.map((t) => ({ ...t }));
    const tools: BetaToolUnion[] = req.tools.map((t) => ({ ...t, eager_input_streaming: true }));
    if (req.web) {
      tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 5 });
      tools.push({ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 });
    }
    return tools;
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    if (!this.config.official) return this.plainTurn(req);
    try {
      const stream = this.client.beta.messages.stream(
        {
          model: this.config.model,
          max_tokens: req.maxTokens ?? 32_000,
          // The system prompt is stable for a given set of settings, rules and
          // memory, so it is cached; anything volatile goes in the messages.
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          messages: req.messages,
          tools: this.tools(req),
          thinking: { type: 'adaptive' },
          output_config: { effort: this.config.effort },
          ...(this.config.fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        },
        { signal: req.signal },
      );
      if (req.onText) stream.on('text', (delta) => req.onText!(delta));
      const message = await stream.finalMessage();
      return { content: message.content, stopReason: message.stop_reason };
    } catch (err) {
      throw this.wrap(err);
    }
  }

  /** A request any Anthropic-compatible server understands: no thinking, effort or server tools. */
  private async plainTurn(req: TurnRequest): Promise<TurnResult> {
    try {
      const tools = this.tools(req);
      const stream = this.client.messages.stream(
        {
          model: this.config.model,
          max_tokens: req.maxTokens ?? 8_192,
          system: req.system,
          messages: portableHistory(req.messages) as Anthropic.MessageParam[],
          ...(tools.length ? { tools: tools as Anthropic.Tool[] } : {}),
        },
        { signal: req.signal },
      );
      if (req.onText) stream.on('text', (delta) => req.onText!(delta));
      const message = await stream.finalMessage();
      return { content: message.content as unknown as BetaContentBlock[], stopReason: message.stop_reason as BetaStopReason | null };
    } catch (err) {
      throw this.wrap(err);
    }
  }

  async complete(system: string, prompt: string, maxTokens = 2_000): Promise<string> {
    try {
      const message = await this.client.messages.create({
        model: this.config.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: prompt }],
        ...(this.config.official ? { output_config: { effort: 'low' as const } } : {}),
      });
      return message.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
    } catch (err) {
      throw this.wrap(err);
    }
  }

  private wrap(err: unknown): Error {
    if (err instanceof Anthropic.APIError) {
      const retryAfter = Number(err.headers?.get?.('retry-after'));
      return new ProviderError(err.message, err.status ?? null, Number.isFinite(retryAfter) ? retryAfter : undefined);
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}

/** A provider's error, with the HTTP status when there was one, so the router can decide what to do next. */
export class ProviderError extends Error {
  status: number | null;
  /** Seconds, from a Retry-After header. */
  retryAfter?: number;

  constructor(message: string, status: number | null, retryAfter?: number) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const PORTABLE = new Set(['text', 'tool_use', 'tool_result', 'image']);

/**
 * History another provider can read: keeps text, tool calls and results, and
 * drops Claude-only blocks (thinking, server-side web search) that would be
 * rejected or misread elsewhere. Lets a run switch providers mid-way.
 */
export function portableHistory(messages: BetaMessageParam[]): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push(m);
      continue;
    }
    const content = m.content.filter((b) => PORTABLE.has(b.type));
    out.push({ role: m.role, content: content.length ? content : [{ type: 'text', text: '(searched the web)' }] });
  }
  return out;
}
