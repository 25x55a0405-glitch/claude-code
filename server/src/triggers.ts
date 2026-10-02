import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.ts';
import type { Providers } from './connections/providers.ts';
import type { Store } from './store.ts';
import type { Task, TaskTrigger, TriggerEvent, TriggerSetup } from './types.ts';
import { ApiError, badRequest, firstLine, iso, truncate, uid } from './util.ts';

/** Most events a task keeps waiting; older ones are dropped. */
const MAX_QUEUED = 20;
/** Most events a task accepts per hour, so a noisy source can't run up model calls. */
const MAX_PER_HOUR = 30;
const MAX_CONTENT = 8000;

interface TriggerKeys {
  /** Part of the webhook URL. */
  token: string;
  /** github: signs the deliveries (X-Hub-Signature-256). */
  secret: string;
}

export type TriggerInput = Pick<TaskTrigger, 'kind' | 'events' | 'source' | 'match' | 'channel' | 'query'>;

/** What the runtime does when an event arrives: run the task now, or after its current run. */
export interface TriggerHooks {
  runTriggered(taskId: string): void;
}

/**
 * Event triggers: a task runs when something happens, not only on a clock.
 * Webhooks arrive at /api/v1/hooks/<token>; GitHub deliveries are checked
 * against the task's secret; Slack and Telegram messages come from the
 * messaging bridges; email is a Gmail search polled every few minutes (free,
 * unlike Gmail's instant push which needs Google Pub/Sub).
 *
 * Each event is queued for its task and handed to the Star at the start of a
 * run, marked as content to work with, never as instructions.
 */
export class Triggers {
  store: Store;
  config: Config;
  providers: Providers;
  hooks?: TriggerHooks;
  private mailTimer: NodeJS.Timeout | null = null;
  private polling: Promise<void> | null = null;

  constructor(store: Store, config: Config, providers: Providers) {
    this.store = store;
    this.config = config;
    this.providers = providers;
  }

  // ---- setting up ------------------------------------------------------------

  validate(input: unknown): TriggerInput {
    const b = input as Record<string, unknown>;
    if (!b || typeof b !== 'object') throw badRequest('trigger must be an object like { "kind": "webhook" }');
    const kinds = ['webhook', 'github', 'message', 'email'] as const;
    if (!kinds.includes(b.kind as never)) throw badRequest(`trigger.kind must be one of ${kinds.join(', ')}`);
    const kind = b.kind as TriggerInput['kind'];
    const text = (v: unknown, field: string, max: number) => {
      if (v === undefined || v === null) return undefined;
      if (typeof v !== 'string' || v.length > max) throw badRequest(`trigger.${field} must be text up to ${max} characters`);
      return v.trim() || undefined;
    };
    const out: TriggerInput = { kind };
    if (kind === 'github') {
      if (b.events !== undefined && (!Array.isArray(b.events) || b.events.some((e) => typeof e !== 'string' || !/^[a-z_]{1,40}$/.test(e)))) {
        throw badRequest('trigger.events must be GitHub event names like "push" or "issues"');
      }
      out.events = [...new Set((b.events as string[] | undefined) ?? [])];
    }
    if (kind === 'message') {
      const source = b.source ?? 'any';
      if (!['slack', 'telegram', 'any'].includes(source as string)) throw badRequest('trigger.source must be slack, telegram or any');
      out.source = source as TriggerInput['source'];
      out.match = text(b.match, 'match', 200);
      out.channel = text(b.channel, 'channel', 100);
    }
    if (kind === 'email') {
      out.query = text(b.query, 'query', 300);
      if (!out.query) throw badRequest('trigger.query is required: a Gmail search like "from:alerts@bank.com"');
    }
    return out;
  }

