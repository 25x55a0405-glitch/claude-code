import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { Approval, ConstellationMessage, Conversation, MemoryItem, Message, Rule, StarView, Task } from '../src/types.ts';
import { fakeConnection, startServer, type TestServer } from './helpers.ts';

let s: TestServer;
afterEach(async () => { await s?.close(); });

const star = (body: Record<string, unknown>) => s.call<StarView>('POST', '/stars', body);
const task = async (id: string) => (await s.call<Task & { steps: { kind: string; summary: string }[] }>('GET', `/tasks/${id}`)).body;
const team = async (starId?: string) => (await s.call<ConstellationMessage[]>('GET', `/constellation/messages${starId ? `?starId=${starId}` : ''}`)).body;
const mainStar = async () => (await s.call<StarView[]>('GET', '/stars')).body.find((x) => x.main)!;

test('the original agent is the main Star, and its name follows Settings', async () => {
  s = await startServer();
  const stars = (await s.call<StarView[]>('GET', '/stars')).body;
  assert.equal(stars.length, 1);
  const main = stars[0];
  assert.equal(main.main, true);
  assert.equal(main.name, 'Sky');
  assert.equal(main.status.state, 'idle');
  const mainChat = (await s.call<Conversation[]>('GET', '/conversations')).body.find((c) => c.main)!;
  assert.equal(main.conversationId, mainChat.id);
  assert.equal(mainChat.starId, main.id);

  await s.call('PATCH', '/settings', { agentName: 'Nova' });
  assert.equal((await mainStar()).name, 'Nova');
  await s.call('PATCH', `/stars/${main.id}`, { name: 'Vega' });
  assert.equal((await s.call('GET', '/settings')).body.agentName, 'Vega');
  assert.equal((await s.call<Conversation[]>('GET', '/conversations')).body.find((c) => c.main)!.title, 'Vega');
  assert.equal((await s.call('DELETE', `/stars/${main.id}`)).status, 403);
});

test('creating Stars: validation, unique names, own chat, live event', async () => {
  s = await startServer();
  assert.equal((await star({ name: 'Scout' })).status, 400, 'role is required');
  assert.equal((await star({ name: 'Scout', role: 'x', connectionIds: ['fax'] })).status, 400);
  assert.equal((await star({ name: 'Scout', role: 'x', autonomy: 'yolo' })).status, 400);
  const scout = (await star({ name: 'Scout', role: 'Finds places and compares options', connectionIds: ['web'] })).body;
  assert.equal(scout.main, false);
  assert.equal(scout.autonomy, null);
  assert.deepEqual(scout.connectionIds, ['web']);
  assert.equal(scout.status.state, 'idle');
  await s.waitFor('star.updated', (e) => e.data.id === scout.id);
  assert.equal((await star({ name: 'scout', role: 'again' })).status, 409);
  assert.equal((await s.call('PATCH', '/settings', { agentName: 'Scout' })).status, 409);

  const convs = (await s.call<Conversation[]>('GET', `/conversations?starId=${scout.id}`)).body;
  assert.deepEqual(convs.map((c) => c.id), [scout.conversationId]);
  const side = (await s.call<Conversation>('POST', '/conversations', { starId: scout.id })).body;
  assert.equal(side.starId, scout.id);
  assert.equal((await s.call('POST', '/conversations', { starId: 'star_nope' })).status, 400);

  const patched = (await s.call<StarView>('PATCH', `/stars/${scout.id}`, { autonomy: 'ask', instructions: 'Prefer places with outdoor seating' })).body;
  assert.equal(patched.autonomy, 'ask');
  assert.equal((await s.call('GET', '/constellation')).body.stars.length, 2);
});

