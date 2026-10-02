import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { afterEach, test } from 'node:test';
import webpush from 'web-push';
import { executeTool } from '../src/agent/execute.ts';
import { systemPrompt } from '../src/agent/prompt.ts';
import { findTool } from '../src/agent/tools/index.ts';
import type { ToolContext } from '../src/agent/tools/types.ts';
import type { Approval, Lesson, MemoryItem, Message, Secret, Skill, StarView, Task } from '../src/types.ts';
import { decodeRaw, fakeConnection, startServer, type TestServer } from './helpers.ts';

let s: TestServer;
afterEach(async () => { await s?.close(); });

const gmailOk = () => ({ body: { id: 'sent_1' } });
const mainStar = async () => (await s.call<StarView[]>('GET', '/stars')).body.find((x) => x.main)!;
const pending = async () => (await s.call<Approval[]>('GET', '/approvals?status=pending')).body;
const task = async (id: string) => (await s.call<Task & { steps: { kind: string; summary: string; detail?: string }[] }>('GET', `/tasks/${id}`)).body;
const say = async (conversationId: string, content: string) => {
  await s.call('POST', `/conversations/${conversationId}/messages`, { content });
  await s.app.runtime.chat.reply(conversationId);
  await s.app.runtime.idle();
};

/** Runs one tool the way a Star would, outside the model loop. */
const run = (name: string, input: unknown, extra: Partial<ToolContext> = {}) => {
  const { store, config, providers, runtime } = s.app;
  const ctx: ToolContext = { store, config, providers, runtime, star: store.mainStar(), source: 'Test', touchedTasks: new Set(), ...extra };
  return executeTool(runtime.deps, findTool(name)!, input, ctx, 'toolu_test');
};

// ---- #14 personality ---------------------------------------------------------

test('each Star has a personality, reply style and notify switches, and can change its own style', async () => {
  s = await startServer();
  const main = await mainStar();
  assert.equal(main.personality, '');
  assert.deepEqual(main.notify, { whenDone: false, whenNeedsYou: true });

  const scout = (await s.call<StarView>('POST', '/stars', { name: 'Scout', role: 'Finds places', personality: 'Upbeat and curious', notify: { whenDone: true } })).body;
  assert.equal(scout.personality, 'Upbeat and curious');
  assert.deepEqual(scout.notify, { whenDone: true, whenNeedsYou: true });
  assert.equal((await s.call('PATCH', `/stars/${scout.id}`, { personality: 'x'.repeat(1001) })).status, 400);
  assert.equal((await s.call('PATCH', `/stars/${scout.id}`, { notify: { whenDone: 'yes' } })).status, 400);
  const patched = (await s.call<StarView>('PATCH', `/stars/${scout.id}`, { replyStyle: 'Bullet points, no more than five', notify: { whenNeedsYou: false } })).body;
  assert.equal(patched.replyStyle, 'Bullet points, no more than five');
  assert.deepEqual(patched.notify, { whenDone: true, whenNeedsYou: false }, 'a partial notify keeps the other switch');

  const prompt = systemPrompt(s.app.store, s.app.providers, 'chat', s.app.store.getStar(scout.id));
  assert.match(prompt, /Upbeat and curious/);
  assert.match(prompt, /Bullet points, no more than five/);

  const res = await run('set_personality', { personality: 'Dry and witty' }, { star: s.app.store.getStar(scout.id), conversationId: scout.conversationId });
  assert.ok(!res.is_error, String(res.content));
  const after = s.app.store.getStar(scout.id);
  assert.equal(after.personality, 'Dry and witty');
  assert.equal(after.replyStyle, 'Bullet points, no more than five', 'what it wasn’t asked to change stays');
});

// ---- #15 live status ---------------------------------------------------------

