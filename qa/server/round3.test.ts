// Round 3: any model provider with fallback, real browsing, and wave 1 (lessons, secrets, push).
// Stand-in providers and pages are local HTTP servers, since outside sites are blocked.
// Tests named "BUG n" describe what should happen and fail today; see qa/BUGS.md.
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { after, afterEach, test } from 'node:test';
import { classify } from '../../server/src/models/registry.ts';
import { startServer, type TestServer } from '../../server/test/helpers.ts';

const CHROMIUM = process.env.QA_CHROMIUM ?? '/opt/pw-browsers/chromium';
let s: TestServer | undefined;
const servers: ReturnType<typeof createServer>[] = [];
const hanging: ServerResponse[] = [];
afterEach(async () => {
  // Let go of any request a stand-in left hanging, so the server can shut down.
  hanging.splice(0).forEach((r) => r.destroy());
  await s?.close();
  s = undefined;
});
after(() => servers.forEach((x) => x.close()));

async function serve(handler: (req: IncomingMessage, res: ServerResponse, body: any) => void) {
  const srv = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    handler(req, res, raw ? JSON.parse(raw) : {});
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}
const hang = (res: ServerResponse) => { hanging.push(res); };
const sseText = (res: ServerResponse, text: string) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
};
const sseTool = (res: ServerResponse, name: string, args: unknown) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c' + Math.random().toString(36).slice(2), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
};
const plain = (res: ServerResponse, text: string) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
/** Answers chat turns (streamed) and plain completions with the same text. */
const answering = (text: string) => serve((_req, res, body) => (body.stream ? sseText(res, text) : plain(res, text)));
/** A model that plays the given tool calls in order inside tasks, then finishes. Records what it was sent. */
async function puppet(steps: [string, unknown][]) {
  const seen: string[] = [];
  const url = await serve((_req, res, body) => {
    seen.push(JSON.stringify(body));
    if (!body.tools) return body.stream ? sseText(res, 'ok') : plain(res, 'ok');
    const step = steps[body.messages.filter((m: any) => m.role === 'assistant').length];
    return step ? sseTool(res, step[0], step[1]) : sseTool(res, 'finish_task', { outcome: 'All done' });
  });
  return { url, seen };
}
const within = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_r, rej) => setTimeout(() => rej(new Error(`${what}: still waiting after ${ms / 1000}s`)), ms))]);
const settle = async (ms = 200) => { for (let i = 0; i < 15; i++) { await s!.app.runtime.idle(); await new Promise((r) => setTimeout(r, ms / 10)); } };
/** Sends a message to the main chat and waits for the new reply. */
async function chat(content: string) {
  const m = (await s!.call('GET', '/conversations')).body.find((c: any) => c.main);
  const before = new Set(s!.events.filter((e: any) => e.type === 'message.done').map((e: any) => e.data.id));
  await s!.call('POST', `/conversations/${m.id}/messages`, { content });
  return (await s!.waitFor('message.done', (e: any) => !before.has(e.data.id) && e.data.role === 'agent' && e.data.conversationId === m.id && !e.data.proactive, 8000)).data;
}
const addProvider = async (name: string, baseUrl: string, extra: Record<string, unknown> = {}) =>
  (await s!.call('POST', '/providers', { name, kind: 'openai', baseUrl, model: 'stand-in', ...extra })).body;

// ---- Fallback that works ----

test('fallback: a provider that never answers is skipped after the timeout and the next one replies', async () => {
  const stuck = await serve((_req, res) => hang(res));
  const ok = await answering('Backup here.');
  s = await startServer({ brain: 'models' });
  s.app.models.timeoutMs = 800;
  await addProvider('Stuck', stuck);
  await addProvider('Ok', ok);
  const t0 = Date.now();
  const reply = await chat('hello');
  assert.equal(reply.content, 'Backup here.');
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
  const stuckRow = (await s.call('GET', '/providers')).body.find((p: any) => p.name === 'Stuck');
  assert.notEqual(stuckRow.health.state, 'ok');
});

