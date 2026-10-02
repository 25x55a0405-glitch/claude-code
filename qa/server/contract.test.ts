// Checks of the server against docs/API.md and docs/BACKEND.md, from the testing thread.
// Tests named "BUG:" describe the behaviour the docs promise and fail today; see qa/BUGS.md.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { ScriptedBrain } from '../../server/src/agent/scripted.ts';
import { loadConfig } from '../../server/src/config.ts';
import { createApp } from '../../server/src/main.ts';
import type { ActivityEvent, Page, Task } from '../../server/src/types.ts';
import { startServer, type TestServer } from '../../server/test/helpers.ts';

let s: TestServer | undefined;
afterEach(async () => { await s?.close(); s = undefined; });

const raw = (method: string, path: string, body: string) =>
  fetch(s!.base + path, { method, headers: { 'Content-Type': 'application/json' }, body });

// ---- passing contract checks ------------------------------------------------

test('activity pages newest first and the cursor walks the whole log', async () => {
  s = await startServer();
  for (let i = 0; i < 120; i++) s.app.store.log('research', `entry ${i}`);
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const r: { body: Page<ActivityEvent> } = await s.call('GET', `/activity${cursor ? `?cursor=${cursor}` : ''}`);
    seen.push(...r.body.items.filter((e) => e.kind === 'research').map((e) => e.summary));
    cursor = r.body.nextCursor;
  } while (cursor);
  assert.equal(seen.length, 120);
  assert.equal(seen[0], 'entry 119');
  assert.equal(seen.at(-1), 'entry 0');
});

test('tasks list newest updatedAt first and filter by several statuses', async () => {
  s = await startServer();
  const a = (await s.call<Task>('POST', '/tasks', { title: 'A', description: '', kind: 'recurring', schedule: 'every day at 9:00' })).body;
  await new Promise((r) => setTimeout(r, 5));
  const b = (await s.call<Task>('POST', '/tasks', { title: 'B', description: '', kind: 'recurring', schedule: 'every day at 10:00' })).body;
  await s.call('POST', `/tasks/${a.id}/pause`);
  const all = (await s.call<Task[]>('GET', '/tasks')).body;
  assert.deepEqual(all.slice(0, 2).map((t) => t.id), [a.id, b.id]);
  const some = (await s.call<Task[]>('GET', '/tasks?status=paused,scheduled')).body;
  assert.deepEqual(new Set(some.map((t) => t.status)), new Set(['paused', 'scheduled']));
});

test('a task made while Skys is paused waits, then runs once Skys resumes', async () => {
  s = await startServer();
  await s.call('POST', '/status', { paused: true });
  const t = (await s.call<Task>('POST', '/tasks', { title: 'Find ramen', description: 'find ramen', kind: 'one_off' })).body;
  await s.app.runtime.idle();
  assert.equal((await s.call<Task>('GET', `/tasks/${t.id}`)).body.status, 'active');
  await s.call('POST', '/status', { paused: false });
  for (let i = 0; i < 20 && (await s.call<Task>('GET', `/tasks/${t.id}`)).body.status !== 'done'; i++) await s.app.runtime.idle();
  assert.equal((await s.call<Task>('GET', `/tasks/${t.id}`)).body.status, 'done');
});

test('the event stream opens with status and allows the configured web origin', async () => {
  s = await startServer({ webOrigin: 'http://localhost:5173' });
  const ctl = new AbortController();
  const res = await fetch(s.base + '/events', { signal: ctl.signal, headers: { Origin: 'http://localhost:5173' } });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
  const { value } = await res.body!.getReader().read();
  assert.match(new TextDecoder().decode(value), /event: status\ndata: \{"state":"idle"/);
  ctl.abort();
});

test('unknown ids are 404s with the documented error shape', async () => {
  s = await startServer();
  for (const [m, p] of [['PATCH', '/memory/m_x'], ['POST', '/ideas/i_x/dismiss'], ['POST', '/connections/nope/connect'], ['GET', '/conversations/c_x/messages'], ['POST', '/approvals/a_x/decision']] as const) {
    const r = await s.call(m, p, m === 'GET' ? undefined : { pinned: true, decision: 'approve' });
    assert.equal(r.status, 404, `${m} ${p}`);
    assert.equal(r.body.error.code, 'not_found');
  }
});

// ---- bugs ---------------------------------------------------------------------

test('BUG 4: a reply cut off by a restart does not stay "streaming" forever', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skys-qa-'));
  const config = loadConfig({ SKYS_USER_NAME: 'd' }, { dbPath: join(dir, 'skys.db'), brain: 'scripted', tickMs: 60_000, webDist: '/nonexistent' });
  const hangs = new ScriptedBrain();
  hangs.turn = () => new Promise(() => {});
  let app = createApp(config, hangs);
  const main = app.store.mainConversation();
  app.store.saveMessage({ id: 'u1', conversationId: main.id, role: 'user', content: 'hello', createdAt: new Date().toISOString(), status: 'done' });
  void app.runtime.chat.reply(main.id);
  await new Promise((r) => setTimeout(r, 50));
  await app.close(); // the server stops while the reply is still streaming

  app = createApp(config);
  app.runtime.start();
  await new Promise((r) => setTimeout(r, 200));
  const stuck = app.store.messages(main.id).filter((m) => m.status === 'streaming');
  await app.close();
  assert.deepEqual(stuck.map((m) => ({ status: m.status, content: m.content })), [], 'reply left streaming with no text after restart');
});

test('BUG 5: Run now can’t bring back a task you stopped', async () => {
  s = await startServer();
  const t = (await s.call<Task>('POST', '/tasks', { title: 'Daily', description: '', kind: 'recurring', schedule: 'every day at 9:00' })).body;
  assert.equal((await s.call<Task>('POST', `/tasks/${t.id}/cancel`)).body.status, 'done');
  const r = await s.call('POST', `/tasks/${t.id}/run_now`);
  assert.equal(r.status, 409, `run_now on a stopped task returned ${r.status} and set it to ${r.body?.status}`);
});

test('BUG 6: a malformed URL is a 400, not a 500', async () => {
  s = await startServer();
  const r = await s.call('GET', '/tasks/%E0%A4%A');
  assert.equal(r.status, 400);
});

test('BUG 7: an unreadable activity cursor is a 400, not an empty page', async () => {
  s = await startServer();
  s.app.store.log('research', 'something');
  const r = await s.call('GET', '/activity?cursor=!!!');
  assert.equal(r.status, 400, `got ${r.status} ${JSON.stringify(r.body)}`);
});

test('BUG 8: PATCH /settings rejects a body that isn’t an object', async () => {
  s = await startServer();
  for (const body of ['null', '[]', '"x"', '5']) {
    const r = await raw('PATCH', '/settings', body);
    assert.equal(r.status, 400, `PATCH /settings with ${body} returned ${r.status}`);
  }
});