test('every Star sends a live status phrase while it chats and works', async () => {
  s = await startServer();
  const main = await mainStar();
  await say(main.conversationId, 'hi');
  const phrases = s.events.filter((e) => e.type === 'star.activity' && e.data.starId === main.id).map((e) => (e as any).data.activity);
  assert.deepEqual(phrases.slice(0, 3), ['Thinking', 'Writing', null]);
  assert.equal((await mainStar()).status.state, 'idle');

  await s.call('POST', '/tasks', { title: 'Plan the week', description: 'Plan my week', kind: 'one_off' });
  await s.app.runtime.idle();
  const working = s.events.find((e) => e.type === 'star.activity' && e.data.taskId && e.data.activity === 'Working') as any;
  assert.ok(working, 'task steps send phrases with the task id');
  assert.equal(working.data.starId, main.id);
});

// ---- #2 skills ---------------------------------------------------------------

test('skills: saved recipes the person and the Stars can add, use and improve', async () => {
  s = await startServer();
  const all = (await s.call<Skill[]>('GET', '/skills')).body;
  const forget = all.find((k) => k.source === 'builtIn')!;
  assert.equal(forget.name, 'Forget something');
  assert.equal((await s.call('PATCH', `/skills/${forget.id}`, { steps: 'nope' })).status, 403);
  assert.equal((await s.call('DELETE', `/skills/${forget.id}`)).status, 403);

  assert.equal((await s.call('POST', '/skills', { name: 'Weekly report' })).status, 400);
  const report = (await s.call<Skill>('POST', '/skills', { name: 'Weekly report', whenToUse: 'Every Friday summary', steps: '1. Gather\n2. Summarize' })).body;
  assert.equal(report.source, 'you');
  assert.equal(report.uses, 0);
  assert.equal((await s.call('POST', '/skills', { name: 'weekly report', whenToUse: 'x', steps: 'y' })).status, 409);
  assert.match(systemPrompt(s.app.store, s.app.providers, 'task'), /Weekly report: Every Friday summary/);

  const scout = (await s.call<StarView>('POST', '/stars', { name: 'Scout', role: 'Finds places' })).body;
  const own = (await s.call<Skill>('POST', '/skills', { name: 'Ramen hunt', whenToUse: 'Finding ramen', steps: '1. Search', starId: scout.id })).body;
  assert.ok(!(await s.call<Skill[]>('GET', `/skills?starId=${(await mainStar()).id}`)).body.some((k) => k.id === own.id), 'a Star’s own skill is only its own');
  assert.ok((await s.call<Skill[]>('GET', `/skills?starId=${scout.id}`)).body.some((k) => k.id === own.id));

  const used = await run('use_skill', { name: 'weekly report' });
  assert.match(String(used.content), /1\. Gather/);
  assert.equal((await s.call<Skill>('GET', `/skills/${report.id}`)).body.uses, 1);
  assert.ok((await run('use_skill', { name: 'Ramen hunt' })).is_error, 'the main Star can’t use Scout’s own skill');

  await run('save_skill', { name: 'Trip budget', when_to_use: 'Planning a trip', steps: '1. Ask the dates' });
  const saved = (await s.call<Skill[]>('GET', '/skills')).body.find((k) => k.name === 'Trip budget')!;
  assert.equal(saved.source, 'star');
  assert.equal(saved.starId, null);
  await run('update_skill', { name: 'Trip budget', steps: '1. Ask the dates\n2. Check flights' });
  assert.match((await s.call<Skill>('GET', `/skills/${saved.id}`)).body.steps, /Check flights/);
  assert.ok((await run('update_skill', { name: 'Forget something', steps: 'x' })).is_error);

  const edited = (await s.call<Skill>('PATCH', `/skills/${report.id}`, { steps: '1. Gather\n2. Summarize\n3. Send' })).body;
  assert.match(edited.steps, /3\. Send/);
  assert.equal((await s.call('DELETE', `/skills/${report.id}`)).status, 204);
  assert.ok(s.events.some((e) => e.type === 'skill.deleted' && e.data.id === report.id));
});

