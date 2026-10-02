import type { BetaContentBlock, BetaMessageParam, BetaToolResultBlockParam, BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { Approval, ApprovalDecision, Star, Task } from '../types.ts';
import { firstLine, iso, truncate } from '../util.ts';
import { BrainUnavailable } from './brain.ts';
import type { AgentDeps } from './deps.ts';
import { errorResult, executeTool } from './execute.ts';
import { contextMemory } from './memory.ts';
import { contextNote, systemPrompt, takeInbox, taskBrief } from './prompt.ts';
import { MAX_ASK_DEPTH, targetStar } from './tools/constellation.ts';
import { availableTools, findTool, toSpec } from './tools/index.ts';
import { validateInput, type ToolContext, type ToolDef, type ToolEnv } from './tools/types.ts';
import type { Verdict } from './policy.ts';

/**
 * A tool call waiting on someone: the person (an approval) or another Star
 * (an ask_star request, answered when its task ends).
 */
interface PendingCall {
  toolUseId: string;
  approvalId?: string;
  childTaskId?: string;
  name: string;
  input: unknown;
  /** Waiting for the person to hand the browser back (they took over, or the Star asked them to). */
  handover?: boolean;
  /** A checkout handed over: the approval first, then the person pays in the browser. */
  checkout?: boolean;
  decision?:
    | { outcome: 'approved' | 'rejected' | 'expired'; editedPreview?: string; note?: string }
    | { outcome: 'answered'; answer: string; failed: boolean }
    | { outcome: 'handed_back'; note: string | null };
}

/**
 * A task run's conversation with the model, saved after every turn so a run
 * survives restarts and can wait days for an approval. The message list is
 * append-only, which keeps prompt caching and thinking blocks valid.
 */
interface RunState {
  id: string;
  messages: BetaMessageParam[];
  /** Results for the current turn's tool calls, sent together once all are in. */
  results: BetaToolResultBlockParam[];
  pending: PendingCall[];
  turns: number;
  startedAt: string;
}

export type RunEnd = 'finished' | 'waiting' | 'stopped' | 'offline';

export class TaskRunner {
  deps: AgentDeps;

  constructor(deps: AgentDeps) {
    this.deps = deps;
  }

  private load(taskId: string) {
    return this.deps.store.db.get<RunState>('run', taskId);
  }

  private save(state: RunState) {
    this.deps.store.db.put('run', state);
  }

  hasRun(taskId: string) {
    return Boolean(this.load(taskId));
  }

  discard(taskId: string) {
    this.deps.store.db.delete('run', taskId);
  }

  private fresh(task: Task, star: Star): RunState {
    const { store } = this.deps;
    const recent = task.kind === 'one_off' ? [] : store.steps(task.id, 12).map((s) => `${s.at} ${s.kind}: ${s.summary}`);
    const memory = contextMemory(store.listMemory(star.id), `${task.title} ${task.description}`);
    const asker = task.requestedBy ? store.findStar(task.requestedBy.starId)?.name : undefined;
    const event = this.deps.triggers?.take(task.id);
    const text = `${contextNote(store.settings(), memory, takeInbox(store, star.id))}\n\n${taskBrief(task, recent, asker, event)}`;
    return { id: task.id, messages: [{ role: 'user', content: text }], results: [], pending: [], turns: 0, startedAt: iso() };
  }

  /** Runs a task until it finishes, waits on an approval, or is stopped. */
  async run(taskId: string, shouldStop: () => boolean): Promise<RunEnd> {
    const { store, brain, providers, config } = this.deps;
    let task = store.getTask(taskId);
    const star = store.findStar(store.starIdOf(task)) ?? store.mainStar();
    let state = this.load(taskId);
    if (!state) {
      state = this.fresh(task, star);
      this.save(state);
      store.log('task_started', task.lastRunAt ? `Running: ${task.title}` : `Started: ${task.title}`, task.id);
    }
    store.setActivity(`Working on ${firstLine(task.title, 60)}`, task.id);

    const ctx: ToolContext = {
      store, config, providers, runtime: this.deps.hooks, star, browser: this.deps.browser, workspaces: this.deps.workspaces, vault: this.deps.vault, companion: this.deps.companion,
      task, source: `Task: ${firstLine(task.title, 40)}`, touchedTasks: new Set(),
    };
    const env = { starId: star.id, browser: this.deps.browser, workspaces: this.deps.workspaces, vault: this.deps.vault, companion: this.deps.companion };

    // Carry out whatever the person decided, or read the other Star's answer, while the task was waiting.
    if (state.pending.length) {
      if (state.pending.some((p) => !p.decision)) {
        this.markWaiting(task, state);
        return 'waiting';
      }
      for (const p of state.pending) state.results.push(await this.applyDecision(p, ctx));
      state.pending = [];
      this.flushResults(state);
      this.save(state);
    }

    while (true) {
      task = store.getTask(taskId);
      ctx.task = task;
      if (shouldStop() || task.status !== 'active') {
        if (task.status === 'done' || task.status === 'failed') this.discard(taskId);
        else this.save(state);
        return 'stopped';
      }
      if (state.turns >= config.maxStepsPerRun) {
        this.finish(task, `Stopped after ${state.turns} steps without finishing. I’ll pick it up again next run.`, task.kind === 'one_off');
        return 'finished';
      }
      state.turns++;

      const tools = [...availableTools('task', providers, star), ...(this.deps.mcp?.toolsFor(star) ?? [])];
      let turn;
      try {
        turn = await brain.turn({
          system: systemPrompt(store, providers, 'task', star),
          messages: state.messages,
          tools: tools.map(toSpec),
          web: providers.isUsable('web'),
          chain: star.providerIds,
        });
      } catch (err) {
        state.turns--;
        this.save(state);
        if (err instanceof BrainUnavailable) {
          store.addStep(task.id, { kind: 'error', summary: 'Couldn’t reach the model. Will retry shortly.', detail: err.message });
          return 'offline';
        }
        const message = err instanceof Error ? err.message : String(err);
        store.addStep(task.id, { kind: 'error', summary: firstLine(`Run failed: ${message}`, 160), detail: message });
        this.finish(task, `Failed: ${firstLine(message, 100)}`, true);
        return 'finished';
      }
      store.setOffline(false);
      state.messages.push({ role: 'assistant', content: turn.content as BetaMessageParam['content'] });
      this.save(state);
      this.recordContent(task, turn.content, state.turns === 1);

      if (turn.stopReason === 'refusal') {
        this.finish(task, 'I can’t help with this task.', true);
        return 'finished';
      }
      if (turn.stopReason === 'pause_turn') continue;

      const uses = turn.content.filter((b): b is BetaToolUseBlock => b.type === 'tool_use');
      if (!uses.length) {
        const text = lastText(turn.content);
        this.finish(task, text ? firstLine(text, 160) : 'Done', false);
        return 'finished';
      }
      if (turn.stopReason === 'max_tokens') {
        state.results = uses.map((u) => errorResult(u.id, 'Your output was cut off. Try again with a shorter input.'));
        this.flushResults(state);
        this.save(state);
        continue;
      }

      const why = lastText(turn.content) || task.title;
      let finishing: { outcome: string; failed?: boolean } | null = null;
      for (const use of uses) {
        const tool = findTool(use.name) ?? this.deps.mcp?.find(use.name);
        if (!tool || !tools.includes(tool)) {
          state.results.push(errorResult(use.id, `Tool ${use.name} is not available right now.`));
          continue;
        }
        const invalid = validateInput(tool, use.input);
        if (invalid) {
          state.results.push(errorResult(use.id, `Invalid input: ${invalid}`));
          continue;
        }
        if (tool.name === 'finish_task') {
          finishing = use.input as { outcome: string; failed?: boolean };
          state.results.push({ type: 'tool_result', tool_use_id: use.id, content: 'Finished.' });
          continue;
        }
        if (tool.name === 'ask_star') {
          const asked = this.askStar(task, ctx, use.id, use.input as { star: string; request: string });
          if (typeof asked === 'string') state.results.push(errorResult(use.id, asked));
          else state.pending.push(asked);
          continue;
        }
        // The person has the browser: browser calls wait for the hand-back. The Star can also ask for it.
        const browser = this.deps.browser;
        if (browser && tool.name === 'browser_checkout_handover' && browser.controller(star.id) === 'star') {
          state.pending.push(await this.checkout(task, star, use.id, use.input as { total: string; merchant?: string; summary: string }));
          continue;
        }
        if (browser && (tool.name === 'browser_ask_person' || tool.name === 'browser_checkout_handover' || (tool.connection === 'browser' && browser.controller(star.id) === 'person'))) {
          state.pending.push(await this.handover(task, star, tool.name, use.id, use.input as { reason?: string }));
          continue;
        }
        const verdict = await this.verdict(tool, use.input, firstLine(why, 300), star, task, env);
        if (verdict.kind === 'forbid') {
          store.addStep(task.id, { kind: 'note', summary: firstLine(`Didn’t ${tool.label(use.input).toLowerCase()}: ${verdict.reason}`, 160) });
          state.results.push(errorResult(use.id, `Not allowed: ${verdict.reason}`));
        } else if (verdict.kind === 'ask') {
          const p = tool.approval?.(use.input, env) ?? { action: tool.label(use.input), target: tool.connection ?? star.name, preview: JSON.stringify(use.input, null, 2) };
          const approval = store.createApproval({
            taskId: task.id, starId: star.id, action: p.action, target: p.target, reason: verdict.reason, preview: p.preview,
            ...(tool.connection ? { connectionId: tool.connection } : {}),
            risk: verdict.risk, expiresAt: iso(Date.now() + 24 * 3_600_000),
          });
          store.addStep(task.id, { kind: 'approval', summary: firstLine(`Asked you before: ${p.action} to ${p.target}`, 160), ...(tool.connection ? { connectionId: tool.connection } : {}) });
          await this.deps.hooks.notify(`Can I ${lowerFirst(p.action)} to ${p.target}? ${firstLine(verdict.reason, 200)}`, {
            taskId: task.id, starId: star.id, kind: 'needs_you', cards: [{ kind: 'approval', approvalId: approval.id }],
          });
          state.pending.push({ toolUseId: use.id, approvalId: approval.id, name: tool.name, input: use.input });
        } else {
          state.results.push(await executeTool(this.deps, tool, use.input, ctx, use.id));
        }
      }

      if (state.pending.length) {
        if (finishing) {
          // Don't let the task close before the person (or the other Star) has answered.
          const r = state.results.find((x) => x.content === 'Finished.');
          if (r) r.content = 'Not finished yet: some calls are still waiting for an answer. Call finish_task again once you have them.';
          finishing = null;
        }
        this.save(state);
        this.markWaiting(task, state);
        return 'waiting';
      }
      this.flushResults(state);
      this.save(state);
      if (finishing && store.getTask(taskId).status === 'active') {
        this.finish(store.getTask(taskId), finishing.outcome, Boolean(finishing.failed), true);
        return 'finished';
      }
    }
  }

  /** Shows what a waiting task waits on: the person's OK, or another Star. */
  private markWaiting(task: Task, state: RunState) {
    const { store } = this.deps;
    const open = state.pending.filter((p) => !p.decision);
    if (open.some((p) => p.approvalId)) {
      store.patchTask(task.id, { status: 'waiting_approval', lastOutcome: 'Waiting for your OK' });
    } else if (open.some((p) => p.handover)) {
      store.patchTask(task.id, { status: 'blocked', lastOutcome: 'Waiting for you to hand the browser back' });
    } else {
      const names = [...new Set(open.map((p) => store.findTask(p.childTaskId!)).map((t) => (t && store.findStar(store.starIdOf(t))?.name) ?? 'another Star'))];
      store.patchTask(task.id, { status: 'blocked', lastOutcome: `Waiting on ${names.join(' and ')}` });
    }
    store.setActivity(null);
  }

  /** Starts an ask_star request: a task for the other Star that answers this call when it ends. */
  private askStar(task: Task, ctx: ToolContext, toolUseId: string, input: { star: string; request: string }): PendingCall | string {
    const { store, hooks } = this.deps;
    let target: Star;
    try {
      target = targetStar(ctx, input.star);
    } catch (err) {
      return (err as Error).message;
    }
    const depth = (task.requestedBy?.depth ?? 0) + 1;
    if (depth > MAX_ASK_DEPTH) return `Too many Stars are already waiting on each other in this chain (limit ${MAX_ASK_DEPTH}). Do this part yourself.`;
    const child = hooks.createTask(
      { title: firstLine(input.request, 80).replace(/^./, (c) => c.toUpperCase()), description: input.request, kind: 'one_off', starId: target.id },
      ctx.star.name, { starId: ctx.star.id, taskId: task.id, depth },
    );
    store.sendTeamMessage({ fromStarId: ctx.star.id, toStarId: target.id, kind: 'request', content: input.request, taskId: child.id });
    store.addStep(task.id, { kind: 'note', summary: firstLine(`Asked ${target.name}: ${input.request}`, 160) });
    return { toolUseId, childTaskId: child.id, name: 'ask_star', input };
  }

  /**
   * The guard looks first (see guard.ts), then the policy. The guard can only
   * make things stricter: its "block" stops the call, and its "ask" turns an
   * action the policy would allow into an approval.
   */
  private async verdict(tool: ToolDef, input: unknown, why: string, star: Star, task: Task, env: ToolEnv): Promise<Verdict> {
    const { guard, policy, store } = this.deps;
    const effect = tool.effectFor?.(input, env) ?? tool.effect;
    const preview = tool.approval?.(input, env) ?? { action: tool.label(input), target: tool.connection ?? star.name, preview: JSON.stringify(input, null, 2) };
    const g = guard ? await guard.check(tool, input, effect, preview, star, task) : null;
    if (g?.verdict === 'block') return { kind: 'forbid', reason: `The guard stopped this: ${g.reason}` };
    const v = await policy.check(tool, input, why, star);
    if (g?.verdict !== 'ask' || v.kind === 'forbid') return v;
    if (g.verdict === 'ask') store.addStep(task.id, { kind: 'note', summary: firstLine(`The guard wants your OK: ${g.reason}`, 160) });
    return { kind: 'ask', reason: `The guard wants your OK: ${g.reason}${v.kind === 'ask' ? ` (${v.reason})` : ''}`, risk: 'high' };
  }

  /** The task waits for the person to hand the browser back. */
  private async handover(task: Task, star: Star, name: string, toolUseId: string, input: { reason?: string }): Promise<PendingCall> {
    const { store, hooks } = this.deps;
    const browser = this.deps.browser!;
    if (name === 'browser_ask_person') {
      const reason = firstLine(input.reason || 'I need your help in the browser', 200);
      await browser.takeOver(star.id, { note: reason, waitingTaskId: task.id });
      store.addStep(task.id, { kind: 'approval', summary: firstLine(`Asked you to take over the browser: ${reason}`, 160), connectionId: 'browser' });
      await hooks.notify(`I need you in the browser: ${reason}. Open my live browser, do it there, then hand it back.`, {
        taskId: task.id, starId: star.id, kind: 'needs_you', cards: [{ kind: 'task', taskId: task.id }],
      });
    } else {
      browser.waitForHandBack(star.id, task.id);
      store.addStep(task.id, { kind: 'note', summary: 'Waiting: you have the browser', connectionId: 'browser' });
    }
    return { toolUseId, handover: true, name, input };
  }

  /**
   * A checkout is ready to pay: an approval with the total. Accepting it
   * gives the person the browser to pay (see recordDecision); Stars never
   * enter card details or press the final pay button.
   */
  private async checkout(task: Task, star: Star, toolUseId: string, input: { total: string; merchant?: string; summary: string }): Promise<PendingCall> {
    const { store, hooks } = this.deps;
    const browser = this.deps.browser!;
    const page = browser.currentPage(star.id);
    let host = 'the shop';
    try {
      if (page?.url) host = new URL(page.url).host;
    } catch { /* keep the default */ }
    const merchant = firstLine(input.merchant?.trim() || host, 60);
    const total = firstLine(input.total.trim(), 40);
    const approval = store.createApproval({
      taskId: task.id, starId: star.id, action: `Pay ${total} at ${merchant}`, target: host, connectionId: 'browser', risk: 'high',
      reason: `${star.name} filled in the checkout up to payment. If you accept, you take over the browser and pay yourself; Stars never enter card details.`,
      preview: `${truncate(input.summary, 1200)}\n\nTotal: ${total}${page ? `\nOn “${page.title || page.url}” (${page.url})` : ''}`,
      expiresAt: iso(Date.now() + 24 * 3_600_000),
    });
    browser.setCheckout(star.id, { taskId: task.id, total, merchant, summary: firstLine(input.summary, 300), url: page?.url ?? '', stage: 'waiting_ok' });
    store.addStep(task.id, { kind: 'approval', summary: firstLine(`Checkout ready: ${total} at ${merchant}. Asked you to pay`, 160), connectionId: 'browser' });
    await hooks.notify(`Ready to pay ${total} at ${merchant}. Accept to take over my browser and pay yourself, or decline to drop it.`, {
      taskId: task.id, starId: star.id, kind: 'needs_you', urgent: true, cards: [{ kind: 'approval', approvalId: approval.id }],
    });
    return { toolUseId, approvalId: approval.id, checkout: true, name: 'browser_checkout_handover', input };
  }

  /** The person handed the browser back. Returns true once every pending call in the run is answered. */
  recordHandBack(taskId: string, note: string | null): boolean {
    const state = this.load(taskId);
    const open = state?.pending.filter((p) => p.handover && !p.decision) ?? [];
    if (!state || !open.length) return false;
    for (const p of open) p.decision = { outcome: 'handed_back', note };
    this.save(state);
    return state.pending.every((x) => x.decision);
  }

  /** Records another Star's answer. Returns null if nothing was waiting on it, else whether every pending call is now answered. */
  recordReply(parentTaskId: string, childTaskId: string, answer: string, failed: boolean): boolean | null {
    const state = this.load(parentTaskId);
    const p = state?.pending.find((x) => x.childTaskId === childTaskId);
    if (!state || !p) return null;
    p.decision = { outcome: 'answered', answer, failed };
    this.save(state);
    return state.pending.every((x) => x.decision);
  }

  private flushResults(state: RunState) {
    if (!state.results.length) return;
    state.messages.push({ role: 'user', content: state.results });
    state.results = [];
  }

  /** Thoughts and web lookups from a model turn, as timeline steps. */
  private recordContent(task: Task, content: BetaContentBlock[], first: boolean) {
    const { store } = this.deps;
    for (const b of content) {
      if (b.type === 'text' && b.text.trim()) {
        const summary = firstLine(b.text, 160);
        store.addStep(task.id, { kind: first ? 'plan' : 'thought', summary, ...(b.text.length > summary.length ? { detail: truncate(b.text, 4000) } : {}) });
        store.setActivity(firstLine(b.text, 80), task.id);
      } else if (b.type === 'server_tool_use') {
        const input = b.input as { query?: string; url?: string };
        const summary = b.name === 'web_search' ? `Searched the web: ${input.query ?? ''}` : `Read ${input.url ?? 'a web page'}`;
        store.addStep(task.id, { kind: 'tool', summary: firstLine(summary, 160), connectionId: 'web' });
        store.setActivity(firstLine(summary, 80), task.id);
      }
    }
  }

  /** Whether an approval is a checkout handed over to pay (declining one isn't a correction to learn from). */
  isCheckout(approval: Approval): boolean {
    return Boolean(approval.taskId && this.load(approval.taskId)?.pending.some((p) => p.approvalId === approval.id && p.checkout));
  }

  /** Records the person's decision. Returns true once every pending call in the run is decided. */
  recordDecision(approval: Approval, decision: ApprovalDecision | 'expired'): boolean {
    if (!approval.taskId) return false;
    const state = this.load(approval.taskId);
    const p = state?.pending.find((x) => x.approvalId === approval.id);
    if (!state || !p) return false;
    if (p.checkout) {
      const browser = this.deps.browser;
      const starId = approval.starId ?? this.deps.store.mainStar().id;
      if (decision !== 'expired' && decision.decision === 'approve' && browser) {
        // Accepted: the person takes the browser to pay, and the task waits for the hand-back.
        const c = p.input as { total: string; merchant?: string };
        p.handover = true;
        this.save(state);
        if (approval.taskId) this.deps.store.patchTask(approval.taskId, { status: 'blocked', lastOutcome: 'Waiting for you to pay, then hand the browser back' });
        const now = browser.sessions().find((x) => x.starId === starId)?.checkout;
        if (now) browser.setCheckout(starId, { ...now, stage: 'paying' });
        void browser.takeOver(starId, { note: `Pay ${firstLine(c.total, 40)} yourself, then hand back`, waitingTaskId: approval.taskId }).catch(() => {});
        return false;
      }
      browser?.setCheckout(starId, null);
    }
    p.decision = decision === 'expired'
      ? { outcome: 'expired' }
      : { outcome: decision.decision === 'approve' ? 'approved' : 'rejected', editedPreview: decision.editedPreview, note: decision.note };
    this.save(state);
    return state.pending.every((x) => x.decision);
  }

  private async applyDecision(p: PendingCall, ctx: ToolContext): Promise<BetaToolResultBlockParam> {
    const { store } = this.deps;
    const found = findTool(p.name) ?? this.deps.mcp?.find(p.name);
    const d = p.decision!;
    if (d.outcome === 'handed_back') {
      if (ctx.task) store.addStep(ctx.task.id, { kind: 'result', summary: firstLine(`You handed the browser back${d.note ? `: ${d.note}` : ''}`, 160), connectionId: 'browser' });
      const asked = p.checkout ? 'The person took over the checkout to pay and has handed the browser back. Don’t assume it was paid: check the page.'
        : p.name === 'browser_ask_person' ? 'The person did what you asked and handed the browser back.'
          : `The person had taken over the browser, so ${p.name} wasn’t run. They’ve handed it back.`;
      return { type: 'tool_result', tool_use_id: p.toolUseId, content: `${asked}${d.note ? ` Their note: “${d.note}”` : ''} Take a fresh snapshot before carrying on.` };
    }
    if (d.outcome === 'answered') {
      const child = store.findTask(p.childTaskId!);
      const who = (child && store.findStar(store.starIdOf(child))?.name) ?? 'The other Star';
      if (ctx.task) store.addStep(ctx.task.id, { kind: 'result', summary: firstLine(`${who} ${d.failed ? 'couldn’t do it' : 'answered'}: ${d.answer}`, 160), ...(d.answer.length > 140 ? { detail: d.answer } : {}) });
      return { type: 'tool_result', tool_use_id: p.toolUseId, content: `${who} ${d.failed ? 'couldn’t do it' : 'replied'}: ${d.answer}`, ...(d.failed ? { is_error: true } : {}) };
    }
    if (!found) return errorResult(p.toolUseId, `${p.name} isn’t available any more (its MCP server may have disconnected), so it wasn’t run.`);
    const tool = found;
    const note = d.note ? ` Their note: “${d.note}”` : '';
    if (d.outcome === 'approved') {
      const input = d.editedPreview && tool.applyEdit ? tool.applyEdit(p.input, d.editedPreview) : p.input;
      if (tool.connection && !this.deps.providers.isUsable(tool.connection)) {
        return errorResult(p.toolUseId, `Approved, but ${tool.connection} is no longer connected.`);
      }
      const result = await executeTool(this.deps, tool, input, ctx, p.toolUseId);
      const edited = d.editedPreview ? ' The person edited it before approving; this is what was used.' : '';
      return { ...result, content: `${result.content}${edited}${note}` };
    }
    const why = p.checkout
      ? (d.outcome === 'expired' ? 'Nobody took the checkout within a day, so nothing was paid.' : 'The person declined to pay, so nothing was bought. Leave the checkout as it is.')
      : d.outcome === 'expired' ? 'The approval expired without an answer, so it was skipped.' : 'The person declined this action, so it was not done.';
    if (ctx.task) store.addStep(ctx.task.id, { kind: 'note', summary: firstLine(`${tool.label(p.input)}: ${d.outcome === 'expired' ? 'skipped, approval expired' : 'skipped as you asked'}`, 160) });
    return { type: 'tool_result', tool_use_id: p.toolUseId, content: `${why}${note}` };
  }

  /** Closes a run: one-off tasks end, recurring and watch tasks go back to their schedule. */
  finish(task: Task, outcome: string, failed: boolean, reported = false) {
    const { store } = this.deps;
    this.discard(task.id);
    // Stopped by the person while this run was in flight: their stop wins.
    if (store.findTask(task.id)?.status === 'done' && task.status !== 'done') return;
    const now = iso();
    store.addStep(task.id, { kind: failed ? 'error' : 'result', summary: firstLine(outcome, 200), ...(outcome.length > 200 ? { detail: outcome } : {}) });
    if (task.kind === 'one_off') {
      store.patchTask(task.id, { status: failed ? 'failed' : 'done', lastOutcome: firstLine(outcome, 160), lastRunAt: now, ...(failed ? {} : { progress: 1 }) });
    } else {
      const latest = store.getTask(task.id);
      store.patchTask(task.id, {
        status: latest.status === 'paused' ? 'paused' : 'scheduled', lastOutcome: firstLine(outcome, 160), lastRunAt: now,
        nextRunAt: this.deps.hooks.nextRunAt(latest, new Date()),
      });
    }
    store.log(failed ? 'task_failed' : 'task_completed', `${failed ? 'Failed' : task.kind === 'one_off' ? 'Finished' : 'Ran'}: ${firstLine(task.title, 60)}. ${firstLine(outcome, 120)}`, task.id);
    store.setActivity(null);
    this.deps.hooks.dropAsks(task.id, `No longer needed: “${firstLine(task.title, 60)}” ended`);
    if (task.kind === 'one_off' && task.requestedBy) this.deps.hooks.starAnswered(task, outcome, failed);
    this.deps.hooks.taskEnded(task, outcome, failed, reported);
  }
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

const lastText = (content: BetaContentBlock[]) =>
  content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim();
