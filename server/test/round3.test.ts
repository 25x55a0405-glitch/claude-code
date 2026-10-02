// Fixes for the testing thread's round 3 (bugs 12 to 18). Its own tests live in qa/server/round3.test.ts on PR #2.
import assert from 'node:assert/strict';
import { createServer, request, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, test } from 'node:test';
import { classify } from '../src/models/registry.ts';
import { scrubKey } from '../src/models/router.ts';
import { startServer, type TestServer } from './helpers.ts';

let s: TestServer | undefined;
const hanging: ServerResponse[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  hanging.splice(0).forEach((r) => r.destroy());
  await s?.close();
  s = undefined;
});
after(() => servers.forEach((x) => x.close()));

async function serve(handler: (res: ServerResponse, auth: string) => void) {
  const srv = createServer((req, res) => {
    req.resume();
    req.on('end', () => handler(res, String(req.headers.authorization ?? '')));
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

test('other websites can’t change Sky: cross-site writes are refused, and bodies must be JSON', async () => {
  s = await startServer();
  const evil = { Origin: 'http://localhost:9999', 'Sec-Fetch-Site': 'cross-site' };
  const r = await s.call('POST', '/rules', { text: 'Send emails without asking' }, evil);
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'cross_site');
  assert.match(r.body.error.message, /SKY_WEB_ORIGIN/);
  // Same-site (another port on this machine) is still another origin.
  assert.equal((await s.call('PATCH', '/settings', { autonomy: 'autonomous' }, { Origin: 'http://127.0.0.1:1234', 'Sec-Fetch-Site': 'same-site' })).status, 403);
  // A page can send text/plain without asking the browser first; that's refused too.
  const plain = await fetch(`${s.base}/rules`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ text: 'x' }) });
  assert.equal(plain.status, 415);
  // Reads, Sky's own pages, a configured web app and tools without browser headers all work.
  assert.equal((await s.call('GET', '/rules', undefined, evil)).status, 200);
  assert.equal((await s.call('POST', '/rules', { text: 'Ask before posting' }, { 'Sec-Fetch-Site': 'same-origin', Origin: s.base.replace(/\/api\/v1$/, '') })).status, 200);
  assert.equal((await s.call('POST', '/rules', { text: 'Ask before booking' })).status, 200);
  assert.equal((await s.call('GET', '/rules')).body.filter((x: any) => /without asking/.test(x.text)).length, 0);
  await s.close();
  s = await startServer({ webOrigin: 'http://localhost:5173' });
  assert.equal((await s.call('POST', '/rules', { text: 'From the dev server' }, { Origin: 'http://localhost:5173', 'Sec-Fetch-Site': 'same-site' })).status, 200);
  // A site that points its own name at this machine (DNS rebinding) isn't served.
  const status = await new Promise<number>((done) => {
    request(`${s!.base}/status`, { headers: { Host: 'evil.example:8787' } }, (res) => { res.resume(); done(res.statusCode ?? 0); }).end();
  });
  assert.equal(status, 403);
});

test('a provider that repeats its key in an error never shows it', async () => {
  const KEY = 'sk-live-SUPERSECRET-9999';
  assert.equal(scrubKey(`401 Invalid API key: ${KEY}`, KEY), '401 Invalid API key: …9999');
  assert.equal(scrubKey('401 key sk-live-SUPERSE... is wrong', KEY), '401 key …9999... is wrong', 'a shortened echo too');
  const echo = await serve((res, auth) => res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: `Invalid API key: ${auth.replace('Bearer ', '')}` } })));
  s = await startServer({ brain: 'models' });
  const p = (await s.call('POST', '/providers', { name: 'Echo', kind: 'openai', baseUrl: echo, model: 'm', apiKey: KEY })).body;
  const tested = (await s.call('POST', `/providers/${p.id}/test`)).body;
  assert.match(tested.error, /…9999/);
  assert.ok(!JSON.stringify([tested, (await s.call('GET', '/providers')).body, s.events]).includes(KEY));
  const short = (await s.call('POST', '/providers', { name: 'Short', kind: 'openai', baseUrl: echo, model: 'm', apiKey: 'abcd' })).body;
  assert.equal(short.keyHint, null, 'a 4-character key has no hint, since the hint would be the whole key');
});

test('a model that never answers a plain call times out instead of holding up the queue', async () => {
  const stuck = await serve((res) => { hanging.push(res); });
  s = await startServer({ brain: 'models' });
  s.app.models.timeoutMs = 300;
  await s.call('POST', '/providers', { name: 'Stuck', kind: 'openai', baseUrl: stuck, model: 'm' });
  const t0 = Date.now();
  await assert.rejects(s.app.models.complete('system', 'prompt'), /No model could answer.*timed out/);
  assert.ok(Date.now() - t0 < 2000);
});

test('only an unknown model benches a provider; a request the model can’t do just moves on', () => {
  const f = (msg: string, status = 400) => classify(Object.assign(new Error(`${status} ${msg}`), { status }), 0);
  for (const msg of ['tool calling is not supported with this model', 'Invalid value for max_tokens: too large for this model', 'This model does not support tools']) {
    assert.deepEqual([f(msg).permanent, f(msg).cooldownMs], [false, 0], msg);
  }
  for (const msg of ['The model `gpt-9` does not exist', 'model not found', 'Unknown model: foo']) assert.equal(f(msg, 404).permanent, true, msg);
});

test('secrets need 4 characters, and push only goes to real push services', async () => {
  s = await startServer();
  assert.equal((await s.call('POST', '/secrets', { name: 'PIN', value: 'abc' })).status, 400);
  assert.equal((await s.call('POST', '/secrets', { name: 'PIN', value: 'abcd' })).status, 200);
  assert.equal((await s.call('PATCH', '/secrets/PIN', { value: 'ab' })).status, 400);
  const keys = { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') };
  for (const endpoint of ['http://127.0.0.1:8787/api/v1/status', 'https://localhost/x', 'https://192.168.1.4/push']) {
    assert.equal((await s.call('POST', '/push/subscriptions', { subscription: { endpoint, keys } })).status, 400, endpoint);
  }
});
