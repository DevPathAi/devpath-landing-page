const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export const MODEL_TURN = 'claude-haiku-4-5';
export const MODEL_ANSWER = 'claude-sonnet-4-6';

export function toClaudeMessages(history) {
  if (!Array.isArray(history)) return [];
  return history.map((m) => ({
    role: m && m.role === 'user' ? 'user' : 'assistant',
    content: String((m && m.text) || ''),
  }));
}

function headers(apiKey) {
  return { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': API_VERSION };
}

export async function callClaude({ apiKey, model, system, messages, maxTokens = 1024, fetchImpl = fetch }) {
  const res = await fetchImpl(API_URL, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
  });
  if (!res.ok) throw new Error(`anthropic_error_${res.status}`);
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text, usage: data.usage || {} };
}

export async function streamClaude({ apiKey, model, system, messages, maxTokens = 1024, fetchImpl = fetch }) {
  return fetchImpl(API_URL, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages, stream: true }),
  });
}