test('the built-in forget skill and forget_memories only delete what was asked', async () => {
  s = await startServer();
  const keep = (await s.call<MemoryItem>('POST', '/memory', { category: 'fact', content: 'Lives in Lisbon' })).body;
  const drop = (await s.call<MemoryItem>('POST', '/memory', { category: 'fact', content: 'Ex is called Sam' })).body;
  const recalled = await run('recall', { query: 'Sam' });
  assert.match(String(recalled.content), new RegExp(drop.id), 'recall shows ids so a Star can forget');
  const res = await run('forget_memories', { ids: [drop.id, 'mem_nope'] });
  assert.match(String(res.content), /Forgot 1\. 1 id was not found/);
  const left = (await s.call<MemoryItem[]>('GET', '/memory')).body.map((m) => m.id);
  assert.ok(left.includes(keep.id));
  assert.ok(!left.includes(drop.id));
});

// ---- #13 learning from corrections --------------------------------------------

test('a declined action with a note becomes a lesson the person can undo', async () => {
  s = await startServer();
  fakeConnection(s, 'gmail', gmailOk);
  await s.call('POST', '/tasks', { title: 'Ping Sam', description: 'Email sam@example.com about lunch', kind: 'one_off' });
  await s.app.runtime.idle();
  const [a] = await pending();
  await s.call('POST', `/approvals/${a.id}/decision`, { decision: 'reject', note: 'never email Sam before 10am' });
  await s.app.runtime.idle();

  const [lesson] = (await s.call<Lesson[]>('GET', '/lessons')).body;
  assert.equal(lesson.lesson, 'Never email Sam before 10am');
  assert.equal(lesson.trigger, 'declined');
  const memory = (await s.call<MemoryItem[]>('GET', '/memory')).body.find((m) => m.id === lesson.memoryId)!;
  assert.equal(memory.content, 'Never email Sam before 10am');
  assert.equal(memory.source, 'Learned from your correction (declined)');
  const main = await mainStar();
  const note = (await s.call<Message[]>('GET', `/conversations/${main.conversationId}/messages`)).body.find((m) => m.lessonId === lesson.id)!;
  assert.match(note.content, /^Got it\. I’ll remember: Never email Sam before 10am/);

  const undone = (await s.call<Lesson>('POST', `/lessons/${lesson.id}/undo`)).body;
  assert.equal(undone.undone, true);
  assert.ok(!(await s.call<MemoryItem[]>('GET', '/memory')).body.some((m) => m.id === lesson.memoryId));
  assert.ok(s.events.some((e) => e.type === 'lesson.undone'));
});

test('a lesson about a skill is added to that skill, and undo takes only that line out', async () => {
  s = await startServer();
  fakeConnection(s, 'gmail', gmailOk);
  const skill = (await s.call<Skill>('POST', '/skills', { name: 'Lunch invites', whenToUse: 'Inviting people to lunch', steps: '1. Pick a place' })).body;
  await s.call('POST', '/tasks', { title: 'Ping Sam', description: 'Email sam@example.com about lunch', kind: 'one_off' });
  await s.app.runtime.idle();
  const [a] = await pending();
  await s.call('POST', `/approvals/${a.id}/decision`, { decision: 'approve', editedPreview: 'Subject: Lunch?\n\nNoon at Rosa?', note: 'Lunch invites should name the place' });
  await s.app.runtime.idle();

  const [lesson] = (await s.call<Lesson[]>('GET', '/lessons')).body;
  assert.equal(lesson.trigger, 'edited');
  assert.equal(lesson.skillId, skill.id);
  assert.equal(lesson.memoryId, undefined);
  assert.match((await s.call<Skill>('GET', `/skills/${skill.id}`)).body.steps, /- Lesson: Lunch invites should name the place/);
  await s.call('PATCH', `/skills/${skill.id}`, { steps: `${(await s.call<Skill>('GET', `/skills/${skill.id}`)).body.steps}\n2. Send it` });
  await s.call('POST', `/lessons/${lesson.id}/undo`);
  assert.equal((await s.call<Skill>('GET', `/skills/${skill.id}`)).body.steps, '1. Pick a place\n2. Send it');
});

