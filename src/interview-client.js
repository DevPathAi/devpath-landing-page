export function parseSSE(buffer) {
  const events = [];
  const parts = buffer.split('\n\n');
  const rest = parts.pop();
  for (const part of parts) {
    const line = part.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try { events.push(JSON.parse(payload)); } catch { /* skip partial */ }
  }
  return { events, rest };
}

export function createInterviewClient({ fetchImpl = fetch } = {}) {
  async function sendTurn({ history, turnstileToken }) {
    const res = await fetchImpl('/api/interview/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ history, turnstileToken }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `turn_error_${res.status}`);
    }
    return res.json();
  }

  async function streamCompare({ transcript, stage, turnstileToken, onEvent }) {
    const res = await fetchImpl('/api/interview/compare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transcript, stage, turnstileToken }),
    });
    if (!res.ok || !res.body) throw new Error(`compare_error_${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const { events, rest } = parseSSE(buf);
      buf = rest;
      for (const evt of events) onEvent(evt);
    }
  }

  return { sendTurn, streamCompare };
}
