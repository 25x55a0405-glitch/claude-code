import type { BetaMessageParam, BetaToolResultBlockParam, BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { Message } from '../types.ts';
import { firstLine, iso, uid } from '../util.ts';
import type { AgentDeps } from './deps.ts';
import { errorResult, executeTool } from './execute.ts';
import { contextMemory } from './memory.ts';
import { contextNote, systemPrompt } from './prompt.ts';
import { availableTools, findTool, toSpec } from './tools/index.ts';
import { validateInput, type ToolContext } from './tools/types.ts';

const MAX_TURNS = 8;
const HISTORY = 40;

/**
 * Replies in a conversation. The reply streams to the UI as message.delta
 * events and ends with message.done. Chat only uses internal and read tools;
 * anything that acts on the world becomes a task, where approvals apply.
 */
export class ChatAgent {
  deps: AgentDeps;
  private inFlight = new Map<string, Promise<void>>();

  constructor(deps: AgentDeps) {
    this.deps = deps;
  }

  /** Queues a reply so two quick messages in one conversation answer in order. */
  reply(conversationId: string): Promise<void> {
    const prev = this.inFlight.get(conversationId) ?? Promise.resolve();
    const next = prev.then(() => this.replyNow(conversationId)).catch((err) => console.error('[chat]', err));
    this.inFlight.set(conversationId, next);
    void next.finally(() => {
      if (this.inFlight.get(conversationId) === next) this.inFlight.delete(conversationId);
    });
    return next;
  }

  private history(conversationId: string): BetaMessageParam[] {
    const out: BetaMessageParam[] = [];
    for (const m of this.deps.store.messages(conversationId).slice(-HISTORY)) {
      if (m.role === 'system' || !m.content.trim() || m.status === 'error') continue;
      const role = m.role === 'user' ? 'user' : 'assistant';
      const last = out[out.length - 1];
      if (last?.role === role) last.content = `${last.content}\n\n${m.content}`;
      else out.push({ role, content: m.content });
    }
    while (out.length && out[0].role !== 'user') out.shift();
    return out;
  }

  private async replyNow(conversationId: string) {
    const { store, brain, providers, config, bus } = { ...this.deps, bus: this.deps.store.bus };
    const settings = store.settings();
    const messages = this.history(conversationId);
    if (!messages.length || messages[messages.length - 1].role !== 'user') return;

    // Volatile context rides on the newest user turn so the cached prefix stays intact.
    const last = messages[messages.length - 1];
    const memory = contextMemory(store.listMemory(), String(last.content));
    messages[messages.length - 1] = { role: 'user', content: `${contextNote(settings, memory)}\n\n${last.content}` };

    const reply: Message = { id: uid('msg'), conversationId, role: 'agent', content: '', createdAt: iso(), status: 'streaming' };
    store.saveMessage(reply);
    const ctx: ToolContext = {
      store, config, providers, runtime: this.deps.hooks, conversationId, touchedTasks: new Set(),
      source: `Chat on ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: settings.timezone })}`,
    };
    const emit = (delta: string) => {
      if (!delta) return;
      reply.content += delta;
      bus.emit({ type: 'message.delta', data: { conversationId, messageId: reply.id, delta } });
    };

    try {
      const tools = availableTools('chat', providers).filter((t) => t.effect === 'internal' || t.effect === 'read');
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        if (turn > 0 && reply.content && !reply.content.endsWith('\n')) emit('\n\n');
        const res = await brain.turn({
          system: systemPrompt(store, providers, 'chat'),
          messages,
          tools: tools.map(toSpec),
          web: providers.isUsable('web') && brain.name === 'claude',
          onText: emit,
          maxTokens: 16_000,
        });
        store.setOffline(false);
        messages.push({ role: 'assistant', content: res.content as BetaMessageParam['content'] });
        if (res.stopReason === 'pause_turn') continue;
        const uses = res.content.filter((b): b is BetaToolUseBlock => b.type === 'tool_use');
        if (!uses.length || res.stopReason === 'refusal') break;
        const results: BetaToolResultBlockParam[] = [];
        for (const use of uses) {
          const tool = findTool(use.name);
          const invalid = tool && tools.includes(tool) ? validateInput(tool, use.input) : `tool ${use.name} is not available`;
          results.push(invalid || !tool ? errorResult(use.id, `Error: ${invalid}`) : await executeTool(this.deps, tool, use.input, ctx, use.id));
        }
        messages.push({ role: 'user', content: results });
      }
      reply.content = reply.content.replace(/\n{3,}/g, '\n\n').trim() || 'Done.';
      reply.status = 'done';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[chat] reply failed', message);
      reply.content = `${reply.content}${reply.content ? '\n\n' : ''}Sorry, I couldn’t finish that reply: ${message}`;
      reply.status = 'error';
    }
    if (ctx.touchedTasks.size) reply.cards = [...ctx.touchedTasks].map((taskId) => ({ kind: 'task' as const, taskId }));
    store.saveMessage(reply);
    store.patchConversation(conversationId, { updatedAt: iso(), preview: firstLine(reply.content, 120) });
    bus.emit({ type: 'message.done', data: reply });
  }
}
