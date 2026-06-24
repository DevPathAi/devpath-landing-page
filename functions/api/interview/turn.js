import { INTERVIEWER_SYSTEM, MAX_TURNS, MAX_MSG_CHARS, READY_TOKEN, detectSensitive } from '../_lib/prompts.js';
import { toClaudeMessages, callClaude, MODEL_TURN } from '../_lib/llm.js';
import { verifyTurnstile, enforceInputCaps, checkRateLimit, addBudget, overBudget } from '../_lib/guardrails.js';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const now = Date.now();
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }

  const history = Array.isArray(body.history) ? body.history : [];
  const isFirst = history.filter((m) => m && m.role === 'user').length <= 1;

  const capErr = enforceInputCaps(history, { maxTurns: MAX_TURNS, maxMsgChars: MAX_MSG_CHARS });
  if (capErr) return json({ error: capErr }, 400);

  const lastUser = [...history].reverse().find((m) => m && m.role === 'user');
  if (lastUser && detectSensitive(lastUser.text)) return json({ error: 'sensitive_blocked' }, 400);

  if (isFirst) {
    const ok = await verifyTurnstile(body.turnstileToken, ip, env.TURNSTILE_SECRET);
    if (!ok) return json({ error: 'turnstile_failed' }, 403);
  }
  if (await checkRateLimit(env.INTERVIEW_KV, ip, now)) return json({ error: 'rate_limited' }, 429);
  if (await overBudget(env.INTERVIEW_KV, now)) return json({ error: 'budget_exceeded' }, 429);

  const userTurns = history.filter((m) => m && m.role === 'user').length;
  if (userTurns >= MAX_TURNS) return json({ question: '', done: true });

  let out;
  try {
    out = await callClaude({
      apiKey: env.ANTHROPIC_API_KEY,
      model: MODEL_TURN,
      system: INTERVIEWER_SYSTEM,
      messages: toClaudeMessages(history),
      maxTokens: 300,
    });
  } catch { return json({ error: 'llm_unavailable' }, 503); }

  try {
    await addBudget(env.INTERVIEW_KV, (out.usage.input_tokens || 0) + (out.usage.output_tokens || 0), now);
  } catch (e) { /* non-fatal: budget write failed, still return the answer */ }

  const text = (out.text || '').trim();
  const done = text.includes(READY_TOKEN) || userTurns + 1 >= MAX_TURNS;
  const question = text.replace(READY_TOKEN, '').trim();
  return json({ question, done });
}
