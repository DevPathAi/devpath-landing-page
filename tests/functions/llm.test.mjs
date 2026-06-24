import test from 'node:test';
import assert from 'node:assert/strict';
import { toClaudeMessages, callClaude, MODEL_TURN, streamClaude, MODEL_ANSWER } from '../../functions/api/_lib/llm.js';

test('toClaudeMessages maps roles and coerces unknown to assistant', () => {
  assert.deepEqual(
    toClaudeMessages([{ role: 'user', text: 'hi' }, { role: 'bot', text: 'q' }]),
    [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'q' }],
  );
});

test('callClaude posts to messages API and extracts text', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: '다음 질문' }], usage: { input_tokens: 10, output_tokens: 3 } }) };
  };
  const out = await callClaude({ apiKey: 'k', model: MODEL_TURN, system: 's', messages: [{ role: 'user', content: 'x' }], fetchImpl });
  assert.equal(out.text, '다음 질문');
  assert.equal(out.usage.output_tokens, 3);
  assert.equal(captured.url, 'https://api.anthropic.com/v1/messages');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'claude-haiku-4-5');
  assert.equal(captured.init.headers['x-api-key'], 'k');
});

test('callClaude throws on non-ok', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, json: async () => ({}) });
  await assert.rejects(() => callClaude({ apiKey: 'k', model: MODEL_TURN, system: 's', messages: [], fetchImpl }), /429/);
});

test('streamClaude sends stream:true with the answer model', async () => {
  let captured;
  const fetchImpl = async (url, init) => { captured = JSON.parse(init.body); return { ok: true, body: null }; };
  await streamClaude({ apiKey: 'k', model: MODEL_ANSWER, system: 's', messages: [{ role: 'user', content: 'x' }], fetchImpl });
  assert.equal(captured.stream, true);
  assert.equal(captured.model, 'claude-sonnet-4-6');
});
