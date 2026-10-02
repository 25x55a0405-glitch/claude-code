import { describeSnapshot, type ElementInfo } from '../../browser/browser.ts';
import { firstLine } from '../../util.ts';
import { bool, schema, str, type ApprovalPreview, type Effect, type ToolContext, type ToolDef, type ToolEnv } from './types.ts';

const MONEY = /\b(pay|payment|purchase|buy|checkout|check out|place (your )?order|order now|add to cart|subscribe|upgrade|donate|transfer|\$\s?\d|€\s?\d|£\s?\d|₹\s?\d)\b/i;
const DELETE = /\b(delete|remove|erase|discard|close account|deactivate|unsubscribe)\b/i;
const SEND = /\b(send|submit|post|publish|reply|comment|share|confirm|sign up|register|apply|book|reserve|save|accept invite|invite|tweet|message)\b/i;

function tab(ctx: ToolContext) {
  if (!ctx.browser) throw new Error('The browser isn’t available on this server.');
  return ctx.browser;
}

const element = (env: ToolEnv | undefined, i: { ref?: string; text?: string }): ElementInfo | undefined =>
  env?.browser?.element(env.starId, i.ref, i.text);

/** What a click does, from the element it lands on: following a link only reads; buying, deleting and submitting need care. */
function clickEffect(el: ElementInfo | undefined, text?: string): Effect {
  const label = `${el?.label ?? ''} ${text ?? ''}`;
  if (MONEY.test(label)) return 'spend';
  if (DELETE.test(label)) return 'delete';
  if (el?.submit || SEND.test(label)) return 'send';
  if (el && el.tag === 'a' && el.href && !el.href.startsWith('javascript:')) return 'read';
  if (el && ['tab', 'link', 'menuitem'].includes(el.role)) return 'read';
  return 'write';
}

function pagePreview(env: ToolEnv | undefined, action: string, detail: string): ApprovalPreview {
  const page = env?.browser?.currentPage(env.starId);
  let host = 'a web page';
  try {
    if (page?.url) host = new URL(page.url).host;
  } catch { /* keep the default */ }
  return { action, target: host, preview: `${detail}${page ? `\n\nOn “${page.title || page.url}” (${page.url})` : ''}` };
}

const STARTED = 'Opened in the browser. ';

export const browserOpen: ToolDef<{ url: string }> = {
  name: 'browser_open',
  description: 'Open a web page in your real browser tab and read it. Returns the page text and a numbered list of links, buttons and fields '
    + '(refs like e12) you can use with browser_click and browser_type. Sign-ins the person made in this browser are kept.',
  input_schema: schema({ url: str('The address to open') }, ['url']),
  effect: 'read',
  connection: 'browser',
  label: (i) => `Opened ${firstLine(i.url, 80)}`,
  async run(i, ctx) {
    return { content: STARTED + describeSnapshot(await tab(ctx).open(ctx.star.id, i.url)) };
  },
};

export const browserSearch: ToolDef<{ query: string }> = {
  name: 'browser_search',
  description: 'Search the web in your browser (DuckDuckGo) and read the results page. Then open a result with browser_open or browser_click.',
  input_schema: schema({ query: str('What to search for') }, ['query']),
  effect: 'read',
  connection: 'browser',
  label: (i) => `Searched in the browser: ${firstLine(i.query, 80)}`,
  async run(i, ctx) {
    return describeSnapshot(await tab(ctx).search(ctx.star.id, i.query));
  },
};

export const browserSnapshot: ToolDef<Record<string, never>> = {
  name: 'browser_snapshot',
  description: 'Read the current page in your browser tab again, with fresh element refs. Use it after the page changes on its own.',
  input_schema: schema({}),
  effect: 'read',
  connection: 'browser',
  label: () => 'Looked at the page again',
  async run(_i, ctx) {
    return describeSnapshot(await tab(ctx).snapshot(ctx.star.id));
  },
};

