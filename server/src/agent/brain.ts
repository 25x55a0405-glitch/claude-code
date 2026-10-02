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
  /** Adds Claude's server-side web search and fetch. */
  web: boolean;
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
 * The model behind every Star. ClaudeBrain is the real one; ScriptedBrain (in
 * scripted.ts) is a deterministic stand-in so the whole server runs and is
 * testable without an API key.
 */
export interface Brain {
  readonly name: string;
  turn(req: TurnRequest): Promise<TurnResult>;
  /** One short, tool-free completion (briefing copy, rule checks). */
  complete(system: string, prompt: string, maxTokens?: number): Promise<string>;
}

/** Thrown when the model can't be reached at all, so the runtime can show "offline" and retry later. */
export class BrainUnavailable extends Error {}

export class ClaudeBrain implements Brain {
  readonly name = 'claude';
  private client = new Anthropic();
  private config: Pick<Config, 'model' | 'effort' | 'fallbacks'>;

  constructor(config: Pick<Config, 'model' | 'effort' | 'fallbacks'>) {
    this.config = config;
  }

  private tools(req: TurnRequest): BetaToolUnion[] {
    const tools: BetaToolUnion[] = req.tools.map((t) => ({ ...t, eager_input_streaming: true }));
    if (req.web) {
      tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 5 });
      tools.push({ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 });
    }
    return tools;
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
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

  async complete(system: string, prompt: string, maxTokens = 2_000): Promise<string> {
    try {
      const message = await this.client.messages.create({
        model: this.config.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: prompt }],
        output_config: { effort: 'low' },
      });
      return message.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
    } catch (err) {
      throw this.wrap(err);
    }
  }

  private wrap(err: unknown): Error {
    if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.AuthenticationError
      || err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) {
      return new BrainUnavailable(err.message);
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}
