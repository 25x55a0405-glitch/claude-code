import { randomInt } from 'node:crypto';
import type { Runtime } from './agent/runtime.ts';
import type { Config } from './config.ts';
import type { Providers } from './connections/providers.ts';
import type { Store } from './store.ts';
import type { Triggers } from './triggers.ts';
import type { Message, MessagingStatus, Star } from './types.ts';
import { ApiError, badRequest, firstLine, iso, sleep, uid } from './util.ts';

type App = 'telegram' | 'slack';

/** A pairing code and the wrong tries against it. */
interface Pairing {
  pairCode?: string;
  pairIssuedAt?: string;
  /** Wrong tries per sender (chat or user id). */
  pairMisses?: Record<string, number>;
  pairLocked?: boolean;
}

interface TelegramCreds {
  accessToken: string;
  extra?: { chatId?: string; botUsername?: string } & Pairing;
}

interface SlackCreds {
  accessToken: string;
  extra?: { appToken?: string; botUserId?: string; team?: string; userId?: string; dmChannel?: string } & Pairing;
}

const PAIR_MS = 10 * 60_000;
/** Wrong codes one sender may send before it's ignored. */
const PAIR_TRIES = 3;
/** Wrong codes from everyone before pairing stops until the person makes a new code. */
const PAIR_TOTAL = 20;

export const newPairing = (): Pairing => ({ pairCode: String(randomInt(100_000, 1_000_000)), pairIssuedAt: iso(), pairMisses: {}, pairLocked: false });
const pairExpiresAt = (x: Pairing) => (x.pairIssuedAt ? new Date(Date.parse(x.pairIssuedAt) + PAIR_MS).toISOString() : null);
const pairLive = (x: Pairing) => Boolean(x.pairCode && !x.pairLocked && Date.parse(pairExpiresAt(x) ?? '') > Date.now());

/**
 * One message to the bot while it waits to pair. Only a message that is exactly the code counts (a list of
 * codes is a wrong try); each sender gets a few tries; many wrong tries in all stop pairing; the code expires.
 */
function tryPair(x: Pairing, sender: string, text: string): { paired: boolean; next: Pairing | null } {
  if (!pairLive(x)) return { paired: false, next: null };
  const misses = x.pairMisses ?? {};
  if ((misses[sender] ?? 0) >= PAIR_TRIES) return { paired: false, next: null };
  // Exactly the code, or "pair <code>" / "/start <code>" (the t.me link).
  if (text.trim().replace(/^(\/start|pair)\s+/i, '') === x.pairCode) return { paired: true, next: null };
  const next = { ...misses, [sender]: (misses[sender] ?? 0) + 1 };
  const total = Object.values(next).reduce((a, b) => a + b, 0);
  return { paired: false, next: { ...x, pairMisses: next, pairLocked: total >= PAIR_TOTAL } };
}

const pairFields = (x: Pairing | undefined, paired: boolean) => ({
  pairCode: !paired && x && pairLive(x) ? x.pairCode! : null,
  pairExpiresAt: !paired && x && pairLive(x) ? pairExpiresAt(x) : null,
  pairLocked: !paired && Boolean(x?.pairLocked),
});

/**
 * Talking to the Stars from Telegram and Slack, both ways, with no public URL
 * needed: Telegram through long polling, Slack through Socket Mode.
 *
 * Only the person can talk to their Stars: the first message must carry the
 * pairing code shown in the app, and after that only that Telegram chat or
 * Slack user is listened to. Messages in other chats and channels the bot is
 * in are events for message triggers, never instructions.
 *
 * "@Scout find ramen" or "Scout: find ramen" picks a Star; otherwise the last
 * Star used there answers (the main Star at first). Approvals arrive with
 * Approve and Decline buttons.
 */
export class Messaging {
  store: Store;
  config: Config;
  providers: Providers;
  runtime: Runtime;
  triggers?: Triggers;
  telegram: TelegramBridge;
  slack: SlackBridge;