  /** Adds, replaces or (with null) removes a task's trigger. */
  set(taskId: string, input: TriggerInput | null): Task {
    const task = this.store.getTask(taskId);
    if (!input) {
      this.store.db.setKv(`trigger:${taskId}`, undefined);
      this.store.addStep(taskId, { kind: 'note', summary: 'Trigger removed' });
      return this.store.patchTask(taskId, { trigger: undefined });
    }
    if (task.kind === 'one_off') throw badRequest('A trigger runs a task every time something happens, so it needs a recurring task');
    if (!this.store.db.getKv<TriggerKeys>(`trigger:${taskId}`)) this.store.db.setKv(`trigger:${taskId}`, newKeys());
    if (input.kind === 'email') this.store.db.setKv(`mailSeen:${taskId}`, undefined);
    const trigger: TaskTrigger = { ...input, fired: task.trigger?.fired ?? 0, lastFiredAt: task.trigger?.lastFiredAt ?? null };
    this.store.addStep(taskId, { kind: 'note', summary: `Runs ${describe(trigger)}` });
    return this.store.patchTask(taskId, { trigger });
  }

  /** The trigger with what to paste into the other service. */
  setup(taskId: string): TriggerSetup {
    const task = this.store.getTask(taskId);
    if (!task.trigger) throw new ApiError(404, 'not_found', 'This task has no trigger');
    const keys = this.keys(taskId);
    const hook = task.trigger.kind === 'webhook' || task.trigger.kind === 'github';
    return { ...task.trigger, url: hook ? `${this.config.publicUrl}/api/v1/hooks/${keys.token}` : null, secret: task.trigger.kind === 'github' ? keys.secret : null };
  }

  /** New URL and secret; the old ones stop working. */
  rotate(taskId: string): TriggerSetup {
    this.store.getTask(taskId);
    this.store.db.setKv(`trigger:${taskId}`, newKeys());
    return this.setup(taskId);
  }

  private keys(taskId: string): TriggerKeys {
    let keys = this.store.db.getKv<TriggerKeys>(`trigger:${taskId}`);
    if (!keys) this.store.db.setKv(`trigger:${taskId}`, keys = newKeys());
    return keys;
  }

  private triggered(kind?: TaskTrigger['kind']): Task[] {
    return this.store.listTasks(['scheduled', 'active', 'waiting_approval', 'blocked']).filter((t) => t.trigger && (!kind || t.trigger.kind === kind));
  }

  // ---- events arriving -------------------------------------------------------