export const browserClick: ToolDef<{ ref?: string; text?: string }> = {
  name: 'browser_click',
  description: 'Click a link, button or other element in your browser tab, by its ref from the last snapshot (preferred) or by its visible text. '
    + 'Clicks that buy, delete or submit something may need the person’s OK first; just call the tool.',
  input_schema: schema({ ref: str('Element ref, like e12'), text: str('Visible text, if you have no ref') }),
  effect: 'write',
  connection: 'browser',
  effectFor: (i, env) => clickEffect(element(env, i), i.text),
  approval: (i, env) => {
    const el = element(env, i);
    const name = el?.label || i.text || i.ref || 'an element';
    const effect = clickEffect(el, i.text);
    const verb = effect === 'spend' ? 'Buy or pay' : effect === 'delete' ? 'Delete' : effect === 'send' ? 'Submit' : 'Click';
    return { ...pagePreview(env, `${verb}: “${firstLine(name, 60)}”`, `Click “${name}”${el?.submit ? ', which submits the form' : ''}.`), ...(effect === 'spend' || effect === 'delete' ? { risk: 'high' as const } : {}) };
  },
  label: (i) => `Clicked ${i.text ? `“${firstLine(i.text, 60)}”` : i.ref ?? 'on the page'}`,
  async run(i, ctx) {
    if (!i.ref && !i.text) throw new Error('Give the element’s ref (or its visible text).');
    const b = tab(ctx);
    const el = b.element(ctx.star.id, i.ref, i.text);
    const snap = await b.click(ctx.star.id, i);
    return { content: describeSnapshot(snap), summary: `Clicked “${firstLine(el?.label || i.text || i.ref || '', 60)}”` };
  },
};

export const browserType: ToolDef<{ ref: string; text: string; submit?: boolean }> = {
  name: 'browser_type',
  description: 'Type into a field in your browser tab (replacing what is there), by its ref. Set submit to press Enter afterwards, '
    + 'which usually submits the form. Never type passwords: ask the person to sign in through the browser view instead.',
  input_schema: schema({ ref: str('Field ref, like e7'), text: str('What to type'), submit: bool('Press Enter afterwards') }, ['ref', 'text']),
  effect: 'write',
  connection: 'browser',
  effectFor: (i) => (i.submit ? 'send' : 'write'),
  approval: (i, env) => {
    const el = element(env, i);
    return pagePreview(env, i.submit ? `Fill in and submit “${firstLine(el?.label || i.ref, 40)}”` : `Type into “${firstLine(el?.label || i.ref, 40)}”`, i.text);
  },
  applyEdit: (i, edited) => ({ ...i, text: edited.split('\n\nOn “')[0] }),
  label: (i) => `Typed into ${i.ref}${i.submit ? ' and submitted' : ''}`,
  async run(i, ctx) {
    const b = tab(ctx);
    const el = b.element(ctx.star.id, i.ref);
    const snap = await b.type(ctx.star.id, i);
    return { content: describeSnapshot(snap), summary: `Typed into “${firstLine(el?.label || i.ref, 50)}”${i.submit ? ' and submitted' : ''}` };
  },
};

export const browserPress: ToolDef<{ key: string }> = {
  name: 'browser_press',
  description: 'Press a key in your browser tab, like Enter, Escape, Tab or ArrowDown.',
  input_schema: schema({ key: str('Key name, as in Playwright: Enter, Escape, Tab, ArrowDown…') }, ['key']),
  // Write by default so chat (which only reads) never presses Enter on a form.
  effect: 'write',
  connection: 'browser',
  effectFor: (i) => (/^enter$/i.test(i.key) ? 'send' : 'read'),
  approval: (i, env) => pagePreview(env, `Press ${i.key}`, `Press ${i.key}, which may submit what was typed.`),
  label: (i) => `Pressed ${i.key}`,
  async run(i, ctx) {
    return describeSnapshot(await tab(ctx).press(ctx.star.id, i.key));
  },
};

export const browserScroll: ToolDef<{ direction: 'up' | 'down' }> = {
  name: 'browser_scroll',
  description: 'Scroll the page in your browser tab to see more.',
  input_schema: schema({ direction: str('up or down', { enum: ['up', 'down'] }) }, ['direction']),
  effect: 'read',
  connection: 'browser',
  label: (i) => `Scrolled ${i.direction}`,
  async run(i, ctx) {
    return describeSnapshot(await tab(ctx).scroll(ctx.star.id, i.direction));
  },
};