  constructor(store: Store, config: Config, providers: Providers, runtime: Runtime, triggers?: Triggers) {
    this.store = store;
    this.config = config;
    this.providers = providers;
    this.runtime = runtime;
    this.triggers = triggers;
    this.telegram = new TelegramBridge(this);
    this.slack = new SlackBridge(this);
  }

  start() {
    this.telegram.start();
    this.slack.start();
  }

  async stop() {
    await Promise.all([this.telegram.stop(), this.slack.stop()]);
  }

  status(): MessagingStatus[] {
    return [this.telegram.status(), this.slack.status()];
  }

  emit(s: MessagingStatus) {
    this.store.bus.emit({ type: 'messaging.updated', data: s });
  }

  /** Which Star a message is for, and the text without the name. */
  route(app: App, text: string): { star: Star; text: string } {
    const m = /^\s*@?([\p{L}\p{N}][\p{L}\p{N} _-]{0,39}?)\s*[:,]\s*([\s\S]+)$/u.exec(text) ?? /^\s*@([\p{L}\p{N}_-]{1,40})\s+([\s\S]+)$/u.exec(text);
    const named = m ? this.store.findStar(m[1].trim()) : undefined;
    if (named) {
      this.store.db.setKv(`msgStar:${app}`, named.id);
      return { star: named, text: m![2].trim() };
    }
    const last = this.store.db.getKv<string>(`msgStar:${app}`);
    return { star: (last && this.store.findStar(last)) || this.store.mainStar(), text: text.trim() };
  }

  /** The person wrote from a messaging app: it goes into the Star's chat, and the reply comes back. */
  async fromPerson(app: App, raw: string): Promise<string> {
    const text = raw.trim();
    if (/^\/stars\b/i.test(text)) {
      return `Your Stars: ${this.store.listStars().map((s) => `${s.name} (${s.role})`).join('; ')}.\nStart a message with a name, like "${this.store.listStars().at(-1)!.name}: …", to talk to that Star.`;
    }
    const { star, text: content } = this.route(app, text);
    if (star.paused) return `${star.name} is paused. Resume it in the app to talk to it.`;
    const conv = this.store.getConversation(star.conversationId);
    const m: Message = { id: uid('msg'), conversationId: conv.id, role: 'user', content, createdAt: iso(), status: 'done', via: app };
    this.store.saveMessage(m);
    this.store.bus.emit({ type: 'message.done', data: m });
    this.store.patchConversation(conv.id, { updatedAt: m.createdAt, preview: firstLine(content, 120) });
    this.store.log('message', `You said (${app === 'slack' ? 'Slack' : 'Telegram'}): ${firstLine(content, 100)}`, undefined, star.id);
    await this.runtime.chat.reply(conv.id);
    const reply = this.store.messages(conv.id).filter((x) => x.role === 'agent' && x.createdAt >= m.createdAt && !x.proactive).at(-1);
    const body = reply?.content || 'Sorry, I couldn’t reply just now.';
    return star.main ? body : `${star.name}: ${body}`;
  }

  /** An Approve or Decline button was pressed. Returns what to show in place of the buttons. */
  decide(approvalId: string, approve: boolean): string {
    try {
      const a = this.runtime.decide(approvalId, { decision: approve ? 'approve' : 'reject' });
      return a.status === 'approved' ? 'Approved' : 'Declined';
    } catch (err) {
      return err instanceof ApiError && err.status === 409 ? 'Already answered' : `Couldn’t answer: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

// ---- Telegram -------------------------------------------------------------------

/** A Telegram bot, polled for updates (no webhook, so no public URL). */
export class TelegramBridge {
  m: Messaging;
  private running = false;
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private inFlight = new Set<Promise<unknown>>();
  private error: string | null = null;

  constructor(m: Messaging) {
    this.m = m;
  }

  private creds(): TelegramCreds | undefined {
    return this.m.providers.credentials('telegram') as TelegramCreds | undefined;
  }

  /** A fresh pairing code (the last one expired, or too many wrong codes came in). */
  newCode(): MessagingStatus {
    const c = this.creds();
    if (!c) throw badRequest('Telegram isn’t set up yet');
    if (c.extra?.chatId) throw badRequest('Telegram is already paired');
    this.m.store.db.setPrivate('connection', 'telegram', { ...c, extra: { ...c.extra, ...newPairing() } });
    const s = this.status();
    this.m.emit(s);
    return s;
  }

  /** Paired and able to send. */
  ready(): boolean {
    return Boolean(this.creds()?.extra?.chatId) && this.m.providers.isUsable('telegram');
  }

  status(): MessagingStatus {
    const c = this.creds();
    const bot = c?.extra?.botUsername ?? null;
    const pair = pairFields(c?.extra, Boolean(c?.extra?.chatId));
    return {
      app: 'telegram',
      state: !c ? 'off' : this.error ? 'error' : c.extra?.chatId ? 'on' : 'pairing',
      ...pair,
      pairLink: pair.pairCode && bot ? `https://t.me/${bot}?start=${pair.pairCode}` : null,
      botName: bot,
      error: this.error,
    };
  }