  /**
   * POST /api/v1/hooks/<token>. Works without signing in: the token is the
   * secret. Returns the status code and body to send back.
   */
  webhook(token: string, headers: Record<string, string | string[] | undefined>, raw: string): { status: number; body: unknown } {
    const task = this.triggered().find((t) => {
      const keys = this.store.db.getKv<TriggerKeys>(`trigger:${t.id}`);
      return keys && safeEqual(keys.token, token);
    });
    // Paused and finished tasks don't take events either; the sender sees the same 404 as a wrong URL.
    if (!task || (task.trigger!.kind !== 'webhook' && task.trigger!.kind !== 'github')) return { status: 404, body: { error: { code: 'not_found', message: 'No trigger at this address' } } };
    const header = (name: string) => {
      const v = headers[name.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };

    if (task.trigger!.kind === 'github') {
      const sig = header('x-hub-signature-256') ?? '';
      const expected = `sha256=${createHmac('sha256', this.keys(task.id).secret).update(raw).digest('hex')}`;
      if (!safeEqual(sig, expected)) return { status: 401, body: { error: { code: 'bad_signature', message: 'The signature didn’t match this trigger’s secret' } } };
      const event = header('x-github-event') ?? 'unknown';
      if (event === 'ping') return { status: 200, body: { ok: true, pong: true } };
      const wanted = task.trigger!.events ?? [];
      if (wanted.length && !wanted.includes(event)) return { status: 202, body: { ok: true, ignored: `Not listening for ${event}` } };
      let payload: any = {};
      try { payload = JSON.parse(raw); } catch { /* keep the raw text */ }
      const summary = githubSummary(event, payload);
      const ok = this.fire(task.id, { source: `GitHub ${event}`, summary, content: raw });
      return ok ? { status: 202, body: { ok: true } } : { status: 429, body: { error: { code: 'rate_limited', message: 'Too many events for this task this hour' } } };
    }

    const type = header('content-type') ?? '';
    let summary = 'Webhook received';
    if (type.includes('json')) {
      try {
        const j = JSON.parse(raw);
        const hint = j?.title ?? j?.subject ?? j?.event ?? j?.type ?? j?.message ?? j?.text;
        if (typeof hint === 'string') summary = `Webhook: ${firstLine(hint, 100)}`;
      } catch {
        return { status: 400, body: { error: { code: 'bad_json', message: 'The body isn’t valid JSON' } } };
      }
    }
    const ok = this.fire(task.id, { source: 'webhook', summary, content: raw || '(empty body)' });
    return ok ? { status: 202, body: { ok: true } } : { status: 429, body: { error: { code: 'rate_limited', message: 'Too many events for this task this hour' } } };
  }

  /** A message in a Slack channel or Telegram group (not the person's own chat with Sky). */
  message(source: 'slack' | 'telegram', channel: string, channelName: string, from: string, text: string): number {
    let fired = 0;
    for (const t of this.triggered('message')) {
      const tr = t.trigger!;
      if (tr.source && tr.source !== 'any' && tr.source !== source) continue;
      if (tr.channel && tr.channel !== channel && tr.channel.replace(/^#/, '') !== channelName.replace(/^#/, '')) continue;
      if (tr.match && !text.toLowerCase().includes(tr.match.toLowerCase())) continue;
      const where = source === 'slack' ? `Slack ${channelName}` : `Telegram ${channelName}`;
      if (this.fire(t.id, { source: where, summary: `${from} in ${channelName}: ${firstLine(text, 80)}`, content: `${from} wrote in ${channelName}:\n${text}` })) fired++;
    }
    return fired;
  }

  /** Queues an event for a task and gets the task running. False when it was dropped. */
  fire(taskId: string, e: Pick<TriggerEvent, 'source' | 'summary' | 'content'>): boolean {
    const task = this.store.findTask(taskId);
    if (!task?.trigger || ['paused', 'done', 'failed'].includes(task.status)) return false;
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const recent = (this.store.db.getKv<string[]>(`fired:${taskId}`) ?? []).filter((at) => at > hourAgo);
    if (recent.length >= MAX_PER_HOUR) {
      if (recent.length === MAX_PER_HOUR) this.store.addStep(taskId, { kind: 'note', summary: `Ignoring events for the rest of the hour: more than ${MAX_PER_HOUR} arrived` });
      this.store.db.setKv(`fired:${taskId}`, [...recent, iso()]);
      return false;
    }
    this.store.db.setKv(`fired:${taskId}`, [...recent, iso()]);
    const event: TriggerEvent = { id: uid('ev'), taskId, source: e.source, summary: firstLine(e.summary, 160), content: truncate(e.content, MAX_CONTENT), at: iso() };
    const queue = [...(this.store.db.getKv<TriggerEvent[]>(`events:${taskId}`) ?? []), event].slice(-MAX_QUEUED);
    this.store.db.setKv(`events:${taskId}`, queue);
    this.store.patchTask(taskId, { trigger: { ...task.trigger, fired: task.trigger.fired + 1, lastFiredAt: event.at } });
    this.store.addStep(taskId, { kind: 'note', summary: firstLine(`Triggered: ${event.summary}`, 160) });
    this.hooks?.runTriggered(taskId);
    return true;
  }

  /** The next waiting event for a task, removed from its queue. */
  take(taskId: string): TriggerEvent | undefined {
    const queue = this.store.db.getKv<TriggerEvent[]>(`events:${taskId}`) ?? [];
    if (!queue.length) return undefined;
    this.store.db.setKv(`events:${taskId}`, queue.slice(1));
    return queue[0];
  }

  pending(taskId: string): TriggerEvent[] {
    return this.store.db.getKv<TriggerEvent[]>(`events:${taskId}`) ?? [];
  }

  // ---- email -------------------------------------------------------------------

  start() {
    const every = Math.min(60, Math.max(2, this.store.settings().mailPollMinutes ?? 3)) * 60_000;
    this.mailTimer = setInterval(() => void this.pollMail(), every);
  }

  async stop() {
    if (this.mailTimer) clearInterval(this.mailTimer);
    this.mailTimer = null;
    await this.polling;
  }

  /** Checks Gmail once for email triggers and mail to the Stars' own addresses. */
  pollMail(): Promise<void> {
    if (!this.polling) this.polling = this.pollMailNow().catch((err) => console.error('[triggers] mail check failed', err)).finally(() => { this.polling = null; });
    return this.polling;
  }

  /** Set by the mail module: handles mail sent to a Star's own address. */
  onStarMail?: () => Promise<void>;

  private async pollMailNow() {
    if (!this.providers.isUsable('gmail')) return;
    for (const t of this.triggered('email')) {
      const seenKey = `mailSeen:${t.id}`;
      const seen = this.store.db.getKv<string[]>(seenKey);
      const list = await this.providers.api<{ messages?: { id: string }[] }>('gmail',
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20&q=${encodeURIComponent(`${t.trigger!.query} newer_than:2d`)}`);
      const ids = (list.messages ?? []).map((m) => m.id);
      // The first check only takes note of what's already there.
      if (!seen) {
        this.store.db.setKv(seenKey, ids);
        continue;
      }
      const fresh = ids.filter((id) => !seen.includes(id)).reverse();
      for (const id of fresh) {
        const m = await this.providers.api<GmailMessage>('gmail', `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`);
        const from = gmailHeader(m, 'From');
        const subject = gmailHeader(m, 'Subject') || '(no subject)';
        this.fire(t.id, {
          source: 'email', summary: `Email from ${from}: ${subject}`,
          content: `From: ${from}\nSubject: ${subject}\nGmail id: ${id} (read it with read_email)\n\n${m.snippet ?? ''}`,
        });
      }
      this.store.db.setKv(seenKey, [...fresh, ...seen].slice(0, 500));
    }
    await this.onStarMail?.();
  }
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  snippet?: string;
  payload?: { headers?: { name: string; value: string }[] };
}

export const gmailHeader = (m: GmailMessage, name: string) =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

const newKeys = (): TriggerKeys => ({ token: randomBytes(24).toString('base64url'), secret: randomBytes(24).toString('base64url') });

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** "when a webhook arrives", for the timeline. */
export function describe(t: Pick<TaskTrigger, 'kind' | 'events' | 'source' | 'match' | 'channel' | 'query'>): string {
  switch (t.kind) {
    case 'webhook': return 'when its webhook is called';
    case 'github': return `on GitHub ${t.events?.length ? t.events.join(', ') : 'events'}`;
    case 'message': return `when a ${t.source && t.source !== 'any' ? `${t.source === 'slack' ? 'Slack' : 'Telegram'} ` : ''}message${t.match ? ` mentions “${t.match}”` : ' arrives'}${t.channel ? ` in ${t.channel}` : ''}`;
    case 'email': return `when an email matches “${t.query}”`;
  }
}

function githubSummary(event: string, p: any): string {
  const repo = p?.repository?.full_name ? ` in ${p.repository.full_name}` : '';
  const who = p?.sender?.login ? ` by ${p.sender.login}` : '';
  switch (event) {
    case 'push': return `${p?.commits?.length ?? 0} commit(s) pushed to ${String(p?.ref ?? '').replace('refs/heads/', '')}${repo}${who}`;
    case 'issues': return `Issue ${p?.action ?? ''}: ${p?.issue?.title ?? ''}${repo}${who}`;
    case 'pull_request': return `Pull request ${p?.action ?? ''}: ${p?.pull_request?.title ?? ''}${repo}${who}`;
    case 'issue_comment': return `Comment on “${p?.issue?.title ?? ''}”${repo}${who}`;
    case 'release': return `Release ${p?.action ?? ''}: ${p?.release?.name ?? p?.release?.tag_name ?? ''}${repo}`;
    default: return `GitHub ${event}${p?.action ? ` ${p.action}` : ''}${repo}${who}`;
  }
}
