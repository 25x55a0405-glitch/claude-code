import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import type { Approval, BrowserSession, CompanionDevice, ModelProvider, StarView, Task, VoiceStatus } from '../src/types.ts';
import { availableTools } from '../src/agent/tools/index.ts';
import { startServer, type TestServer } from './helpers.ts';

const COMPANION = join(import.meta.dirname, '..', '..', 'companion', 'sky-companion.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (check: () => Promise<boolean> | boolean, ms = 8000, what = 'condition') => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(25);
  }
};

let s: TestServer;
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  await s?.close();
});

const mainStar = async () => (await s.call<StarView[]>('GET', '/stars')).body.find((x) => x.main)!;
const pending = async () => (await s.call<Approval[]>('GET', '/approvals?status=pending')).body;
const task = async (id: string) => (await s.call<Task & { steps: { kind: string; summary: string; detail?: string }[] }>('GET', `/tasks/${id}`)).body;
const run = async (title: string) => {
  const t = (await s.call<Task>('POST', '/tasks', { title, description: title, kind: 'one_off' })).body;
  await s.app.runtime.idle();
  return t;
};
const decide = async (decision: 'approve' | 'reject') => {
  for (const a of await pending()) await s.call('POST', `/approvals/${a.id}/decision`, { decision });
  await s.app.runtime.idle();
};

/** Stands in for the model inside tasks (see wave3.test.ts). Returns what each call gave back. */
function puppet(steps: [string, Record<string, unknown>][]) {
  const results: string[] = [];
  const brain = s.app.runtime.brain;
  const turn = brain.turn.bind(brain);
  let n = 0;
  brain.turn = async (req) => {
    if (!req.tools.some((t) => t.name === 'finish_task')) return turn(req);
    const last = req.messages.at(-1)!;
    if (Array.isArray(last.content)) for (const b of last.content) if (b.type === 'tool_result') results.push(String(b.content));
    const done = req.messages.filter((m) => m.role === 'assistant').length;
    const use = steps[done] ?? ['finish_task', { outcome: 'All done' }];
    return { content: [{ type: 'tool_use', id: `toolu_p${++n}`, name: use[0], input: use[1], caller: { type: 'direct' } }] as any, stopReason: 'tool_use' };
  };
  return results;
}

// ---- voice ---------------------------------------------------------------------------------

interface Heard { path: string; auth: string; type: string; body: Buffer }
async function audioServer(handler?: (req: IncomingMessage, res: ServerResponse, path: string) => boolean) {
  const heard: Heard[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const path = req.url ?? '';
    heard.push({ path, auth: String(req.headers.authorization ?? ''), type: String(req.headers['content-type'] ?? ''), body: Buffer.concat(chunks) });
    if (handler?.(req, res, path)) return;
    if (path.endsWith('/audio/transcriptions')) res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ text: ' Remind me to call Maya ' }));
    else if (path.endsWith('/audio/speech')) res.writeHead(200, { 'Content-Type': 'audio/mpeg' }).end(Buffer.from('ID3-fake-mp3'));
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  return { heard, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}

const addProvider = async (name: string, baseUrl: string, apiKey?: string) =>
  (await s.call<ModelProvider>('POST', '/providers', { name, kind: 'openai', baseUrl, model: 'm', apiKey })).body;

const rawPost = (path: string, body: Buffer | string, type: string) => fetch(`${s.base}${path}`, { method: 'POST', headers: { 'Content-Type': type }, body });

test('voice: with nothing set up the app is told to use the browser’s own speech', async () => {
  s = await startServer();
  const v = (await s.call<VoiceStatus>('GET', '/voice')).body;
  assert.deepEqual([v.serverSpeechToText, v.serverTextToSpeech, v.settings.sttModel], [false, false, 'whisper-large-v3-turbo']);
  const res = await rawPost('/voice/transcribe', Buffer.from('audio'), 'audio/webm');
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'voice_unavailable');
  assert.equal((await s.call('POST', '/voice/speak', { text: 'hi' })).status, 503);
});

