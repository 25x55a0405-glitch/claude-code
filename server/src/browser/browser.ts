import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import type { Config } from '../config.ts';
import type { Store } from '../store.ts';
import type { BrowserSession, CheckoutHandover, RecordedStep } from '../types.ts';
import { ApiError, badRequest, firstLine as oneLine, iso, uid } from '../util.ts';

/** One interactive element from the last snapshot of a Star's tab. */
export interface ElementInfo {
  ref: string;
  tag: string;
  type: string;
  role: string;
  label: string;
  href?: string;
  /** Clicking it submits a form. */
  submit: boolean;
  password: boolean;
  /** A card number, expiry, security code or cardholder field: only the person fills these in. */
  payment: boolean;
}

export interface Snapshot {
  url: string;
  title: string;
  text: string;
  elements: ElementInfo[];
}

interface Tab {
  page: Page;
  elements: Map<string, ElementInfo>;
  frame: Buffer | null;
  frameId: string | null;
  url: string;
  title: string;
  updatedAt: string;
  control: 'star' | 'person';
  controlNote: string | null;
  /** Taken by using the live view rather than "Take over": handed back after a short idle. */
  implicit: boolean;
  lastPersonAt: number;
  /** Tasks waiting for the person to hand the tab back. */
  waiting: string[];
  recordingId: string | null;
  checkout: CheckoutHandover | null;
  /** Digits the Star pressed one key at a time since the page changed, so a card number can't be typed that way. */
  digits: string;
}

/** Thrown when a Star tries to use its tab while the person has control. */
export class PersonInControl extends Error {
  constructor(note: string | null) {
    super(`The person has taken over your browser${note ? ` (${note})` : ''}. Wait until they hand it back, then take a fresh snapshot.`);
  }
}

/** A saved login being filled: the password goes straight into the page. */
export interface LoginToFill {
  origin: string;
  username: string;
  password: string;
}

/** What the person can do in a Star's tab from the live view, e.g. to sign in. */
export type ViewInput =
  | { type: 'click'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string }
  | { type: 'scroll'; dy: number }
  | { type: 'navigate'; url: string }
  | { type: 'back' };

const VIEWPORT = { width: 1280, height: 800 };
const TEXT_LIMIT = 6_000;
/** Control taken just by using the live view goes back to the Star after this long without input. */
const IMPLICIT_IDLE_MS = 2 * 60_000;
/** "Take over" goes back after this long without input, so a forgotten take-over can't park a Star for good. */
const TAKEOVER_IDLE_MS = 30 * 60_000;

/**
 * A real Chromium, driven with Playwright, shared by every Star: each Star
 * gets its own tab. It uses one persistent profile on disk, so cookies and
 * sign-ins survive restarts: the person signs in once (through the live view
 * or by running it visibly) and every Star can use that session.
 *
 * The browser starts on first use. After each action a screenshot is taken
 * for the live view, and a `browser.frame` event says a new one is ready.
 */
export class BrowserManager {
  store: Store;
  config: Config;
  private context: BrowserContext | null = null;
  private launching: Promise<BrowserContext> | null = null;
  private tabs = new Map<string, Tab>();
  private problem: string | null = null;
  private viewers = new Map<string, number>();
  private pumps = new Map<string, NodeJS.Timeout>();
  private idleTimer: NodeJS.Timeout | null = null;
  /** Called when control goes back to a Star, with the tasks that were waiting for it. */
  onHandBack?: (starId: string, waitingTaskIds: string[], note: string | null) => void;
  /** Called for each thing the person does while recording. */
  onRecord?: (recordingId: string, step: RecordedStep) => void;

  /** Ports Sky itself answers on (set when the server starts listening), which Stars' browsers never open. */
  ownPorts = new Set<number>();

  constructor(store: Store, config: Config) {
    this.store = store;
    this.config = config;
    this.ownPorts.add(config.port);
  }

  /**
   * Why a Star's browser may not open this address, or null. Sky's own address is off limits (its API would
   * hand a Star every memory, file and setting), and so are link-local and cloud metadata addresses.
   * The person's own live view isn't limited.
   */
  blockedForStars(raw: string): string | null {
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
    if (/^169\.254\./.test(host) || /^fe[89ab][0-9a-f]:/.test(host) || host === 'fd00:ec2::254' || host === 'metadata.google.internal' || host === 'metadata' || host === 'instance-data') {
      return 'That’s a link-local or cloud metadata address, which Stars’ browsers never open.';
    }
    const loopback = host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '::1' || host === '0.0.0.0' || host === '::' || host === this.config.host.toLowerCase();
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    const own = [this.config.publicUrl, this.config.webUrl].some((o) => { try { return new URL(o).origin === u.origin; } catch { return false; } });
    if (own || (loopback && this.ownPorts.has(port))) return 'That’s Sky’s own address. Stars’ browsers don’t open it: it holds everything Sky knows.';
    return null;
  }

