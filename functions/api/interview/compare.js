import { distillSystem, genericAnswerSystem, contextAnswerSystem, MAX_TURNS, MAX_MSG_CHARS } from '../_lib/prompts.js';
import { toClaudeMessages, callClaude, streamClaude, MODEL_TURN, MODEL_ANSWER } from '../_lib/llm.js';
import { verifyTurnstile, enforceInputCaps, checkRateLimit, addBudget, overBudget } from '../_lib/guardrails.js';

function sse(controller, enc, obj) {
  controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
}

// Reads an Anthropic SSE Response and invokes onText(delta) for each text_delta.
async function pipeAnthropicText(res, onText) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
        onText(evt.delta.text);
      }
    }
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const now = Date.now();
  let body;
  try { body = await request.json(); } catch { return new Response('bad_json', { status: 400 }); }

  const transcript = Array.isArray(body.transcript) ? body.transcript : [];
  const capErr = enforceInputCaps(transcript, { maxTurns: MAX_TURNS, maxMsgChars: MAX_MSG_CHARS });
  if (capErr) return new Response(capErr, { status: 400 });

  if (!(await verifyTurnstile(body.turnstileToken, ip, env.TURNSTILE_SECRET))) {
    return new Response('turnstile_failed', { status: 403 });
  }
  if (await checkRateLimit(env.INTERVIEW_KV, ip, now)) return new Response('rate_limited', { status: 429 });
  if (await overBudget(env.INTERVIEW_KV, now)) return new Response('budget_exceeded', { status: 429 });

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        // 1) distill core question (Haiku, non-streaming)
        const distill = await callClaude({
          apiKey: env.ANTHROPIC_API_KEY, model: MODEL_TURN,
          system: distillSystem(),
          messages: toClaudeMessages(transcript),
          maxTokens: 120,
        });
        const question = (distill.text || '').trim();
        await addBudget(env.INTERVIEW_KV, (distill.usage.input_tokens || 0) + (distill.usage.output_tokens || 0), now);
        sse(controller, enc, { type: 'distilled', question });

        // 2) generic answer (Sonnet, streamed) — no context
        const gen = await streamClaude({
          apiKey: env.ANTHROPIC_API_KEY, model: MODEL_ANSWER,
          system: genericAnswerSystem(),
          messages: [{ role: 'user', content: question }],
          maxTokens: 700,
        });
        await pipeAnthropicText(gen, (delta) => sse(controller, enc, { type: 'generic', delta }));

        // 3) context-aware answer (Sonnet, streamed) — full transcript + stage
        const ctxMessages = [
          ...toClaudeMessages(transcript),
          { role: 'user', content: `위 인터뷰 맥락을 반영해 다음 질문에 답해줘: ${question}` },
        ];
        const ctx = await streamClaude({
          apiKey: env.ANTHROPIC_API_KEY, model: MODEL_ANSWER,
          system: contextAnswerSystem(body.stage),
          messages: ctxMessages,
          maxTokens: 700,
        });
        await pipeAnthropicText(ctx, (delta) => sse(controller, enc, { type: 'context', delta }));

        sse(controller, enc, { type: 'done' });
      } catch (e) {
        sse(controller, enc, { type: 'error', message: 'llm_unavailable' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
  });
}
