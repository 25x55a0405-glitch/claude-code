import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

// Points the Anthropic SDK at a local stand-in for the Messages API, so the
// exact request Skys sends can be checked without an API key.
let requests: { headers: Record<string, string | string[] | undefined>; body: any }[] = [];
let reply: (body: any) => unknown[] = () => [];
const fake = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push({ headers: req.headers, body });
  if (!body.stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: 'none' }], usage: { input_tokens: 1, output_tokens: 1 },
    }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of reply(body)) res.write(`event: ${(event as any).type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
});

function textStream(text: string, stop = 'end_turn') {
  return [
    { type: 'message_start', message: { id: 'msg_s', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...text.split(/(?<= )/).map((t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
}

before(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.env.ANTHROPIC_API_KEY = 'sk-test';
});
after(() => fake.close());

test('Claude requests use the current API shape and stream replies into chat', async () => {
  const { startServer } = await import('./helpers.ts');
  const s = await startServer({ brain: 'claude', model: 'claude-opus-5-5', effort: 'medium', fallbacks: true });
  try {
    requests = [];
    reply = () => textStream('Hello there, happy to help.');
    const main = (await s.call('GET', '/conversations')).body.find((c: any) => c.main);
    await s.call('POST', `/conversations/${main.id}/messages`, { content: 'hi' });
    const done = await s.waitFor('message.done', (e) => e.data.role === 'agent', 5000);
    assert.equal(done.data.content, 'Hello there, happy to help.');
    assert.ok(s.events.filter((e) => e.type === 'message.delta').length > 1, 'streamed in pieces');

    const { headers, body } = requests.find((r) => r.body.stream)!;
    assert.equal(body.model, 'claude-opus-5-5');
    assert.deepEqual(body.thinking, { type: 'adaptive' });
    assert.deepEqual(body.output_config, { effort: 'medium' });
    assert.equal(body.fallbacks, 'default');
    assert.match(String(headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
    assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
    assert.ok(body.tools.some((t: any) => t.type === 'web_search_20260209'));
    assert.ok(body.tools.filter((t: any) => t.input_schema).every((t: any) => t.eager_input_streaming === true));
    assert.ok(body.tools.some((t: any) => t.name === 'create_task'));
    // Volatile context rides on the user turn, not the cached system prompt.
    assert.match(body.messages[0].content, /^\[Context\] Now: /);
    assert.doesNotMatch(body.system[0].text, /Now: /);
  } finally {
    await s.close();
  }
});