  /** Whether a browser can be used, and if not, why. */
  available(): { ok: boolean; running: boolean; reason: string | null } {
    // Before the first launch, at least check the package is there.
    if (!this.problem && !this.context) {
      try {
        import.meta.resolve('playwright-core');
      } catch {
        this.problem = MISSING_PACKAGE;
      }
    }
    return { ok: !this.problem, running: Boolean(this.context), reason: this.problem };
  }

  private profileDir(): string {
    if (this.config.browserProfileDir) return this.config.browserProfileDir;
    if (this.config.dbPath === ':memory:') return mkdtempSync(join(tmpdir(), 'sky-browser-'));
    const dir = join(this.config.dataDir, 'browser-profile');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private async ensure(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (!this.launching) {
      this.launching = (async () => {
        let chromium;
        try {
          ({ chromium } = await import('playwright-core'));
        } catch {
          throw this.fail(MISSING_PACKAGE);
        }
        const proxyUrl = this.config.browserProxy;
        let proxy;
        if (proxyUrl) {
          const u = new URL(proxyUrl);
          proxy = { server: `${u.protocol}//${u.host}`, ...(u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : {}) };
        }
        try {
          const ctx = await chromium.launchPersistentContext(this.profileDir(), {
            headless: this.config.browserHeadless,
            viewport: VIEWPORT,
            ...(this.config.browserPath ? { executablePath: this.config.browserPath } : {}),
            ...(this.config.browserChannel ? { channel: this.config.browserChannel } : {}),
            ...(proxy ? { proxy } : {}),
            args: ['--disable-blink-features=AutomationControlled'],
          });
          // Pages a Star's tab reaches by a redirect or a link are held to the same limits as the addresses it opens.
          await ctx.route('**/*', (route) => {
            const req = route.request();
            if (this.blockedForStars(req.url())) {
              let page: Page | null = null;
              try { page = req.frame().page(); } catch { /* a service worker's request */ }
              const tab = [...this.tabs.values()].find((t) => t.page === page);
              if (!tab || tab.control === 'star') return route.abort('blockedbyclient');
            }
            return route.fallback();
          });
          ctx.on('close', () => {
            this.context = null;
            this.tabs.clear();
          });
          this.problem = null;
          this.context = ctx;
          return ctx;
        } catch (err) {
          throw this.fail(`Couldn’t start the browser: ${firstLine((err as Error).message)}. `
            + 'Install Chromium with `npx playwright install chromium`, or point SKY_BROWSER_PATH at Chrome.');
        }
      })().finally(() => { this.launching = null; });
    }
    return this.launching;
  }

  /** The browser can't start: remembered for GET /browser, and a 503 with the reason for API callers. */
  private fail(message: string): Error {
    this.problem = message;
    return new ApiError(503, 'browser_unavailable', message);
  }

  private async tab(starId: string): Promise<Tab> {
    const existing = this.tabs.get(starId);
    if (existing && !existing.page.isClosed()) return existing;
    const ctx = await this.ensure();
    // The persistent context opens with one blank page; the first Star takes it.
    const blank = ctx.pages().find((p) => p.url() === 'about:blank' && ![...this.tabs.values()].some((t) => t.page === p));
    const page = blank ?? await ctx.newPage();
    const tab: Tab = {
      page, elements: new Map(), frame: null, frameId: null, url: page.url(), title: '', updatedAt: iso(),
      control: 'star', controlNote: null, implicit: false, lastPersonAt: 0, waiting: [], recordingId: null, checkout: null, digits: '',
    };
    // While recording, pages the person ends up on (by a link, a form or a redirect) are steps too.
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) tab.digits = '';
      if (f === page.mainFrame() && tab.recordingId) this.record(tab, { kind: 'open', value: f.url() });
    });
    this.tabs.set(starId, tab);
    return tab;
  }

  /** Reads the page as text plus a numbered list of what can be clicked or typed into. */
  private async read(tab: Tab): Promise<Snapshot> {
    const { page } = tab;
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    const raw = await page.evaluate(SNAPSHOT_SCRIPT) as { elements: ElementInfo[]; text: string };
    tab.elements = new Map(raw.elements.map((e) => [e.ref, e]));
    tab.url = page.url();
    tab.title = await page.title().catch(() => '');
    return { url: tab.url, title: tab.title, text: raw.text, elements: raw.elements };
  }

  /** Screenshot for the live view. */
  private async capture(starId: string, tab: Tab) {
    try {
      tab.frame = await tab.page.screenshot({ type: 'jpeg', quality: 60 });
      tab.frameId = uid('f');
      tab.updatedAt = iso();
      tab.url = tab.page.url();
      tab.title = await tab.page.title().catch(() => tab.title);
      this.store.bus.emit({ type: 'browser.frame', data: this.session(starId, tab) });
    } catch {
      // A page mid-navigation can refuse a screenshot; the next action takes another.
    }
  }

  /** Hides secret values that ended up in an address or a title (set to the vault's redact). */
  redact: (text: string) => string = (t) => t;

  private session(starId: string, tab: Tab): BrowserSession {
    return {
      starId, url: this.redact(tab.url), title: this.redact(tab.title), frameId: tab.frameId, updatedAt: tab.updatedAt,
      control: tab.control, controlNote: tab.controlNote, waitingTaskId: tab.waiting[0] ?? null, recordingId: tab.recordingId,
      checkout: tab.checkout ? { ...tab.checkout, url: this.redact(tab.checkout.url) } : null,
    };
  }

  private async act(starId: string, action: (tab: Tab) => Promise<void>): Promise<Snapshot> {
    const tab = await this.tab(starId);
    if (tab.control === 'person') throw new PersonInControl(tab.controlNote);
    await action(tab);
    await tab.page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    await tab.page.waitForTimeout(300);
    const snap = await this.read(tab);
    await this.capture(starId, tab);
    return snap;
  }

  open(starId: string, url: string) {
    const target = pageUrl(url);
    if (!target) throw new Error(`“${oneLine(url, 80)}” isn’t a web address Sky can open (only http and https pages)`);
    const blocked = this.blockedForStars(target);
    if (blocked) throw new Error(blocked);
    return this.act(starId, async (t) => { await t.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 }); });
  }

  search(starId: string, query: string) {
    return this.open(starId, `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  }

  snapshot(starId: string) {
    return this.act(starId, async () => {});
  }

  /** The element a ref, or failing that a visible label, points at in the last snapshot. */
  element(starId: string, ref?: string, text?: string): ElementInfo | undefined {
    const els = this.tabs.get(starId)?.elements;
    if (!els) return undefined;
    if (ref && els.has(ref)) return els.get(ref);
    if (text) {
      const want = text.trim().toLowerCase();
      const all = [...els.values()];
      return all.find((e) => e.label.toLowerCase() === want) ?? all.find((e) => e.label.toLowerCase().includes(want));
    }
    return undefined;
  }

  currentPage(starId: string): { url: string; title: string } | undefined {
    const t = this.tabs.get(starId);
    return t ? { url: this.redact(t.page.url()), title: this.redact(t.title) } : undefined;
  }

  click(starId: string, target: { ref?: string; text?: string }) {
    return this.act(starId, async (t) => {
      const el = this.element(starId, target.ref, target.text);
      if (el) await t.page.locator(`[data-sky-ref="${el.ref}"]`).first().click({ timeout: 10_000 });
      else if (target.text) await t.page.getByText(target.text, { exact: false }).first().click({ timeout: 10_000 });
      else throw new Error(`No element ${target.ref} on the page. Take a fresh snapshot.`);
    });
  }

  type(starId: string, input: { ref?: string; text: string; submit?: boolean }) {
    return this.act(starId, async (t) => {
      const el = this.element(starId, input.ref);
      if (!el) throw new Error(`No field ${input.ref} on the page. Take a fresh snapshot.`);
      if (el.password) throw new Error('Stars don’t type passwords. Ask the person to sign in through the browser view; the sign-in will stick.');
      if (el.payment || looksLikeCard(input.text)) throw new Error('Stars never enter card details. Fill in everything else, then call browser_checkout_handover so the person pays themselves.');
      const field = t.page.locator(`[data-sky-ref="${el.ref}"]`).first();
      t.digits = '';
      await field.fill(input.text, { timeout: 10_000 });
      if (input.submit) await field.press('Enter');
    });
  }

  /**
   * A key press. The page's focused element decides what it can do, so the checks that guard browser_type and
   * browser_click hold here too: no characters into a password or card field (found through frames and shadow
   * DOM), no Enter or Space on a pay button, and no long number typed one key at a time.
   */
  press(starId: string, key: string) {
    return this.act(starId, async (t) => {
      const focus = await deepFocus(t.page);
      const ch = keyChar(key);
      if (ch !== null && focus?.secret) {
        throw new Error(focus.password
          ? 'Stars don’t type passwords. Ask the person to sign in through the browser view; the sign-in will stick.'
          : 'Stars never enter card details. Fill in everything else, then call browser_checkout_handover so the person pays themselves.');
      }
      if (activatesFocus(key) && focus?.pay) {
        throw new Error(`“${focus.label}” looks like a pay button. Stars never pay: call browser_checkout_handover so the person does.`);
      }
      if (ch !== null && /\d/.test(ch)) {
        t.digits = `${t.digits}${ch}`.slice(-40);
        if (t.digits.length >= MAX_KEY_DIGITS) {
          t.digits = '';
          if (focus?.editable) await t.page.keyboard.press('Control+A').then(() => t.page.keyboard.press('Backspace')).catch(() => {});
          throw new Error('Stars never enter card details, and a long number isn’t typed one key at a time: use browser_type for ordinary text.');
        }
      }
      await t.page.keyboard.press(key);
    });
  }

  scroll(starId: string, direction: 'up' | 'down') {
    return this.act(starId, async (t) => { await t.page.mouse.wheel(0, direction === 'down' ? 700 : -700); });
  }

  back(starId: string) {
    return this.act(starId, async (t) => { await t.page.goBack({ timeout: 15_000 }).catch(() => {}); });
  }

  // ---- take-over and hand-back -------------------------------------------

  /** Who drives a Star's tab right now. */
  controller(starId: string): 'star' | 'person' {
    return this.tabs.get(starId)?.control ?? 'star';
  }

  /**
   * The person takes the wheel: the Star's browser tools wait until it's
   * handed back. `waitingTaskId` is a task that asked for this (to sign in,
   * solve a puzzle) and carries on at hand-back.
   */
  async takeOver(starId: string, opts: { note?: string | null; waitingTaskId?: string | null; implicit?: boolean; recordingId?: string } = {}): Promise<BrowserSession> {
    const tab = await this.tab(starId);
    const was = tab.control;
    tab.control = 'person';
    tab.implicit = Boolean(opts.implicit) && (was === 'star' || tab.implicit);
    tab.lastPersonAt = Date.now();
    if (opts.note !== undefined) tab.controlNote = opts.note ? oneLine(opts.note, 200) : null;
    if (opts.waitingTaskId && !tab.waiting.includes(opts.waitingTaskId)) tab.waiting.push(opts.waitingTaskId);
    if (opts.recordingId) tab.recordingId = opts.recordingId;
    if (!this.idleTimer) {
      this.idleTimer = setInterval(() => this.handBackIdle(), 15_000);
      this.idleTimer.unref();
    }
    if (was !== 'person' && !tab.implicit) this.store.log('browser', `You took over ${this.starName(starId)}’s browser${tab.controlNote ? `: ${tab.controlNote}` : ''}`, undefined, starId);
    await this.capture(starId, tab);
    this.emitControl(starId, tab);
    return this.session(starId, tab);
  }

  /** Control goes back to the Star; a task waiting for this carries on. */
  handBack(starId: string, note?: string | null): BrowserSession | null {
    const tab = this.tabs.get(starId);
    if (!tab) return null;
    if (tab.control === 'star') return this.session(starId, tab);
    const waiting = tab.waiting;
    const recorded = tab.recordingId;
    const implicit = tab.implicit;
    tab.control = 'star';
    tab.controlNote = null;
    tab.implicit = false;
    tab.waiting = [];
    tab.recordingId = null;
    tab.checkout = null;
    const clean = note?.trim() ? oneLine(note, 300) : null;
    if (!implicit || waiting.length) this.store.log('browser', `${this.starName(starId)} has the browser back${clean ? `: ${clean}` : ''}`, waiting[0], starId);
    this.emitControl(starId, tab);
    if (recorded) this.onRecordEnd?.(recorded);
    this.onHandBack?.(starId, waiting, clean);
    if (![...this.tabs.values()].some((t) => t.control === 'person') && this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    return this.session(starId, tab);
  }

  /** Called when a recording ends with a hand-back (by the person or the idle timer). */
  onRecordEnd?: (recordingId: string) => void;

  /** Forgotten take-overs end on their own. */
  handBackIdle(now = Date.now()) {
    for (const [starId, t] of this.tabs) {
      if (t.control !== 'person' || t.recordingId) continue;
      const limit = t.implicit ? IMPLICIT_IDLE_MS : TAKEOVER_IDLE_MS;
      if (now - t.lastPersonAt >= limit) this.handBack(starId, t.implicit ? null : 'handed back on its own after 30 minutes without input');
    }
  }

  private emitControl(starId: string, tab: Tab) {
    this.store.bus.emit({ type: 'browser.control', data: this.session(starId, tab) });
  }

  private starName(starId: string) {
    return this.store.findStar(starId)?.name ?? 'The Star';
  }

  /** A task that tried to use the tab while the person has it waits for the hand-back. */
  waitForHandBack(starId: string, taskId: string) {
    const tab = this.tabs.get(starId);
    if (tab && tab.control === 'person' && !tab.waiting.includes(taskId)) {
      tab.waiting.push(taskId);
      this.emitControl(starId, tab);
    }
  }

  /** A Star filled in a checkout: shown on the live view and the approval until it's paid or dropped. */
  setCheckout(starId: string, checkout: CheckoutHandover | null) {
    const tab = this.tabs.get(starId);
    if (!tab) return;
    tab.checkout = checkout;
    this.emitControl(starId, tab);
  }

  // ---- recording (teach a task) ------------------------------------------

  /** Starts recording the person in a Star's tab; the person takes control for it. */
  async startRecording(starId: string, recordingId: string, title: string, url?: string) {
    const target = url ? pageUrl(url) : null;
    if (url && !target) throw badRequest(`“${oneLine(url, 80)}” isn’t a web address`);
    const tab = await this.tab(starId);
    if (tab.recordingId) throw new ApiError(409, 'conflict', 'Already recording in this browser. Stop that recording first.');
    await this.takeOver(starId, { note: `Recording: ${title}`, recordingId });
    if (target) {
      await tab.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
      await this.capture(starId, tab);
    } else if (tab.page.url() !== 'about:blank') {
      this.record(tab, { kind: 'open', value: tab.page.url() });
    }
  }

  /** Stops recording (and hands the browser back). */
  stopRecording(starId: string): string | null {
    const tab = this.tabs.get(starId);
    const id = tab?.recordingId ?? null;
    if (tab && id) {
      // Hand back without the end hook: the caller drafts the skill itself.
      const hook = this.onRecordEnd;
      this.onRecordEnd = undefined;
      try { this.handBack(starId); } finally { this.onRecordEnd = hook; }
    }
    return id;
  }

  private lastOpen = new Map<string, string>();

  private record(tab: Tab, step: Omit<RecordedStep, 'at' | 'url'>) {
    if (!tab.recordingId || !this.onRecord) return;
    const url = tab.page.url();
    if (step.kind === 'open') {
      if (!step.value || step.value === 'about:blank' || this.lastOpen.get(tab.recordingId) === step.value) return;
      this.lastOpen.set(tab.recordingId, step.value);
    }
    // What's kept (and later shown, replayed and sent to a model) never holds a card number or a vault secret.
    const clean = (v: string | undefined) => (v === undefined ? v : this.redact(maskCards(v)));
    this.onRecord(tab.recordingId, { at: iso(), url: this.redact(url), ...step, value: clean(step.value), ...(step.target !== undefined ? { target: clean(step.target) } : {}) });
  }

  /** What the person is about to click or type into, for the recording. */
  private async describeAt(page: Page, x?: number, y?: number) {
    return await page.evaluate(describeFn, x === undefined ? null : [x, y]).catch(() => null) as { label: string; password: boolean } | null;
  }

  // ---- saved logins ------------------------------------------------------

  /**
   * Fills a saved login into the current page. Only on the exact site it was
   * saved for, only over https (or on this machine), and never on a page with
   * a new-password field or more than one password field, which is a
   * sign-up or change-password form. The password goes into the page and
   * nowhere else: not the snapshot, the timeline or the model.
   */
  async fillLogin(starId: string, login: LoginToFill, submit: boolean): Promise<{ snapshot: Snapshot; filled: 'both' | 'username' | 'password' }> {
    let filled: 'both' | 'username' | 'password' = 'both';
    const snapshot = await this.act(starId, async (t) => {
      const here = new URL(t.page.url());
      if (here.origin !== login.origin) throw new Error(`This login is for ${login.origin}, and the page is on ${here.origin}. Logins are only filled on the site they were saved for.`);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(here.hostname);
      if (here.protocol !== 'https:' && !local) throw new Error('The page isn’t secure (https), so the login wasn’t filled.');
      const form = await t.page.evaluate(LOGIN_SCRIPT) as { passwords: number; newPassword: boolean; user: boolean; pass: boolean };
      if (form.newPassword || form.passwords > 1) throw new Error('This looks like a sign-up or change-password form. Stars only sign in; they never set or change passwords.');
      if (!form.user && !form.pass) throw new Error('No sign-in fields on this page. Open the sign-in page first.');
      if (form.user) await t.page.locator('[data-sky-fill="user"]').first().fill(login.username, { timeout: 10_000 });
      if (form.pass) await t.page.locator('[data-sky-fill="pass"]').first().fill(login.password, { timeout: 10_000 });
      filled = form.user && form.pass ? 'both' : form.user ? 'username' : 'password';
      if (submit) await t.page.locator(`[data-sky-fill="${form.pass ? 'pass' : 'user'}"]`).first().press('Enter');
      await t.page.evaluate(`document.querySelectorAll('[data-sky-fill]').forEach((e) => e.removeAttribute('data-sky-fill'))`);
    });
    return { snapshot, filled };
  }

  // ---- the live view -----------------------------------------------------

  sessions(): BrowserSession[] {
    return [...this.tabs.entries()].filter(([, t]) => !t.page.isClosed()).map(([id, t]) => this.session(id, t));
  }

  frame(starId: string): Buffer | null {
    return this.tabs.get(starId)?.frame ?? null;
  }

  /** The person acting in a Star's tab, e.g. to sign in. Returns the new session state. */
  async input(starId: string, i: ViewInput): Promise<BrowserSession> {
    const target = i.type === 'navigate' ? pageUrl(i.url) : null;
    if (i.type === 'navigate' && !target) throw badRequest(`“${oneLine(i.url, 80)}” isn’t a web address. Try something like example.com or https://example.com`);
    const tab = await this.tab(starId);
    const { page } = tab;
    // Using the live view takes control, so the Star and the person don't fight over the page.
    if (tab.control === 'star') await this.takeOver(starId, { implicit: true, note: null });
    tab.lastPersonAt = Date.now();
    if (tab.recordingId) {
      const at = i.type === 'click' ? await this.describeAt(page, i.x, i.y) : null;
      // What's being typed into, looking through frames and shadow DOM to the real focused element.
      const focus = i.type === 'type' || i.type === 'key' ? await deepFocus(page) : null;
      const hidden = focus?.password ? '[password]' : focus?.secret || (i.type === 'type' && looksLikeCard(i.text)) ? '[hidden]' : null;
      if (i.type === 'click') this.record(tab, { kind: 'click', target: at?.label || `the spot at ${Math.round(i.x)}, ${Math.round(i.y)}` });
      else if (i.type === 'type') this.record(tab, { kind: 'type', ...(focus?.label ? { target: focus.label } : {}), value: hidden ?? i.text });
      else if (i.type === 'key') this.record(tab, { kind: 'key', value: hidden && keyChar(i.key) !== null ? hidden : i.key });
      else if (i.type === 'scroll') this.record(tab, { kind: 'scroll', value: i.dy > 0 ? 'down' : 'up' });
      else if (i.type === 'back') this.record(tab, { kind: 'back' });
      else if (i.type === 'navigate') this.record(tab, { kind: 'open', value: target! });
    }
    try {
      switch (i.type) {
        case 'click': await page.mouse.click(i.x, i.y); break;
        case 'type': await page.keyboard.type(i.text); break;
        case 'key': await page.keyboard.press(i.key); break;
        case 'scroll': await page.mouse.wheel(0, i.dy); break;
        case 'navigate': await page.goto(target!, { waitUntil: 'domcontentloaded', timeout: 45_000 }); break;
        case 'back': await page.goBack().catch(() => {}); break;
      }
    } catch (err) {
      // A page that won't load (no such site, offline, refused) is the page's problem, not the server's.
      const reason = (err instanceof Error ? err.message : String(err)).replace(/^page\.\w+:\s*/, '');
      await this.capture(starId, tab).catch(() => {});
      throw new ApiError(400, 'page_failed', i.type === 'navigate' ? `Couldn’t open ${target}: ${oneLine(reason, 160)}` : `That didn’t work: ${oneLine(reason, 160)}`);
    }
    await page.waitForTimeout(250);
    await this.capture(starId, tab);
    return this.session(starId, tab);
  }

  /** Live view stream: while someone watches, a new frame about once a second. */
  watch(starId: string, onFrame: (jpeg: Buffer) => void): () => void {
    this.viewers.set(starId, (this.viewers.get(starId) ?? 0) + 1);
    const listener = this.store.bus.subscribe((e) => {
      if (e.type === 'browser.frame' && e.data.starId === starId) {
        const f = this.frame(starId);
        if (f) onFrame(f);
      }
    });
    if (!this.pumps.has(starId)) {
      this.pumps.set(starId, setInterval(() => {
        const tab = this.tabs.get(starId);
        if (tab && !tab.page.isClosed()) void this.capture(starId, tab);
      }, 1_000));
    }
    const f = this.frame(starId);
    if (f) onFrame(f);
    return () => {
      listener();
      const n = (this.viewers.get(starId) ?? 1) - 1;
      this.viewers.set(starId, n);
      if (n <= 0) {
        clearInterval(this.pumps.get(starId));
        this.pumps.delete(starId);
      }
    };
  }

  async closeTab(starId: string) {
    const tab = this.tabs.get(starId);
    this.tabs.delete(starId);
    await tab?.page.close().catch(() => {});
  }

  async close() {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    for (const t of this.pumps.values()) clearInterval(t);
    this.pumps.clear();
    const ctx = this.context;
    this.context = null;
    this.tabs.clear();
    await ctx?.close().catch(() => {});
  }
}

