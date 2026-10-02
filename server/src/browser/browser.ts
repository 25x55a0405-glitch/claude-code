import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import type { Config } from '../config.ts';
import type { Store } from '../store.ts';
import type { BrowserSession } from '../types.ts';
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

  constructor(store: Store, config: Config) {
    this.store = store;
    this.config = config;
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
    const tab: Tab = { page, elements: new Map(), frame: null, frameId: null, url: page.url(), title: '', updatedAt: iso() };
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
    return { starId, url: this.redact(tab.url), title: this.redact(tab.title), frameId: tab.frameId, updatedAt: tab.updatedAt };
  }

  private async act(starId: string, action: (tab: Tab) => Promise<void>): Promise<Snapshot> {
    const tab = await this.tab(starId);
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
      const field = t.page.locator(`[data-sky-ref="${el.ref}"]`).first();
      await field.fill(input.text, { timeout: 10_000 });
      if (input.submit) await field.press('Enter');
    });
  }

  press(starId: string, key: string) {
    return this.act(starId, async (t) => { await t.page.keyboard.press(key); });
  }

  scroll(starId: string, direction: 'up' | 'down') {
    return this.act(starId, async (t) => { await t.page.mouse.wheel(0, direction === 'down' ? 700 : -700); });
  }

  back(starId: string) {
    return this.act(starId, async (t) => { await t.page.goBack({ timeout: 15_000 }).catch(() => {}); });
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
    const kind = e.tag === 'a' ? 'link' : e.tag === 'input' || e.tag === 'textarea' ? (e.password ? 'password field' : `${e.type || 'text'} field`)
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
    const value = !password && (tag === 'button' || type === 'submit' || type === 'button') ? el.value : '';
    const label = (el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || value
      || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const submit = (tag === 'button' && (type === '' || type === 'submit') && !!el.form) || (tag === 'input' && (type === 'submit' || type === 'image'));
    out.push({ ref, tag, type, role: el.getAttribute('role') || '', label, href: tag === 'a' ? el.href : undefined, submit, password });
  }
  const text = document.body ? document.body.innerText.replace(/\\n{3,}/g, '\\n\\n').trim() : '';
  return { elements: out, text };
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