test('“no, …” in chat teaches the Star; with learning off a note is kept as it was written', async () => {
  s = await startServer();
  const main = await mainStar();
  await say(main.conversationId, 'hi');
  await say(main.conversationId, 'No, keep replies under three lines');
  const [lesson] = (await s.call<Lesson[]>('GET', '/lessons')).body;
  assert.equal(lesson.trigger, 'chat');
  assert.equal(lesson.lesson, 'Keep replies under three lines');

  await s.call('PATCH', '/settings', { learnFromCorrections: false });
  await say(main.conversationId, 'No, actually never mind');
  assert.equal((await s.call<Lesson[]>('GET', '/lessons')).body.length, 1, 'nothing learned while it’s off');

  fakeConnection(s, 'gmail', gmailOk);
  await s.call('POST', '/tasks', { title: 'Ping Sam', description: 'Email sam@example.com about lunch', kind: 'one_off' });
  await s.app.runtime.idle();
  const [a] = await pending();
  await s.call('POST', `/approvals/${a.id}/decision`, { decision: 'reject', note: 'Sam is on holiday' });
  await s.app.runtime.idle();
  assert.ok((await s.call<MemoryItem[]>('GET', '/memory')).body.some((m) => m.content === 'Sam is on holiday' && /^Your note on/.test(m.source)));
});

test('settings for learning and the small model chain are checked', async () => {
  s = await startServer();
  assert.equal((await s.call('PATCH', '/settings', { learnFromCorrections: 'yes' })).status, 400);
  assert.equal((await s.call('PATCH', '/settings', { smallProviderIds: ['p_nope'] })).status, 400);
  assert.equal((await s.call('PATCH', '/settings', { smallProviderIds: null, learnFromCorrections: true })).status, 200);
});

// ---- #9 secrets vault ----------------------------------------------------------

test('secrets: stored encrypted, names only through the API, never shown to the model', async () => {
  s = await startServer();
  assert.equal((await s.call('POST', '/secrets', { name: 'bad name', value: 'x' })).status, 400);
  assert.equal((await s.call('POST', '/secrets', { name: 'DOOR_CODE' })).status, 400, 'a value is required');
  const created = await s.call<Secret>('POST', '/secrets', { name: 'DOOR_CODE', value: 'hunter2-4471', description: 'Front door' });
  assert.equal(created.status, 200);
  assert.equal((await s.call('POST', '/secrets', { name: 'door_code', value: 'y' })).status, 409);

  const listed = await s.call('GET', '/secrets');
  assert.equal(listed.body.keySource, 'memory');
  assert.deepEqual(listed.body.secrets.map((x: Secret) => x.name), ['DOOR_CODE']);
  for (const body of [JSON.stringify(created.body), JSON.stringify(listed.body)]) assert.ok(!body.includes('hunter2'), 'the value never comes back');
  assert.ok(!JSON.stringify(s.app.store.db.getPrivate('secret', created.body.id)).includes('hunter2'), 'stored encrypted');

  const prompt = systemPrompt(s.app.store, s.app.providers, 'task');
  assert.match(prompt, /DOOR_CODE \(Front door\)/);
  assert.ok(!prompt.includes('hunter2'));
  assert.equal(s.app.vault.redact('the code is hunter2-4471.'), 'the code is [secret:DOOR_CODE].');

  // Chat and the Stars' own notes never get a secret.
  const remembered = await run('remember', { category: 'fact', content: 'Door code is {{secret:DOOR_CODE}}' });
  assert.ok(remembered.is_error);
  assert.ok(!(await s.call<MemoryItem[]>('GET', '/memory')).body.some((m) => m.content.includes('hunter2')));

  // Changing the value keeps the name; limiting it to one Star keeps others out.
  const scout = (await s.call<StarView>('POST', '/stars', { name: 'Scout', role: 'Finds places' })).body;
  await s.call('PATCH', '/secrets/DOOR_CODE', { value: 'swordfish-99', starIds: [scout.id] });
  assert.throws(() => s.app.vault.fill({ x: '{{secret:DOOR_CODE}}' }, s.app.store.mainStar().id), /aren’t allowed/);
  assert.deepEqual(s.app.vault.fill({ x: 'code {{secret:DOOR_CODE}}' }, scout.id), { x: 'code swordfish-99' });
  assert.ok(!systemPrompt(s.app.store, s.app.providers, 'task').includes('DOOR_CODE'), 'other Stars don’t see its name');
  assert.equal((await s.call('DELETE', '/secrets/DOOR_CODE')).status, 204);
  assert.equal((await s.call('GET', '/secrets')).body.secrets.length, 0);
});