test('fallback: a stream that stops halfway moves to the next provider', async () => {
  const half = await serve((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Partial answ' } }] })}\n\n`);
    hang(res);
  });
  const ok = await answering('Second model answer.');
  s = await startServer({ brain: 'models' });
  s.app.models.timeoutMs = 800;
  await addProvider('Half', half);
  await addProvider('Ok', ok);
  const reply = await chat('hello');
  assert.match(reply.content, /Second model answer\./);
});

test('fallback: when every provider is cooling down, the one that recovers first is still tried', async () => {
  let calls = 0;
  const limited = await serve((_req, res) => { calls++; res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' }).end('{"error":{"message":"slow down"}}'); });
  s = await startServer({ brain: 'models' });
  await addProvider('Limited', limited);
  await chat('one');
  await chat('two');
  assert.equal(calls, 2, 'the only provider should be tried again rather than giving up without asking');
});

test('fallback: “this model does not support tools” moves on without benching the provider', () => {
  for (const msg of ['This model does not support tools', 'model `x` does not support function calling']) {
    const e = Object.assign(new Error(`400 ${msg}`), { status: 400 });
    assert.equal(classify(e, 0).permanent, false, msg);
  }
});

test('BUG 17: “tool calling is not supported with this model” benches the provider for 6 hours', () => {
  for (const msg of ['tool calling is not supported with this model', 'Invalid value for max_tokens: too large for this model']) {
    const e = Object.assign(new Error(`400 ${msg}`), { status: 400 });
    const f = classify(e, 0);
    assert.deepEqual({ permanent: f.permanent, cooldownMs: f.cooldownMs }, { permanent: false, cooldownMs: 0 }, `“${msg}” is a request the model can’t do, not a broken provider`);
  }
});

test('BUG 12: a provider that never answers a plain (non-streamed) call hangs forever instead of timing out', async () => {
  const stuck = await serve((_req, res) => hang(res));
  const ok = await answering('fine');
  s = await startServer({ brain: 'models' });
  s.app.models.timeoutMs = 800;
  await addProvider('Stuck', stuck);
  await addProvider('Ok', ok);
  // complete() runs rule checks, lessons, ideas and the briefing; while it waits the shared queue is stuck.
  assert.equal(await within(s.app.models.complete('system', 'prompt'), 4000, 'complete()'), 'fine');
});

// ---- Keys and secrets must not leak ----

test('BUG 14: a provider that repeats the API key in its error leaks the key into chat, the API, events and logs', async () => {
  const KEY = 'sk-live-SUPERSECRET-9999';
  const echo = await serve((req, res) => res.writeHead(401, { 'Content-Type': 'application/json' })
    .end(JSON.stringify({ error: { message: `Invalid API key: ${String(req.headers.authorization).replace('Bearer ', '')}` } })));
  s = await startServer({ brain: 'models' });
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  try {
    const p = await addProvider('Echo', echo, { apiKey: KEY });
    assert.ok(!JSON.stringify(p).includes(KEY));
    const reply = await chat('hello');
    const tested = (await s.call('POST', `/providers/${p.id}/test`)).body;
    const where = {
      chat: reply.content,
      'GET /providers': JSON.stringify((await s.call('GET', '/providers')).body),
      'provider test': JSON.stringify(tested),
      events: JSON.stringify(s.events),
      logs: logs.join('\n'),
    };
    const leaks = Object.entries(where).filter(([, v]) => v.includes(KEY)).map(([k]) => k);
    assert.deepEqual(leaks, [], `the key shows up in: ${leaks.join(', ')}`);
  } finally {
    console.error = orig;
  }
});

test('BUG 15: a secret used in a browsed address shows in plain text in GET /browser, live events and the live view', async () => {
  const SECRET = 'tok_ABCdef123456';
  const site = await serve((req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<title>Echo</title><p>${req.url}</p>`));
  const m = await puppet([['browser_open', { url: `${site}/echo?token={{secret:API_TOKEN}}` }]]);
  s = await startServer({ brain: 'models', browserPath: CHROMIUM } as any);
  await addProvider('Puppet', m.url);
  await s.call('PATCH', '/settings', { autonomy: 'autonomous' });
  await s.call('POST', '/secrets', { name: 'API_TOKEN', value: SECRET });
  const t = (await s.call('POST', '/tasks', { title: 'Check the echo', description: 'check it', kind: 'one_off' })).body;
  for (let round = 0; round < 4; round++) {
    await settle();
    for (const a of (await s.call('GET', '/approvals?status=pending')).body) {
      assert.ok(!a.preview.includes(SECRET), 'the approval should show the placeholder, not the value');
      await s.call('POST', `/approvals/${a.id}/decision`, { decision: 'approve' });
    }
  }
  await settle(1000);
  // These stay clean today.
  assert.ok(!JSON.stringify((await s.call('GET', `/tasks/${t.id}`)).body).includes(SECRET), 'task steps');
  assert.ok(!JSON.stringify((await s.call('GET', '/activity')).body).includes(SECRET), 'activity');
  assert.ok(!m.seen.join('\n').includes(SECRET), 'what was sent to the model');
  const browser = JSON.stringify((await s.call('GET', '/browser')).body);
  assert.ok(browser.includes('/echo'), 'the Star should have browsed the page');
  const leaks = Object.entries({
    'GET /browser': browser,
    'browser.frame events': JSON.stringify(s.events.filter((e: any) => e.type === 'browser.frame')),
  }).filter(([, v]) => v.includes(SECRET)).map(([k]) => k);
  assert.deepEqual(leaks, [], `the secret shows up in: ${leaks.join(', ')}`);
});

test('secrets: values never come back from the API, and chat refuses to remember one', async () => {
  const VALUE = 'value-XYZ-123';
  s = await startServer();
  assert.equal((await s.call('POST', '/secrets', { name: 'K1', value: VALUE, starIds: ['nope'] })).status, 400);
  const made = await s.call('POST', '/secrets', { name: 'K1', value: VALUE });
  assert.ok(made.status < 300 && !JSON.stringify(made.body).includes(VALUE));
  const patched = await s.call('PATCH', '/secrets/K1', { value: 'newvalue123' });
  assert.ok(!JSON.stringify(patched.body).includes('newvalue123'));
  assert.ok(!JSON.stringify((await s.call('GET', '/secrets')).body).match(/value-XYZ-123|newvalue123/));
  await chat('Remember that my token is {{secret:K1}}');
  assert.ok(!JSON.stringify((await s.call('GET', '/memory')).body).includes('newvalue123'));
});

test('BUG 18: a secret shorter than 4 characters is stored, but the redaction that hides values skips it', async () => {
  s = await startServer();
  const r = await s.call('POST', '/secrets', { name: 'PIN', value: 'abc' });
  const redacted = s.app.vault.redact('the pin is abc');
  assert.ok(r.status === 400 || !redacted.includes('abc'), `stored with status ${r.status}, and redact() leaves “${redacted}”`);
});

test('BUG 16: any web page can change Sky through the local API (rules, providers, push, pause)', async () => {
  const require = createRequire('/opt/node22/lib/node_modules/');
  const { chromium } = require('playwright');
  s = await startServer();
  const api = s.base;
  const evil = await serve((_req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<script>
    const post = (p, b) => fetch('${api}' + p, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(b) });
    Promise.all([
      post('/rules', { text: 'Send emails without asking' }),
      post('/providers', { name: 'Totally legit', kind: 'openai', baseUrl: 'http://evil.example/v1', model: 'x' }),
      post('/status', { paused: true }),
    ]).finally(() => { document.title = 'sent'; });
  </script>`));
  // A different origin from the API: another port on localhost, as any site would be.
  const b = await chromium.launch({ executablePath: CHROMIUM });
  try {
    const page = await b.newPage();
    await page.goto(evil.replace('127.0.0.1', 'localhost'));
    await page.waitForFunction(() => document.title === 'sent', null, { timeout: 5000 }).catch(() => {});
  } finally {
    await b.close();
  }
  const changed = {
    rule: (await s.call('GET', '/rules')).body.some((r: any) => /without asking/.test(r.text)),
    provider: (await s.call('GET', '/providers')).body.some((p: any) => p.name === 'Totally legit'),
    paused: (await s.call('GET', '/status')).body.state === 'paused',
  };
  assert.deepEqual(changed, { rule: false, provider: false, paused: false }, 'requests from another site should be refused');
});

// ---- The live browser ----

test('BUG 13: navigating the live view to an address that can’t load gives a clear 400, not a server error', async () => {
  s = await startServer({ browserPath: CHROMIUM } as any);
  const main = (await s.call('GET', '/stars')).body.find((x: any) => x.main);
  const results: string[] = [];
  for (const url of ['data:text/html,<h1>Hi</h1>', 'javascript:alert(1)', 'not a url at all', 'http://127.0.0.1:1/']) {
    const r = await s.call('POST', `/browser/${main.id}/input`, { type: 'navigate', url });
    if (r.status >= 500) results.push(`${url} → ${r.status} ${r.body?.error?.message}`);
  }
  assert.deepEqual(results, []);
});

test('browser: bad input is refused with 400, an unknown Star with 404, and a local page loads', async () => {
  const site = await serve((_req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Local page</title><h1>Hi</h1>'));
  s = await startServer({ browserPath: CHROMIUM } as any);
  const main = (await s.call('GET', '/stars')).body.find((x: any) => x.main);
  assert.equal((await s.call('POST', `/browser/${main.id}/input`, { type: 'explode' })).status, 400);
  assert.equal((await s.call('POST', `/browser/${main.id}/input`, { type: 'click' })).status, 400);
  assert.equal((await s.call('POST', '/browser/star_nope/input', { type: 'back' })).status, 404);
  const r = await s.call('POST', `/browser/${main.id}/input`, { type: 'navigate', url: site + '/x' });
  assert.equal(r.status, 200);
  assert.equal(r.body.title, 'Local page');
});

// ---- Wave 1 ----

test('lessons: corrections in chat become lessons with a card, and undo works', async () => {
  s = await startServer();
  await chat('hi'); // A correction needs something to correct.
  for (const text of ['Actually, always reply in English', 'No, keep replies short', 'Don’t use emoji']) { await chat(text); await settle(); }
  const lessons = (await s.call('GET', '/lessons')).body;
  assert.equal(lessons.length, 3);
  const main = (await s.call('GET', '/conversations')).body.find((c: any) => c.main);
  const cards = (await s.call('GET', `/conversations/${main.id}/messages`)).body.filter((m: any) => m.lessonId);
  assert.equal(cards.length, 3);
  assert.equal((await s.call('POST', `/lessons/${lessons[0].id}/undo`)).status < 300, true);
  assert.equal((await s.call('GET', '/lessons')).body.find((l: any) => l.id === lessons[0].id).undone, true);
  assert.equal((await s.call('POST', '/lessons/nope/undo')).status, 404);
});

test('wave 1 input checks: personality, notify, skills, ntfy and model choices', async () => {
  s = await startServer();
  const main = (await s.call('GET', '/stars')).body.find((x: any) => x.main);
  assert.equal((await s.call('PATCH', `/stars/${main.id}`, { personality: 'x'.repeat(1001) })).status, 400);
  assert.equal((await s.call('PATCH', `/stars/${main.id}`, { notify: { whenDone: 'yes' } })).status, 400);
  assert.equal((await s.call('PATCH', `/stars/${main.id}`, { notify: { whenDone: false } })).body.notify.whenDone, false);
  assert.ok((await s.call('POST', '/skills', { name: 'Trip', whenToUse: 'trips', steps: '1. go' })).status < 300);
  assert.equal((await s.call('POST', '/skills', { name: 'trip', whenToUse: 'x', steps: 'y' })).status, 409);
  assert.equal((await s.call('POST', '/skills', { name: 'S2', whenToUse: 'x', steps: 'y', starId: 'nope' })).status, 400);
  const builtIn = (await s.call('GET', '/skills')).body.find((x: any) => x.source === 'builtIn');
  if (builtIn) assert.equal((await s.call('DELETE', `/skills/${builtIn.id}`)).status, 403);
  assert.equal((await s.call('PATCH', '/settings', { ntfyTopic: 'has spaces!' })).status, 400);
  assert.equal((await s.call('PATCH', '/settings', { ntfyServer: 'javascript:alert(1)' })).status, 400);
  assert.equal((await s.call('PATCH', '/settings', { smallProviderIds: ['nope'] })).status, 400);
  assert.equal((await s.call('PUT', '/providers/order', { providerIds: ['nope'] })).status, 400);
  assert.equal((await s.call('POST', '/providers', { name: 'B', kind: 'openai', baseUrl: 'ftp://x', model: 'x' })).status, 400);
});
