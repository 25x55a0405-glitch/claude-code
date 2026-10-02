import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Approval, Connection, MemoryItem, Rule, Settings, Task } from '../src/types.ts';
import { startServer, type TestServer } from './helpers.ts';

let s: TestServer;
before(async () => { s = await startServer(); });
after(async () => { await s.close(); });

test('status starts idle with counts', async () => {
  const { status, body } = await s.call('GET', '/status');
  assert.equal(status, 200);
  assert.equal(body.state, 'idle');
  assert.equal(body.autonomy, 'balanced');
  assert.deepEqual(body.counts, { activeTasks: 0, pendingApprovals: 0, completedToday: 0 });
});

test('pausing shows as paused and emits a status event', async () => {
  const paused = await s.call('POST', '/status', { paused: true });
  assert.equal(paused.body.state, 'paused');
  await s.waitFor('status', (e) => e.data.state === 'paused');
  const resumed = await s.call('POST', '/status', { paused: false });
  assert.equal(resumed.body.state, 'idle');
  assert.equal((await s.call('POST', '/status', { paused: 'yes' })).status, 400);
});

test('errors use the documented shape', async () => {
  const r = await s.call('GET', '/tasks/t_missing');
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { error: { code: 'not_found', message: 'Task t_missing not found' } });
  assert.equal((await s.call('GET', '/nope')).status, 404);
  assert.equal((await s.call('PUT', '/tasks')).status, 405);
});

test('settings patch is partial, validated, and autonomy shows in status', async () => {
  const r = await s.call<Settings>('PATCH', '/settings', { tone: 'concise', autonomy: 'ask' });
  assert.equal(r.body.tone, 'concise');
  assert.equal(r.body.userName, 'd');
  assert.equal((await s.call('GET', '/status')).body.autonomy, 'ask');
  assert.equal((await s.call('PATCH', '/settings', { tone: 'grumpy' })).status, 400);
  assert.equal((await s.call('PATCH', '/settings', { timezone: 'Mars/Base' })).status, 400);
  assert.equal((await s.call('PATCH', '/settings', { briefingTime: '25:00' })).status, 400);
  assert.equal((await s.call('PATCH', '/settings', { briefingTime: null })).body.briefingTime, null);
  await s.call('PATCH', '/settings', { autonomy: 'balanced', tone: 'warm' });
});

test('memory: add, edit, pin, delete', async () => {
  const added = await s.call<MemoryItem>('POST', '/memory', { category: 'preference', content: 'Prefers aisle seats' });
  assert.equal(added.body.source, 'Added by you');
  assert.equal(added.body.pinned, false);
  const pinned = await s.call<MemoryItem>('PATCH', `/memory/${added.body.id}`, { pinned: true, content: 'Prefers aisle seats on flights' });
  assert.equal(pinned.body.pinned, true);
  assert.equal(pinned.body.content, 'Prefers aisle seats on flights');
  assert.equal((await s.call('POST', '/memory', { category: 'mood', content: 'x' })).status, 400);
  assert.equal((await s.call('DELETE', `/memory/${added.body.id}`)).status, 204);
  assert.equal((await s.call<MemoryItem[]>('GET', '/memory')).body.some((m) => m.id === added.body.id), false);
});

test('rules: built-ins are protected, custom rules editable', async () => {
  const rules = (await s.call<Rule[]>('GET', '/rules')).body;
  const builtIn = rules.find((r) => r.builtIn)!;
  assert.ok(builtIn);
  assert.equal((await s.call('PATCH', `/rules/${builtIn.id}`, { enabled: false })).status, 403);
  assert.equal((await s.call('DELETE', `/rules/${builtIn.id}`)).status, 403);
  const added = await s.call<Rule>('POST', '/rules', { text: 'Archive newsletters without asking' });
  assert.equal(added.body.enabled, true);
  assert.equal((await s.call<Rule>('PATCH', `/rules/${added.body.id}`, { enabled: false })).body.enabled, false);
  assert.equal((await s.call('DELETE', `/rules/${added.body.id}`)).status, 204);
});

test('connections list every provider; web connects directly, OAuth ones explain setup', async () => {
  const list = (await s.call<Connection[]>('GET', '/connections')).body;
  assert.deepEqual(list.map((c) => c.provider), ['web', 'gmail', 'calendar', 'drive', 'github', 'notion', 'slack', 'telegram']);
  const web = await s.call('POST', '/connections/web/connect');
  assert.equal(web.body.authorizeUrl, null);
  assert.equal(web.body.connection.status, 'connected');
  const gmail = await s.call('POST', '/connections/gmail/connect');
  assert.equal(gmail.status, 400);
  assert.match(gmail.body.error.message, /GOOGLE_CLIENT_ID/);
  assert.equal((await s.call<Connection>('PATCH', '/connections/gmail', { access: 'read' })).body.access, 'read');
  assert.equal((await s.call('PATCH', '/connections/gmail', { access: 'all' })).status, 400);
  assert.equal((await s.call<Connection>('POST', '/connections/web/disconnect')).body.status, 'disconnected');
  await s.call('POST', '/connections/web/connect');
});

