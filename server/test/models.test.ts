import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, test } from 'node:test';
import { classify } from '../src/models/registry.ts';
import type { Conversation, ModelProvider, StarView } from '../src/types.ts';
import { startServer, type TestServer } from './helpers.ts';

// Stand-ins for model providers: each records what it was sent and answers with `reply`.
interface Fake {
  url: string;
  requests: any[];
  reply: (body: any, res: ServerResponse) => void;
  close(): void;
}

async function fakeProvider(reply: Fake['reply']): Promise<Fake> {
  const f: Fake = { url: '', requests: [], reply, close: () => server.close() };
  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    f.requests.push({ path: req.url, headers: req.headers, body });
    f.reply(body, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  f.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return f;
}

/** An OpenAI-style streamed reply: text, or one tool call. */
function sse(res: ServerResponse, chunks: unknown[]) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end('data: [DONE]\n\n');
}
const textChunks = (text: string) => [
  ...text.split(/(?<= )/).map((t) => ({ choices: [{ index: 0, delta: { content: t } }] })),
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
];
const toolChunks = (id: string, name: string, args: unknown) => {
  const json = JSON.stringify(args);
  return [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: json.slice(0, 10) } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: json.slice(10) } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ];
};

/** Answers like a small model that saves a memory, then confirms. */
const rememberer = (body: any, res: ServerResponse) => {
  const last = body.messages[body.messages.length - 1];
  if (last.role === 'tool') return sse(res, textChunks('Saved, I’ll remember that.'));
  if (!body.tools) return sse(res, textChunks('hello'));
  return sse(res, toolChunks('call:abc/1', 'remember', { category: 'preference', content: 'Likes green tea' }));
};

let s: TestServer;
const fakes: Fake[] = [];
afterEach(async () => { await s?.close(); s = undefined as unknown as TestServer; });
after(() => { for (const f of fakes) f.close(); });

let limited: Fake;
let free: Fake;
let broken: Fake;
before(async () => {
  limited = await fakeProvider((_b, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '30' }).end(JSON.stringify({ error: { message: 'Rate limit reached for free tier' } }));
  });
  free = await fakeProvider(rememberer);
  broken = await fakeProvider((_b, res) => { res.writeHead(500).end('{"error":{"message":"upstream exploded"}}'); });
  fakes.push(limited, free, broken);
});

const add = (body: Record<string, unknown>) => s.call<ModelProvider>('POST', '/providers', body);
const mainChat = async () => (await s.call<Conversation[]>('GET', '/conversations')).body.find((c) => c.main)!;

