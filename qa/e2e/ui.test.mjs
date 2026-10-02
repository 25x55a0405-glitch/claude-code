// End-to-end tests: the real web app (web/dist) served by the real server on the scripted brain.
// Run with qa/run-e2e.sh, which builds the UI, starts fresh servers and points SKYS_URL at them.
// Tests named "BUG n" describe what should happen and fail today; see qa/BUGS.md.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? '/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const BASE = process.env.SKYS_URL ?? 'http://localhost:8799';
const API = BASE + '/api/v1';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

/** A page that counts open EventSource connections and collects uncaught errors. */
async function open(path = '/') {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(e.message));
  await page.addInitScript(() => {
    const Orig = window.EventSource;
    window.__es = { open: 0, max: 0 };
    window.EventSource = class extends Orig {
      constructor(...a) { super(...a); __es.open++; __es.max = Math.max(__es.max, __es.open); }
      close() { if (this.readyState !== 2) __es.open--; super.close(); }
    };
  });
  await page.goto(BASE + path);
  return { ctx, page, problems };
}

const api = async (method, path, body) => {
  const r = await fetch(API + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return r.status === 204 ? undefined : r.json();
};
const composer = (page) => page.getByRole('textbox', { name: /message|ask|tell/i }).first();

test('home opens on the main chat with the agent name and a live status line', async () => {
  const { ctx, page } = await open('/');
  await page.getByText('Keeping an eye on things').first().waitFor();
  await page.getByRole('button', { name: /profile/ }).waitFor();
  await ctx.close();
});

test('chat: a request streams a reply with a goal card, user message first', async () => {
  const { ctx, page, problems } = await open('/');
  const box = composer(page);
  await box.waitFor();
  await box.fill('Find me a good ramen place near Alfama');
  await box.press('Enter');
  await page.getByText('On it. I started a task').last().waitFor({ timeout: 5000 });
  const text = await page.locator('body').innerText();
  assert.ok(text.indexOf('Find me a good ramen place') < text.indexOf('On it. I started a task'), 'user message should sit above the reply');
  // The goal card links to the task.
  await page.locator('a[href^="#/goals/t_"]').first().waitFor();
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('chat: a preference shows up on the Memory page', async () => {
  const { ctx, page } = await open('/');
  await composer(page).fill('I prefer morning flights');
  await composer(page).press('Enter');
  await page.getByText('Got it. I’ll remember that.').last().waitFor({ timeout: 5000 });
  await page.goto(BASE + '/#/memory');
  await page.getByText(/morning flights/i).first().waitFor();
  await ctx.close();
});

test('goals: a recurring task from chat can be paused and resumed from its page', async () => {
  const { ctx, page } = await open('/');
  await composer(page).fill('Remind me every weekday at 9:00 to stretch');
  await composer(page).press('Enter');
  await page.getByText(/I set that up as a recurring task/).last().waitFor({ timeout: 5000 });
  const t = (await api('GET', '/tasks')).find((x) => /stretch/i.test(x.title));
  assert.equal(t.status, 'scheduled');
  await page.goto(`${BASE}/#/goals/${t.id}`);
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.getByRole('button', { name: 'Resume' }).waitFor();
  await page.getByRole('button', { name: 'Resume' }).click();
  await page.getByRole('button', { name: 'Pause' }).waitFor();
  await ctx.close();
});

test('BUG 1: the app keeps few live connections open (browsers allow 6 per host)', async () => {
  const { ctx, page } = await open('/');
  await page.getByText('Keeping an eye on things').first().waitFor();
  await page.waitForTimeout(500);
  const { open: n } = await page.evaluate(() => window.__es);
  assert.ok(n <= 2, `main chat holds ${n} EventSource connections; one shared stream is enough`);
  await ctx.close();
});

/** Times one API call made from inside the page, the way the app makes them. */
const inPageFetch = (page) => page.evaluate(() => Promise.race([
  fetch('/api/v1/status', { credentials: 'include' }).then(() => 'ok'),
  new Promise((r) => setTimeout(() => r('stalled'), 3000)),
]));

test('BUG 1: opening the profile sheet does not stall the app', async () => {
  const { ctx, page } = await open('/');
  await page.getByText('Keeping an eye on things').first().waitFor();
  assert.equal(await inPageFetch(page), 'ok');
  await page.getByRole('button', { name: /profile/ }).click();
  await page.waitForTimeout(500);
  const streams = (await page.evaluate(() => window.__es)).open;
  assert.equal(await inPageFetch(page), 'ok', `with the profile sheet open (${streams} event streams) API calls never complete`);
  await ctx.close();
});

test('BUG 1: a second tab of the app still works', async () => {
  const ctx = await browser.newContext();
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const a = await ctx.newPage();
  await a.goto(BASE + '/');
  await a.getByText('Keeping an eye on things').first().waitFor();
  const b = await ctx.newPage();
  await b.goto(BASE + '/');
  await b.waitForTimeout(1500);
  assert.equal(await inPageFetch(b), 'ok', 'with the app open in two tabs, API calls in the second tab never complete');
  await ctx.close();
});

test('pausing Skys from the API shows in the UI live', async () => {
  const { ctx, page } = await open('/');
  await page.getByText('Keeping an eye on things').first().waitFor();
  await api('POST', '/status', { paused: true });
  try {
    await page.getByText('Paused. Not taking any actions').first().waitFor({ timeout: 4000 });
  } finally {
    await api('POST', '/status', { paused: false });
    await ctx.close();
  }
});

test('BUG 2: a message the server rejects shows an error instead of thinking forever', async () => {
  const { ctx, page } = await open('/');
  const box = composer(page);
  await box.waitFor();
  await box.fill('x'.repeat(20_001)); // the server caps messages at 20,000 characters
  await box.press('Enter');
  await page.waitForTimeout(1500);
  const shown = await page.getByText(/too long/i).count();
  assert.ok(shown > 0, 'the 400 "content is too long" never reaches the user');
  await ctx.close();
});

test('approvals: an email waits for approval in chat, and Approve sends it', async () => {
  const t = await api('POST', '/tasks', { title: 'Confirm Thursday', description: 'Email maya@studio.co to confirm Thursday 3pm', kind: 'one_off' });
  const { ctx, page, problems } = await open('/');
  const card = page.locator('.bubble, .card, article, div').filter({ hasText: 'maya@studio.co' }).filter({ has: page.getByRole('button', { name: 'Approve' }) }).last();
  await card.waitFor({ timeout: 8000 });
  assert.equal((await api('GET', `/tasks/${t.id}`)).status, 'waiting_approval');
  await card.getByRole('button', { name: 'Approve' }).click();
  for (let i = 0; i < 40 && (await api('GET', `/tasks/${t.id}`)).status !== 'done'; i++) await page.waitForTimeout(100);
  const done = await api('GET', `/tasks/${t.id}`);
  assert.equal(done.status, 'done');
  assert.equal(done.lastOutcome, 'Sent the email to maya@studio.co');
  const sends = await (await fetch(BASE + '/__qa/gmail-sends')).json();
  assert.ok(sends.length >= 1, 'Gmail send was called');
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('approvals: Not now declines and the task skips sending', async () => {
  const before = (await (await fetch(BASE + '/__qa/gmail-sends')).json()).length;
  const t = await api('POST', '/tasks', { title: 'Ping Sam', description: 'Email sam@studio.co about Friday', kind: 'one_off' });
  const { ctx, page } = await open('/#/approvals');
  const card = page.locator('div').filter({ hasText: 'sam@studio.co' }).filter({ has: page.getByRole('button', { name: 'Not now' }) }).last();
  await card.waitFor({ timeout: 8000 });
  await card.getByRole('button', { name: 'Not now' }).click();
  for (let i = 0; i < 40 && (await api('GET', `/tasks/${t.id}`)).status !== 'done'; i++) await page.waitForTimeout(100);
  assert.equal((await api('GET', `/tasks/${t.id}`)).lastOutcome, 'Skipped sending as you asked');
  assert.equal((await (await fetch(BASE + '/__qa/gmail-sends')).json()).length, before, 'nothing was sent');
  await ctx.close();
});

test('settings: renaming Skys updates the whole app live', async () => {
  const { ctx, page } = await open('/#/settings');
  await page.getByText('Keeping an eye on things').first().waitFor();
  await api('PATCH', '/settings', { agentName: 'Nimbus' });
  try {
    await page.getByRole('button', { name: /Nimbus’s profile/ }).waitFor({ timeout: 4000 });
  } finally {
    await api('PATCH', '/settings', { agentName: 'Skys' });
    await ctx.close();
  }
});

test('ideas: Do it sends the idea to the main chat and removes it', async () => {
  const ideas = await api('GET', '/ideas');
  if (!ideas.length) return; // starter ideas depend on what is connected
  const { ctx, page } = await open('/#/ideas');
  await page.getByText(ideas[0].title).waitFor();
  await page.getByRole('button', { name: /do it/i }).first().click();
  await page.waitForTimeout(1000);
  const after = await api('GET', '/ideas');
  assert.ok(!after.some((i) => i.id === ideas[0].id), 'idea dismissed');
  const main = (await api('GET', '/conversations')).find((c) => c.main);
  const msgs = await api('GET', `/conversations/${main.id}/messages`);
  assert.ok(msgs.some((m) => m.role === 'user' && m.content === ideas[0].prompt), 'idea prompt sent to main chat');
  await ctx.close();
});

test('phone width: no page scrolls sideways', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  const wide = [];
  for (const route of ['', 'goals', 'ideas', 'approvals', 'memory', 'permissions', 'activity', 'settings']) {
    await page.goto(`${BASE}/#/${route}`);
    await page.waitForTimeout(600);
    const [sw, w] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    if (sw > w) wide.push(`${route || 'chat'} (${sw}px)`);
  }
  assert.deepEqual(wide, []);
  await ctx.close();
});

test('BUG 3: signed out, the app asks you to sign in', { skip: !process.env.SKYS_LOCKED_URL && 'needs a server with a password (qa/run-e2e.sh starts one)' }, async () => {
  const ctx = await browser.newContext();
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  await page.goto(process.env.SKYS_LOCKED_URL + '/');
  await page.waitForTimeout(1500);
  const prompt = (await page.getByText(/sign in/i).count()) + (await page.locator('input[type=password]').count());
  assert.ok(prompt > 0 || page.url().includes('/login'), 'signed out, the app shows an empty chat with no way to sign in');
  await ctx.close();
});
