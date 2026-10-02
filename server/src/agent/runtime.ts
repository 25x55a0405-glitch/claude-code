import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { Config } from '../config.ts';
import type { Providers } from '../connections/providers.ts';
import type { Store } from '../store.ts';
import type { Approval, ApprovalDecision, CreateTaskInput, MessageCard, Star, Task, TaskCommand } from '../types.ts';
import { ApiError, badRequest, firstLine, iso, uid } from '../util.ts';
import { generateBriefing } from './briefing.ts';
import { refreshIdeas } from './ideas.ts';
import { BrainUnavailable, type Brain } from './brain.ts';
import { ChatAgent } from './chat.ts';
import type { AgentDeps } from './deps.ts';
import { executeTool } from './execute.ts';
import { contextNote, formatMemory, systemPrompt } from './prompt.ts';
import { Policy } from './policy.ts';
import { TaskRunner } from './runner.ts';
import { describeSchedule, nextRun, parseSchedule } from './schedule.ts';
import { inWindow, localDateKey, localMinutes, parseHHMM } from './time.ts';
import { findTool, toSpec } from './tools/index.ts';
import type { RuntimeHooks, ToolContext } from './tools/types.ts';

const WATCH_DEFAULT = 'every 3 hours';

/**
 * The always-on part of Sky. A clock ticks every few seconds and:
 *  - starts scheduled tasks that are due and queues active ones
 *  - expires approvals nobody answered
 *  - prepares the daily briefing at the person's briefing time
 *  - does a round of proactive research when things are quiet
 * Task runs from every Star go through one queue, one at a time, so the orb
 * always shows the single thing being done and Stars never race each other
 * over the same apps. A Star waiting on another (ask_star) leaves the queue
 * until it's answered. Chat replies don't wait for the queue.
 */
export class Runtime implements RuntimeHooks {
  store: Store;
  config: Config;
  brain: Brain;
  providers: Providers;
  policy: Policy;
  runner: TaskRunner;
  chat: ChatAgent;

  private queue: string[] = [];
  private running: string | null = null;
  private stopRequested = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;
  private retryAt = 0;
  private lastResearch = 0;
  private briefingBusy = false;

  constructor(store: Store, config: Config, brain: Brain, providers: Providers) {
    this.store = store;
    this.config = config;
    this.brain = brain;
    this.providers = providers;
    this.policy = new Policy(store, brain);
    const deps: AgentDeps = { store, config, brain, providers, policy: this.policy, hooks: this };
    this.runner = new TaskRunner(deps);
    this.chat = new ChatAgent(deps);
    this.lastResearch = store.db.getKv<number>('lastResearch') ?? Date.now();
  }

