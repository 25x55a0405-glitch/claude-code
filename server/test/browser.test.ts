import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, test } from 'node:test';
import type { Approval, StarView, Task } from '../src/types.ts';
import { startServer, type TestServer } from './helpers.ts';

// A small shop on localhost, opened in a real Chromium.
const orders: string[] = [];
let site = '';
const shop = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/order') {
    let raw = '';
    for await (const c of req) raw += c;
    orders.push(raw);
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Thanks</title><h1>Order placed</h1>');
    return;
  }
  const pages: Record<string, string> = {
    '/shop': `<title>Ramen Shop</title><h1>Tonkotsu ramen</h1><p>Rich pork broth, 12 euros.</p>
      <a href="/menu">Menu</a>
      <form method="post" action="/order"><label>Name <input name="name"></label><label>Password <input type="password" name="pw"></label>
      <button type="submit">Place order</button></form>`,
    '/menu': '<title>Menu</title><h1>Menu</h1><ul><li>Shoyu</li><li>Miso</li></ul>',
  };
  const body = pages[req.url ?? ''];
  res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html' }).end(body ?? 'not found');
});

let s: TestServer;
before(async () => {
  await new Promise<void>((r) => shop.listen(0, '127.0.0.1', () => r()));
  site = `http://127.0.0.1:${(shop.address() as AddressInfo).port}`;
});
after(() => shop.close());
afterEach(async () => { await s?.close(); });

const task = async (id: string) => (await s.call<Task & { steps: { kind: string; summary: string; connectionId?: string }[] }>('GET', `/tasks/${id}`)).body;
const mainStar = async () => (await s.call<StarView[]>('GET', '/stars')).body.find((x) => x.main)!;

test('browsing opens the page in a real browser, and the live view gets a screenshot', async () => {
  s = await startServer();
  const main = await mainStar();
  const t = (await s.call<Task>('POST', '/tasks', { title: 'Check the ramen shop', description: `Browse ${site}/shop and tell me what they sell`, kind: 'one_off' })).body;
  await s.app.runtime.idle();
  const after = await task(t.id);
  assert.equal(after.status, 'done');
  assert.equal(after.lastOutcome, 'Done: Check the ramen shop. Saw “Ramen Shop”');
  const opened = after.steps.find((x) => x.summary.startsWith('Opened '))!;
  assert.equal(opened.connectionId, 'browser');
  assert.ok(after.connectionIds.includes('browser'));

  const frame = await s.waitFor('browser.frame', (e) => e.data.starId === main.id);
  assert.equal(frame.data.title, 'Ramen Shop');
  const view = (await s.call('GET', '/browser')).body;
  assert.equal(view.ok, true);
  assert.deepEqual(view.sessions.map((x: any) => x.url), [`${site}/shop`]);
  const shot = await fetch(`${s.base}/browser/${main.id}/screenshot`);
  assert.equal(shot.headers.get('content-type'), 'image/jpeg');
  const bytes = new Uint8Array(await shot.arrayBuffer());
  assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xd8], 'a real JPEG');
});

test('a click that places an order waits for approval; following a link doesn’t', async () => {
  s = await startServer();
  orders.length = 0;
  const t = (await s.call<Task>('POST', '/tasks', { title: 'Order ramen', description: `Browse ${site}/shop and click "Place order"`, kind: 'one_off' })).body;
  await s.app.runtime.idle();
  assert.equal((await task(t.id)).status, 'waiting_approval');
  const [a] = (await s.call<Approval[]>('GET', '/approvals?status=pending')).body;
  assert.equal(a.action, 'Buy or pay: “Place order”');
  assert.equal(a.target, new URL(site).host);
  assert.equal(a.risk, 'high');
  assert.match(a.preview, /Click “Place order”, which submits the form/);
  assert.equal(orders.length, 0, 'nothing submitted before the OK');

  await s.call('POST', `/approvals/${a.id}/decision`, { decision: 'approve' });
  await s.app.runtime.idle();
  assert.equal(orders.length, 1);
  assert.equal((await task(t.id)).lastOutcome, 'Done: Order ramen. Saw “Thanks”');

  const link = (await s.call<Task>('POST', '/tasks', { title: 'See the menu', description: `Browse ${site}/shop and click "Menu"`, kind: 'one_off' })).body;
  await s.app.runtime.idle();
  assert.equal((await task(link.id)).lastOutcome, 'Done: See the menu. Saw “Menu”');
});

test('the person can drive a Star’s tab from the live view, and Stars never type passwords', async () => {
  s = await startServer();
  const main = await mainStar();
  const nav = await s.call('POST', `/browser/${main.id}/input`, { type: 'navigate', url: `${site}/menu` });
  assert.equal(nav.body.url, `${site}/menu`);
  assert.equal(nav.body.title, 'Menu');
  assert.equal((await s.call('POST', `/browser/${main.id}/input`, { type: 'click' })).status, 400);

  // The stream is MJPEG, which an <img> shows directly.
  const ctrl = new AbortController();
  const res = await fetch(`${s.base}/browser/${main.id}/stream`, { signal: ctrl.signal });
  assert.match(res.headers.get('content-type')!, /^multipart\/x-mixed-replace/);
  const first = new TextDecoder().decode((await res.body!.getReader().read()).value!.slice(0, 60));
  assert.match(first, /--frame\r\nContent-Type: image\/jpeg/);
  ctrl.abort();

  await s.app.browser.open(main.id, `${site}/shop`);
  const pw = s.app.browser.element(main.id, undefined, 'Password')!;
  assert.equal(pw.password, true);
  await assert.rejects(s.app.browser.type(main.id, { ref: pw.ref, text: 'hunter2' }), /don’t type passwords/);
});
