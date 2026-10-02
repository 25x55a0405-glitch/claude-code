import type { BetaContentBlock, BetaMessageParam, BetaToolResultBlockParam, BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { Approval, ApprovalDecision, Task } from '../types.ts';
import { firstLine, iso, truncate } from '../util.ts';
import { BrainUnavailable } from './brain.ts';
import type { AgentDeps } from './deps.ts';
import { errorResult, executeTool } from './execute.ts';
import { contextMemory } from './memory.ts';
import { contextNote, systemPrompt, taskBrief } from './prompt.ts';
import { availableTools, findTool, toSpec } from './tools/index.ts';
import { validateInput, type ToolContext } from './tools/types.ts';

/** A tool call waiting on the person, and what they decided once they have. */
interface PendingCall {
  toolUseId: string;
  approvalId: string;
  name: string;
  input: unknown;
  decision?: { outcome: 'approved' | 'rejected' | 'expired'; editedPreview?: string; note?: string };
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

  private fresh(task: Task): RunState {
    const { store } = this.deps;
    const recent = task.kind === 'one_off' ? [] : store.steps(task.id, 12).map((s) => `${s.at} ${s.kind}: ${s.summary}`);
    const memory = contextMemory(store.listMemory(), `${task.title} ${task.description}`);
    const text = `${contextNote(store.settings(), memory)}\n\n${taskBrief(task, recent)}`;
    return { id: task.id, messages: [{ role: 'user', content: text }], results: [], pending: [], turns: 0, startedAt: iso() };
  }

  /** Runs a task until it finishes, waits on an approval, or is stopped. */
  async run(taskId: string, shouldStop: () => boolean): Promise<RunEnd> {
    const { store, brain, providers, config } = this.deps;
    let task = store.getTask(taskId);
    let state = this.load(taskId);
    if (!state) {
      state = this.fresh(task);
      this.save(state);
      store.log('task_started', task.lastRunAt ? `Running: ${task.title}` : `Started: ${task.title}`, task.id);
    }
    store.setActivity(`Working on ${firstLine(task.title, 60)}`, task.id);

    const ctx: ToolContext = {
      store, config, providers, runtime: this.deps.hooks, task, source: `Task: ${firstLine(task.title, 40)}`, touchedTasks: new Set(),
    };

    // Carry out whatever the person decided on while the task was waiting.
    if (state.pending.length) {
      if (state.pending.some((p) => !p.decision)) return 'waiting';
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

      const tools = availableTools('task', providers);
      let turn;
      try {
        turn = await brain.turn({
          system: systemPrompt(store, providers, 'task'),
          messages: state.messages,
          tools: tools.map(toSpec),
          web: providers.isUsable('web') && brain.name === 'claude',
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
        const tool = findTool(use.name);
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
        const verdict = await this.deps.policy.check(tool, use.input, firstLine(why, 300));
        if (verdict.kind === 'forbid') {
          store.addStep(task.id, { kind: 'note', summary: firstLine(`Didn’t ${tool.label(use.input).toLowerCase()}: ${verdict.reason}`, 160) });
          state.results.push(errorResult(use.id, `Not allowed: ${verdict.reason}`));
        } else if (verdict.kind === 'ask') {
          const p = tool.approval?.(use.input) ?? { action: tool.label(use.input), target: tool.connection ?? 'Skys', preview: JSON.stringify(use.input, null, 2) };
          const approval = store.createApproval({
            taskId: task.id, action: p.action, target: p.target, reason: verdict.reason, preview: p.preview,
            ...(tool.connection ? { connectionId: tool.connection } : {}),
            risk: verdict.risk, expiresAt: iso(Date.now() + 24 * 3_600_000),
          });
          store.addStep(task.id, { kind: 'approval', summary: firstLine(`Asked you before: ${p.action} to ${p.target}`, 160), ...(tool.connection ? { connectionId: tool.connection } : {}) });
          await this.deps.hooks.notify(`Can I ${lowerFirst(p.action)} to ${p.target}? ${firstLine(verdict.reason, 200)}`, {
            taskId: task.id, cards: [{ kind: 'approval', approvalId: approval.id }],
          });
          state.pending.push({ toolUseId: use.id, approvalId: approval.id, name: tool.name, input: use.input });
        } else {
          state.results.push(await executeTool(this.deps, tool, use.input, ctx, use.id));
        }
      }

      if (state.pending.length) {
        if (finishing) {
          // Don't let the task close before the person has answered.
          const r = state.results.find((x) => x.content === 'Finished.');
          if (r) r.content = 'Not finished yet: some actions are waiting for the person. Call finish_task again once you have their answers.';
          finishing = null;
        }
        this.save(state);
        store.patchTask(task.id, { status: 'waiting_approval', lastOutcome: 'Waiting for your OK' });
        store.setActivity(null);
        return 'waiting';
      }
      this.flushResults(state);
      this.save(state);
      if (finishing && store.getTask(taskId).status === 'active') {
        this.finish(store.getTask(taskId), finishing.outcome, Boolean(finishing.failed));
        return 'finished';
      }
    }
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

  /** Records the person's decision. Returns true once every pending call in the run is decided. */
  recordDecision(approval: Approval, decision: ApprovalDecision | 'expired'): boolean {
    if (!approval.taskId) return false;
    const state = this.load(approval.taskId);
    const p = state?.pending.find((x) => x.approvalId === approval.id);
    if (!state || !p) return false;
    p.decision = decision === 'expired'
      ? { outcome: 'expired' }
      : { outcome: decision.decision === 'approve' ? 'approved' : 'rejected', editedPreview: decision.editedPreview, note: decision.note };
    this.save(state);
    return state.pending.every((x) => x.decision);
  }

  private async applyDecision(p: PendingCall, ctx: ToolContext): Promise<BetaToolResultBlockParam> {
    const { store } = this.deps;
    const tool = findTool(p.name)!;
    const d = p.decision!;
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
    const why = d.outcome === 'expired' ? 'The approval expired without an answer, so it was skipped.' : 'The person declined this action, so it was not done.';
    if (ctx.task) store.addStep(ctx.task.id, { kind: 'note', summary: firstLine(`${tool.label(p.input)}: ${d.outcome === 'expired' ? 'skipped, approval expired' : 'skipped as you asked'}`, 160) });
    return { type: 'tool_result', tool_use_id: p.toolUseId, content: `${why}${note}` };
  }

  /** Closes a run: one-off tasks end, recurring and watch tasks go back to their schedule. */
  finish(task: Task, outcome: string, failed: boolean) {
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
  }
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

const lastText = (content: BetaContentBlock[]) =>
  content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim();
