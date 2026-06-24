import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSensitive, MAX_TURNS, READY_TOKEN, INTERVIEWER_SYSTEM } from '../../functions/api/_lib/prompts.js';

test('detectSensitive flags code/secrets/urls, passes plain text', () => {
  assert.equal(detectSensitive('JPA N+1이 헷갈립니다'), false);
  assert.equal(detectSensitive('https://github.com/a/b'), true);
  assert.equal(detectSensitive('token: abc'), true);
});

test('interview prompt config is sane', () => {
  assert.equal(MAX_TURNS, 5);
  assert.equal(READY_TOKEN, '[READY]');
  assert.ok(INTERVIEWER_SYSTEM.includes(READY_TOKEN));
});
