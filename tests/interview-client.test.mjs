import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE, createInterviewClient } from '../src/interview-client.js';

test('parseSSE extracts complete events and keeps remainder', () => {
  const { events, rest } = parseSSE('data: {"type":"distilled","question":"q"}\n\ndata: {"type":"gen');
  assert.deepEqual(events, [{ type: 'distilled', question: 'q' }]);
  assert.equal(rest, 'data: {"type":"gen');
});

test('sendTurn posts history and returns question/done', async () => {
  const fetchImpl = async (url, init) => {
    assert.equal(url, '/api/interview/turn');
    const body = JSON.parse(init.body);
    assert.equal(body.history[0].text, 'hi');
    return { ok: true, json: async () => ({ question: '무엇이 막혔나요?', done: false }) };
  };
  const client = createInterviewClient({ fetchImpl });
  const out = await client.sendTurn({ history: [{ role: 'user', text: 'hi' }], turnstileToken: 't' });
  assert.equal(out.question, '무엇이 막혔나요?');
  assert.equal(out.done, false);
});