test('providers: add any OpenAI- or Anthropic-compatible one; keys never come back', async () => {
  s = await startServer({ brain: 'models' });
  assert.equal((await s.call('GET', '/health')).body.brain, 'scripted', 'no providers yet: the offline stand-in');
  assert.ok((await s.call('GET', '/providers/presets')).body.some((p: any) => p.name === 'OpenRouter' && p.kind === 'openai'));

  assert.equal((await add({ name: 'X', kind: 'openai', baseUrl: 'ftp://nope', model: 'm' })).status, 400);
  assert.equal((await add({ name: 'X', kind: 'gemini', baseUrl: 'https://x.ai', model: 'm' })).status, 400);
  const p = (await add({ name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1/', model: 'meta-llama/llama-3.3-70b-instruct:free', apiKey: 'sk-or-secret-9876' })).body;
  assert.equal(p.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(p.hasKey, true);
  assert.equal(p.keyHint, '9876');
  assert.equal(p.health.state, 'unknown');
  assert.ok(!JSON.stringify((await s.call('GET', '/providers')).body).includes('secret'));
  const local = (await add({ name: 'Ollama', kind: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' })).body;
  assert.equal(local.hasKey, false);
  assert.equal((await s.call('GET', '/health')).body.brain, 'models');

  assert.deepEqual((await s.call('PUT', '/providers/order', { providerIds: [local.id] })).body.providerIds, [local.id, p.id]);
  assert.deepEqual((await s.call<ModelProvider[]>('GET', '/providers')).body.map((x) => x.id), [local.id, p.id]);
  assert.equal((await s.call('PUT', '/providers/order', { providerIds: ['p_nope'] })).status, 400);
  assert.equal((await s.call<ModelProvider>('PATCH', `/providers/${p.id}`, { apiKey: null })).body.hasKey, false);
  assert.equal((await s.call('DELETE', `/providers/${p.id}`)).status, 204);
  assert.deepEqual((await s.call('GET', '/providers/order')).body.providerIds, [local.id]);
});

test('the server’s ANTHROPIC_API_KEY shows up as a built-in provider that can’t be removed', async () => {
  s = await startServer({ brain: 'models', anthropicKey: true, model: 'claude-opus-5-5' });
  const [p] = (await s.call<ModelProvider[]>('GET', '/providers')).body;
  assert.equal(p.builtIn, true);
  assert.equal(p.model, 'claude-opus-5-5');
  assert.equal((await s.call('DELETE', `/providers/${p.id}`)).status, 403);
  assert.equal((await s.call('PATCH', `/providers/${p.id}`, { apiKey: 'x' })).status, 403);
  assert.equal((await s.call<ModelProvider>('PATCH', `/providers/${p.id}`, { enabled: false })).body.enabled, false);
});

test('fallback: a rate-limited provider is benched and the next one answers, tools and all', async () => {
  s = await startServer({ brain: 'models' });
  limited.requests = [];
  free.requests = [];
  const a = (await add({ name: 'Limited', kind: 'openai', baseUrl: limited.url, model: 'big', apiKey: 'k1' })).body;
  const b = (await add({ name: 'Free', kind: 'openai', baseUrl: free.url, model: 'small', apiKey: 'k2' })).body;

  const main = await mainChat();
  await s.call('POST', `/conversations/${main.id}/messages`, { content: 'I like green tea' });
  const done = await s.waitFor('message.done', (e) => e.data.role === 'agent', 5000);
  assert.equal(done.data.status, 'done');
  assert.equal(done.data.content, 'Saved, I’ll remember that.');
  assert.ok((await s.call('GET', '/memory')).body.some((m: any) => m.content === 'Likes green tea'));

  // The limited provider was tried once, then skipped while it cools down.
  assert.equal(limited.requests.length, 1);
  const benched = (await s.call<ModelProvider>('GET', `/providers/${a.id}`)).body;
  assert.equal(benched.health.state, 'cooling');
  const wait = Date.parse(benched.health.cooldownUntil!) - Date.now();
  assert.ok(wait > 20_000 && wait <= 30_000, `honours Retry-After (${wait}ms)`);
  assert.match(benched.health.lastError!, /Rate limit/);
  assert.equal((await s.call<ModelProvider>('GET', `/providers/${b.id}`)).body.health.state, 'ok');

  // What the OpenAI-compatible provider was sent: a proper Chat Completions request.
  const [first, second] = free.requests;
  assert.equal(first.path, '/chat/completions');
  assert.equal(first.headers.authorization, 'Bearer k2');
  assert.equal(first.body.model, 'small');
  assert.equal(first.body.stream, true);
  assert.equal(first.body.messages[0].role, 'system');
  assert.ok(first.body.tools.some((t: any) => t.type === 'function' && t.function.name === 'remember' && t.function.parameters.type === 'object'));
  const toolMsg = second.body.messages.find((m: any) => m.role === 'tool');
  const call = second.body.messages.find((m: any) => m.tool_calls)?.tool_calls[0];
  assert.equal(call.function.name, 'remember');
  assert.equal(toolMsg.tool_call_id, call.id, 'tool result matches the call');
  assert.match(call.id, /^[a-zA-Z0-9_-]+$/, 'ids are made safe for every provider');
});

test('each Star can have its own chain; with every provider down the reply says so', async () => {
  s = await startServer({ brain: 'models' });
  free.requests = [];
  broken.requests = [];
  const down = (await add({ name: 'Down', kind: 'openai', baseUrl: broken.url, model: 'x' })).body;
  const ok = (await add({ name: 'Free', kind: 'openai', baseUrl: free.url, model: 'small' })).body;
  await s.call('PUT', '/providers/order', { providerIds: [down.id, ok.id] });

  const scout = (await s.call<StarView>('POST', '/stars', { name: 'Scout', role: 'Finds things', providerIds: [ok.id] })).body;
  assert.deepEqual(scout.providerIds, [ok.id]);
  assert.equal((await s.call('PATCH', `/stars/${scout.id}`, { providerIds: ['p_nope'] })).status, 400);
  await s.call('POST', `/conversations/${scout.conversationId}/messages`, { content: 'I like green tea' });
  await s.waitFor('message.done', (e) => e.data.role === 'agent' && e.data.conversationId === scout.conversationId, 5000);
  assert.equal(broken.requests.length, 0, 'Scout only uses its own chain');
  assert.ok(free.requests.length > 0);

  const lonely = (await s.call<StarView>('POST', '/stars', { name: 'Lonely', role: 'x', providerIds: [down.id] })).body;
  await s.call('POST', `/conversations/${lonely.conversationId}/messages`, { content: 'hi' });
  const failed = await s.waitFor('message.done', (e) => e.data.role === 'agent' && e.data.conversationId === lonely.conversationId, 5000);
  assert.equal(failed.data.status, 'error');
  assert.match(failed.data.content, /No model could answer\. Down: 500 upstream exploded/);
  assert.equal((await s.call<ModelProvider>('GET', `/providers/${down.id}`)).body.health.state, 'cooling');
});

test('an Anthropic-compatible server gets a plain Messages request', async () => {
  const anth = await fakeProvider((body, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const events = [
      { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi from a compatible server' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ];
    for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.end();
  });
  fakes.push(anth);
  s = await startServer({ brain: 'models' });
  const p = (await add({ name: 'Compat', kind: 'anthropic', baseUrl: anth.url, model: 'kimi-k2', apiKey: 'ak-1' })).body;

  const test = await s.call('POST', `/providers/${p.id}/test`);
  assert.equal(test.body.ok, true);
  assert.equal(test.body.reply, 'Hi from a compatible server');

  const main = await mainChat();
  await s.call('POST', `/conversations/${main.id}/messages`, { content: 'hi' });
  const done = await s.waitFor('message.done', (e) => e.data.role === 'agent', 5000);
  assert.equal(done.data.content, 'Hi from a compatible server');
  const req = anth.requests[anth.requests.length - 1];
  assert.equal(req.path, '/v1/messages');
  assert.equal(req.headers['x-api-key'], 'ak-1');
  assert.equal(req.body.model, 'kimi-k2');
  assert.equal(req.body.thinking, undefined);
  assert.equal(req.body.output_config, undefined);
  assert.equal(typeof req.body.system, 'string');
  assert.ok(!req.body.tools.some((t: any) => t.type?.startsWith('web_') || t.eager_input_streaming));
});

test('errors decide how long a provider sits out', () => {
  const e = (status: number | null, message: string, retryAfter?: number) => Object.assign(new Error(message), { status, retryAfter });
  assert.deepEqual(classify(e(401, 'invalid x-api-key'), 0), { message: 'invalid x-api-key', cooldownMs: 6 * 3_600_000, permanent: true });
  assert.equal(classify(e(402, 'Insufficient credits'), 0).cooldownMs, 3_600_000);
  assert.equal(classify(e(429, 'You exceeded your current quota'), 0).cooldownMs, 3_600_000);
  assert.equal(classify(e(429, 'slow down', 12), 0).cooldownMs, 12_000);
  assert.equal(classify(e(429, 'slow down'), 2).cooldownMs, 240_000);
  assert.equal(classify(e(404, 'The model `gpt-9` does not exist'), 0).permanent, true);
  assert.equal(classify(e(400, 'tools are not supported'), 0).cooldownMs, 0, 'request-specific: try the next one, no bench');
  assert.equal(classify(e(null, 'ECONNREFUSED'), 0).cooldownMs, 30_000);
});