test('a task that uses a secret always asks first, sends the real value, and logs only the name', async () => {
  s = await startServer();
  await s.call('PATCH', '/settings', { autonomy: 'autonomous' });
  const calls = fakeConnection(s, 'gmail', gmailOk);
  await s.call('POST', '/secrets', { name: 'DOOR_CODE', value: 'hunter2-4471' });
  const t = (await s.call<Task>('POST', '/tasks', { title: 'Door code for Kim', description: 'Email kim@example.com the door code {{secret:DOOR_CODE}}', kind: 'one_off' })).body;
  await s.app.runtime.idle();

  const [a] = await pending();
  assert.ok(a, 'asks even when fully autonomous');
  assert.match(a.reason, /uses your secret DOOR_CODE/);
  assert.equal(a.risk, 'high');
  assert.match(a.preview, /\{\{secret:DOOR_CODE\}\}/);
  assert.ok(!a.preview.includes('hunter2'));
  assert.equal(calls.filter((c) => c.url.endsWith('/messages/send')).length, 0);

  await s.call('POST', `/approvals/${a.id}/decision`, { decision: 'approve' });
  await s.app.runtime.idle();
  const [sent] = calls.filter((c) => c.url.endsWith('/messages/send'));
  assert.match(decodeRaw(sent.body.raw), /the door code hunter2-4471/);
  const done = await task(t.id);
  assert.equal(done.status, 'done');
  assert.ok(!JSON.stringify(done).includes('hunter2'));
  assert.ok(!JSON.stringify((await s.call('GET', '/activity')).body).includes('hunter2'));
});

// ---- #8 push notifications ------------------------------------------------------

/** A browser-like subscription with real keys, as pushManager.subscribe() returns. */
const subscription = (endpoint = 'https://push.example.com/send/abc') => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
};

test('push: VAPID key, subscriptions, and a real encrypted request for each device', async () => {
  s = await startServer();
  const { publicKey } = (await s.call('GET', '/push/key')).body;
  assert.match(publicKey, /^[A-Za-z0-9_-]{87}$/);
  assert.equal((await s.call('GET', '/push/key')).body.publicKey, publicKey, 'the key is kept');

  assert.equal((await s.call('POST', '/push/subscriptions', { subscription: { endpoint: 'nope' } })).status, 400);
  const sub = subscription();
  const first = (await s.call('POST', '/push/subscriptions', { subscription: sub, label: 'Phone' })).body;
  const again = (await s.call('POST', '/push/subscriptions', { subscription: sub, label: 'Phone' })).body;
  assert.notEqual(first.id, again.id);
  const list = (await s.call('GET', '/push/subscriptions')).body;
  assert.deepEqual(list.map((x: any) => x.label), ['Phone'], 'the same device replaces its old entry');
  assert.ok(!JSON.stringify(list).includes(sub.keys.auth), 'device keys stay on the server');

  // The request web-push would send: VAPID-signed and encrypted for this device.
  const vapid = s.app.store.db.getKv<{ publicKey: string; privateKey: string }>('vapid')!;
  const details = webpush.generateRequestDetails(sub, JSON.stringify({ title: 'Hi' }), { vapidDetails: { subject: 'mailto:sky@localhost', ...vapid } });
  assert.equal(details.endpoint, sub.endpoint);
  assert.equal(details.headers['Content-Encoding'], 'aes128gcm');
  assert.match(String(details.headers.Authorization), /^vapid t=.+, k=/);

  assert.equal((await s.call('POST', '/push/test')).status, 400, 'push is off in settings');
  const sent: { endpoint: string; payload: any; urgency?: string }[] = [];
  s.app.push.sendWebPush = (async (to: { endpoint: string }, payload: string, opts: { urgency?: string }) => {
    sent.push({ endpoint: to.endpoint, payload: JSON.parse(payload), urgency: opts.urgency });
    return { statusCode: 201, body: '', headers: {} };
  }) as never;
  const settings = (await s.call('GET', '/settings')).body;
  await s.call('PATCH', '/settings', { channels: { ...settings.channels, push: true } });
  const test1 = (await s.call('POST', '/push/test')).body;
  assert.deepEqual(test1, { delivered: ['Phone'], failed: [] });
  assert.equal(sent[0].payload.title, 'Sky');

  // A device the browser dropped (410) is forgotten.
  s.app.push.sendWebPush = (async () => { throw Object.assign(new Error('Gone'), { statusCode: 410 }); }) as never;
  assert.deepEqual((await s.call('POST', '/push/test')).body, { delivered: [], failed: ['Phone: 410'] });
  assert.equal((await s.call('GET', '/push/subscriptions')).body.length, 0);
  assert.equal((await s.call('DELETE', `/push/subscriptions/${again.id}`)).status, 404);
});