  private async api<T = any>(method: string, body: unknown, signal?: AbortSignal, token = this.creds()?.accessToken): Promise<T> {
    if (!token) throw new Error('Telegram isn’t connected');
    const res = await this.m.providers.fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? res.status}`);
    return json.result as T;
  }

  /** Sets up a bot from its BotFather token. The person then sends the pairing code to it. */
  async connect(botToken: string): Promise<MessagingStatus> {
    if (!/^\d{5,}:[\w-]{30,}$/.test(botToken)) throw badRequest('That doesn’t look like a bot token from @BotFather (it looks like 123456:ABC-…)');
    let me: { username: string };
    try {
      me = await this.api<{ username: string }>('getMe', {}, undefined, botToken);
    } catch (err) {
      throw new ApiError(400, 'bad_token', `Telegram didn’t accept that token: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.stop();
    this.m.providers.disconnect('telegram');
    this.m.store.db.setPrivate('connection', 'telegram', { accessToken: botToken, extra: { botUsername: me.username, ...newPairing() } } satisfies TelegramCreds);
    this.m.store.db.setKv('tgOffset', undefined);
    this.error = null;
    this.start();
    const s = this.status();
    this.m.emit(s);
    return s;
  }

  async disconnect(): Promise<MessagingStatus> {
    await this.stop();
    this.m.providers.disconnect('telegram');
    const s = this.status();
    this.m.emit(s);
    return s;
  }

  start() {
    if (this.running || !this.creds()) return;
    this.running = true;
    this.abort = new AbortController();
    this.loop = this.poll(this.abort.signal);
  }

  async stop() {
    this.running = false;
    this.abort?.abort();
    await this.loop;
    this.loop = null;
    await Promise.allSettled([...this.inFlight]);
  }

  private async poll(signal: AbortSignal) {
    let backoff = 1000;
    while (this.running) {
      try {
        await this.pollOnce(25, signal);
        backoff = 1000;
        if (this.error) {
          this.error = null;
          this.m.emit(this.status());
        }
      } catch (err) {
        if (!this.running) break;
        const message = err instanceof Error ? err.message : String(err);
        if (this.error !== message) {
          this.error = message;
          this.m.emit(this.status());
        }
        await sleep(backoff);
        backoff = Math.min(60_000, backoff * 2);
      }
    }
  }

  /** One getUpdates call; tests use it with timeout 0. */
  async pollOnce(timeout = 0, signal?: AbortSignal) {
    const offset = this.m.store.db.getKv<number>('tgOffset') ?? 0;
    const updates = await this.api<TelegramUpdate[]>('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] }, signal);
    for (const u of updates) {
      this.m.store.db.setKv('tgOffset', u.update_id + 1);
      this.track(this.handle(u).catch((err) => console.error('[telegram]', err)));
    }
  }

  private track(p: Promise<unknown>) {
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
  }

  /** Waits for the messages being answered. Used by tests. */
  async idle() {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
  }

  async handle(u: TelegramUpdate) {
    const creds = this.creds();
    if (!creds) return;
    const chatId = creds.extra?.chatId;

    if (u.callback_query) {
      const q = u.callback_query;
      if (!chatId || String(q.message?.chat.id) !== chatId) return;
      const [, id, yes] = /^a:([\w-]+):([yn])$/.exec(q.data ?? '') ?? [];
      if (!id) return;
      const result = this.m.decide(id, yes === 'y');
      await this.api('answerCallbackQuery', { callback_query_id: q.id, text: result });
      if (q.message) await this.api('editMessageText', { chat_id: chatId, message_id: q.message.message_id, text: `${q.message.text ?? ''}\n\n${result}` }).catch(() => {});
      return;
    }

    const msg = u.message;
    const text = msg?.text?.trim();
    if (!msg || !text) return;
    const from = String(msg.chat.id);

    if (!chatId) {
      // Pairing: the code from the app, typed or sent through the t.me link (/start <code>).
      if (msg.chat.type !== 'private' || !creds.extra) return;
      const tried = tryPair(creds.extra, from, text);
      if (tried.next) {
        this.m.store.db.setPrivate('connection', 'telegram', { ...creds, extra: { ...creds.extra, ...tried.next } } satisfies TelegramCreds);
        if (tried.next.pairLocked) this.m.emit(this.status());
      }
      if (tried.paired) {
        this.m.store.db.setPrivate('connection', 'telegram', { accessToken: creds.accessToken, extra: { botUsername: creds.extra?.botUsername, chatId: from } } satisfies TelegramCreds);
        this.m.providers.markConnected('telegram');
        this.m.emit(this.status());
        await this.send(`Paired. This chat now talks to your Stars. Start a message with a Star's name to pick one, or send /stars to list them.`);
      }
      return;
    }

    if (from !== chatId) {
      // Another chat the bot is in: an event for message triggers.
      if (msg.chat.type !== 'private') this.m.triggers?.message('telegram', from, msg.chat.title ?? from, msg.from?.first_name ?? 'Someone', text);
      return;
    }
    if (/^\/start\b/.test(text)) {
      await this.send('Hi! Write to me here like you would in the app.');
      return;
    }
    await this.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    await this.send(await this.m.fromPerson('telegram', text));
  }

  /** Sends to the person, with Approve and Decline buttons for an approval. */
  async send(text: string, approvalId?: string) {
    const chatId = this.creds()?.extra?.chatId;
    if (!chatId) throw new Error('Telegram isn’t paired yet');
    const chunks = text.match(/[\s\S]{1,4000}/g) ?? [''];
    for (const [i, chunk] of chunks.entries()) {
      const last = i === chunks.length - 1;
      await this.api('sendMessage', {
        chat_id: chatId, text: chunk,
        ...(last && approvalId ? { reply_markup: { inline_keyboard: [[{ text: 'Approve', callback_data: `a:${approvalId}:y` }, { text: 'Decline', callback_data: `a:${approvalId}:n` }]] } } : {}),
      });
    }
  }
}