test('voice: speech to text and back through the providers’ own audio endpoints, with the Star’s voice', async () => {
  s = await startServer();
  const fake = await audioServer();
  const p = await addProvider('Groq', fake.url, 'gsk-secret-key-123456');
  assert.equal((await s.call('PUT', '/voice', { sttProviderIds: ['p_nope'] })).status, 400);
  assert.equal((await s.call('PUT', '/voice', { sttModel: 'bad model;rm -rf' })).status, 400);
  const set = (await s.call<VoiceStatus>('PUT', '/voice', { sttProviderIds: [p.id], ttsProviderIds: [p.id], ttsVoice: 'nova' })).body;
  assert.deepEqual([set.serverSpeechToText, set.serverTextToSpeech, set.settings.ttsVoice], [true, true, 'nova']);

  assert.equal((await rawPost('/voice/transcribe', 'not audio', 'text/plain')).status, 415);
  const got = await (await rawPost('/voice/transcribe', Buffer.from('RIFF-fake-audio'), 'audio/wav')).json() as { text: string; provider: string };
  assert.deepEqual([got.text, got.provider], ['Remind me to call Maya', 'Groq']);
  const sent = fake.heard.find((h) => h.path.endsWith('/audio/transcriptions'))!;
  assert.equal(sent.auth, 'Bearer gsk-secret-key-123456');
  assert.match(sent.type, /^multipart\/form-data/);
  assert.match(sent.body.toString('latin1'), /whisper-large-v3-turbo/);

  // The Star's own voice, and the answer is audio that can't run as a page.
  const main = await mainStar();
  assert.equal((await s.call('PATCH', `/stars/${main.id}`, { voice: 'shimmer' })).status, 200);
  assert.equal((await s.call('PATCH', `/stars/${main.id}`, { voice: 'x;y' })).status, 400);
  const spoken = await fetch(`${s.base}/voice/speak`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '**Hello** there', starId: main.id }) });
  assert.equal(spoken.status, 200);
  assert.equal(spoken.headers.get('content-type'), 'audio/mpeg');
  assert.equal(spoken.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(Buffer.from(await spoken.arrayBuffer()).toString(), 'ID3-fake-mp3');
  const speech = JSON.parse(fake.heard.find((h) => h.path.endsWith('/audio/speech'))!.body.toString());
  assert.deepEqual([speech.voice, speech.input], ['shimmer', 'Hello there']);

  // Said out loud in a chat: saved as the person's message (via voice), and the Star answers.
  const said = await (await rawPost(`/conversations/${main.conversationId}/voice`, Buffer.from('RIFF-fake-audio'), 'audio/webm;codecs=opus')).json() as { heard: string; message: { via: string }; reply: { role: string; content: string } | null };
  assert.equal(said.heard, 'Remind me to call Maya');
  assert.equal(said.message.via, 'voice');
  assert.ok(said.reply?.content, 'the Star replied');
  const msgs = (await s.call<{ role: string; via?: string }[]>('GET', `/conversations/${main.conversationId}/messages`)).body;
  assert.ok(msgs.some((m) => m.role === 'user' && m.via === 'voice'));
  assert.equal((await s.call('POST', `/conversations/${main.conversationId}/messages`, { content: 'hi', via: 'carrier-pigeon' })).status, 400);
});

test('voice: a failing provider is skipped, and its key never shows in the error', async () => {
  s = await startServer();
  const bad = await audioServer((_q, res) => { res.writeHead(401).end('{"error":{"message":"Invalid API key: gsk-leaky-key-987654"}}'); return true; });
  const good = await audioServer();
  const a = await addProvider('Broken', bad.url, 'gsk-leaky-key-987654');
  const b = await addProvider('Working', good.url);
  await s.call('PUT', '/voice', { sttProviderIds: [a.id, b.id] });
  const res = await (await rawPost('/voice/transcribe', Buffer.from('x'), 'audio/webm')).json() as { provider: string };
  assert.equal(res.provider, 'Working');
  await s.call('PUT', '/voice', { sttProviderIds: [a.id] });
  const failed = await rawPost('/voice/transcribe', Buffer.from('x'), 'audio/webm');
  assert.equal(failed.status, 502);
  const text = await failed.text();
  assert.match(text, /voice_failed/);
  assert.ok(!text.includes('gsk-leaky-key-987654'), text);
});

// ---- checkout handover ----------------------------------------------------------------------

const shop = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  const pages: Record<string, string> = {
    '/checkout': `<title>Checkout</title><h1>Total €42.50</h1><form action="/paid">
      <label>Card number <input id="card" name="cardnumber" autocomplete="cc-number"></label>
      <label>Email <input id="email" type="email" name="email"></label><button>Pay now</button></form>`,
    '/paid': '<title>Thanks</title><h1>Order placed</h1>',
  };
  res.writeHead(pages[path] ? 200 : 404, { 'Content-Type': 'text/html' }).end(pages[path] ?? 'not found');
});
let shopUrl = '';
before(async () => {
  await new Promise<void>((r) => shop.listen(0, '127.0.0.1', () => r()));
  shopUrl = `http://127.0.0.1:${(shop.address() as AddressInfo).port}`;
});
after(() => shop.close());

