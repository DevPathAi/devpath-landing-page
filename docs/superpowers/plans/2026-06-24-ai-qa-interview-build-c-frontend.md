# AI Q&A Interview — Build C: Frontend (chat UI + funnel) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the video-interview UI with the on-page adaptive AI interview: chat turns → email gate → blind A/B compare + rating → save, and remove the now-obsolete `interview_opt_in` field.

**Architecture:** Two new browser modules — `interview-client.js` (network/SSE) and `interview-ui.js` (DOM state machine) — driven by `app.js`, reusing `form-utils.js` for validation/lead-id/attribution and the new `buildInterviewPayload`/`pickBlindOrder`. The single-source bundler (`build.mjs`) is generalized to inline all modules into `app.bundle.js`.

**Tech Stack:** Vanilla ES modules + non-module IIFE bundle (file:// safe), Turnstile widget, `node --test`.

**Spec:** `docs/superpowers/specs/2026-06-24-ai-qa-interview-design.md` (§2, §4.1–4.3, §5, §9, §12).

## Global Constraints

- Single source: edit `src/*.js`; run `npm run build` to regenerate `src/app.bundle.js`. The bundle must contain **no** `import`/`export` lines.
- ES modules; `node --test`; LF endings.
- Reuse `form-utils.js`: `validateStep1`, `createLeadId`, `parseAttribution`, `buildInterviewPayload`, `pickBlindOrder` (Build A), `normalizeEmail`.
- Consume Build B contracts exactly: `POST /api/interview/turn` → `{question,done}`; `POST /api/interview/compare` → SSE `{type:'distilled'|'generic'|'context'|'done'|'error', ...}`.
- Bump `CONSENT_VERSION` to `2026-06-24-aiqa-v1` and update consent copy to cover interview-transcript storage + AI processing.
- Save record via the existing browser → Apps Script path (`window.DEVPATH_FORM_ENDPOINT`, `content-type: text/plain;charset=utf-8`). Fail closed if the endpoint is empty (existing behavior).
- Turnstile sitekey via `window.DEVPATH_TURNSTILE_SITEKEY` (public; set in Build E). If unset, interview shows a setup error instead of pretending.
- Branch `feat/ai-qa-interview`; PR to `develop`.

---

## File Structure

- Modify: `src/form-utils.js` — remove `interview_opt_in` from `buildStep2Payload` and `createSafeDraft`; bump `CONSENT_VERSION`.
- Modify: `tests/form-utils.test.mjs` — drop `interview_opt_in` from the two tests that reference it.
- Modify: `build.mjs` — generalized multi-module bundler.
- Create: `src/interview-client.js` — `parseSSE` (pure) + `createInterviewClient`.
- Create: `src/interview-ui.js` — `initInterview(root, deps)` state machine.
- Test: `tests/interview-client.test.mjs` — `parseSSE` + `sendTurn` (mock fetch).
- Modify: `src/app.js` — wire `initInterview`; remove old step1/step2 form controller; keep nav/scroll/particles.
- Modify: `index.html` — replace form panel with interview container, add Turnstile, update consent copy, set config vars, remove `interview_opt_in`.
- Modify: `styles.css` — chat/answer-card/rating styles (append).
- Regenerate: `src/app.bundle.js` via `npm run build`.

---

## Task 1: Remove `interview_opt_in`, bump consent version

**Files:**
- Modify: `src/form-utils.js`
- Test: `tests/form-utils.test.mjs`

- [ ] **Step 1: Update the two tests (make them the new spec)**

In `tests/form-utils.test.mjs`, replace the `interview_opt_in` test bodies. Change the "builds Step 2 payload" test:

```js
test('builds Step 2 payload without erasing optional blanks', () => {
  const payload = buildStep2Payload({
    lead_id: 'lead-1',
    email: 'user@example.com',
    stack: 'Java, Spring, JPA',
    recent_stuck_moment: 'N+1 문제를 보고 있는데 fetch join 기준이 헷갈립니다.',
    wtp_krw: '',
  }, {
    now: '2026-06-24T00:05:00.000Z',
  });

  assert.equal(payload.wtp_krw, '');
  assert.equal(payload.step2_submitted_at, '2026-06-24T00:05:00.000Z');
  assert.equal(payload.interview_opt_in, undefined);
});
```

And the `createSafeDraft` test:

```js
test('createSafeDraft omits sensitive recent stuck moment from localStorage drafts', () => {
  assert.deepEqual(createSafeDraft({
    email: 'learner@example.com',
    current_stage: 'job_seeker',
    consent_required: true,
    stack: 'Spring',
    recent_stuck_moment: 'https://github.com/acme/private-repo 에러입니다',
    wtp_krw: '15000',
  }), {
    email: 'learner@example.com',
    current_stage: 'job_seeker',
    consent_required: true,
    stack: 'Spring',
    recent_stuck_moment: '',
    wtp_krw: '15000',
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test`
Expected: FAIL — `buildStep2Payload`/`createSafeDraft` still emit `interview_opt_in`.

- [ ] **Step 3: Edit `src/form-utils.js`**

Change `CONSENT_VERSION` (line 1):

```js
export const CONSENT_VERSION = '2026-06-24-aiqa-v1';
```

In `buildStep2Payload`, delete the line `interview_opt_in: Boolean(data.interview_opt_in),`.
In `createSafeDraft`, delete the line `interview_opt_in: Boolean(data.interview_opt_in),`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add src/form-utils.js tests/form-utils.test.mjs
git commit -m "refactor(form-utils): drop interview_opt_in, bump consent to aiqa-v1"
```

---

## Task 2: Generalize the bundler

**Files:**
- Modify: `build.mjs`

- [ ] **Step 1: Replace `build.mjs` with the multi-module bundler**

```js
// Inlines src/*.js (ES modules) into a single non-module IIFE bundle
// (src/app.bundle.js) that loads under file:// without CORS.
// Edit the source modules and run `npm run build` to regenerate.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const srcDir = fileURLToPath(new URL('./src/', import.meta.url));
const MODULES = ['form-utils.js', 'interview-client.js', 'interview-ui.js', 'app.js'];

function strip(code) {
  return code
    .replace(/^export\s+/gm, '')
    .replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
}

const banner =
  '// AUTO-GENERATED by build.mjs — DO NOT EDIT.\n' +
  '// Edit src/*.js then run: npm run build\n';

const parts = [];
for (const name of MODULES) {
  parts.push(strip(await readFile(srcDir + name, 'utf8')));
}
const bundle = `${banner}(function () {\n'use strict';\n${parts.join('\n')}\n})();\n`;
await writeFile(srcDir + 'app.bundle.js', bundle);
console.log(`built src/app.bundle.js (${bundle.length} bytes)`);
```

- [ ] **Step 2: Defer build verification**

The build needs `interview-client.js`, `interview-ui.js`, and the rewritten `app.js` to exist (Tasks 3–5). Do not run `npm run build` yet — it runs in Task 6.

- [ ] **Step 3: Commit**

```bash
git add build.mjs
git commit -m "build: generalize bundler to inline all src modules"
```

---

## Task 3: `interview-client.js` — network + SSE

**Files:**
- Create: `src/interview-client.js`
- Test: `tests/interview-client.test.mjs`

**Interfaces:**
- Produces:
  - `parseSSE(buffer)->{events:object[], rest:string}` (pure; splits complete `data:` lines, JSON-parses, returns leftover).
  - `createInterviewClient({fetchImpl})->{ sendTurn({history,turnstileToken}), streamCompare({transcript,stage,turnstileToken,onEvent}) }`.

- [ ] **Step 1: Write the failing test**

Create `tests/interview-client.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test`
Expected: FAIL — cannot find module `interview-client.js`.

- [ ] **Step 3: Write the implementation**

Create `src/interview-client.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/interview-client.js tests/interview-client.test.mjs
git commit -m "feat(frontend): interview-client with SSE parsing"
```

---

## Task 4: `interview-ui.js` — chat state machine

**Files:**
- Create: `src/interview-ui.js`

**Interfaces:**
- Consumes: `interview-client.js` (`createInterviewClient`), `form-utils.js` (`validateStep1`, `createLeadId`, `parseAttribution`, `buildInterviewPayload`, `pickBlindOrder`).
- Produces: `initInterview(root, { config })` — config: `{ endpoint, consentVersion, landingVariant, turnstileToken() }`. Renders into `root` and drives INTERVIEW→GATE→COMPARE→RATE→DONE. DOM behavior verified manually in Build D.

- [ ] **Step 1: Write the implementation**

Create `src/interview-ui.js`:

```js
export function initInterview(root, { config }) {
  const client = createInterviewClient({});
  const attribution = parseAttribution(window.location.href, document.referrer);
  const leadId = createLeadId();
  const history = [];           // {role:'assistant'|'user', text}
  let distilled = '';
  let blind = { contextSide: 1, order: ['context', 'generic'] };
  let answers = { context: '', generic: '' };
  let userChoice = null;
  let stage = '';
  let email = '';

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const log = el('div', 'iv-log');
  const status = el('div', 'iv-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  root.append(log, status);

  function addBubble(role, text) {
    const b = el('div', `iv-bubble iv-${role}`, text);
    log.append(b); log.scrollTop = log.scrollHeight; return b;
  }
  function setStatus(msg, tone) { status.textContent = msg || ''; if (tone) status.dataset.tone = tone; else delete status.dataset.tone; }

  function renderInput(onSend) {
    const wrap = el('form', 'iv-input');
    const ta = el('textarea'); ta.maxLength = 600; ta.required = true; ta.placeholder = '코드/로그/URL 없이 상황만 적어주세요';
    const btn = el('button', 'btn', '보내기'); btn.type = 'submit';
    wrap.append(ta, btn);
    wrap.addEventListener('submit', (e) => { e.preventDefault(); const v = ta.value.trim(); if (!v) return; onSend(v, wrap); });
    root.append(wrap); ta.focus(); return wrap;
  }

  async function nextTurn(inputWrap) {
    setStatus('생각 중...'); 
    try {
      const { question, done } = await client.sendTurn({ history, turnstileToken: config.turnstileToken() });
      setStatus('');
      if (question) { addBubble('assistant', question); history.push({ role: 'assistant', text: question }); }
      if (done) { if (inputWrap) inputWrap.remove(); renderGate(); }
    } catch (err) { setStatus(`오류: ${err.message}. 다시 시도해주세요.`, 'error'); }
  }

  function startInterview() {
    const opener = '최근 Java/Spring을 공부하다 가장 막혔던 순간은 무엇이었나요?';
    addBubble('assistant', opener); history.push({ role: 'assistant', text: opener });
    const wrap = renderInput(async (v, w) => {
      addBubble('user', v); history.push({ role: 'user', text: v });
      w.querySelector('textarea').value = '';
      await nextTurn(w);
    });
    return wrap;
  }

  function renderGate() {
    const form = el('form', 'iv-gate');
    form.append(el('p', 'iv-gate-title', '결과를 보려면 이메일을 남겨주세요'));
    const emailInput = el('input'); emailInput.type = 'email'; emailInput.placeholder = 'you@example.com'; emailInput.required = true;
    const stageSel = document.createElement('select'); stageSel.required = true;
    [['', '현재 단계 선택'], ['job_seeker', '취업 준비생'], ['junior_dev', '주니어 현직자'], ['self_taught', '비전공 독학자'], ['other', '기타']]
      .forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; stageSel.append(o); });
    const consentLabel = el('label', 'iv-consent');
    const consent = el('input'); consent.type = 'checkbox'; consent.required = true;
    consentLabel.append(consent, el('span', null, '이메일·학습 단계와 인터뷰 전사를 출시 알림·분석 목적으로 저장하고 AI 처리에 사용하는 데 동의합니다. 보유 기간은 정식 출시 후 6개월 또는 동의 철회 시까지입니다.'));
    const btn = el('button', 'btn', '결과 보기'); btn.type = 'submit';
    form.append(emailInput, stageSel, consentLabel, btn);
    root.append(form);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      email = emailInput.value; stage = stageSel.value;
      const errors = validateStep1({ email, current_stage: stage, consent_required: consent.checked });
      if (errors.length) { setStatus(errors[0], 'error'); return; }
      form.remove(); runCompare();
    });
  }

  async function runCompare() {
    setStatus('두 가지 답변을 생성하고 있습니다...');
    blind = pickBlindOrder(Math.floor(Math.random() * 2));
    const cards = renderAnswerCards();
    try {
      await client.streamCompare({
        transcript: history, stage, turnstileToken: config.turnstileToken(),
        onEvent: (evt) => {
          if (evt.type === 'distilled') { distilled = evt.question || ''; }
          else if (evt.type === 'generic') { answers.generic += evt.delta || ''; cards.update('generic'); }
          else if (evt.type === 'context') { answers.context += evt.delta || ''; cards.update('context'); }
          else if (evt.type === 'done') { setStatus(''); renderRating(); }
          else if (evt.type === 'error') { setStatus('생성 중 오류가 발생했습니다. 다시 시도해주세요.', 'error'); }
        },
      });
    } catch (err) { setStatus(`오류: ${err.message}`, 'error'); }
  }

  function renderAnswerCards() {
    const grid = el('div', 'iv-ab');
    const slots = {};
    blind.order.forEach((which, i) => {
      const card = el('div', 'iv-card');
      card.append(el('h4', null, `답변 ${i + 1}`));
      const body = el('div', 'iv-card-body'); card.append(body);
      const pick = el('button', 'btn btn-ghost', '이 답변이 더 유용해요'); pick.type = 'button';
      pick.addEventListener('click', () => { userChoice = i + 1; grid.querySelectorAll('.iv-card').forEach((c) => c.classList.remove('chosen')); card.classList.add('chosen'); });
      card.append(pick);
      grid.append(card); slots[which] = body;
    });
    root.append(grid);
    return { update: (which) => { slots[which].textContent = answers[which]; } };
  }

  function renderRating() {
    const form = el('form', 'iv-rate');
    form.append(el('p', null, '더 유용한 답변을 고르고, 도움 정도를 1~5점으로 평가해주세요.'));
    const range = el('input'); range.type = 'range'; range.min = '1'; range.max = '5'; range.value = '3';
    const out = el('span', 'iv-rate-val', '3'); range.addEventListener('input', () => { out.textContent = range.value; });
    const btn = el('button', 'btn', '제출'); btn.type = 'submit';
    form.append(range, out, btn);
    root.append(form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!userChoice) { setStatus('어느 답변이 더 유용했는지 선택해주세요.', 'error'); return; }
      form.remove(); await save(Number(range.value));
    });
  }

  async function save(rating) {
    setStatus('저장 중...');
    const payload = buildInterviewPayload(
      { lead_id: leadId, email, current_stage: stage, consent_required: true },
      history,
      { distilledQuestion: distilled, contextSide: blind.contextSide, userChoice, rating },
      { ...attribution, consentVersion: config.consentVersion, landingVariant: config.landingVariant },
    );
    if (!config.endpoint) { setStatus('저장 URL이 설정되지 않았습니다. 잠시 후 다시 시도해주세요.', 'error'); return; }
    try {
      const res = await fetch(config.endpoint, { method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error || '저장 실패');
      setStatus('');
      root.append(el('div', 'iv-done', '신청이 완료되었습니다! 베타 우선 초대 대상자에게 이메일로 연락드리겠습니다.'));
    } catch (err) { setStatus(`저장 오류: ${err.message}`, 'error'); }
  }

  if (!config.turnstileToken || !window.DEVPATH_TURNSTILE_SITEKEY) {
    setStatus('데모 준비 중입니다(보안 위젯 미설정).', 'error');
    return;
  }
  startInterview();
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check src/interview-ui.js`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/interview-ui.js
git commit -m "feat(frontend): interview chat UI state machine"
```

---

## Task 5: `app.js` + `index.html` + `styles.css` wiring

**Files:**
- Modify: `src/app.js`, `index.html`, `styles.css`

- [ ] **Step 1: Rewrite `src/app.js` entry**

Replace the form-controller portion of `src/app.js` (everything from the top imports through the `form.addEventListener('input', ...)` initializer, i.e. the lead-form logic) with interview wiring. Keep the three IIFEs at the bottom (`initNav`, `initScrollFade`, `initParticles`) unchanged. New top of `src/app.js`:

```js
import { CONSENT_VERSION } from './form-utils.js';
import { initInterview } from './interview-ui.js';

const endpoint = window.DEVPATH_FORM_ENDPOINT || '';
const consentVersion = window.DEVPATH_CONSENT_VERSION || CONSENT_VERSION;
const landingVariant = window.DEVPATH_LANDING_VARIANT || 'aiqa-v1';

(function initInterviewRoot() {
  const root = document.querySelector('#interview-root');
  if (!root) return;
  initInterview(root, {
    config: {
      endpoint,
      consentVersion,
      landingVariant,
      turnstileToken: () => (window.turnstile && window.__turnstileToken) || '',
    },
  });
})();
```

(`window.__turnstileToken` is set by the Turnstile callback added in Step 3. The old `form-utils` imports beyond `CONSENT_VERSION` and all step1/step2 DOM logic are removed; `buildStep2Payload`/`createSafeDraft`/`validateStep2` remain exported in form-utils for tests but are no longer used by the page.)

- [ ] **Step 2: Replace the form panel section in `index.html`**

Replace the entire `<section class="panel ...">...</section>` block (the lead-form panel, lines ≈113–197) with:

```html
      <!-- ── AI Interview ── -->
      <section class="panel scroll-fade" aria-labelledby="form-title" id="apply">
        <div class="panel-head">
          <h2 id="form-title">AI 학습 진단 인터뷰</h2>
          <p>AI가 몇 가지 질문으로 막혔던 순간을 함께 짚어본 뒤, 학습 맥락을 반영한 답변과 일반 답변을 비교해 보여드립니다.</p>
        </div>
        <div class="console">
          <div id="interview-root" class="interview-root"></div>
          <div id="turnstile-widget" class="cf-turnstile"
               data-sitekey="" data-callback="onTurnstile" data-theme="dark"></div>
        </div>
      </section>
```

- [ ] **Step 3: Update head config + Turnstile in `index.html`**

Replace the inline config `<script>` (lines ≈24–28) with:

```html
    <script>
      window.DEVPATH_FORM_ENDPOINT = '';
      window.DEVPATH_CONSENT_VERSION = '2026-06-24-aiqa-v1';
      window.DEVPATH_LANDING_VARIANT = 'aiqa-v1';
      window.DEVPATH_TURNSTILE_SITEKEY = '';
      window.__turnstileToken = '';
      function onTurnstile(token) { window.__turnstileToken = token; }
      window.addEventListener('DOMContentLoaded', function () {
        var s = window.DEVPATH_TURNSTILE_SITEKEY;
        var w = document.getElementById('turnstile-widget');
        if (s && w) w.setAttribute('data-sitekey', s);
      });
    </script>
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
```

- [ ] **Step 4: Update copy that references video calls**

In `index.html`, update these so nothing promises a human video call:
- meta description (line ≈9): `content="Java/Spring 학습자를 위한 AI 학습 진단 인터뷰 — 막혔던 순간을 바탕으로 맥락 반영 AI 답변을 체험합니다."`
- STEP 02 (lines ≈94–95): `<h3>AI와 질의응답</h3>` / `<p>AI가 막힌 지점을 한 질문씩 짚어줍니다. 준비할 것은 없습니다.</p>`
- FAQ "인터뷰는 어떻게 진행되나요?" answer (line ≈217): `<p>화면에서 AI와 채팅으로 진행됩니다. 막혔던 순간을 적으면 AI가 후속 질문을 이어가고, 마지막에 학습 맥락을 반영한 답변과 일반 답변을 비교해 보여드립니다. 약 5분이면 됩니다.</p>`
- FAQ 사례비 question/answer (lines ≈221–226): remove the honorarium FAQ item (no paid interview in the AI demo) — delete that `<details>` block.

- [ ] **Step 5: Append chat styles to `styles.css`**

Append:

```css
/* ── AI Interview ── */
.interview-root { display: flex; flex-direction: column; gap: 12px; }
.iv-log { display: flex; flex-direction: column; gap: 8px; max-height: 320px; overflow-y: auto; padding: 4px; }
.iv-bubble { padding: 10px 12px; border-radius: 10px; max-width: 85%; white-space: pre-wrap; line-height: 1.5; }
.iv-assistant { background: rgba(57,197,207,0.12); align-self: flex-start; }
.iv-user { background: rgba(255,255,255,0.06); align-self: flex-end; }
.iv-input { display: flex; gap: 8px; }
.iv-input textarea { flex: 1; min-height: 56px; resize: vertical; }
.iv-status[data-tone="error"] { color: #ff8a8a; }
.iv-gate, .iv-rate { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
.iv-consent { display: flex; gap: 8px; font-size: 0.85rem; align-items: flex-start; }
.iv-ab { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }
.iv-card { border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.iv-card.chosen { border-color: var(--green, #39c5cf); }
.iv-card-body { white-space: pre-wrap; line-height: 1.5; font-size: 0.92rem; }
.iv-done { margin-top: 12px; color: var(--green, #39c5cf); }
@media (max-width: 640px) { .iv-ab { grid-template-columns: 1fr; } }
```

- [ ] **Step 6: Build and run the unit suite**

```bash
npm run build
node --test
```
Expected: build prints byte count; `node --test` all PASS; then verify the bundle is clean:

```bash
grep -nE "^(import|export)\b" src/app.bundle.js || echo "BUNDLE_CLEAN"
```
Expected: `BUNDLE_CLEAN`.

- [ ] **Step 7: Commit**

```bash
git add src/app.js src/app.bundle.js index.html styles.css
git commit -m "feat(frontend): wire AI interview into landing page, remove video-call copy"
```

---

## Self-Review (completed by author)

- **Spec coverage:** §2 flow (interview→gate→A/B→rate→save) → Tasks 4–5; §4.1 ui / §4.2 client → Tasks 4/3; §4.3 helpers consumed; §5 contracts consumed verbatim; §9 `interview_opt_in` removal + consent bump → Task 1; §12 consent copy → Task 5 Step 3/2.
- **Placeholder scan:** none — full code for client, UI, app.js wiring, HTML blocks, CSS, and bundler. DOM/visual behavior is verified in Build D (documented), not a placeholder.
- **Type consistency:** client `sendTurn`/`streamCompare`/`parseSSE` and event shapes match Build B's SSE contract and `interview-ui.js` usage; `buildInterviewPayload`/`pickBlindOrder` calls match Build A signatures; `config.turnstileToken()` getter matches `app.js` wiring and the Turnstile callback in `index.html`.

---

## Depends on / feeds

- Depends on: Build A (helpers), Build B (endpoints).
- Feeds: Build D (E2E), Build E (Turnstile sitekey, Pages deploy).