test('creating tasks: validation, schedules and filters', async () => {
  assert.equal((await s.call('POST', '/tasks', { title: '', kind: 'one_off' })).status, 400);
  assert.equal((await s.call('POST', '/tasks', { title: 'x', kind: 'recurring' })).status, 400);
  const rec = await s.call<Task>('POST', '/tasks', { title: 'Weekly review', description: 'Summarise my week', kind: 'recurring', schedule: 'Fridays at 4pm' });
  assert.equal(rec.body.status, 'scheduled');
  assert.ok(rec.body.nextRunAt);
  assert.equal(new Date(rec.body.nextRunAt!).getUTCDay(), 5);
  const detail = await s.call('GET', `/tasks/${rec.body.id}`);
  assert.deepEqual(detail.body.steps.map((x: any) => x.summary), ['Created by You', 'Runs Fri at 16:00']);
  const scheduled = await s.call<Task[]>('GET', '/tasks?status=scheduled,paused');
  assert.ok(scheduled.body.every((t) => ['scheduled', 'paused'].includes(t.status)));
  assert.equal((await s.call('GET', '/tasks?status=bogus')).status, 400);
});

test('task commands append notes and enforce what makes sense', async () => {
  const t = (await s.call<Task>('POST', '/tasks', { title: 'Check prices', description: 'Watch prices', kind: 'watch', schedule: 'every 6 hours' })).body;
  await s.app.runtime.idle();
  assert.equal((await s.call<Task>('POST', `/tasks/${t.id}/pause`)).body.status, 'paused');
  assert.equal((await s.call<Task>('POST', `/tasks/${t.id}/resume`)).body.status, 'scheduled');
  const run = await s.call<Task>('POST', `/tasks/${t.id}/run_now`);
  assert.equal(run.body.status, 'active');
  await s.app.runtime.idle();
  assert.equal((await s.call<Task>('GET', `/tasks/${t.id}`)).body.status, 'scheduled');
  const cancelled = await s.call<Task>('POST', `/tasks/${t.id}/cancel`);
  assert.equal(cancelled.body.status, 'done');
  assert.equal((await s.call('POST', `/tasks/${t.id}/cancel`)).status, 409);
  const notes = (await s.call('GET', `/tasks/${t.id}`)).body.steps.filter((x: any) => x.kind === 'note').map((x: any) => x.summary);
  for (const n of ['Paused by you', 'Resumed by you', 'Run started by you', 'Stopped by you']) assert.ok(notes.includes(n), n);
  const oneOff = (await s.call<Task>('POST', '/tasks', { title: 'Once', description: '', kind: 'one_off' })).body;
  await s.app.runtime.idle();
  assert.equal((await s.call('POST', `/tasks/${oneOff.id}/run_now`)).status, 409);
});

test('activity pages newest first with a cursor', async () => {
  for (let i = 0; i < 60; i++) s.app.store.log('research', `Finding ${i}`);
  const first = await s.call('GET', '/activity');
  assert.equal(first.body.items.length, 50);
  assert.equal(first.body.items[0].summary, 'Finding 59');
  assert.ok(first.body.nextCursor);
  const second = await s.call('GET', `/activity?cursor=${first.body.nextCursor}`);
  assert.ok(second.body.items.length > 0);
  assert.ok(second.body.items[0].at <= first.body.items[49].at);
});

test('briefing is always available', async () => {
  const b = await s.call('GET', '/briefing');
  assert.equal(b.status, 200);
  assert.match(b.body.greeting, /, d$/);
  assert.ok(Array.isArray(b.body.highlights));
});

test('the event stream speaks SSE', async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${s.base}/events`, { signal: ctrl.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body!.getReader();
  let text = '';
  const readUntil = async (needle: string) => {
    while (!text.includes(needle)) text += new TextDecoder().decode((await reader.read()).value);
  };
  await readUntil('event: status');
  await s.call('POST', '/memory', { category: 'fact', content: 'Lives in Lisbon' });
  await s.call('POST', '/tasks', { title: 'Stream me', description: '', kind: 'one_off' });
  await readUntil('event: task.updated');
  assert.match(text, /event: task.updated\ndata: \{.*"title":"Stream me"/);
  ctrl.abort();
  await s.app.runtime.idle();
});

test('approvals list and decision validation', async () => {
  assert.deepEqual((await s.call<Approval[]>('GET', '/approvals?status=pending')).body, []);
  assert.equal((await s.call('POST', '/approvals/a_missing/decision', { decision: 'approve' })).status, 404);
  assert.equal((await s.call('GET', '/approvals?status=maybe')).status, 400);
});