export const browserBack: ToolDef<Record<string, never>> = {
  name: 'browser_back',
  description: 'Go back to the previous page in your browser tab.',
  input_schema: schema({}),
  effect: 'read',
  connection: 'browser',
  label: () => 'Went back',
  async run(_i, ctx) {
    return describeSnapshot(await tab(ctx).back(ctx.star.id));
  },
};

export const browserAskPerson: ToolDef<{ reason: string }> = {
  name: 'browser_ask_person',
  description: 'Hand your browser tab to the person for something only they should do: signing in, a captcha, a two-factor code, '
    + 'or a choice that is theirs. The task waits until they hand it back, then you get their note. Take a fresh snapshot after.',
  input_schema: schema({ reason: str('What you need them to do, in one sentence, e.g. "Sign in to your bank so I can download the statement"') }, ['reason']),
  // The runner handles it: the task waits for the hand-back like it waits for an approval.
  effect: 'internal',
  connection: 'browser',
  scope: 'task',
  label: (i) => `Asked you to take over the browser: ${firstLine(i.reason, 80)}`,
  async run() {
    throw new Error('browser_ask_person only works inside a task.');
  },
};

/** The saved login a fill would use: the one named, or the one for the current page's site. */
function pickLogin(i: { login?: string }, env: { starId: string; browser?: ToolEnv['browser'] }, vault: ToolContext['vault']) {
  const page = env.browser?.currentPage(env.starId);
  let origin: string | null = null;
  try {
    origin = page ? new URL(page.url).origin : null;
  } catch { /* no page */ }
  return vault?.loginFor(env.starId, origin, i.login) ?? null;
}

export const browserFillLogin: ToolDef<{ login?: string; submit?: boolean }> = {
  name: 'browser_fill_login',
  description: 'Sign in on the current page with a login the person saved for this exact site. The username and password go '
    + 'straight into the page; you never see the password. Open the site’s sign-in page first. Set submit to press Enter afterwards. '
    + 'It only signs in: it refuses sign-up and change-password forms.',
  input_schema: schema({ login: str('The saved login’s username, if there is more than one for this site'), submit: bool('Press Enter to sign in') }),
  effect: 'send',
  connection: 'browser',
  scope: 'task',
  when: (store) => store.settings().passwordFill === true,
  // A login the person marked "fill without asking" is a plain write; any other fill asks each time.
  effectFor: (i, env) => (env && pickLogin(i, env, env.vault)?.autoFill ? 'write' : 'send'),
  mustAsk: (i, env) => (env && pickLogin(i, env, env.vault)?.autoFill ? null : 'Signing in with a saved password asks you each time, unless you set that login to fill without asking'),
  approval: (i, env) => {
    const login = env ? pickLogin(i, env, env.vault) : null;
    return { ...pagePreview(env, 'Sign in with your saved login', `Fill in ${login ? `${login.username} and its password` : 'a saved login'}${i.submit ? ' and sign in' : ''}.`), risk: 'high' as const };
  },
  label: (i) => `Signed in with a saved login${i.login ? ` (${firstLine(i.login, 40)})` : ''}`,
  async run(i, ctx) {
    const b = tab(ctx);
    if (!ctx.vault) throw new Error('Saved logins aren’t available on this server.');
    if (ctx.store.settings().passwordFill !== true) throw new Error('Password fill is turned off. The person can turn it on in Settings.');
    const login = pickLogin(i, { starId: ctx.star.id, browser: b }, ctx.vault);
    if (!login) throw new Error('There’s no saved login for this site that you may use. Ask the person to sign in with browser_ask_person, or to save a login in Settings.');
    const { snapshot, filled } = await b.fillLogin(ctx.star.id, { origin: login.origin, username: login.username, password: ctx.vault.loginPassword(login.id) }, Boolean(i.submit));
    ctx.vault.touchLogin(login.id);
    const what = filled === 'both' ? 'the username and password' : filled === 'username' ? 'the username (the password goes on the next page: call this again there)' : 'the password';
    return { content: `Filled ${what} for ${login.username}.${i.submit ? ' Pressed Enter.' : ''}\n\n${describeSnapshot(snapshot)}`, summary: `Signed in to ${new URL(login.origin).host} as ${login.username}` };
  },
};

export const browserTools: ToolDef[] = [browserOpen, browserSearch, browserSnapshot, browserClick, browserType, browserPress, browserScroll, browserBack, browserAskPerson, browserFillLogin];
