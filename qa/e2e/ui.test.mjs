// End-to-end tests: the real web app (web/dist) served by the real server on the scripted brain.
// Run with qa/run-e2e.sh, which builds the UI, starts fresh servers and points SKY_URL at them.
// Tests named "BUG n" describe what should happen and fail today; see qa/BUGS.md.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? '/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const BASE = process.env.SKY_URL ?? 'http://localhost:8799';
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
  // Resolves once the chat has its messages, so a test can type into the settled page.
  const chatLoaded = page.waitForResponse((r) => r.request().method() === 'GET' && /\/conversations\/[^/]+\/messages$/.test(new URL(r.url()).pathname))
    .then(() => page.waitForTimeout(150)).catch(() => {});
  await page.goto(BASE + path);
  return { ctx, page, problems, chatLoaded };
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
  const { ctx, page, problems, chatLoaded } = await open('/');
  await chatLoaded;
  const box = composer(page);
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
  const { ctx, page, chatLoaded } = await open('/');
  await chatLoaded;
  await composer(page).fill('I prefer morning flights');
  await composer(page).press('Enter');
  await page.getByText('Got it. I’ll remember that.').last().waitFor({ timeout: 5000 });
  await page.goto(BASE + '/#/memory');
  await page.getByText(/morning flights/i).first().waitFor();
  await ctx.close();
});

