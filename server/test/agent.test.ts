import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { Approval, Conversation, Message, Task } from '../src/types.ts';
import { decodeRaw, fakeConnection, startServer, type TestServer } from './helpers.ts';

let s: TestServer;
afterEach(async () => { await s?.close(); });

const gmailOk = () => ({ body: { id: 'sent_1' } });
const pending = async () => (await s.call<Approval[]>('GET', '/approvals?status=pending')).body;
const task = async (id: string) => (await s.call('GET', `/tasks/${id}`)).body;
const mainChat = async () => (await s.call<Conversation[]>('GET', '/conversations')).body.find((c) => c.main)!;

test('there is always exactly one main chat; side chats are titled from their first message', async () => {
  s = await startServer();
  const convs = (await s.call<Conversation[]>('GET', '/conversations')).body;
  assert.equal(convs.filter((c) => c.main).length, 1);
  const side = (await s.call<Conversation>('POST', '/conversations', {})).body;
  assert.equal(side.main, false);
  await s.call('POST', `/conversations/${side.id}/messages`, { content: 'Gift ideas for Sam' });
  const after = (await s.call<Conversation[]>('GET', '/conversations')).body;
  assert.equal(after.find((c) => c.id === side.id)!.title, 'Gift ideas for Sam');
  assert.equal(after.filter((c) => c.main).length, 1);
});

test('chat replies stream and link the tasks they start as cards', async () => {
  s = await startServer();
  const main = await mainChat();
  const sent = await s.call<Message>('POST', `/conversations/${main.id}/messages`, { content: 'Find me a good ramen place near Alfama' });
  assert.equal(sent.body.role, 'user');
  const done = await s.waitFor('message.done', (e) => e.data.conversationId === main.id && e.data.role === 'agent');
  assert.equal(done.data.status, 'done');
  const deltas = s.events.filter((e) => e.type === 'message.delta' && e.data.messageId === done.data.id).map((e: any) => e.data.delta).join('');
  assert.equal(deltas, done.data.content);
  assert.equal(done.data.cards?.[0].kind, 'task');
  const t = await task((done.data.cards![0] as { taskId: string }).taskId);
  assert.equal(t.kind, 'one_off');
  const messages = (await s.call<Message[]>('GET', `/conversations/${main.id}/messages`)).body;
  assert.deepEqual(messages.map((m) => m.role), ['user', 'agent']);
});

test('chat remembers preferences and tells the UI it learned something', async () => {
  s = await startServer();
  const main = await mainChat();
  await s.call('POST', `/conversations/${main.id}/messages`, { content: 'I prefer morning flights' });
  const learned = await s.waitFor('memory.learned');
  assert.match(learned.data.content, /morning flights/);
  assert.match(learned.data.source, /^Chat on /);
});

test('sending email waits for approval, shows a card in the main chat, and uses the edited version', async () => {
  s = await startServer();
  const calls = fakeConnection(s, 'gmail', gmailOk);
  const t = (await s.call<Task>('POST', '/tasks', { title: 'Confirm Thursday', description: 'Email maya@studio.co to confirm Thursday 3pm', kind: 'one_off' })).body;
  await s.app.runtime.idle();

  assert.equal((await task(t.id)).status, 'waiting_approval');
  const [a] = await pending();
  assert.equal(a.action, 'Send email');
  assert.equal(a.target, 'maya@studio.co');
  assert.equal(a.taskId, t.id);
  assert.equal(a.connectionId, 'gmail');
  assert.ok(a.expiresAt);
  assert.equal(calls.filter((c) => c.url.includes('/send')).length, 0, 'nothing sent before approval');
  assert.equal((await s.call('GET', '/status')).body.state, 'waiting');

  const card = s.events.find((e) => e.type === 'message.done' && e.data.proactive && e.data.cards?.some((c) => c.kind === 'approval')) as any;
  assert.ok(card, 'approval card posted to the main chat');
  assert.equal(card.data.conversationId, (await mainChat()).id);

  const decided = await s.call<Approval>('POST', `/approvals/${a.id}/decision`, {
    decision: 'approve', editedPreview: 'Subject: Thursday works\n\nSee you Thursday at 3!', note: 'Keep emails to Maya short',
  });
  assert.equal(decided.body.status, 'approved');
  assert.equal((await s.call('POST', `/approvals/${a.id}/decision`, { decision: 'reject' })).status, 409);
  await s.app.runtime.idle();

  const sends = calls.filter((c) => c.url.endsWith('/messages/send'));
  assert.equal(sends.length, 1);
  const raw = decodeRaw(sends[0].body.raw);
  assert.match(raw, /^To: maya@studio\.co/m);
  assert.match(raw, /^Subject: Thursday works/m);
  assert.match(raw, /See you Thursday at 3!/);

  const done = await task(t.id);
  assert.equal(done.status, 'done');
  assert.ok(done.connectionIds.includes('gmail'));
  assert.ok(done.steps.some((x: any) => x.kind === 'approval'));
  assert.ok(done.steps.some((x: any) => x.kind === 'action' && /Sent/.test(x.summary)));
  const memory = (await s.call('GET', '/memory')).body;
  assert.ok(memory.some((m: any) => m.content === 'Keep emails to Maya short'));
});