test('checkout: Stars never type card details, and hand the browser over to pay', async () => {
  s = await startServer();
  const main = await mainStar();
  await s.call('PATCH', '/settings', { autonomy: 'autonomous' });
  const out = puppet([
    ['browser_open', { url: `${shopUrl}/checkout` }],
    ['browser_type', { ref: 'e1', text: '4242 4242 4242 4242' }],
    ['browser_type', { ref: 'e2', text: '4111111111111111' }],
    ['browser_checkout_handover', { total: '€42.50', merchant: 'Corner Shop', summary: '1 kettle, ships to Rosa Street' }],
    ['browser_snapshot', {}],
  ]);
  const t = await run('Buy the kettle');
  assert.match(out[0], /Page: Checkout/, 'the page opened');
  assert.match(out[1], /Stars never enter card details/, 'the card field refuses');
  assert.match(out[2], /Stars never enter card details/, 'a card number is refused even in another field');

  // Even an autonomous Star asks, and the approval carries the total.
  assert.equal((await task(t.id)).status, 'waiting_approval');
  const [a] = await pending();
  assert.equal(a.action, 'Pay €42.50 at Corner Shop');
  assert.equal(a.risk, 'high');
  assert.match(a.preview, /1 kettle/);
  let view = (await s.call<{ sessions: BrowserSession[] }>('GET', '/browser')).body.sessions[0];
  assert.deepEqual([view.checkout?.stage, view.checkout?.total], ['waiting_ok', '€42.50']);

  await decide('approve');
  assert.equal((await task(t.id)).status, 'blocked');
  view = (await s.call<{ sessions: BrowserSession[] }>('GET', '/browser')).body.sessions[0];
  assert.deepEqual([view.control, view.checkout?.stage], ['person', 'paying']);
  // The person drives the page themselves, then hands it back.
  assert.equal((await s.call('POST', `/browser/${main.id}/input`, { type: 'navigate', url: `${shopUrl}/paid` })).status, 200);
  await s.call('POST', `/browser/${main.id}/handback`, { note: 'Paid' });
  await s.app.runtime.idle();
  assert.equal((await task(t.id)).status, 'done');
  assert.match(out[3], /Don’t assume it was paid: check the page/);
  assert.match(out[4], /Page: Thanks/, 'and the Star sees where the person left the page');
  view = (await s.call<{ sessions: BrowserSession[] }>('GET', '/browser')).body.sessions[0];
  assert.equal(view.checkout, null);
});

test('checkout: declining keeps the browser with the Star and teaches it nothing', async () => {
  s = await startServer();
  await s.call('PATCH', '/settings', { autonomy: 'autonomous' });
  const out = puppet([
    ['browser_open', { url: `${shopUrl}/checkout` }],
    ['browser_checkout_handover', { total: '€42.50', summary: 'A kettle' }],
  ]);
  const t = await run('Buy the kettle');
  assert.equal((await task(t.id)).status, 'waiting_approval');
  await decide('reject');
  assert.equal((await task(t.id)).status, 'done');
  assert.match(out[1], /declined|did not want|isn’t paying/i);
  const view = (await s.call<{ sessions: BrowserSession[] }>('GET', '/browser')).body.sessions[0];
  assert.deepEqual([view.control, view.checkout], ['star', null]);
  assert.equal((await s.call<{ id: string }[]>('GET', '/lessons')).body.length, 0, 'no lesson from a declined checkout');
});

// ---- the companion ---------------------------------------------------------------------------