/** Formats a snapshot for the model: the page, its text, and numbered elements. */
export function describeSnapshot(s: Snapshot): string {
  const lines = s.elements.map((e) => {
    const kind = e.tag === 'a' ? 'link' : e.payment ? 'card field (the person fills this in)' : e.tag === 'input' || e.tag === 'textarea' ? (e.password ? 'password field' : `${e.type || 'text'} field`)
      : e.tag === 'select' ? 'dropdown' : e.role || e.tag;
    return `[${e.ref}] ${kind} “${e.label}”${e.href ? ` → ${e.href}` : ''}${e.submit ? ' (submits a form)' : ''}`;
  });
  const text = s.text.length > TEXT_LIMIT ? `${s.text.slice(0, TEXT_LIMIT)}\n…(cut; scroll or snapshot again for more)` : s.text;
  return `Page: ${s.title || '(untitled)'} — ${s.url}\n\n${text || '(no text)'}\n\nWhat you can use (pass the ref to browser_click or browser_type):\n${lines.join('\n') || '(nothing interactive)'}`;
}

const MISSING_PACKAGE = 'The browser needs the playwright-core package. Run npm install in server/.';
const firstLine = (s: string) => s.split('\n')[0].slice(0, 200);

/** Runs in the page: tags visible interactive elements with data-sky-ref and returns them with the page text. */
const SNAPSHOT_SCRIPT = `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  document.querySelectorAll('[data-sky-ref]').forEach((e) => e.removeAttribute('data-sky-ref'));
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[contenteditable=""],[contenteditable=true],summary';
  const out = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (out.length >= 150) break;
    if (!visible(el)) continue;
    const ref = 'e' + (++n);
    el.setAttribute('data-sky-ref', ref);
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const password = type === 'password';
    const hints = [el.getAttribute('autocomplete'), el.getAttribute('name'), el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.labels && el.labels[0] && el.labels[0].innerText].join(' ');
    const payment = (tag === 'input' || tag === 'select') && (/\\bcc-|card.?(number|num|no\\b)|cardnumber|\\bcvc|\\bcvv|\\bcsc\\b|security code|expir|exp.?(date|month|year)|cardholder|name on card/i.test(hints));
    const value = !password && (tag === 'button' || type === 'submit' || type === 'button') ? el.value : '';
    const label = (el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || value
      || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const submit = (tag === 'button' && (type === '' || type === 'submit') && !!el.form) || (tag === 'input' && (type === 'submit' || type === 'image'));
    out.push({ ref, tag, type, role: el.getAttribute('role') || '', label, href: tag === 'a' ? el.href : undefined, submit, password, payment });
  }
  const text = document.body ? document.body.innerText.replace(/\\n{3,}/g, '\\n\\n').trim() : '';
  return { elements: out, text };
})()`;

