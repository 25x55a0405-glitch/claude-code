import type { BetaContentBlock, BetaMessageParam, BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { firstLine } from '../util.ts';
import type { Brain, TurnRequest, TurnResult } from './brain.ts';

/**
 * A deterministic stand-in for Claude. It understands just enough (set up a
 * reminder, start a task, remember a preference, send the email a task asks
 * for) to exercise every path in the server, so the back end runs, demos and
 * tests without an API key. It never pretends to have real answers.
 */
export class ScriptedBrain implements Brain {
  readonly name = 'scripted';
  private n = 0;

  private id() {
    return `toolu_scripted_${++this.n}`;
  }

  private text(t: string): BetaContentBlock {
    return { type: 'text', text: t, citations: null } as BetaContentBlock;
  }

  private use(name: string, input: Record<string, unknown>): BetaContentBlock {
    return { type: 'tool_use', id: this.id(), name, input, caller: { type: 'direct' } } as unknown as BetaContentBlock;
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    const content = req.tools.some((t) => t.name === 'create_task') ? this.chat(req) : this.task(req);
    const text = content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
    if (req.onText && text) for (const chunk of text.match(/\S+\s*/g) ?? []) req.onText(chunk);
    return { content, stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' };
  }

  async complete(_system: string, prompt: string): Promise<string> {
    if (prompt.startsWith('Rules the person set')) return this.ruleCheck(prompt);
    return '';
  }

  /** Keyword version of the rule check: a rule applies when it shares a meaningful word with the action. */
  private ruleCheck(prompt: string): string {
    const rules = [...prompt.matchAll(/^(\d+)\. (.*)$/gm)].map((m) => ({ n: m[1], text: m[2].toLowerCase() }));
    const action = (/The assistant wants to: (.*)/.exec(prompt)?.[1] ?? '').toLowerCase();
    const verbs = action.match(/[a-z]{4,}/g) ?? [];
    for (const r of rules) {
      if (!verbs.some((v) => r.text.includes(v))) continue;
      if (/\bnever\b|\bdon[’']?t\b|\bdo not\b/.test(r.text)) return `${r.n} forbid`;
      if (/without asking|no need to ask|automatically/.test(r.text)) return `${r.n} allow`;
      if (/\bask\b|\bcheck with\b|\bconfirm\b/.test(r.text)) return `${r.n} ask`;
    }
    return 'none';
  }

  private lastUser(messages: BetaMessageParam[]) {
    const m = messages[messages.length - 1];
    if (typeof m.content === 'string') return { text: m.content.replace(/^\[Context\][\s\S]*?\n\n/, ''), results: [] as BetaToolResultBlockParam[] };
    const results = m.content.filter((b): b is BetaToolResultBlockParam => b.type === 'tool_result');
    return { text: '', results };
  }

  private chat(req: TurnRequest): BetaContentBlock[] {
    const { text, results } = this.lastUser(req.messages);
    if (results.length) {
      const prev = req.messages[req.messages.length - 2];
      const used = Array.isArray(prev.content) ? prev.content.find((b) => b.type === 'tool_use') as { name: string; input: any } | undefined : undefined;
      const failed = results.some((r) => r.is_error);
      if (failed) return [this.text(`That didn’t work: ${String(results[0].content).replace(/^Error: /, '')}`)];
      if (used?.name === 'create_task') {
        return [this.text(used.input.kind === 'one_off'
          ? 'On it. I started a task for this and I’ll keep working in the background. You’ll see progress in **Goals**.'
          : `Done. I set that up as a ${used.input.kind === 'watch' ? 'watch' : 'recurring'} task (${used.input.schedule}). You can change it any time from **Goals**.`)];
      }
      if (used?.name === 'remember') return [this.text('Got it. I’ll remember that.')];
      if (used?.name === 'list_tasks') return [this.text(`Here’s what I’m on:\n${String(results[0].content)}`)];
      return [this.text('Done.')];
    }
    const lower = text.toLowerCase();
    const title = firstLine(text.replace(/^(please|can you|could you)\s+/i, ''), 60).replace(/^./, (c) => c.toUpperCase());
    if (/\b(remind|every|daily|weekly|each (morning|day|week)|weekdays|hourly)\b/.test(lower)) {
      return [this.use('create_task', { title, description: text, kind: 'recurring', schedule: text })];
    }
    if (/\b(watch|track|monitor|alert me|let me know when|keep an eye)\b/.test(lower)) {
      return [this.use('create_task', { title, description: text, kind: 'watch', schedule: 'every 3 hours' })];
    }
    if (/\b(find|research|look up|look into|book|search|draft|email|send|plan|compare|summari[sz]e)\b/.test(lower)) {
      return [this.use('create_task', { title, description: text, kind: 'one_off' })];
    }
    const pref = /\b(remember|i prefer|i like|i love|i hate|i don[’']?t like|my name is|i am|i'm)\b(.*)/i.exec(text);
    if (pref) {
      const content = firstLine(text.replace(/^remember( that)?\s*/i, ''), 200);
      return [this.use('remember', { category: /prefer|like|love|hate/i.test(text) ? 'preference' : 'fact', content: content.replace(/^./, (c) => c.toUpperCase()) })];
    }
    if (/\b(what are you (doing|up to)|status|my tasks|what.*working on)\b/.test(lower)) return [this.use('list_tasks', {})];
    if (/^(hi|hello|hey|yo|good (morning|afternoon|evening))\b/.test(lower)) {
      return [this.text('Hey! I’m here and keeping an eye on things. Ask me to look into something, set up a reminder, or keep track of anything for you.')];
    }
    return [this.text('I’m running in offline mode right now, so I can’t think that through properly. I can still set up tasks, reminders and watches, and remember things for you. '
      + 'To unlock full answers, the server needs an Anthropic API key.')];
  }

  private task(req: TurnRequest): BetaContentBlock[] {
    const brief = typeof req.messages[0].content === 'string' ? req.messages[0].content : '';
    const title = /^Task: (.*)$/m.exec(brief)?.[1] ?? 'the task';
    const description = /^Brief: (.*)$/m.exec(brief)?.[1] ?? '';
    const turns = req.messages.filter((m) => m.role === 'assistant').length;
    const has = (name: string) => req.tools.some((t) => t.name === name);
    const email = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(description)?.[0];

    if (turns === 0) {
      return [this.text(`Plan: ${firstLine(description || title, 140)}`), this.use('update_progress', { summary: 'Worked through the brief', progress: 0.5 })];
    }
    if (turns === 1 && email && has('send_email')) {
      return [this.use('send_email', { to: email, subject: title, body: `Hi,\n\n${description}\n\nSent by Skys` })];
    }
    const { results } = this.lastUser(req.messages);
    const declined = results.some((r) => /declined|expired/.test(String(r.content)));
    const failed = results.some((r) => r.is_error);
    const outcome = declined ? 'Skipped sending as you asked' : failed ? `Couldn’t finish: ${String(results.find((r) => r.is_error)?.content)}` : email && turns >= 2 ? `Sent the email to ${email}` : `Done: ${title}`;
    return [this.use('finish_task', { outcome })];
  }
}