/** The real companion program, run as a child with its own settings file. */
function companion(config: string, ...args: string[]) {
  const child = spawn(process.execPath, [COMPANION, ...args], { env: { ...process.env, SKY_COMPANION_CONFIG: config }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = new Promise<number | null>((r) => child.once('exit', r));
  cleanups.push(() => { child.kill(); });
  return { child, exited, get output() { return output; } };
}
const cli = async (config: string, ...args: string[]) => {
  const c = companion(config, ...args);
  const code = await c.exited;
  return { code, output: c.output };
};

const devices = async () => (await s.call<{ devices: CompanionDevice[] }>('GET', '/companion')).body.devices;

async function pairedComputer(opts: { confirm?: boolean } = {}) {
  s = await startServer();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sky-companion-')));
  const docs = join(root, 'docs');
  mkdirSync(docs);
  writeFileSync(join(docs, 'notes.txt'), 'buy tea');
  writeFileSync(join(root, 'secret.txt'), 'do not read');
  const config = join(root, 'companion.json');
  const base = s.base.replace(/\/api\/v1$/, '');
  const { code } = (await s.call<{ code: string }>('POST', '/companion/pair')).body;
  const paired = await cli(config, 'pair', base, code);
  assert.equal(paired.code, 0, paired.output);
  assert.match(paired.output, /Nothing is allowed yet/);
  await cli(config, 'allow-folder', docs);
  await cli(config, 'allow-command', 'echo');
  if (opts.confirm !== true) await cli(config, 'confirm', 'off');
  const running = companion(config);
  await until(async () => (await devices())[0]?.connected === true, 8000, 'the companion to connect');
  return { root, docs, config, running };
}

test('companion: pairing needs a fresh one-time code, and a web page can’t dial in', async () => {
  s = await startServer();
  const base = s.base.replace(/\/api\/v1$/, '');
  const config = join(mkdtempSync(join(tmpdir(), 'sky-companion-')), 'c.json');
  assert.notEqual((await cli(config, 'pair', base, 'WRONGONE')).code, 0);
  const { code } = (await s.call<{ code: string; command: string }>('POST', '/companion/pair')).body;
  assert.equal((await cli(config, 'pair', base, code)).code, 0);
  assert.notEqual((await cli(config, 'pair', base, code)).code, 0, 'a code works once');

  // Five wrong guesses use a code up.
  const second = (await s.call<{ code: string }>('POST', '/companion/pair')).body.code;
  for (let i = 0; i < 5; i++) await cli(config, 'pair', base, 'AAAAAAAA');
  assert.notEqual((await cli(join(mkdtempSync(join(tmpdir(), 'sky-companion-')), 'c.json'), 'pair', base, second)).code, 0);

  // A browser tab always sends an Origin; the companion is a program, so that's refused.
  const refused = await new Promise<number | string>((resolve) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/v1/companion/socket`, { headers: { Origin: 'https://evil.example' } } as never);
    ws.onopen = () => resolve('opened');
    ws.onerror = () => resolve('refused');
    ws.onclose = () => resolve('refused');
  });
  assert.equal(refused, 'refused');
});

test('companion: Stars use the computer only inside the allowlist, with an approval every time', async () => {
  const { docs, root } = await pairedComputer();
  const [d] = await devices();
  assert.deepEqual([d.enabled, d.localEnabled, d.connected, d.allow.folders, d.allow.commands, d.allow.openUrls], [true, true, true, [docs], ['echo'], false]);
  assert.equal((await s.call<{ status: string }[]>('GET', '/connections')).body.find((c: any) => c.id === 'computer')?.status, 'connected');

  await s.call('PATCH', '/settings', { autonomy: 'autonomous' });
  const out = puppet([
    ['computer_list_files', { path: docs }],
    ['computer_read_file', { path: join(docs, 'notes.txt') }],
    ['computer_read_file', { path: join(root, 'secret.txt') }],
    ['computer_write_file', { path: join(docs, 'out.txt'), content: 'hello from Sky' }],
    ['computer_run', { program: 'echo', args: ['hi; echo pwned', '$(whoami)'] }],
    ['computer_run', { program: 'rm', args: ['-rf', docs] }],
  ]);
  const t = (await s.call<Task>('POST', '/tasks', { title: 'Tidy my notes', description: 'Tidy my notes', kind: 'one_off' })).body;
  // Every step asks, even for an autonomous Star, and reading counts. The computer's own allowlist answers after that.
  const seen: string[] = [];
  for (let i = 0; i < 7; i++) {
    await s.app.runtime.idle();
    const [a] = await pending();
    if (!a) break;
    seen.push(`${a.action} @ ${a.target}`);
    await s.call('POST', `/approvals/${a.id}/decision`, { decision: 'approve' });
  }
  await s.app.runtime.idle();
  assert.equal((await task(t.id)).status, 'done');
  assert.equal(seen.length, 6, `all six calls reached the person first:\n${seen.join('\n')}`);
  assert.match(seen[0], /List .*docs @ /);
  assert.match(out[0], /notes\.txt \(7 bytes\)/);
  assert.equal(out[1], 'buy tea');
  assert.match(out[2], /isn't in a folder this computer allows/, 'a file next to the allowed folder is refused by the computer');
  assert.equal(readFileSync(join(docs, 'out.txt'), 'utf8'), 'hello from Sky');
  assert.equal(out[4], 'exit 0\nhi; echo pwned $(whoami)', 'no shell: ; and $() are just text');
  assert.match(out[5], /isn’t a program .* allows/, 'a program that isn’t allowed never runs');
});

test('companion: the allowlist holds against .. and links, and the switches stop everything', async () => {
  const { docs, root, running } = await pairedComputer();
  symlinkSync(join(root, 'secret.txt'), join(docs, 'link.txt'));
  await s.call('PATCH', '/settings', { autonomy: 'autonomous' });
  const out = puppet([
    ['computer_read_file', { path: join(docs, '..', 'secret.txt') }],
    ['computer_read_file', { path: join(docs, 'link.txt') }],
    ['computer_write_file', { path: join(docs, '..', 'evil.txt'), content: 'x' }],
    ['computer_open', { url: 'https://example.com' }],
  ]);
  const t = (await s.call<Task>('POST', '/tasks', { title: 'Poke around', description: 'Poke around', kind: 'one_off' })).body;
  for (let i = 0; i < 5; i++) {
    await s.app.runtime.idle();
    const [a] = await pending();
    if (!a) break;
    await s.call('POST', `/approvals/${a.id}/decision`, { decision: 'approve' });
  }
  await s.app.runtime.idle();
  assert.equal((await task(t.id)).status, 'done');
  assert.match(out[0], /isn't in a folder/);
  assert.match(out[1], /isn't in a folder/, 'a link to a file outside the folder is followed first, then refused');
  assert.match(out[2], /isn't in a folder/);
  assert.match(out[3], /doesn’t allow opening pages/);

  // Sky's switch: off means no Star can reach it, and the computer hears about it.
  const [d] = await devices();
  assert.equal((await s.call('PATCH', `/companion/devices/${d.id}`, { enabled: 'yes' })).status, 400);
  await s.call('PATCH', `/companion/devices/${d.id}`, { enabled: false });
  assert.equal((await s.call<{ status: string }[]>('GET', '/connections')).body.find((c: any) => c.id === 'computer')?.status, 'disconnected');
  assert.ok(!availableTools('task', s.app.providers, s.app.store.mainStar()).some((x) => x.name === 'computer_run'), 'the tools aren’t even offered while it’s off');
  await s.call('PATCH', `/companion/devices/${d.id}`, { enabled: true });
  assert.ok(availableTools('task', s.app.providers, s.app.store.mainStar()).some((x) => x.name === 'computer_run'));

  // The computer's own switch (pressing o; with no keyboard, typing off or on) shows up in Sky, and tools go away.
  running.child.stdin!.write('off\n');
  await until(async () => (await devices())[0].localEnabled === false, 8000, 'the computer’s own switch');
  assert.ok(!availableTools('task', s.app.providers, s.app.store.mainStar()).some((x) => x.name === 'computer_run'));
  const refused = puppet([['computer_list_files', { path: docs }]]);
  await s.call('POST', '/tasks', { title: 'Look again', description: 'Look again', kind: 'one_off' });
  await s.app.runtime.idle();
  assert.equal((await pending()).length, 0, 'with the computer off nothing reaches the person, and nothing runs');
  assert.ok(refused.every((r) => !/notes\.txt/.test(r)), `nothing was listed: ${refused.join(' | ')}`);
  running.child.stdin!.write('on\n');
  await until(async () => (await devices())[0].localEnabled === true, 8000, 'the switch back on');
});

test('companion: asking on the computer comes first, and with no keyboard the answer is no', async () => {
  const { docs } = await pairedComputer({ confirm: true });
  await s.call('PATCH', '/settings', { autonomy: 'autonomous' });
  const out = puppet([['computer_read_file', { path: join(docs, 'notes.txt') }]]);
  const t = (await s.call<Task>('POST', '/tasks', { title: 'Read notes', description: 'Read notes', kind: 'one_off' })).body;
  await s.app.runtime.idle();
  const [a] = await pending();
  await s.call('POST', `/approvals/${a.id}/decision`, { decision: 'approve' });
  await s.app.runtime.idle();
  assert.equal((await task(t.id)).status, 'done');
  assert.match(out[0], /said no on the computer/);
});

test('companion: unpairing in Sky ends the connection and the computer forgets its token', async () => {
  const { config, running } = await pairedComputer();
  const [d] = await devices();
  assert.equal((await s.call('DELETE', `/companion/devices/${d.id}`)).status, 204);
  assert.equal(await running.exited, 0);
  assert.equal(JSON.parse(readFileSync(config, 'utf8')).token, null);
  assert.deepEqual(await devices(), []);
  assert.match(running.output, /unpaired this computer/);
});