test('a declined action is skipped and the task carries on', async () => {
  s = await startServer();
  const calls = fakeConnection(s, 'gmail', gmailOk);
  const t = (await s.call<Task>('POST', '/tasks', { title: 'Ping Sam', description: 'Email sam@example.com about lunch', kind: 'one_off' })).body;
  await s.app.runtime.idle();
  const [a] = await pending();
  await s.call('POST', `/approvals/${a.id}/decision`, { decision: 'reject' });
  await s.app.runtime.idle();
  assert.equal(calls.filter((c) => c.url.includes('/send')).length, 0);
  const done = await task(t.id);
  assert.equal(done.status, 'done');
  assert.equal(done.lastOutcome, 'Skipped sending as you asked');
});

test('hands-off autonomy sends without asking; read-only access refuses', async () => {
  s = await startServer();
  const calls = fakeConnection(s, 'gmail', gmailOk);
  await s.call('PATCH', '/settings', { autonomy: 'autonomous' });
  await s.call('POST', '/tasks', { title: 'Thank Ana', description: 'Email ana@example.com a thank-you', kind: 'one_off' });
  await s.app.runtime.idle();
  assert.equal((await pending()).length, 0);
  assert.equal(calls.filter((c) => c.url.endsWith('/messages/send')).length, 1);

  await s.call('PATCH', '/connections/gmail', { access: 'read' });
  const t = (await s.call<Task>('POST', '/tasks', { title: 'Thank Bo', description: 'Email bo@example.com a thank-you', kind: 'one_off' })).body;
  await s.app.runtime.idle();
  assert.equal(calls.filter((c) => c.url.endsWith('/messages/send')).length, 1, 'no second send');
  assert.ok((await task(t.id)).steps.some((x: any) => /read-only/.test(x.summary)));
});

test('the person’s own rules can require approval even when hands-off', async () => {
  s = await startServer();
  fakeConnection(s, 'gmail', gmailOk);
  await s.call('PATCH', '/settings', { autonomy: 'autonomous' });
  await s.call('POST', '/rules', { text: 'Always ask before I send email to anyone' });
  await s.call('POST', '/tasks', { title: 'Note to Kim', description: 'Email kim@example.com the notes', kind: 'one_off' });
  await s.app.runtime.idle();
  const [a] = await pending();
  assert.ok(a);
  assert.match(a.reason, /your rule/);
});

test('approvals expire and the task skips that action', async () => {
  s = await startServer();
  fakeConnection(s, 'gmail', gmailOk);
  const t = (await s.call<Task>('POST', '/tasks', { title: 'Late note', description: 'Email lee@example.com', kind: 'one_off' })).body;
  await s.app.runtime.idle();
  const [a] = await pending();
  s.app.store.db.put('approval', { ...a, expiresAt: new Date(Date.now() - 1000).toISOString() });
  await s.app.runtime.tick();
  await s.app.runtime.idle();
  assert.equal((await s.call<Approval[]>('GET', '/approvals')).body[0].status, 'expired');
  assert.equal((await task(t.id)).lastOutcome, 'Skipped sending as you asked');
});

test('nothing runs while paused; work resumes when unpaused', async () => {
  s = await startServer();
  await s.call('POST', '/status', { paused: true });
  const t = (await s.call<Task>('POST', '/tasks', { title: 'Paused work', description: 'Do a thing', kind: 'one_off' })).body;
  await s.app.runtime.idle();
  assert.equal((await task(t.id)).status, 'active');
  assert.equal((await task(t.id)).steps.length, 1);
  await s.call('POST', '/status', { paused: false });
  await new Promise((r) => setTimeout(r, 50));
  await s.app.runtime.idle();
  assert.equal((await task(t.id)).status, 'done');
});