/** Runs in the page: what's at a point (or focused), labelled like the snapshot labels it. */
const DESCRIBE_SCRIPT = `((at) => {
  let el = at ? document.elementFromPoint(at[0], at[1]) : document.activeElement;
  if (!el) return null;
  el = el.closest('a,button,input,select,textarea,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],summary') || el;
  const type = (el.getAttribute('type') || '').toLowerCase();
  const label = (el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText
    || (type === 'submit' || type === 'button' ? el.value : '') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '')
    .trim().replace(/\\s+/g, ' ').slice(0, 80);
  return { label, password: type === 'password' };
})`;

// A real function, so Playwright passes the point to it.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const describeFn = new Function(`return ${DESCRIBE_SCRIPT}`)() as (at: (number | undefined)[] | null) => unknown;

/** Runs in a frame: the element that really has focus (through shadow roots), and whether it is secret or a pay button. */
const FOCUS_SCRIPT = `(() => {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el === document.body || el === document.documentElement || /^(iframe|frame)$/i.test(el.tagName)) return null;
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const auto = (el.getAttribute('autocomplete') || '').toLowerCase();
  const hints = [auto, el.getAttribute('name'), el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.labels && el.labels[0] && el.labels[0].innerText].join(' ');
  const password = type === 'password' || /password|passwd|passcode/.test(auto) || /\\b(password|passwd|pwd|passcode)\\b/i.test(hints);
  const field = tag === 'input' || tag === 'textarea' || el.isContentEditable;
  const payment = field && (/\\bcc-|card.?(number|num|no\\b)|cardnumber|\\bcvc|\\bcvv|\\bcsc\\b|security code|expir|exp.?(date|month|year)|cardholder|name on card/i.test(hints) || /one-time-code|\\botp\\b/i.test(hints));
  const button = tag === 'button' || (tag === 'input' && ['submit', 'button', 'image'].includes(type)) || el.getAttribute('role') === 'button';
  // A field's value is what the person typed, so it is never its label.
  const label = (el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || (button ? el.innerText || el.value : '') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
  const pay = button && /\\b(pay|pay now|payment|purchase|buy now|place (your )?order|order now|complete (order|purchase)|confirm (order|purchase|payment)|donate|subscribe)\\b/i.test(label);
  return { tag, type, label, password, secret: password || payment, pay, editable: field };
})`;