test('handing off from chat gives the work to the other Star, and the answer comes back', async () => {
  s = await startServer();
  const main = await mainStar();
  const scout = (await star({ name: 'Scout', role: 'Finds places' })).body;
  await s.call('POST', `/conversations/${main.conversationId}/messages`, { content: 'Have Scout find the best ramen in Lisbon' });
  const done = await s.waitFor('message.done', (e) => e.data.role === 'agent' && e.data.conversationId === main.conversationId);
  assert.match(done.data.content, /handed that to Scout/);
  assert.equal(done.data.starId, main.id);
  const childId = (done.data.cards![0] as { taskId: string }).taskId;
  await s.app.runtime.idle();

  const child = await task(childId);
  assert.equal(child.starId, scout.id);
  assert.deepEqual(child.requestedBy, { starId: main.id });
  assert.equal(child.status, 'done');
  assert.equal((await s.call<Task[]>('GET', `/tasks?starId=${scout.id}`)).body.length, 1);

  const msgs = await team();
  assert.deepEqual(msgs.map((m) => [m.kind, m.fromStarId, m.toStarId]), [['handoff', main.id, scout.id], ['reply', scout.id, main.id]]);
  assert.equal(msgs[1].read, false, 'waits in the main Star’s inbox');
  // The next chat reply hands the inbox over and marks it read.
  await s.call('POST', `/conversations/${main.conversationId}/messages`, { content: 'hi' });
  await s.app.runtime.chat.reply(main.conversationId);
  assert.equal((await team(main.id)).every((m) => m.read || m.toStarId !== main.id), true);
});

test('ask_star: the asking task waits on the other Star and carries on with its answer', async () => {
  s = await startServer();
  const main = await mainStar();
  const scout = (await star({ name: 'Scout', role: 'Finds places' })).body;
  const parent = (await s.call<Task>('POST', '/tasks', { title: 'Plan dinner', description: 'Plan Friday dinner. Ask Scout for the best ramen in Lisbon', kind: 'one_off' })).body;
  assert.equal(parent.starId, main.id);
  await s.app.runtime.idle();

  const after = await task(parent.id);
  assert.equal(after.status, 'done');
  assert.match(after.lastOutcome!, /Scout replied: Done: The best ramen in Lisbon/);
  assert.ok(s.events.some((e) => e.type === 'task.updated' && e.data.id === parent.id && e.data.status === 'blocked' && e.data.lastOutcome === 'Waiting on Scout'));
  assert.ok(after.steps.some((x) => x.summary.startsWith('Asked Scout: ')));
  assert.ok(after.steps.some((x) => x.kind === 'result' && x.summary.startsWith('Scout answered: ')));

  const child = (await s.call<Task[]>('GET', `/tasks?starId=${scout.id}`)).body[0];
  assert.deepEqual(child.requestedBy, { starId: main.id, taskId: parent.id, depth: 1 });
  assert.equal(child.status, 'done');
  const msgs = await team();
  assert.deepEqual(msgs.map((m) => m.kind), ['request', 'reply']);
  assert.equal(msgs[1].read, true, 'the answer went straight to the waiting task');
});

test('asking a Star that doesn’t exist is an error the task can recover from', async () => {
  s = await startServer();
  const t = (await s.call<Task>('POST', '/tasks', { title: 'Lonely', description: 'Ask Nobody for help', kind: 'one_off' })).body;
  await s.app.runtime.idle();
  const after = await task(t.id);
  assert.equal(after.status, 'done');
  assert.match(after.lastOutcome!, /no Star called “Nobody”/);
});

test('pausing one Star holds only its work; pausing everything holds all of it', async () => {
  s = await startServer();
  const scout = (await star({ name: 'Scout', role: 'Finds places' })).body;
  const paused = (await s.call<StarView>('POST', `/stars/${scout.id}/pause`, { paused: true })).body;
  assert.equal(paused.paused, true);
  assert.equal(paused.status.state, 'paused');
  const held = (await s.call<Task>('POST', '/tasks', { title: 'Find ramen', description: 'x', kind: 'one_off', starId: scout.id })).body;
  const free = (await s.call<Task>('POST', '/tasks', { title: 'Main work', description: 'x', kind: 'one_off' })).body;
  await s.app.runtime.idle();
  assert.equal((await task(held.id)).status, 'active');
  assert.equal((await task(free.id)).status, 'done');

  await s.call('POST', `/stars/${scout.id}/pause`, { paused: false });
  await s.app.runtime.idle();
  assert.equal((await task(held.id)).status, 'done');

  await s.call('POST', '/status', { paused: true });
  const stars = (await s.call<StarView[]>('GET', '/stars')).body;
  assert.ok(stars.every((x) => x.status.state === 'paused'));
  assert.equal(stars.find((x) => x.id === scout.id)!.paused, false, 'global pause doesn’t rewrite each Star');
});

