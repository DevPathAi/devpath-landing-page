import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyTurnstile, enforceInputCaps, checkRateLimit, overBudget, addBudget } from '../../functions/api/_lib/guardrails.js';

function memKV() {
  const m = new Map();
  return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); }, _m: m };
}

test('verifyTurnstile returns success from siteverify', async () => {
  const fetchImpl = async () => ({ json: async () => ({ success: true }) });
  assert.equal(await verifyTurnstile('tok', '1.2.3.4', 'secret', fetchImpl), true);
  assert.equal(await verifyTurnstile('', '1.2.3.4', 'secret', fetchImpl), false);
});

test('enforceInputCaps rejects too many turns and long messages', () => {
  const ok = [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'q' }];
  assert.equal(enforceInputCaps(ok, { maxTurns: 5, maxMsgChars: 600 }), null);
  const long = [{ role: 'user', text: 'x'.repeat(601) }];
  assert.match(enforceInputCaps(long, { maxTurns: 5, maxMsgChars: 600 }), /long/);
  const many = Array.from({ length: 6 }, () => ({ role: 'user', text: 'a' }));
  assert.match(enforceInputCaps(many, { maxTurns: 5, maxMsgChars: 600 }), /turns/);
});

test('checkRateLimit increments and blocks over cap', async () => {
  const kv = memKV();
  const now = 1_750_000_000_000;
  for (let i = 0; i < 12; i++) assert.equal(await checkRateLimit(kv, '1.2.3.4', now, { perMin: 12 }), null);
  assert.match(await checkRateLimit(kv, '1.2.3.4', now, { perMin: 12 }), /rate/);
});

test('budget accumulates and trips cap', async () => {
  const kv = memKV();
  const now = 1_750_000_000_000;
  assert.equal(await overBudget(kv, now, { cap: 100 }), false);
  await addBudget(kv, 150, now);
  assert.equal(await overBudget(kv, now, { cap: 100 }), true);
});

test('verifyTurnstile fails closed on missing secret', async () => {
  const fetchImpl = async () => ({ json: async () => ({ success: true }) });
  assert.equal(await verifyTurnstile('tok', '1.2.3.4', '', fetchImpl), false);
});