  start() {
    // A reply cut off by a restart would otherwise show "typing" forever.
    for (const m of this.store.interruptedMessages()) {
      this.store.saveMessage({ ...m, status: 'error', content: `${m.content}${m.content ? '\n\n' : ''}I was interrupted before I could finish this reply. Ask me again?` });
    }
    // Tasks that were mid-run when the server stopped pick up where they left off.
    for (const t of this.store.listTasks(['active'])) this.enqueue(t.id);
    this.timer = setInterval(() => void this.tick(), this.config.tickMs);
    void this.tick();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) this.stopRequested.add(this.running);
    await this.draining;
  }

  /** Resolves once the queue is empty. Used by tests and graceful shutdown. */
  async idle() {
    while (this.draining) await this.draining;
  }

  // ---- the clock -----------------------------------------------------------

  async tick() {
    const now = new Date();
    this.expireApprovals(now);
    if (this.store.isPaused()) return;
    for (const t of this.store.listTasks(['scheduled'])) {
      if (this.store.isStarPaused(this.store.starIdOf(t))) continue;
      if (t.nextRunAt && t.nextRunAt <= now.toISOString()) {
        this.store.patchTask(t.id, { status: 'active' });
        this.enqueue(t.id);
      }
    }
    for (const t of this.store.listTasks(['active'])) this.enqueue(t.id);
    await this.maybeBrief(now);
    await this.maybeIdeas();
    await this.maybeResearch(now);
  }

  private ideasBusy = false;

  /** New ideas at most every few hours, from what's connected and what Sky knows. */
  private async maybeIdeas() {
    const last = this.store.db.getKv<number>('lastIdeas') ?? 0;
    if (this.ideasBusy || Date.now() - last < 6 * 3_600_000) return;
    this.ideasBusy = true;
    try {
      this.store.db.setKv('lastIdeas', Date.now());
      await refreshIdeas(this.store, this.providers, this.brain);
    } catch (err) {
      console.error('[runtime] ideas failed', err);
    } finally {
      this.ideasBusy = false;
    }
  }

  enqueue(taskId: string) {
    if (this.running !== taskId && !this.queue.includes(taskId)) this.queue.push(taskId);
    if (!this.draining) this.draining = this.drain().finally(() => { this.draining = null; });
  }

  private async drain() {
    while (this.queue.length) {
      if (this.store.isPaused() || Date.now() < this.retryAt) return;
      const id = this.queue.shift()!;
      const task = this.store.findTask(id);
      if (!task || task.status !== 'active') continue;
      // A paused Star's tasks wait; the clock queues them again once it's resumed.
      const starId = this.store.starIdOf(task);
      if (this.store.isStarPaused(starId)) continue;
      this.running = id;
      try {
        const end = await this.runner.run(id, () => this.store.isStarPaused(starId) || this.stopRequested.has(id));
        if (end === 'offline') {
          this.store.setOffline(true);
          this.retryAt = Date.now() + 60_000;
          this.queue.unshift(id);
        }
      } catch (err) {
        console.error('[runtime] run crashed', err);
        const t = this.store.findTask(id);
        if (t) this.runner.finish(t, `Something went wrong: ${err instanceof Error ? err.message : String(err)}`, true);
      } finally {
        this.stopRequested.delete(id);
        this.running = null;
        this.store.setActivity(null);
      }
    }
  }

  // ---- tasks ---------------------------------------------------------------

  nextRunAt(task: Task, after: Date): string | undefined {
    if (task.kind === 'one_off' || !task.schedule) return undefined;
    const s = parseSchedule(task.schedule) ?? parseSchedule(task.kind === 'watch' ? WATCH_DEFAULT : 'every day at 9:00')!;
    return nextRun(s, this.store.settings().timezone, after, task.lastRunAt ? new Date(task.lastRunAt) : undefined).toISOString();
  }

  createTask(input: CreateTaskInput, origin = 'You', requestedBy?: Task['requestedBy']): Task {
    const star = input.starId ? this.store.getStar(input.starId) : this.store.mainStar();
    const title = input.title?.trim();
    if (!title) throw badRequest('A task needs a title');
    if (!['one_off', 'recurring', 'watch'].includes(input.kind)) throw badRequest('kind must be one_off, recurring or watch');
    let schedule = input.schedule?.trim() || undefined;
    if (input.kind === 'watch' && !schedule) schedule = WATCH_DEFAULT;
    if (input.kind === 'recurring' && !schedule) throw badRequest('A recurring task needs a schedule, like “Weekdays at 9:00”');
    const parsed = schedule ? parseSchedule(schedule) : null;
    const now = iso();
    const task: Task = {
      id: uid('t'), title: firstLine(title, 120), description: input.description?.trim() ?? '', kind: input.kind,
      status: input.kind === 'recurring' ? 'scheduled' : 'active',
      ...(schedule ? { schedule } : {}),
      createdAt: now, updatedAt: now, connectionIds: [], starId: star.id,
      ...(requestedBy ? { requestedBy } : {}),
    };
    task.nextRunAt = this.nextRunAt(task, new Date());
    if (!task.nextRunAt) delete task.nextRunAt;
    this.store.insertTask(task);
    this.store.addStep(task.id, { kind: 'plan', summary: `Created by ${origin}` });
    if (schedule) {
      this.store.addStep(task.id, {
        kind: 'note',
        summary: parsed ? `Runs ${describeSchedule(parsed)}` : `Couldn’t read “${schedule}”, so it runs ${task.kind === 'watch' ? 'every 3 hours' : 'every day at 9:00'}. Edit the schedule to change it.`,
      });
    }
    if (task.status === 'scheduled') this.store.log('task_started', `Scheduled: ${task.title}`, task.id);
    if (task.status === 'active') this.enqueue(task.id);
    return this.store.getTask(task.id);
  }

  commandTask(id: string, command: TaskCommand): Task {
    const task = this.store.getTask(id);
    const recurringish = task.kind !== 'one_off';
    const finished = task.status === 'done' || task.status === 'failed';
    const note = { pause: 'Paused by you', resume: 'Resumed by you', run_now: 'Run started by you', cancel: 'Stopped by you' }[command];
    if (!note) throw badRequest(`Unknown command ${command}`);
    switch (command) {
      case 'pause':
        if (finished) throw new ApiError(409, 'conflict', 'This task has already finished');
        if (this.running === id) this.stopRequested.add(id);
        this.store.patchTask(id, { status: 'paused' });
        break;
      case 'resume': {
        if (task.status !== 'paused') throw new ApiError(409, 'conflict', 'Only paused tasks can be resumed');
        const waiting = this.store.listApprovals('pending').some((a) => a.taskId === id);
        const status = waiting ? 'waiting_approval' : recurringish && !this.runner.hasRun(id) ? 'scheduled' : 'active';
        this.store.patchTask(id, { status, ...(status === 'scheduled' ? { nextRunAt: this.nextRunAt(task, new Date()) } : {}) });
        if (status === 'active') this.enqueue(id);
        break;
      }
      case 'run_now':
        if (!recurringish) throw new ApiError(409, 'conflict', 'Run now is for recurring and watch tasks');
        if (finished) throw new ApiError(409, 'conflict', 'This task has already finished');
        if (task.status === 'active' || task.status === 'waiting_approval') throw new ApiError(409, 'conflict', 'This task is already running');
        this.store.patchTask(id, { status: 'active' });
        this.enqueue(id);
        break;
      case 'cancel':
        if (finished) throw new ApiError(409, 'conflict', 'This task has already finished');
        if (this.running === id) this.stopRequested.add(id);
        this.runner.discard(id);
        for (const a of this.store.listApprovals('pending').filter((x) => x.taskId === id)) this.store.setApprovalStatus(a.id, 'expired');
        this.store.patchTask(id, { status: 'done', lastOutcome: 'Stopped by you' });
        this.store.setActivity(null);
        if (task.kind === 'one_off' && task.requestedBy) this.starAnswered(task, 'The person stopped this before it finished.', true);
        break;
    }
    this.store.addStep(id, { kind: 'note', summary: note });
    return this.store.getTask(id);
  }

  // ---- approvals -----------------------------------------------------------

  decide(id: string, decision: ApprovalDecision): Approval {
    const current = this.store.getApproval(id);
    if (current.status !== 'pending') throw new ApiError(409, 'conflict', `This was already ${current.status}`);
    if (decision.decision !== 'approve' && decision.decision !== 'reject') throw badRequest('decision must be approve or reject');
    const edited = decision.decision === 'approve' && decision.editedPreview?.trim() ? decision.editedPreview : undefined;
    const a = this.store.setApprovalStatus(id, decision.decision === 'approve' ? 'approved' : 'rejected', edited);
    this.store.log('approval_resolved', `${a.status === 'approved' ? 'Approved' : 'Declined'}: ${a.action} to ${a.target}`, a.taskId);
    if (decision.note?.trim()) {
      this.store.addMemory('preference', decision.note.trim(), `Your note on “${firstLine(a.action, 40)}”`, true, a.taskId);
    }
    this.afterDecision(a, { ...decision, editedPreview: edited });
    return a;
  }

  private afterDecision(a: Approval, decision: ApprovalDecision | 'expired') {
    if (!this.runner.recordDecision(a, decision) || !a.taskId) return;
    this.wake(a.taskId);
  }

  /** Puts a task that was waiting on answers back in the queue. */
  private wake(taskId: string) {
    const task = this.store.findTask(taskId);
    if (task?.status === 'waiting_approval' || task?.status === 'blocked') {
      this.store.patchTask(task.id, { status: 'active' });
      this.enqueue(task.id);
    }
  }

  // ---- stars ---------------------------------------------------------------

  /**
   * A task another Star asked for has ended. The asking Star hears back as a
   * constellation reply; if its task was waiting on this (ask_star), the
   * answer becomes that call's result and the task carries on.
   */
  starAnswered(task: Task, answer: string, failed: boolean) {
    const req = task.requestedBy;
    if (!req) return;
    const allIn = req.taskId ? this.runner.recordReply(req.taskId, task.id, answer, failed) : null;
    this.store.sendTeamMessage({
      fromStarId: this.store.starIdOf(task), toStarId: req.starId, kind: 'reply',
      content: `${failed ? 'Couldn’t finish' : 'Finished'} “${firstLine(task.title, 60)}”: ${answer}`, taskId: task.id,
      // An ask_star answer reaches the asking task directly, so it isn't also left in the inbox.
      read: allIn !== null,
    });
    if (allIn && req.taskId) this.wake(req.taskId);
  }

  createStar(input: Pick<Star, 'name' | 'role' | 'instructions' | 'avatar' | 'autonomy' | 'connectionIds'>): Star {
    return this.store.createStar(input);
  }

  /** Pauses one Star: its running task stops at the next step and nothing of its starts until it's resumed. */
  setStarPaused(id: string, paused: boolean): Star {
    const star = this.store.getStar(id);
    if (star.paused === paused) return star;
    if (paused && this.running) {
      const t = this.store.findTask(this.running);
      if (t && this.store.starIdOf(t) === id) this.stopRequested.add(t.id);
    }
    const next = this.store.patchStar(id, { paused });
    this.store.log('message', `${paused ? 'Paused' : 'Resumed'} ${star.name}`, undefined, id);
    if (!paused) void this.tick();
    return next;
  }

  /** Removes a Star. Its unfinished tasks stop, its approvals expire, and Stars waiting on it get told. */
  deleteStar(id: string) {
    const star = this.store.getStar(id);
    if (star.main) throw new ApiError(403, 'forbidden', 'The main Star can’t be removed');
    for (const t of this.store.listTasks(['active', 'scheduled', 'waiting_approval', 'blocked', 'paused'], id)) {
      if (this.running === t.id) this.stopRequested.add(t.id);
      this.runner.discard(t.id);
      for (const a of this.store.listApprovals('pending').filter((x) => x.taskId === t.id)) this.store.setApprovalStatus(a.id, 'expired');
      this.store.patchTask(t.id, { status: 'done', lastOutcome: `Stopped: ${star.name} was removed` });
      this.store.addStep(t.id, { kind: 'note', summary: `Stopped because ${star.name} was removed` });
      if (t.kind === 'one_off' && t.requestedBy) this.starAnswered(t, `${star.name} was removed before finishing this.`, true);
    }
    this.store.removeStar(id);
  }

  private expireApprovals(now: Date) {
    for (const a of this.store.listApprovals('pending')) {
      if (a.expiresAt && a.expiresAt <= now.toISOString()) {
        const expired = this.store.setApprovalStatus(a.id, 'expired');
        this.store.log('approval_resolved', `Expired: ${a.action} to ${a.target}`, a.taskId);
        this.afterDecision(expired, 'expired');
      }
    }
  }

  // ---- pause ---------------------------------------------------------------

  setPaused(paused: boolean) {
    this.store.setPaused(paused);
    if (!paused) void this.tick();
    return this.store.status();
  }

  // ---- notifications -------------------------------------------------------

  inQuietHours(now = new Date()) {
    const { quietHours, timezone } = this.store.settings();
    const start = parseHHMM(quietHours.start);
    const end = parseHHMM(quietHours.end);
    return quietHours.enabled && start !== null && end !== null && inWindow(localMinutes(now, timezone), start, end);
  }

  /**
   * A Star reaching out on its own: a proactive message in its own chat (the
   * main chat for the main Star) and, outside quiet hours, the person's other
   * channels, signed with the Star's name when it isn't the main one.
   */
  async notify(message: string, opts: { urgent?: boolean; taskId?: string; cards?: MessageCard[]; starId?: string } = {}): Promise<string> {
    const settings = this.store.settings();
    const delivered: string[] = ['the app'];
    const cards = opts.cards ?? (opts.taskId ? [{ kind: 'task' as const, taskId: opts.taskId }] : []);
    const star = (opts.starId && this.store.findStar(opts.starId)) || this.store.mainStar();
    this.store.postAgentMessage(star.conversationId, message, { proactive: true, cards });
    this.store.log('message', `Told you: ${firstLine(message, 120)}`, opts.taskId, star.id);
    if (!star.main) message = `${star.name}: ${message}`;

    if (this.inQuietHours() && !opts.urgent) return 'Posted in the app. Other channels are held during quiet hours.';
    const { channels } = settings;
    const attempts: Promise<void>[] = [];
    if (channels.telegram && this.providers.isUsable('telegram')) {
      attempts.push(this.sendTelegram(message).then(() => { delivered.push('Telegram'); }));
    }
    if (channels.email && this.providers.isUsable('gmail')) {
      attempts.push(this.emailSelf(message).then(() => { delivered.push('email'); }));
    }
    const slackChannel = process.env.SKY_SLACK_NOTIFY_CHANNEL ?? process.env.SKYS_SLACK_NOTIFY_CHANNEL;
    if (channels.slack && this.providers.isUsable('slack') && slackChannel) {
      attempts.push(this.providers.api('slack', 'https://slack.com/api/chat.postMessage', { method: 'POST', body: { channel: slackChannel, text: message } })
        .then(() => { delivered.push('Slack'); }));
    }
    const results = await Promise.allSettled(attempts);
    const failed = results.filter((r) => r.status === 'rejected').length;
    return `Delivered to ${delivered.join(', ')}${failed ? ` (${failed} channel${failed === 1 ? '' : 's'} failed)` : ''}.`;
  }

  private async sendTelegram(text: string) {
    const creds = this.providers.credentials('telegram');
    if (!creds?.extra?.chatId) throw new Error('Telegram chat id missing');
    const res = await this.providers.fetch(`https://api.telegram.org/bot${creds.accessToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: creds.extra.chatId, text }),
    });
    if (!res.ok) throw new Error(`Telegram ${res.status}`);
  }

  private async emailSelf(text: string) {
    const profile = await this.providers.api('gmail', 'https://gmail.googleapis.com/gmail/v1/users/me/profile');
    const name = this.store.settings().agentName;
    const raw = Buffer.from(`To: ${profile.emailAddress}\r\nSubject: ${name}: ${firstLine(text, 60)}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${text}`).toString('base64url');
    await this.providers.api('gmail', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', body: { raw } });
  }

  // ---- briefing and research ----------------------------------------------

  async briefing() {
    return this.store.latestBriefing() ?? generateBriefing(this.store, this.brain);
  }

  private async maybeBrief(now: Date) {
    const { briefingTime, timezone } = this.store.settings();
    const at = briefingTime ? parseHHMM(briefingTime) : null;
    if (at === null || this.briefingBusy) return;
    const today = localDateKey(now, timezone);
    if (localMinutes(now, timezone) < at || this.store.db.getKv<string>('briefedOn') === today) return;
    this.briefingBusy = true;
    try {
      const b = await generateBriefing(this.store, this.brain);
      this.store.db.setKv('briefedOn', today);
      const needs = b.highlights.filter((h) => h.kind === 'needs_you').length;
      await this.notify(`${b.greeting}. ${b.summary}`, { urgent: needs > 0 && !this.inQuietHours() });
    } catch (err) {
      console.error('[runtime] briefing failed', err);
    } finally {
      this.briefingBusy = false;
    }
  }

  private async maybeResearch(now: Date) {
    const settings = this.store.settings();
    if (!settings.proactiveResearch || this.brain.name !== 'claude' || !this.providers.isUsable('web')) return;
    if (this.running || this.queue.length || this.inQuietHours(now) || Date.now() - this.lastResearch < this.config.researchEveryMs) return;
    const interests = this.store.listMemory().filter((m) => m.category === 'goal' || m.category === 'preference').slice(0, 20);
    if (!interests.length) return;
    this.lastResearch = Date.now();
    this.store.db.setKv('lastResearch', this.lastResearch);
    this.running = 'research';
    this.store.setActivity('Researching things you care about');
    try {
      const summary = await this.research(interests.map((m) => m.content));
      if (summary) this.store.log('research', firstLine(summary, 200));
    } catch (err) {
      if (err instanceof BrainUnavailable) this.store.setOffline(true);
      console.error('[runtime] research failed', err);
    } finally {
      this.running = null;
      this.store.setActivity(null);
    }
  }

  private async research(interests: string[]): Promise<string> {
    const tools = ['remember', 'notify_user', 'recall'].map((n) => findTool(n)!);
    const recent = this.store.activitySince(new Date(Date.now() - 7 * 86_400_000).toISOString()).filter((e) => e.kind === 'research').map((e) => `- ${e.summary}`);
    const messages: BetaMessageParam[] = [{
      role: 'user',
      content: `${contextNote(this.store.settings(), [])}\n\nTheir goals and interests:\n${formatMemory(this.store.listMemory().filter((m) => interests.includes(m.content)))}`
        + `${recent.length ? `\n\nYou already looked into these this week, so find something else:\n${recent.join('\n')}` : ''}`,
    }];
    const ctx: ToolContext = { store: this.store, config: this.config, providers: this.providers, runtime: this, star: this.store.mainStar(), source: 'Proactive research', touchedTasks: new Set() };
    const deps: AgentDeps = { store: this.store, config: this.config, brain: this.brain, providers: this.providers, policy: this.policy, hooks: this };
    let text = '';
    for (let i = 0; i < 6; i++) {
      const res = await this.brain.turn({ system: systemPrompt(this.store, this.providers, 'research'), messages, tools: tools.map(toSpec), web: true });
      messages.push({ role: 'assistant', content: res.content as BetaMessageParam['content'] });
      text = res.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim() || text;
      if (res.stopReason === 'pause_turn') continue;
      const uses = res.content.filter((b) => b.type === 'tool_use') as { id: string; name: string; input: unknown }[];
      if (!uses.length) break;
      const results = [];
      for (const u of uses) {
        const tool = tools.find((t) => t.name === u.name);
        results.push(tool ? await executeTool(deps, tool, u.input, ctx, u.id) : { type: 'tool_result' as const, tool_use_id: u.id, content: 'Unknown tool', is_error: true });
      }
      messages.push({ role: 'user', content: results });
    }
    return text;
  }
}
