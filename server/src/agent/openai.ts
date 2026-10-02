import type { BetaContentBlock, BetaMessageParam, BetaStopReason } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { ProviderError, type Brain, type TurnRequest, type TurnResult } from './brain.ts';

export interface OpenAICompatOptions {
  /** e.g. https://openrouter.ai/api/v1, https://api.groq.com/openai/v1, http://localhost:11434/v1 */
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Swappable for tests. */
  fetch?: typeof fetch;
}

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/**
 * Any server that speaks OpenAI's Chat Completions format: OpenRouter, Groq,
 * Together, Mistral, DeepSeek, Gemini's OpenAI endpoint, Ollama, LM Studio,
 * vLLM and so on. Requests and replies are translated to and from the
 * Anthropic shapes the rest of Sky uses, so tool calls work the same way and
 * a run can move between providers.
 */
export class OpenAICompatBrain implements Brain {
  readonly name = 'openai';
  private opts: OpenAICompatOptions;

  constructor(opts: OpenAICompatOptions) {
    this.opts = { ...opts, baseUrl: opts.baseUrl.replace(/\/+$/, '') };
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
          // OpenRouter shows these on its dashboard; other servers ignore them.
          'HTTP-Referer': 'https://github.com/25x55a0405-glitch/claude-code',
          'X-Title': 'Sky',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw new ProviderError(`Couldn’t reach ${this.opts.baseUrl}: ${(err as Error).message}`, null);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const retryAfter = Number(res.headers.get('retry-after'));
      throw new ProviderError(`${res.status} ${errorMessage(text) || res.statusText}`, res.status, Number.isFinite(retryAfter) ? retryAfter : undefined);
    }
    return res;
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    const tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    const res = await this.post({
      model: this.opts.model,
      messages: toChatMessages(req.system, req.messages),
      ...(tools.length ? { tools } : {}),
      max_tokens: Math.min(req.maxTokens ?? 4_096, 8_192),
      stream: true,
    }, req.signal);

    let text = '';
    let finish: string | null = null;
    const calls: { id?: string; name: string; args: string }[] = [];
    const take = (choice: any) => {
      const d = choice?.delta ?? choice?.message ?? {};
      if (typeof d.content === 'string' && d.content) {
        text += d.content;
        req.onText?.(d.content);
      }
      for (const tc of d.tool_calls ?? []) {
        const i = typeof tc.index === 'number' ? tc.index : calls.length;
        const c = (calls[i] ??= { name: '', args: '' });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
    };

    if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      // Some servers ignore stream: true and answer in one piece.
      const body = await res.json() as any;
      if (body.error) throw new ProviderError(errorMessage(JSON.stringify(body)), Number(body.error.code) || 400);
      take(body.choices?.[0]);
    } else {
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let parsed: any;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          if (parsed.error) throw new ProviderError(errorMessage(data), Number(parsed.error.code) || 500);
          take(parsed.choices?.[0]);
        }
      }
    }

    const content: BetaContentBlock[] = [];
    if (text.trim()) content.push({ type: 'text', text, citations: null } as BetaContentBlock);
    calls.forEach((c, i) => {
      if (!c.name) return;
      let input: unknown = {};
      try {
        input = c.args.trim() ? JSON.parse(c.args) : {};
      } catch {
        input = { _unparsed_arguments: c.args };
      }
      const id = (c.id ?? `call_${Date.now().toString(36)}_${i}`).replace(/[^a-zA-Z0-9_-]/g, '_');
      content.push({ type: 'tool_use', id, name: c.name, input } as BetaContentBlock);
    });
    if (!content.length && finish !== 'length') throw new ProviderError('The model returned an empty reply', 502);
    const stop: BetaStopReason = content.some((b) => b.type === 'tool_use') ? 'tool_use'
      : finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : 'end_turn';
    return { content, stopReason: stop };
  }

  async complete(system: string, prompt: string, maxTokens = 2_000, _chain?: string[] | null, signal?: AbortSignal): Promise<string> {
    const res = await this.post({
      model: this.opts.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      max_tokens: maxTokens,
    }, signal);
    const body = await res.json() as any;
    return String(body.choices?.[0]?.message?.content ?? '').trim();
  }
}

/** Anthropic-format history to Chat Completions messages. */
export function toChatMessages(system: string, messages: BetaMessageParam[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push(m.role === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', content: m.content });
      continue;
    }
    if (m.role === 'user') {
      const texts: string[] = [];
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          const body = typeof b.content === 'string' ? b.content
            : (b.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
          out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: `${b.is_error ? 'Error: ' : ''}${body}` });
        } else if (b.type === 'text') {
          texts.push(b.text);
        }
      }
      if (texts.length) out.push({ role: 'user', content: texts.join('\n\n') });
    } else {
      const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
      const toolCalls = m.content.filter((b) => b.type === 'tool_use').map((b) => {
        const u = b as { id: string; name: string; input: unknown };
        return { id: u.id, type: 'function' as const, function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) } };
      });
      out.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    }
  }
  return out;
}

function errorMessage(text: string): string {
  try {
    const body = JSON.parse(text);
    const e = body.error ?? body;
    return String(e.message ?? e.error ?? text).slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}