test('push goes out when a Star needs you or finishes, following each Star’s switches', async () => {
  s = await startServer();
  fakeConnection(s, 'gmail', gmailOk);
  const sent: any[] = [];
  s.app.push.sendWebPush = (async (_to: unknown, payload: string) => {
    sent.push(JSON.parse(payload));
    return { statusCode: 201, body: '', headers: {} };
  }) as never;
  const settings = (await s.call('GET', '/settings')).body;
  await s.call('PATCH', '/settings', { channels: { ...settings.channels, push: true } });
  await s.call('POST', '/push/subscriptions', { subscription: subscription(), label: 'Laptop' });

  const t = (await s.call<Task>('POST', '/tasks', { title: 'Ping Sam', description: 'Email sam@example.com about lunch', kind: 'one_off' })).body;
  await s.app.runtime.idle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'Sky needs you');
  assert.match(sent[0].body, /^Can I send email to sam@example\.com\?/);
  assert.equal(sent[0].url, `#/tasks/${t.id}`);

  // Finishing pushes only for Stars set to tell you.
  const [a] = await pending();
  await s.call('POST', `/approvals/${a.id}/decision`, { decision: 'approve' });
  await s.app.runtime.idle();
  assert.equal(sent.length, 1);

  const main = await mainStar();
  await s.call('PATCH', `/stars/${main.id}`, { notify: { whenDone: true, whenNeedsYou: false } });
  const t2 = (await s.call<Task>('POST', '/tasks', { title: 'Ping Lee', description: 'Email lee@example.com about lunch', kind: 'one_off' })).body;
  await s.app.runtime.idle();
  assert.equal(sent.length, 1, 'whenNeedsYou off: no push for the question');
  const [a2] = await pending();
  await s.call('POST', `/approvals/${a2.id}/decision`, { decision: 'approve' });
  await s.app.runtime.idle();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].title, 'Sky finished');
  assert.match(sent[1].body, /^Ping Lee: /);
  assert.equal(sent[1].url, `#/tasks/${t2.id}`);
});

test('ntfy: a topic gets the same notifications through a plain POST', async () => {
  s = await startServer();
  assert.equal((await s.call('PATCH', '/settings', { ntfyTopic: 'has spaces' })).status, 400);
  assert.equal((await s.call('PATCH', '/settings', { ntfyServer: 'ftp://x' })).status, 400);
  await s.call('PATCH', '/settings', { ntfyTopic: 'sky-d-8f3k2', ntfyServer: 'https://ntfy.example.org/' });
  const posts: { url: string; headers: Record<string, string>; body: string }[] = [];
  s.app.providers.fetch = async (input, init = {}) => {
    posts.push({ url: String(input), headers: init.headers as Record<string, string>, body: String(init.body) });
    return new Response('{}', { status: 200 });
  };
  assert.deepEqual((await s.call('POST', '/push/test')).body, { delivered: ['ntfy'], failed: [] });
  assert.equal(posts[0].url, 'https://ntfy.example.org/sky-d-8f3k2');
  assert.equal(posts[0].headers.Title, 'Sky');
  assert.equal(posts[0].body, 'Notifications from Sky are working.');

  s.app.providers.fetch = async () => new Response('nope', { status: 429 });
  assert.deepEqual((await s.call('POST', '/push/test')).body, { delivered: [], failed: ['ntfy: ntfy 429'] });
});