interface TelegramUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number; type: string; title?: string }; from?: { first_name?: string }; text?: string };
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: { id: number }; text?: string } };
}

// ---- Slack ----------------------------------------------------------------------

/**
 * A Slack app in Socket Mode: Slack opens a WebSocket to Sky, so no public URL.
 * Needs the app's bot token (xoxb-) and an app-level token (xapp-) with
 * connections:write. GET /messaging/slack/manifest gives a ready app manifest.
 */
export class SlackBridge {
  m: Messaging;
  private ws: WebSocket | null = null;
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private inFlight = new Set<Promise<unknown>>();
  private channelNames = new Map<string, string>();
  private error: string | null = null;

  constructor(m: Messaging) {
    this.m = m;
  }

  private creds(): SlackCreds | undefined {
    return this.m.providers.credentials('slack') as SlackCreds | undefined;
  }

  /** A fresh pairing code (the last one expired, or too many wrong codes came in). */
  newCode(): MessagingStatus {
    const c = this.creds();
    if (!c) throw badRequest('Slack isn’t set up yet');
    if (c.extra?.userId) throw badRequest('Slack is already paired');
    this.m.store.db.setPrivate('connection', 'slack', { ...c, extra: { ...c.extra, ...newPairing() } });
    const s = this.status();
    this.m.emit(s);
    return s;
  }

