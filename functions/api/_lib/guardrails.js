export const RL_PER_MIN = 12;
export const BUDGET_PER_DAY = 2_000_000;

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function minuteBucket(nowMs) { return Math.floor(nowMs / 60_000); }
function dayBucket(nowMs) { return Math.floor(nowMs / 86_400_000); }

export async function verifyTurnstile(token, ip, secret, fetchImpl = fetch) {
  if (!token || !secret) return false;
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set('remoteip', ip);
  const res = await fetchImpl(SITEVERIFY, { method: 'POST', body });
  const data = await res.json().catch(() => ({ success: false }));
  return Boolean(data && data.success);
}

export function enforceInputCaps(history, { maxTurns, maxMsgChars }) {
  if (!Array.isArray(history)) return 'invalid_history';
  const userTurns = history.filter((m) => m && m.role === 'user').length;
  if (userTurns > maxTurns) return 'too_many_turns';
  for (const m of history) {
    if (String((m && m.text) || '').length > maxMsgChars) return 'message_too_long';
  }
  return null;
}

export async function checkRateLimit(kv, ip, nowMs, { perMin = RL_PER_MIN } = {}) {
  if (!kv) { console.error('INTERVIEW_KV not bound — rate limiting disabled'); return null; }
  try {
    const key = `rl:${ip}:${minuteBucket(nowMs)}`;
    const count = Number(await kv.get(key)) || 0;
    if (count >= perMin) return 'rate_limited';
    await kv.put(key, String(count + 1), { expirationTtl: 120 });
    return null;
  } catch (e) {
    console.error('checkRateLimit KV error', e);
    return null;
  }
}

export async function addBudget(kv, tokens, nowMs) {
  if (!kv) return;
  try {
    const key = `budget:${dayBucket(nowMs)}`;
    const cur = Number(await kv.get(key)) || 0;
    await kv.put(key, String(cur + (Number(tokens) || 0)), { expirationTtl: 90_000 });
  } catch (e) { /* non-fatal: budget write best-effort */ }
}

export async function overBudget(kv, nowMs, { cap = BUDGET_PER_DAY } = {}) {
  if (!kv) return false;
  try {
    const key = `budget:${dayBucket(nowMs)}`;
    return (Number(await kv.get(key)) || 0) >= cap;
  } catch (e) {
    console.error('overBudget KV error', e);
    return false;
  }
}