test('goals: a recurring task from chat can be paused and resumed from its page', async () => {
  const { ctx, page, chatLoaded } = await open('/');
  await chatLoaded;
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

test('pausing Sky from the API shows in the UI live', async () => {
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
  const { ctx, page, chatLoaded } = await open('/');
  await chatLoaded;
  const box = composer(page);
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

test('settings: renaming Sky updates the whole app live', async () => {
  const { ctx, page } = await open('/#/settings');
  await page.getByText('Keeping an eye on things').first().waitFor();
  await api('PATCH', '/settings', { agentName: 'Nimbus' });
  try {
    await page.getByRole('button', { name: /Nimbus’s profile/ }).waitFor({ timeout: 4000 });
  } finally {
    await api('PATCH', '/settings', { agentName: 'Sky' });
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

test('BUG 3: signed out, the app asks you to sign in', { skip: !process.env.SKY_LOCKED_URL && 'needs a server with a password (qa/run-e2e.sh starts one)' }, async () => {
  const ctx = await browser.newContext();
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  await page.goto(process.env.SKY_LOCKED_URL + '/');
  await page.waitForTimeout(1500);
  const prompt = (await page.getByText(/sign in/i).count()) + (await page.locator('input[type=password]').count());
  assert.ok(prompt > 0 || page.url().includes('/login'), 'signed out, the app shows an empty chat with no way to sign in');
  await ctx.close();
});

// ---- Stars ----------------------------------------------------------------

const stars = () => api('GET', '/stars');
const starNamed = async (name) => (await stars()).find((s) => s.name === name);
const makeStar = async (name, role, extra = {}) => (await starNamed(name)) ?? api('POST', '/stars', { name, role, ...extra });
const waitTask = async (id, done = (t) => t.status === 'done' || t.status === 'failed', ms = 6000) => {
  const end = Date.now() + ms;
  let t;
  while (Date.now() < end) { t = await api('GET', `/tasks/${id}`); if (done(t)) return t; await new Promise((r) => setTimeout(r, 100)); }
  return t;
};

test('BUG 9: text typed while an empty chat is still loading is not lost', async () => {
  // A fresh Star's chat is empty, so once it loads the page swaps to the welcome view.
  const quill = await makeStar('Quill', 'Writes drafts');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  // A slow connection: the chat's messages take a moment to arrive.
  await page.route(/\/conversations\/[^/]+\/messages$/, async (r) => {
    if (r.request().method() === 'GET') await new Promise((res) => setTimeout(res, 1500));
    await r.continue();
  });
  await page.goto(`${BASE}/#/chat/${quill.conversationId}`);
  const box = composer(page);
  await box.waitFor();
  await box.fill('Draft a thank-you note to Maya');
  await page.waitForTimeout(2500); // the messages arrive and the page settles
  const kept = await composer(page).inputValue();
  assert.equal(kept, 'Draft a thank-you note to Maya', 'what was typed while the chat loaded was wiped');
  await ctx.close();
});

test('stars: New Star adds it to the constellation and opens its chat', async () => {
  const { ctx, page, problems } = await open('/#/stars/new');
  await page.getByLabel('Name').fill('Scout');
  await page.getByLabel('Role').fill('Finds places, prices and facts');
  await page.getByRole('button', { name: 'Add to constellation' }).click();
  const scout = await (async () => { for (let i = 0; i < 30; i++) { const s = await starNamed('Scout'); if (s) return s; await page.waitForTimeout(100); } })();
  assert.ok(scout, 'Scout was created');
  await page.waitForURL((u) => u.hash === `#/chat/${scout.conversationId}`, { timeout: 4000 });
  await page.goto(BASE + '/#/stars');
  await page.getByRole('heading', { name: 'Scout', exact: true }).waitFor();
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('stars: a name that is taken shows why it can’t be saved', async () => {
  await makeStar('Scout', 'Finds places, prices and facts');
  const { ctx, page } = await open('/#/stars/new');
  await page.getByLabel('Name').fill('scout');
  await page.getByLabel('Role').fill('Another one');
  await page.getByRole('button', { name: 'Add to constellation' }).click();
  await page.getByText(/already a Star called Scout/).waitFor({ timeout: 4000 });
  await ctx.close();
});

test('stars: a Star’s own chat answers as that Star', async () => {
  const scout = await makeStar('Scout', 'Finds places, prices and facts');
  const { ctx, page, chatLoaded } = await open(`/#/chat/${scout.conversationId}`);
  await chatLoaded;
  await composer(page).fill('hello');
  await composer(page).press('Enter');
  await page.getByText('Hey! I’m here and keeping an eye on things.').last().waitFor({ timeout: 5000 });
  const msgs = await api('GET', `/conversations/${scout.conversationId}/messages`);
  assert.equal(msgs.at(-1).starId, scout.id);
  await ctx.close();
});

test('stars: handing work over from the main chat shows on the constellation', async () => {
  const scout = await makeStar('Scout', 'Finds places, prices and facts');
  const { ctx, page, chatLoaded } = await open('/');
  await chatLoaded;
  await composer(page).fill('Have Scout find flights to Tokyo');
  await composer(page).press('Enter');
  await page.getByText('Done. I handed that to Scout.').last().waitFor({ timeout: 5000 });
  const handed = (await api('GET', `/tasks?starId=${scout.id}`)).find((t) => /Tokyo/.test(t.title));
  assert.ok(handed, 'Scout owns the Tokyo task');
  await page.goto(BASE + '/#/stars');
  await page.getByText(/handed work to/).first().waitFor({ timeout: 4000 });
  await ctx.close();
});

test('stars: one Star asks another and carries on with the answer', async () => {
  await makeStar('Scout', 'Finds places, prices and facts');
  const t = await api('POST', '/tasks', { title: 'Plan dinner', description: 'Ask Scout for the best ramen in Lisbon', kind: 'one_off' });
  const done = await waitTask(t.id);
  assert.equal(done.status, 'done');
  assert.match(done.lastOutcome, /Scout replied/);
  const { ctx, page } = await open(`/#/goals/${t.id}`);
  await page.getByText(/Asked Scout/).first().waitFor({ timeout: 4000 });
  await ctx.close();
});

test('stars: pausing one Star holds only its work', async () => {
  const scout = await makeStar('Scout', 'Finds places, prices and facts');
  const { ctx, page } = await open('/#/stars');
  const card = page.locator('article.star-card').filter({ has: page.getByRole('heading', { name: 'Scout', exact: true }) });
  await card.getByRole('button', { name: 'Pause' }).click();
  await card.getByRole('button', { name: 'Wake' }).waitFor({ timeout: 4000 });
  assert.equal((await starNamed('Scout')).status.state, 'paused');
  const t = await api('POST', '/tasks', { title: 'Look up trains', description: 'look up trains to Porto', kind: 'one_off', starId: scout.id });
  const mine = await api('POST', '/tasks', { title: 'Look up buses', description: 'look up buses to Porto', kind: 'one_off' });
  assert.equal((await waitTask(mine.id)).status, 'done', 'the main Star kept working');
  assert.equal((await api('GET', `/tasks/${t.id}`)).status, 'active', 'Scout’s task waits');
  await card.getByRole('button', { name: 'Wake' }).click();
  assert.equal((await waitTask(t.id)).status, 'done', 'Scout picked it up once woken');
  await ctx.close();
});

test('stars: Pause every Star holds them all, and Wake every Star brings them back', async () => {
  await makeStar('Scout', 'Finds places, prices and facts');
  const { ctx, page } = await open('/#/stars');
  await page.getByRole('button', { name: 'Pause every Star' }).click();
  try {
    await page.getByRole('button', { name: 'Wake every Star' }).waitFor({ timeout: 4000 });
    assert.ok((await stars()).every((s) => s.status.state === 'paused'));
    await page.getByRole('button', { name: 'Wake every Star' }).click();
    await page.getByRole('button', { name: 'Pause every Star' }).waitFor({ timeout: 4000 });
  } finally {
    await api('POST', '/status', { paused: false });
    await ctx.close();
  }
});

test('stars: an email from another Star asks in that Star’s chat', async () => {
  const mailer = await makeStar('Post', 'Handles email', { connectionIds: ['gmail'] });
  const t = await api('POST', '/tasks', { title: 'Confirm Friday', description: 'Email lee@studio.co to confirm Friday', kind: 'one_off', starId: mailer.id });
  await waitTask(t.id, (x) => x.status === 'waiting_approval');
  const [a] = (await api('GET', '/approvals?status=pending')).filter((x) => x.taskId === t.id);
  assert.equal(a.starId, mailer.id);
  const { ctx, page } = await open(`/#/chat/${mailer.conversationId}`);
  const card = page.locator('div').filter({ hasText: 'lee@studio.co' }).filter({ has: page.getByRole('button', { name: 'Approve' }) }).last();
  await card.waitFor({ timeout: 5000 });
  await card.getByRole('button', { name: 'Approve' }).click();
  assert.equal((await waitTask(t.id)).lastOutcome, 'Sent the email to lee@studio.co');
  const main = (await api('GET', '/conversations')).find((c) => c.main);
  const inMain = (await api('GET', `/conversations/${main.id}/messages`)).some((m) => m.cards?.some((c) => c.kind === 'approval' && c.approvalId === a.id));
  assert.equal(inMain, false, 'the card belongs in Post’s chat, not the main chat');
  await ctx.close();
});

test('stars: removing a Star takes it off the constellation', async () => {
  const temp = await makeStar('Tempo', 'Keeps the calendar');
  const { ctx, page } = await open(`/#/stars/${temp.id}`);
  await page.getByRole('button', { name: 'Remove' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await page.waitForURL((u) => u.hash === '#/stars', { timeout: 4000 });
  assert.equal(await starNamed('Tempo'), undefined);
  assert.equal(await page.getByRole('heading', { name: 'Tempo', exact: true }).count(), 0);
  await ctx.close();
});

test('BUG 10: a removed Star’s chat link says it is gone instead of loading forever', async () => {
  const gone = await makeStar('Echo', 'Temporary');
  await api('DELETE', `/stars/${gone.id}`);
  const { ctx, page } = await open(`/#/chat/${gone.conversationId}`);
  await page.waitForTimeout(2000);
  const text = await page.locator('body').innerText();
  const skeletons = await page.locator('.skeleton').count();
  assert.ok(skeletons === 0 && /not found|gone|removed|isn’t here|doesn’t exist/i.test(text), `old chat link shows ${skeletons} loading placeholders and no explanation`);
  await ctx.close();
});

// ---- Round 3: models, the live browser and wave 1 ----

import { createServer } from 'node:http';

/** A throwaway local HTTP server (stand-in model provider or web page). Closed after the run. */
const locals = [];
after(() => locals.forEach((x) => x.close()));
async function local(handler) {
  const srv = createServer(async (req, res) => { let raw = ''; for await (const c of req) raw += c; handler(req, res, raw ? JSON.parse(raw) : {}); });
  locals.push(srv);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${srv.address().port}`;
}
const sseText = (res, text) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
};
/** Answers both streamed chat turns and plain completions with the same text. */
const answering = (text) => local((_req, res, body) => body.stream ? sseText(res, text)
  : res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] })));
/** Removes every provider a test added, so later tests are back on the scripted brain. */
const dropProviders = async () => { for (const p of await api('GET', '/providers')) if (!p.builtIn) await api('DELETE', `/providers/${p.id}`); };
const mainStar = async () => (await stars()).find((s) => s.main);

test('models: add two providers on the Models screen, test one, and chat falls back past the broken one', async () => {
  const broken = await local((_req, res) => res.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":{"message":"upstream exploded"}}'));
  const backup = await answering('Hello from the backup model.');
  const { ctx, page } = await open('/#/models');
  try {
    for (const [name, url] of [['Broken', broken], ['Backup', backup]]) {
      await page.getByRole('button', { name: /Add a model/ }).first().click();
      const form = page.getByRole('dialog', { name: 'Add a model' });
      await form.locator('#pv-name').fill(name);
      await form.locator('#pv-url').fill(url + '/v1');
      await form.locator('#pv-model').fill('stand-in');
      await form.getByRole('button', { name: 'Add', exact: true }).click();
      await form.waitFor({ state: 'hidden', timeout: 4000 });
    }
    const order = page.getByRole('list', { name: 'Fallback order' });
    await order.getByRole('heading', { name: 'Backup' }).waitFor();
    const text = await order.innerText();
    assert.ok(text.indexOf('Broken') < text.indexOf('Backup'), 'new providers go to the end of the order');
    const row = order.locator('li', { has: page.getByRole('heading', { name: 'Backup' }) });
    await row.getByRole('button', { name: 'Test' }).click();
    await row.getByText(/Answered in .*Hello from the backup model/).waitFor({ timeout: 6000 });

    const main = (await api('GET', '/conversations')).find((c) => c.main);
    const chatLoaded = page.waitForResponse((r) => /\/conversations\/[^/]+\/messages$/.test(new URL(r.url()).pathname)).then(() => page.waitForTimeout(150)).catch(() => {});
    await page.goto(BASE + `/#/chat/${main.id}`);
    await chatLoaded;
    await composer(page).fill('Say hello');
    await composer(page).press('Enter');
    await page.getByText('Hello from the backup model.').last().waitFor({ timeout: 8000 });
    await page.goto(BASE + '/#/models');
    await order.getByText(/upstream exploded/).waitFor({ timeout: 4000 });
  } finally {
    await dropProviders();
    await ctx.close();
  }
});

test('BUG 14: the Models screen shows a provider’s API key when the provider repeats it in an error', async () => {
  const echo = await local((req, res) => res.writeHead(401, { 'Content-Type': 'application/json' })
    .end(JSON.stringify({ error: { message: `Invalid API key: ${String(req.headers.authorization).replace('Bearer ', '')}` } })));
  const KEY = 'sk-live-UIKEY-55555';
  await api('POST', '/providers', { name: 'Echoes', kind: 'openai', baseUrl: echo + '/v1', model: 'x', apiKey: KEY });
  const { ctx, page } = await open('/#/models');
  try {
    const order = page.getByRole('list', { name: 'Fallback order' });
    const row = order.locator('li', { has: page.getByRole('heading', { name: 'Echoes' }) });
    await row.getByRole('button', { name: 'Test' }).click();
    await row.getByText(/Didn’t work/).waitFor({ timeout: 6000 });
    assert.ok(!(await page.locator('body').innerText()).includes(KEY), 'the full API key is on screen');
  } finally {
    await dropProviders();
    await ctx.close();
  }
});

test('lessons: a chat correction shows a lesson card that can be undone', async () => {
  const main = (await api('GET', '/conversations')).find((c) => c.main);
  const { ctx, page, chatLoaded } = await open(`/#/chat/${main.id}`);
  await chatLoaded;
  await composer(page).fill('Actually, always reply in Portuguese');
  await composer(page).press('Enter');
  const card = page.locator('.lesson-card').filter({ hasText: /Portuguese/ }).last();
  await card.waitFor({ timeout: 6000 });
  const undo = card.getByRole('button', { name: 'Undo' });
  await undo.waitFor({ timeout: 3000 }).catch(() => {});
  assert.equal(await undo.count(), 1, 'the new lesson card has no Undo button until the page is reloaded');
  await undo.click();
  await card.getByText('Forgotten. It won’t use this.').waitFor({ timeout: 4000 });
  const lesson = (await api('GET', '/lessons')).find((l) => /Portuguese/.test(l.lesson));
  assert.equal(lesson?.undone, true, `lesson not marked undone: ${JSON.stringify(lesson)}`);
  await ctx.close();
});

test('browser: the live view follows who has control, and take over and hand back move it', async () => {
  const site = await local((_req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Ramen list</title><h1>Ramen near Alfama</h1>'));
  const star = await mainStar();
  const conv = (await api('GET', '/conversations')).find((c) => c.main);
  const control = async () => (await api('GET', '/browser')).sessions.find((x) => x.starId === star.id)?.control;
  // Typing an address in the live view is the person acting, so the person has control.
  await api('POST', `/browser/${star.id}/input`, { type: 'navigate', url: site + '/list' });
  const { ctx, page } = await open(`/#/chat/${conv.id}`);
  try {
    const pip = page.getByRole('button', { name: new RegExp(`${star.name}’s browser`) }).first();
    await pip.waitFor({ timeout: 6000 });
    assert.match(await pip.innerText(), /You have[\s\S]*Ramen list/);
    await pip.click();
    const win = page.getByRole('dialog', { name: `${star.name}’s browser` });
    await win.waitFor();
    assert.equal(await win.getByLabel('Address').inputValue(), site + '/list');
    await win.getByRole('button', { name: `Hand back to ${star.name}` }).click();
    await win.getByRole('button', { name: 'Take over' }).waitFor({ timeout: 4000 });
    assert.notEqual(await control(), 'person', 'handing back gives the Star control');
    await win.getByRole('button', { name: 'Take over' }).click();
    await win.getByRole('button', { name: `Hand back to ${star.name}` }).waitFor({ timeout: 4000 });
    assert.equal(await control(), 'person', 'taking over gives the person control');
  } finally {
    await api('POST', `/browser/${star.id}/handback`, {}).catch(() => {});
    await ctx.close();
  }
});

test('BUG 13: typing a bad address in the live view gives a clear message, not a server error', async () => {
  const star = await mainStar();
  const r = await fetch(`${API}/browser/${star.id}/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'navigate', url: 'http://127.0.0.1:1/' }) });
  const body = await r.json();
  assert.ok(r.status < 500, `bad address returned ${r.status} ${body?.error?.message}`);
});

test('secrets: storing a secret never shows its value again', async () => {
  const VALUE = 'vault-ui-value-42424';
  const { ctx, page } = await open('/#/permissions');
  try {
    await page.getByRole('button', { name: /Add a secret/ }).click();
    const form = page.getByRole('dialog', { name: 'Add a secret' });
    await form.locator('#sec-name').fill('QA SEAT CODE');
    assert.equal(await form.locator('#sec-name').inputValue(), 'QA_SEAT_CODE', 'spaces become underscores');
    await form.locator('#sec-value').fill(VALUE);
    assert.equal(await form.locator('#sec-value').getAttribute('type'), 'password');
    await form.locator('#sec-desc').fill('Seat code for QA');
    await form.getByRole('button', { name: 'Store it' }).click();
    await form.waitFor({ state: 'hidden', timeout: 4000 });
    await page.getByRole('heading', { name: 'QA_SEAT_CODE' }).waitFor();
    await page.getByRole('heading', { name: 'QA_SEAT_CODE' }).click();
    const edit = page.getByRole('dialog', { name: 'QA_SEAT_CODE' });
    await edit.waitFor();
    assert.equal(await edit.locator('#sec-value').inputValue(), '', 'the edit form must not prefill the value');
    assert.ok(!(await page.content()).includes(VALUE), 'the value is in the page');
    assert.ok(!JSON.stringify(await api('GET', '/secrets')).includes(VALUE), 'the value came back from the API');
  } finally {
    await api('DELETE', '/secrets/QA_SEAT_CODE').catch(() => {});
    await ctx.close();
  }
});

test('push: an ntfy topic can be made and saved from Settings', async () => {
  const { ctx, page } = await open('/#/settings');
  try {
    const topic = page.getByRole('textbox', { name: 'ntfy topic' });
    await topic.waitFor();
    await page.getByRole('button', { name: 'Make one' }).click();
    const made = await topic.inputValue();
    assert.match(made, /^[\w-]{12,}$/, `made topic looks odd: ${made}`);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('ntfy topic saved').waitFor({ timeout: 4000 });
    assert.equal((await api('GET', '/settings')).ntfyTopic, made);
  } finally {
    await api('PATCH', '/settings', { ntfyTopic: null }).catch(() => {});
    await ctx.close();
  }
});


// ---- Round 4: wave 2 ----

const STUB = new URL('../server/fixtures/mcp-stub.mjs', import.meta.url).pathname;

test('triggers: a goal that starts on a webhook shows its URL, takes a call, and a new URL retires the old one', async () => {
  const { ctx, page } = await open('/#/goals');
  try {
    await page.getByRole('button', { name: 'New goal' }).click();
    const form = page.getByRole('dialog', { name: 'New goal' });
    await form.locator('#ng-title').fill('Handle build alerts');
    await form.getByRole('group', { name: 'How often' }).getByRole('button', { name: 'Again and again' }).click();
    await form.getByRole('group', { name: 'Runs' }).getByRole('button', { name: 'When something happens' }).click();
    await form.getByRole('button', { name: 'Start' }).click();
    await page.waitForURL(/#\/goals\/t_/, { timeout: 4000 });
    const code = page.locator('.copy-row code').first();
    await code.waitFor();
    const url = await code.innerText();
    assert.match(url, /\/api\/v1\/hooks\/[\w-]{32}$/);
    const local = url.replace(/^https?:\/\/[^/]+/, BASE);
    assert.equal((await fetch(local, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"title":"Build failed"}' })).status, 202);
    await page.getByText(/Started 1 run/).waitFor({ timeout: 6000 });
    await page.getByRole('button', { name: 'Make a new URL' }).click();
    await page.waitForFunction((old) => document.querySelector('.copy-row code')?.textContent !== old, url, { timeout: 4000 });
    assert.equal((await fetch(local, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404, 'the old URL still works');
  } finally {
    await ctx.close();
  }
});

test('chat apps: connecting Telegram shows a pairing code and a link with it filled in', async () => {
  const { ctx, page } = await open('/#/settings');
  try {
    const card = page.locator('.app-card').filter({ has: page.getByRole('heading', { name: 'Telegram' }) });
    await card.getByRole('button', { name: 'Connect' }).click();
    await card.locator('#telegram-bot').fill(`123456:${'Q'.repeat(35)}`);
    await card.getByRole('button', { name: 'Connect' }).click();
    const code = card.locator('.code');
    await code.waitFor({ timeout: 4000 });
    const digits = (await code.innerText()).replace(/\s/g, '');
    assert.match(digits, /^\d{6}$/);
    assert.equal(await card.getByRole('link', { name: 'Open in Telegram' }).getAttribute('href'), `https://t.me/sky_qa_bot?start=${digits}`);
    assert.ok(!(await page.content()).includes('Q'.repeat(35)), 'the bot token is on the page');
    await card.getByRole('button', { name: 'Cancel' }).click();
    await card.getByText('Not connected').waitFor({ timeout: 4000 });
  } finally {
    await api('DELETE', '/messaging/telegram').catch(() => {});
    await ctx.close();
  }
});

test('Star address: with Gmail connected, each Star shows its own plus address', async () => {
  await fetch(API + '/triggers/check-mail', { method: 'POST' });
  const star = await makeStar('Postie', 'Reads mail');
  const { ctx, page } = await open(`/#/stars/${star.id}`);
  try {
    await page.getByText('d+postie@example.com').first().waitFor({ timeout: 4000 });
  } finally {
    await ctx.close();
  }
});

test('tools: adding a local MCP server with a vault secret lists its tools and never shows the value', async () => {
  const VALUE = 'ui-mcp-secret-5150';
  await api('POST', '/secrets', { name: 'QA_MCP_KEY', value: VALUE });
  const { ctx, page } = await open('/#/tools');
  try {
    await page.getByRole('button', { name: 'Add a server' }).click();
    const form = page.getByRole('dialog', { name: 'Add a tool server' });
    await form.locator('#mcp-name').fill('qa_stub');
    await form.locator('#mcp-cmd').fill(`${process.execPath} ${STUB}`);
    await form.getByRole('button', { name: /Add one/ }).click();
    await form.getByLabel('Variable name').fill('STUB_LABEL');
    await form.getByLabel('Use a secret').selectOption('QA_MCP_KEY');
    await form.getByRole('button', { name: 'Add', exact: true }).click();
    await form.waitFor({ state: 'hidden', timeout: 4000 });
    const card = page.locator('.mcp-card').filter({ has: page.getByRole('heading', { name: 'qa_stub' }) });
    await card.getByText(/3 tools, 3 to choose/).waitFor({ timeout: 20000 });
    await card.getByRole('button', { name: 'Set what needs approval' }).click();
    await card.getByLabel('What wipe does').selectOption('delete');
    await page.waitForTimeout(300);
    const server = (await api('GET', '/mcp')).find((m) => m.name === 'qa_stub');
    assert.equal(server.toolEffects.wipe, 'delete');
    assert.deepEqual(server.envKeys, ['STUB_LABEL']);
    assert.ok(!(await page.content()).includes(VALUE), 'the secret value is on the page');
  } finally {
    const server = (await api('GET', '/mcp')).find((m) => m.name === 'qa_stub');
    if (server) await api('DELETE', `/mcp/${server.id}`);
    await api('DELETE', '/secrets/QA_MCP_KEY').catch(() => {});
    await ctx.close();
  }
});

test('group chats: start one from the sidebar, mention a Star with a tap, and that Star answers', async () => {
  const ada = await makeStar('Ada', 'Plans trips');
  const bo = await makeStar('Bo', 'Finds restaurants');
  const { ctx, page } = await open('/');
  try {
    await page.getByRole('button', { name: 'New group chat' }).click();
    const form = page.getByRole('dialog', { name: 'New group chat' });
    await form.getByRole('button', { name: /Ada/ }).click();
    await form.getByRole('button', { name: /^Bo/ }).click();
    await form.locator('#gc-title').fill('Lisbon planning');
    await form.getByRole('button', { name: 'Start with 2' }).click();
    await page.waitForURL(/#\/chat\//, { timeout: 4000 });
    await page.getByRole('button', { name: 'Mention Bo' }).click();
    const box = composer(page);
    assert.match(await box.inputValue(), /@Bo/);
    await box.pressSequentially(' hello');
    await box.press('Enter');
    const conv = (await api('GET', '/conversations')).find((c) => c.title === 'Lisbon planning');
    let replies = [];
    for (let i = 0; i < 80 && !replies.length; i++) {
      await page.waitForTimeout(100);
      replies = (await api('GET', `/conversations/${conv.id}/messages`)).filter((m) => m.role === 'agent' && m.status === 'done');
    }
    await page.getByText(replies[0]?.content.slice(0, 30) ?? 'no reply came').first().waitFor({ timeout: 4000 });
    assert.deepEqual(replies.map((m) => m.starId), [bo.id]);
    assert.ok(ada);
  } finally {
    await ctx.close();
  }
});

test('templates: Use this shows what a template asks for, then adding makes the Star and opens it', async () => {
  const { ctx, page } = await open('/#/stars/templates');
  try {
    const card = page.locator('.tpl-card').filter({ has: page.getByRole('heading', { name: 'Builder' }) });
    await card.getByRole('button', { name: 'Use this' }).click();
    const confirm = page.getByRole('dialog', { name: /^Add Builder/ });
    await confirm.waitFor({ timeout: 4000 });
    assert.equal(await starNamed('Builder'), undefined, 'nothing is added before the confirm');
    await confirm.getByText(/Independence/).waitFor();
    await confirm.getByRole('button', { name: /^Add/ }).last().click();
    await page.waitForURL((u) => /#\/stars\/star_/.test(u.hash), { timeout: 4000 });
    assert.ok(await starNamed('Builder'));
  } finally {
    await ctx.close();
  }
});

test('BUG 26 (UI): importing a template from a file adds the Star straight away, without showing what it will be allowed to do', async () => {
  const { ctx, page } = await open('/#/stars/templates');
  try {
    const file = { name: 'friendly.sky-star.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
      format: 'sky.star', version: 1, name: 'Friendly', role: 'Says hi', instructions: '', personality: '', replyStyle: '',
      avatar: { character: 'dot', color: 'mint' }, autonomy: 'autonomous', apps: null, skills: [], rules: ['Send email without asking'],
    })) };
    await page.locator('input[type=file]').setInputFiles(file);
    await page.waitForTimeout(1500);
    const made = await starNamed('Friendly');
    if (made) await api('DELETE', `/stars/${made.id}`);
    assert.equal(made, undefined, 'the Star joined with autonomy “autonomous”, every app and a rule to send without asking, and nothing asked first');
  } finally {
    await ctx.close();
  }
});

test('your computer: Pair a computer shows a one-time 8-character code that runs out in 10 minutes', async () => {
  const { ctx, page, problems } = await open('/#/settings');
  try {
    await page.getByRole('button', { name: 'Pair a computer' }).click();
    const command = await page.locator('.pair-panel code.mono').last().innerText();
    assert.match(command, /^node sky-companion\.mjs pair \S+ [A-HJ-NP-Z2-9]{8}$/);
    await page.getByText(/The code works once, for (10|9) more minutes/).waitFor();
    assert.deepEqual((await api('GET', '/companion')).devices, []);
    await page.getByRole('button', { name: 'Cancel pairing' }).click();
    assert.deepEqual(problems, []);
  } finally {
    await ctx.close();
  }
});