  /** Paired with the person's Slack user and able to DM them. */
  ready(): boolean {
    return Boolean(this.creds()?.extra?.dmChannel) && this.m.providers.isUsable('slack');
  }

  status(): MessagingStatus {
    const c = this.creds();
    const two = Boolean(c?.extra?.appToken);
    return {
      app: 'slack',
      state: !two ? 'off' : this.error ? 'error' : c?.extra?.userId ? 'on' : 'pairing',
      ...pairFields(two ? c?.extra : undefined, Boolean(c?.extra?.userId)),
      pairLink: null,
      botName: c?.extra?.team ?? null,
      error: this.error,
    };
  }

  private async api<T = any>(method: string, body: Record<string, unknown>, token = this.creds()?.accessToken): Promise<T> {
    if (!token) throw new Error('Slack isn’t connected');
    const res = await this.m.providers.fetch(`https://slack.com/api/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
    if (!json.ok) throw new Error(`Slack ${method}: ${json.error ?? res.status}`);
    return json;
  }

  async connect(botToken: string, appToken: string): Promise<MessagingStatus> {
    if (!/^xoxb-/.test(botToken)) throw badRequest('botToken must be the app’s Bot User OAuth Token (xoxb-…)');
    if (!/^xapp-/.test(appToken)) throw badRequest('appToken must be an app-level token with connections:write (xapp-…)');
    let who: { user_id: string; team: string };
    try {
      who = await this.api<{ user_id: string; team: string }>('auth.test', {}, botToken);
      await this.api('apps.connections.open', {}, appToken);
    } catch (err) {
      throw new ApiError(400, 'bad_token', `Slack didn’t accept those tokens: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.stop();
    this.m.store.db.setPrivate('connection', 'slack', { accessToken: botToken, extra: { appToken, botUserId: who.user_id, team: who.team, ...newPairing() } } satisfies SlackCreds);
    this.m.providers.markConnected('slack');
    this.error = null;
    this.start();
    const s = this.status();
    this.m.emit(s);
    return s;
  }

  async disconnect(): Promise<MessagingStatus> {
    await this.stop();
    this.m.providers.disconnect('slack');
    const s = this.status();
    this.m.emit(s);
    return s;
  }

  start() {
    if (this.running || !this.creds()?.extra?.appToken) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop() {
    this.running = false;
    this.ws?.close();
    this.wake?.();
    await this.loop;
    this.loop = null;
    await Promise.allSettled([...this.inFlight]);
  }

  async idle() {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
  }

  private async run() {
    let backoff = 1000;
    while (this.running) {
      try {
        const { url } = await this.api<{ url: string }>('apps.connections.open', {}, this.creds()?.extra?.appToken);
        await this.session(url);
        backoff = 1000;
      } catch (err) {
        if (!this.running) break;
        this.setError(err instanceof Error ? err.message : String(err));
        await new Promise<void>((r) => {
          const t = setTimeout(r, backoff);
          this.wake = () => { clearTimeout(t); r(); };
        });
        backoff = Math.min(60_000, backoff * 2);
      }
    }
  }

  private setError(e: string | null) {
    if (this.error === e) return;
    this.error = e;
    this.m.emit(this.status());
  }

  /** One WebSocket session; resolves when Slack or Sky closes it. */
  private session(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let opened = false;
      ws.onopen = () => { opened = true; };
      ws.onerror = () => { if (!opened) reject(new Error('Couldn’t open the Slack connection')); };
      ws.onclose = () => { this.ws = null; resolve(); };
      ws.onmessage = (ev) => {
        let env: SlackEnvelope;
        try { env = JSON.parse(String(ev.data)); } catch { return; }
        if (env.envelope_id) ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
        if (env.type === 'hello') this.setError(null);
        else if (env.type === 'disconnect') ws.close();
        else {
          const p = this.handle(env).catch((err) => console.error('[slack]', err));
          this.inFlight.add(p);
          void p.finally(() => this.inFlight.delete(p));
        }
      };
    });
  }