// A real function, so it runs as written in each frame.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const focusFn = new Function(`return ${FOCUS_SCRIPT}`)() as () => { tag: string; type: string; label: string; password: boolean; secret: boolean; pay: boolean; editable: boolean } | null;

/** What has focus in the page, whichever frame it is in. */
async function deepFocus(page: Page) {
  for (const f of page.frames()) {
    const r = await f.evaluate(focusFn).catch(() => null);
    if (r) return r;
  }
  return null;
}

/** Long numbers pressed one key at a time are refused from this many digits (a card has 13 to 19). */
const MAX_KEY_DIGITS = 13;

/** The character a key press types, or null for keys like Tab and ArrowDown. */
export function keyChar(key: string): string | null {
  const num = /^(?:Digit|Numpad)(\d)$/.exec(key);
  if (num) return num[1];
  if (key === 'Space') return ' ';
  return [...key].length === 1 ? key : null;
}

/** Keys that press the focused button or submit a form: Enter, Space and anything with a modifier (except Shift+Tab). */
export function activatesFocus(key: string): boolean {
  return /^(enter|numpadenter|space)$/i.test(key) || key === ' ' || (/^[^+]+\+./.test(key) && !/^shift\+tab$/i.test(key));
}

/** Replaces card numbers in text (13 to 19 digits that pass the Luhn check) with a marker. */
export function maskCards(text: string): string {
  return text.replace(/(?:\d[ -]?){13,19}/g, (m) => (looksLikeCard(m) ? `[card number]${/[ -]+$/.exec(m)?.[0] ?? ''}` : m));
}