test('each Star has its own autonomy, rules and apps, and its approvals land in its own chat', async () => {
  s = await startServer();
  const calls = fakeConnection(s, 'gmail', () => ({ body: { id: 'sent_1' } }));
  const mailer = (await star({ name: 'Mailer', role: 'Sends routine email', autonomy: 'autonomous', connectionIds: ['gmail'] })).body;
  const careful = (await star({ name: 'Careful', role: 'Asks first', autonomy: 'ask' })).body;
  const blind = (await star({ name: 'Blind', role: 'No apps', connectionIds: [] })).body;
  const brief = (who: string) => ({ title: 'Confirm', description: 'Email maya@studio.co to confirm Thursday', kind: 'one_off', starId: who });

  // Hands-off Star: sends without asking.
  const a = (await s.call<Task>('POST', '/tasks', brief(mailer.id))).body;
  await s.app.runtime.idle();
  assert.equal((await task(a.id)).status, 'done');
  assert.equal(calls.filter((c) => c.url.endsWith('/messages/send')).length, 1);

  // Ask-first Star: the approval belongs to it and its card goes to its chat.
  const b = (await s.call<Task>('POST', '/tasks', brief(careful.id))).body;
  await s.app.runtime.idle();
  assert.equal((await task(b.id)).status, 'waiting_approval');
  const [approval] = (await s.call<Approval[]>('GET', `/approvals?status=pending&starId=${careful.id}`)).body;
  assert.equal(approval.starId, careful.id);
  assert.deepEqual((await s.call<Approval[]>('GET', `/approvals?status=pending&starId=${mailer.id}`)).body, []);
  const card = (await s.call<Message[]>('GET', `/conversations/${careful.conversationId}/messages`)).body.find((m) => m.cards?.some((c) => c.kind === 'approval'));
  assert.ok(card?.proactive);
  assert.equal(card?.starId, careful.id);
  assert.equal((await s.call<StarView>('GET', `/stars/${careful.id}`)).body.status.state, 'waiting');

  // A Star without Gmail never gets the tool.
  const c = (await s.call<Task>('POST', '/tasks', brief(blind.id))).body;
  await s.app.runtime.idle();
  assert.equal((await task(c.id)).lastOutcome, 'Done: Confirm');
  assert.equal(calls.filter((x) => x.url.endsWith('/messages/send')).length, 1);

  // A rule for one Star doesn't bind the others.
  const rule = (await s.call<Rule>('POST', '/rules', { text: 'Never send email', starId: mailer.id })).body;
  assert.equal(rule.starId, mailer.id);
  assert.ok((await s.call<Rule[]>('GET', `/rules?starId=${mailer.id}`)).body.some((r) => r.id === rule.id));
  assert.ok(!(await s.call<Rule[]>('GET', `/rules?starId=${careful.id}`)).body.some((r) => r.id === rule.id));
  const d = (await s.call<Task>('POST', '/tasks', brief(mailer.id))).body;
  await s.app.runtime.idle();
  assert.ok((await task(d.id)).steps.some((x) => /Didn’t send email/.test(x.summary)));
  assert.equal(calls.filter((x) => x.url.endsWith('/messages/send')).length, 1);
});