  async handle(env: SlackEnvelope) {
    const creds = this.creds();
    if (!creds) return;
    const x = creds.extra ?? {};

    if (env.type === 'interactive' && env.payload?.type === 'block_actions') {
      const p = env.payload;
      if (!x.userId || p.user?.id !== x.userId) return;
      const action = p.actions?.[0];
      if (!action || !['approve', 'decline'].includes(action.action_id)) return;
      const result = this.m.decide(action.value, action.action_id === 'approve');
      if (p.channel?.id && p.message?.ts) {
        await this.api('chat.update', { channel: p.channel.id, ts: p.message.ts, text: `${p.message.text ?? ''}\n\n${result}`, blocks: [] }).catch(() => {});
      }
      return;
    }

    if (env.type !== 'events_api') return;
    const e = env.payload?.event;
    if (!e || e.type !== 'message' || e.subtype || e.bot_id || !e.text || e.user === x.botUserId) return;

    if (e.channel_type === 'im') {
      if (!x.userId) {
        const tried = tryPair(x, String(e.user), String(e.text));
        if (tried.next) {
          this.m.store.db.setPrivate('connection', 'slack', { ...creds, extra: { ...x, ...tried.next } });
          if (tried.next.pairLocked) this.m.emit(this.status());
        }
        if (tried.paired) {
          this.m.store.db.setPrivate('connection', 'slack', { ...creds, extra: { ...x, userId: e.user, dmChannel: e.channel, pairCode: undefined, pairMisses: undefined } });
          this.m.emit(this.status());
          await this.send('Paired. Write to me here like you would in the app. Start with a Star’s name to pick one.');
        }
        return;
      }
      if (e.user !== x.userId) return;
      await this.send(await this.m.fromPerson('slack', e.text));
      return;
    }
    // A channel the bot is in: an event for message triggers.
    const name = await this.channelName(e.channel);
    this.m.triggers?.message('slack', e.channel, name, e.user ? `<@${e.user}>` : 'Someone', e.text);
  }

  private async channelName(id: string): Promise<string> {
    if (this.channelNames.has(id)) return this.channelNames.get(id)!;
    let name = id;
    try {
      const info = await this.api<{ channel: { name: string } }>('conversations.info', { channel: id });
      name = `#${info.channel.name}`;
    } catch { /* keep the id */ }
    this.channelNames.set(id, name);
    return name;
  }

  async send(text: string, approvalId?: string) {
    const dm = this.creds()?.extra?.dmChannel;
    if (!dm) throw new Error('Slack isn’t paired yet');
    await this.api('chat.postMessage', {
      channel: dm, text,
      ...(approvalId ? {
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } },
          { type: 'actions', elements: [
            { type: 'button', text: { type: 'plain_text', text: 'Approve' }, style: 'primary', action_id: 'approve', value: approvalId },
            { type: 'button', text: { type: 'plain_text', text: 'Decline' }, style: 'danger', action_id: 'decline', value: approvalId },
          ] },
        ],
      } : {}),
    });
  }
}

export interface SlackEnvelope {
  type: string;
  envelope_id?: string;
  payload?: {
    type?: string;
    event?: { type: string; subtype?: string; bot_id?: string; channel_type?: string; channel: string; user?: string; text?: string };
    user?: { id: string };
    actions?: { action_id: string; value: string }[];
    channel?: { id: string };
    message?: { ts: string; text?: string };
  };
}

/** A Slack app manifest for "Create an app → From a manifest". */
export const slackManifest = (name: string) => ({
  display_information: { name, description: 'Talk to your Sky Stars from Slack' },
  features: {
    bot_user: { display_name: name, always_online: true },
    app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
  },
  oauth_config: {
    scopes: { bot: ['chat:write', 'im:history', 'im:read', 'im:write', 'channels:history', 'channels:read', 'groups:history', 'groups:read'] },
  },
  settings: {
    event_subscriptions: { bot_events: ['message.im', 'message.channels', 'message.groups'] },
    interactivity: { is_enabled: true },
    socket_mode_enabled: true,
    org_deploy_enabled: false,
    token_rotation_enabled: false,
  },
});