/** Runs in the page: marks the sign-in fields with data-sky-fill and says what it found. */
const LOGIN_SCRIPT = `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled; };
  const inputs = [...document.querySelectorAll('input')].filter(visible);
  const passwords = inputs.filter((i) => i.type === 'password');
  const newPassword = passwords.some((p) => (p.autocomplete || '').includes('new-password'));
  const pass = passwords[0] || null;
  const userish = (i) => ['text', 'email', 'tel', ''].includes(i.type) && (/user|email|login|account|identifier/i.test(i.autocomplete + ' ' + i.name + ' ' + i.id + ' ' + (i.getAttribute('aria-label') || '') + ' ' + (i.placeholder || '')) || i.type === 'email');
  let user = null;
  if (pass) {
    const scope = pass.form ? [...pass.form.querySelectorAll('input')].filter(visible) : inputs;
    const before = scope.slice(0, scope.indexOf(pass)).filter((i) => ['text', 'email', 'tel', ''].includes(i.type));
    user = before.filter(userish).pop() || before.pop() || null;
  } else {
    user = inputs.find(userish) || null;
  }
  if (user) user.setAttribute('data-sky-fill', 'user');
  if (pass) pass.setAttribute('data-sky-fill', 'pass');
  return { passwords: passwords.length, newPassword, user: !!user, pass: !!pass };
})()`;

/** A typed address as a page URL: "example.com" gets https://. Null when it isn't an http(s) address. */
export function pageUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text || /\s/.test(text)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^:/]+:\d+(\/|$)/.test(text) ? text : `https://${text}`;
  try {
    const u = new URL(withScheme);
    if (!/^https?:$/.test(u.protocol) || !u.hostname || (!u.hostname.includes('.') && u.hostname !== 'localhost' && !/^\[|^\d+\.\d+/.test(u.hostname))) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** A 13 to 19 digit number that passes the Luhn check, with or without spaces and dashes: a card number. */
export function looksLikeCard(text: string): boolean {
  for (const m of text.matchAll(/(?:\d[ -]?){13,19}/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}