test('memory is shared unless it belongs to one Star', async () => {
  s = await startServer();
  const main = await mainStar();
  const scout = (await star({ name: 'Scout', role: 'Finds places' })).body;
  const shared = (await s.call<MemoryItem>('POST', '/memory', { category: 'preference', content: 'Vegetarian' })).body;
  const own = (await s.call<MemoryItem>('POST', '/memory', { category: 'fact', content: 'Favourite site is example.com', starId: scout.id })).body;
  assert.equal(shared.starId, null);
  assert.equal(own.starId, scout.id);
  const forScout = (await s.call<MemoryItem[]>('GET', `/memory?starId=${scout.id}`)).body.map((m) => m.id);
  const forMain = (await s.call<MemoryItem[]>('GET', `/memory?starId=${main.id}`)).body.map((m) => m.id);
  assert.ok(forScout.includes(shared.id) && forScout.includes(own.id));
  assert.ok(forMain.includes(shared.id) && !forMain.includes(own.id));
  assert.equal((await s.call<MemoryItem[]>('GET', '/memory')).body.length, 2);
});

test('removing a Star stops its work, expires its approvals, and clears its own data', async () => {
  s = await startServer();
  fakeConnection(s, 'gmail', () => ({ body: { id: 'sent_1' } }));
  const temp = (await star({ name: 'Temp', role: 'Short-lived', autonomy: 'ask' })).body;
  const t = (await s.call<Task>('POST', '/tasks', { title: 'Confirm', description: 'Email maya@studio.co', kind: 'one_off', starId: temp.id })).body;
  const weekly = (await s.call<Task>('POST', '/tasks', { title: 'Weekly', description: 'x', kind: 'recurring', schedule: 'Fridays at 9:00', starId: temp.id })).body;
  await s.call('POST', '/memory', { category: 'fact', content: 'Temp only', starId: temp.id });
  await s.app.runtime.idle();
  assert.equal((await task(t.id)).status, 'waiting_approval');

  assert.equal((await s.call('DELETE', `/stars/${temp.id}`)).status, 204);
  await s.waitFor('star.deleted', (e) => e.data.id === temp.id);
  assert.equal((await s.call('GET', `/stars/${temp.id}`)).status, 404);
  assert.equal((await task(t.id)).status, 'done');
  assert.equal((await task(weekly.id)).status, 'done');
  assert.deepEqual((await s.call<Approval[]>('GET', '/approvals?status=pending')).body, []);
  assert.equal((await s.call('GET', `/conversations/${temp.conversationId}/messages`)).status, 404);
  assert.ok(!(await s.call<MemoryItem[]>('GET', '/memory')).body.some((m) => m.content === 'Temp only'));
});

test('stopping a task, or removing its Star, stops what it asked other Stars for', async () => {
  s = await startServer();
  const scout = (await star({ name: 'Scout', role: 'Finds places' })).body;
  const helper = (await star({ name: 'Helper', role: 'Plans things' })).body;
  await s.call('POST', `/stars/${scout.id}/pause`, { paused: true });
  const childOf = async (id: string) => (await s.call<Task[]>('GET', '/tasks')).body.find((x) => x.requestedBy?.taskId === id)!;

  const t = (await s.call<Task>('POST', '/tasks', { title: 'Plan dinner', description: 'Ask Scout for the best ramen in Lisbon', kind: 'one_off' })).body;
  await s.app.runtime.idle();
  const child = await childOf(t.id);
  assert.equal((await task(t.id)).status, 'blocked');
  await s.call('POST', `/tasks/${t.id}/cancel`);
  assert.equal((await task(child.id)).status, 'done');
  assert.match((await task(child.id)).lastOutcome!, /^No longer needed: you stopped/);

  const u = (await s.call<Task>('POST', '/tasks', { title: 'Plan lunch', description: 'Ask Scout for a lunch spot', kind: 'one_off', starId: helper.id })).body;
  await s.app.runtime.idle();
  const child2 = await childOf(u.id);
  await s.call('DELETE', `/stars/${helper.id}`);
  await s.call('POST', `/stars/${scout.id}/pause`, { paused: false });
  await s.app.runtime.idle();
  assert.match((await task(child2.id)).lastOutcome!, /Helper was removed/);
  assert.equal((await s.call<Task[]>('GET', `/tasks?starId=${scout.id}`)).body.filter((x) => x.lastOutcome?.startsWith('Done')).length, 0, 'Scout did no orphaned work');
});