test('due scheduled tasks run on the clock and go back to their schedule', async () => {
  s = await startServer();
  const t = (await s.call<Task>('POST', '/tasks', { title: 'Morning check', description: 'Check things', kind: 'recurring', schedule: 'every day at 9:00' })).body;
  s.app.store.patchTask(t.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
  await s.app.runtime.tick();
  await s.app.runtime.idle();
  const after = await task(t.id);
  assert.equal(after.status, 'scheduled');
  assert.ok(after.lastRunAt);
  assert.ok(after.nextRunAt > new Date().toISOString());
  assert.equal((await s.call('GET', '/status')).body.counts.completedToday, 1);
});

test('an expired token blocks dependent tasks until reconnected', async () => {
  s = await startServer({ providers: { githubToken: 'ghp_test' } });
  fakeConnection(s, 'gmail', () => ({ status: 401, body: { error: 'invalid_token' } }));
  await s.call('PATCH', '/settings', { autonomy: 'autonomous' });
  const t = (await s.call<Task>('POST', '/tasks', { title: 'Mail', description: 'Email x@example.com', kind: 'one_off' })).body;
  await s.app.runtime.idle();
  const gmail = (await s.call('GET', '/connections')).body.find((c: any) => c.id === 'gmail');
  assert.equal(gmail.status, 'expired');
  assert.equal((await task(t.id)).status, 'blocked');
  assert.ok(s.events.some((e) => e.type === 'task.updated' && e.data.id === t.id && e.data.status === 'blocked'));
});

test('ideas: offered from what is connected, dismissable, not repeated', async () => {
  s = await startServer();
  fakeConnection(s, 'gmail', gmailOk);
  s.app.store.db.setKv('lastIdeas', 0);
  await s.app.runtime.tick();
  const ideas = (await s.call('GET', '/ideas')).body;
  assert.ok(ideas.some((i: any) => i.title === 'Keep your inbox tidy'));
  assert.ok(s.events.some((e) => e.type === 'idea.created'));
  const id = ideas[0].id;
  assert.equal((await s.call('POST', `/ideas/${id}/dismiss`)).status, 204);
  s.app.store.db.setKv('lastIdeas', 0);
  await s.app.runtime.tick();
  assert.equal((await s.call('GET', '/ideas')).body.some((i: any) => i.title === ideas[0].title), false);
});

test('settings changes are broadcast, including the avatar', async () => {
  s = await startServer();
  const r = await s.call('PATCH', '/settings', { avatar: { character: 'drop', color: 'mint' } });
  assert.deepEqual(r.body.avatar, { character: 'drop', color: 'mint' });
  assert.ok(s.events.some((e) => e.type === 'settings.updated' && e.data.avatar.character === 'drop'));
  assert.equal((await s.call('PATCH', '/settings', { avatar: { character: 'cat', color: 'mint' } })).status, 400);
});

test('sign-in: password, session cookie and API token', async () => {
  s = await startServer({ password: 'open sesame', apiToken: 'tok_123' });
  assert.equal((await s.call('GET', '/status')).status, 401);
  assert.deepEqual((await s.call('GET', '/session')).body, { signedIn: false, authRequired: true });
  assert.equal((await s.call('GET', '/health')).status, 200);
  assert.equal((await s.call('POST', '/session', { password: 'nope' })).status, 401);
  const ok = await s.call('POST', '/session', { password: 'open sesame' });
  const cookie = ok.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await s.call('GET', '/status', undefined, { Cookie: cookie })).status, 200);
  assert.equal((await s.call('GET', '/status', undefined, { Authorization: 'Bearer tok_123' })).status, 200);
  assert.equal((await s.call('GET', '/status', undefined, { Cookie: 'skys_session=1.forged' })).status, 401);
});

test('CORS allows the configured web origin with credentials', async () => {
  s = await startServer({ webOrigin: 'http://localhost:5173' });
  const res = await fetch(`${s.base}/status`, { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
  const other = await fetch(`${s.base}/status`, { headers: { Origin: 'http://evil.example' } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
});
