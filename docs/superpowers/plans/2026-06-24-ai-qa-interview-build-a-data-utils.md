# AI Q&A Interview — Build A: Data & Utilities Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the pure data/utility helpers and the Apps Script `interview` storage path that the AI Q&A interview feature needs, additively and without breaking the existing step1/step2 smoke-test flow.

**Architecture:** Extend `src/form-utils.js` (the single, node-tested source of form logic) with three pure functions — `pickBlindOrder`, `sanitizeTranscript`, `buildInterviewPayload` — and extend `apps-script/Code.gs` with a new `action: "interview"` branch plus the columns it writes. Everything is additive; the legacy `interview_opt_in` field and `CONSENT_VERSION` bump are intentionally deferred to Build C (the UI rework) so existing tests stay green.

**Tech Stack:** Vanilla ES modules, Node 20+ built-in test runner (`node --test`), Google Apps Script (`Code.gs`), `build.mjs` single-source bundler.

**Spec:** `docs/superpowers/specs/2026-06-24-ai-qa-interview-design.md` (§4.3, §5, §9).

## Global Constraints

- Logic lives only in `src/form-utils.js`; after edits run `npm run build` to regenerate the committed `src/app.bundle.js` (file:// safe IIFE bundle).
- ES modules (`"type": "module"`); tests run with `node --test`.
- LF line endings enforced by `.gitattributes` — do not introduce CRLF.
- Privacy rule: stored data must not contain source code, stack traces, GitHub URLs, tokens, DB URLs, or long logs — enforce with the existing `detectSensitiveInput` / `SENSITIVE_PATTERNS` on both client and server.
- Interview storage `landing_variant` is the literal `"aiqa-v1"`.
- Work on branch `feat/ai-qa-interview`; integrate via PR to `develop` (never push `main`/`develop` directly).
- **Deferred to Build C — DO NOT touch in Build A:** removing `interview_opt_in` (from `form-utils.js`, `app.js`, `index.html`, `Code.gs` HEADERS, tests), bumping `CONSENT_VERSION` to `2026-06-24-aiqa-v1`, and any `index.html`/`app.js`/`styles.css` changes. Keeping these intact is what keeps the 9 existing tests passing.

---

## File Structure

- Modify: `src/form-utils.js` — append `pickBlindOrder`, `sanitizeTranscript`, `buildInterviewPayload` after the existing `createSafeDraft` function (≈ line 125), before `mergeRows`.
- Modify: `tests/form-utils.test.mjs` — add the new helpers to the import block (line 4–15) and append new `test(...)` cases at the end.
- Modify: `apps-script/Code.gs` — append 7 fields to `HEADERS` (after `insight_coded_at`, line 31) and add an `interview` branch in `validatePayload_`.
- Regenerate: `src/app.bundle.js` — via `npm run build` (the bundle embeds `form-utils.js`; rebuild keeps it in sync).

---

## Task 1: `pickBlindOrder` — deterministic blind A/B ordering

**Files:**
- Modify: `src/form-utils.js`
- Test: `tests/form-utils.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `pickBlindOrder(seed: number) -> { contextSide: 1|2, order: ('context'|'generic')[] }`. The browser passes a random 0/1 seed; the function maps it deterministically so the display order is testable. `contextSide` is the displayed position (1 or 2) that holds the context-aware answer, stored later as `ab_context_side`.

- [ ] **Step 1: Add the import**

In `tests/form-utils.test.mjs`, add `pickBlindOrder` to the named import block (keep alphabetical-ish order is not required; just add it):

```js
import {
  buildInterviewPayload,
  buildStep1Payload,
  buildStep2Payload,
  createSafeDraft,
  detectSensitiveInput,
  isValidEmail,
  mergeRows,
  normalizeEmail,
  parseAttribution,
  pickBlindOrder,
  sanitizeTranscript,
  validateStep1,
  validateStep2,
} from '../src/form-utils.js';
```

(This import block also covers Tasks 2; importing not-yet-defined names is fine — the tests for them are added in their own tasks.)

- [ ] **Step 2: Write the failing test**

Append to `tests/form-utils.test.mjs`:

```js
test('pickBlindOrder maps even/odd seed to deterministic blind order', () => {
  assert.deepEqual(pickBlindOrder(0), { contextSide: 1, order: ['context', 'generic'] });
  assert.deepEqual(pickBlindOrder(1), { contextSide: 2, order: ['generic', 'context'] });
  assert.deepEqual(pickBlindOrder(2), { contextSide: 1, order: ['context', 'generic'] });
  assert.equal(pickBlindOrder(undefined).contextSide, 1);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test`
Expected: FAIL — `pickBlindOrder is not a function` (or import error for the new names).

- [ ] **Step 4: Write minimal implementation**

In `src/form-utils.js`, after the `createSafeDraft` function, add:

```js
export function pickBlindOrder(seed) {
  const contextFirst = (Math.abs(Math.trunc(Number(seed) || 0)) % 2) === 0;
  return {
    contextSide: contextFirst ? 1 : 2,
    order: contextFirst ? ['context', 'generic'] : ['generic', 'context'],
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test`
Expected: the new test PASSES (the other new test for `sanitizeTranscript`/`buildInterviewPayload` may still fail until Task 2 — that is expected).

- [ ] **Step 6: Commit**

```bash
git add src/form-utils.js tests/form-utils.test.mjs
git commit -m "feat(form-utils): add pickBlindOrder for blind A/B ordering"
```

---

## Task 2: `sanitizeTranscript` + `buildInterviewPayload` — interview storage payload

**Files:**
- Modify: `src/form-utils.js`
- Test: `tests/form-utils.test.mjs`
- Regenerate: `src/app.bundle.js`

**Interfaces:**
- Consumes: existing `normalizeEmail`, `detectSensitiveInput`, `CONSENT_VERSION` from `form-utils.js`.
- Produces:
  - `sanitizeTranscript(transcript: {role,text}[]) -> {role:'user'|'assistant',text:string}[]` — blanks any `user` turn whose text trips `detectSensitiveInput`; passes `assistant` turns (our own questions) through.
  - `buildInterviewPayload(data, transcript, ab, context) -> object` — the `action:"interview"` storage record posted (browser → Apps Script). `data = {lead_id,email,current_stage,consent_required}`; `ab = {distilledQuestion,contextSide,userChoice,rating}`; `context = {now?,consentVersion?,landingVariant?,utm_*?,referrer?}`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/form-utils.test.mjs`:

```js
test('sanitizeTranscript blanks sensitive user turns, keeps assistant turns', () => {
  const result = sanitizeTranscript([
    { role: 'assistant', text: '최근 어떤 걸 공부하다 막혔나요?' },
    { role: 'user', text: 'JPA N+1이 헷갈립니다.' },
    { role: 'user', text: 'https://github.com/acme/repo 참고하세요' },
  ]);
  assert.deepEqual(result, [
    { role: 'assistant', text: '최근 어떤 걸 공부하다 막혔나요?' },
    { role: 'user', text: 'JPA N+1이 헷갈립니다.' },
    { role: 'user', text: '' },
  ]);
  assert.deepEqual(sanitizeTranscript(null), []);
});

test('buildInterviewPayload assembles storage payload with sanitized transcript', () => {
  const payload = buildInterviewPayload(
    { lead_id: 'lead-9', email: ' Learner@Example.com ', current_stage: 'job_seeker', consent_required: true },
    [
      { role: 'assistant', text: '무엇이 막혔나요?' },
      { role: 'user', text: 'JPA 트랜잭션 경계가 헷갈립니다.' },
      { role: 'user', text: 'token: abc123' },
    ],
    { distilledQuestion: 'JPA 트랜잭션 경계를 어떻게 잡나요?', contextSide: 1, userChoice: 1, rating: 4 },
    { now: '2026-06-24T01:00:00.000Z', consentVersion: 'aiqa-test', utm_source: 'github', landingVariant: 'aiqa-v1' },
  );
  assert.equal(payload.action, 'interview');
  assert.equal(payload.email_normalized, 'learner@example.com');
  assert.equal(payload.interview_turns, 2);
  assert.equal(payload.ab_rating_1to5, 4);
  assert.equal(payload.recent_stuck_moment, 'JPA 트랜잭션 경계를 어떻게 잡나요?');
  assert.equal(payload.ab_distilled_question, 'JPA 트랜잭션 경계를 어떻게 잡나요?');
  assert.equal(payload.consent_version, 'aiqa-test');
  const t = JSON.parse(payload.interview_transcript);
  assert.equal(t[2].text, '');
});

test('buildInterviewPayload leaves rating/side blank when not provided', () => {
  const payload = buildInterviewPayload(
    { lead_id: 'l', email: 'a@b.co', current_stage: 'other', consent_required: true },
    [{ role: 'user', text: '막힘' }],
    { distilledQuestion: 'q' },
    { now: '2026-06-24T01:00:00.000Z' },
  );
  assert.equal(payload.ab_rating_1to5, '');
  assert.equal(payload.ab_context_side, '');
  assert.equal(payload.ab_user_choice, '');
  assert.equal(payload.landing_variant, 'aiqa-v1');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test`
Expected: FAIL — `sanitizeTranscript`/`buildInterviewPayload` not defined.

- [ ] **Step 3: Write minimal implementation**

In `src/form-utils.js`, after `pickBlindOrder` (from Task 1), add:

```js
export function sanitizeTranscript(transcript) {
  if (!Array.isArray(transcript)) return [];
  return transcript.map((entry) => {
    const role = entry && entry.role === 'user' ? 'user' : 'assistant';
    const text = String((entry && entry.text) || '');
    if (role === 'user' && detectSensitiveInput(text).length > 0) {
      return { role, text: '' };
    }
    return { role, text };
  });
}

export function buildInterviewPayload(data, transcript, ab = {}, context = {}) {
  const now = context.now || new Date().toISOString();
  const safe = sanitizeTranscript(transcript);
  const distilled = String(ab.distilledQuestion || '').trim();
  return {
    action: 'interview',
    lead_id: data.lead_id,
    email_normalized: normalizeEmail(data.email),
    current_stage: data.current_stage || '',
    consent_required: Boolean(data.consent_required),
    consent_version: context.consentVersion || CONSENT_VERSION,
    consent_accepted_at: now,
    interview_transcript: JSON.stringify(safe),
    interview_turns: safe.filter((t) => t.role === 'user').length,
    recent_stuck_moment: distilled,
    ab_distilled_question: distilled,
    ab_context_side: ab.contextSide == null ? '' : String(ab.contextSide),
    ab_user_choice: ab.userChoice == null ? '' : String(ab.userChoice),
    ab_rating_1to5: ab.rating == null || ab.rating === '' ? '' : Number(ab.rating),
    ab_completed_at: now,
    step1_submitted_at: now,
    last_updated_at: now,
    utm_source: context.utm_source || '',
    utm_medium: context.utm_medium || '',
    utm_campaign: context.utm_campaign || '',
    utm_content: context.utm_content || '',
    referrer: context.referrer || '',
    landing_variant: context.landingVariant || 'aiqa-v1',
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test`
Expected: PASS — all tests including the 9 pre-existing ones (no regressions).

- [ ] **Step 5: Regenerate the bundle**

Run: `npm run build`
Expected: prints `built src/app.bundle.js (...)`.

- [ ] **Step 6: Commit**

```bash
git add src/form-utils.js src/app.bundle.js tests/form-utils.test.mjs
git commit -m "feat(form-utils): add sanitizeTranscript + buildInterviewPayload"
```

---

## Task 3: Apps Script `interview` action + columns

**Files:**
- Modify: `apps-script/Code.gs`

**Interfaces:**
- Consumes: existing `doPost`, `validatePayload_`, `decoratePayload_`, `mergeRows_`, `findRow_`, `objectToRow_`, `ensureHeaders_`, `SENSITIVE_PATTERNS`.
- Produces: handles a posted record with `action: "interview"` — upserts into the `leads` sheet keyed by `lead_id`/`email_normalized` (reusing the existing upsert path), writing the new interview columns. Not node-testable (uses Google services); verified by an Apps Script editor test run and again in Build D E2E.

- [ ] **Step 1: Add the new columns to `HEADERS`**

In `apps-script/Code.gs`, in the `HEADERS` array, after `'insight_coded_at'` (the last entry, line 31), add:

```js
  'insight_coded_at',
  'interview_transcript',
  'interview_turns',
  'ab_distilled_question',
  'ab_context_side',
  'ab_user_choice',
  'ab_rating_1to5',
  'ab_completed_at',
];
```

(Adding columns is safe: `ensureHeaders_` appends any missing headers to existing sheets.)

- [ ] **Step 2: Add the `interview` validation branch**

In `validatePayload_`, immediately after the existing `if (payload.action === 'step1') { ... }` block and before the trailing `recent_stuck_moment` sensitive check, add:

```js
  if (payload.action === 'interview') {
    if (!payload.email_normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email_normalized)) {
      throw new Error('Valid email is required.');
    }
    if (!payload.current_stage) throw new Error('current_stage is required.');
    if (payload.consent_required !== true) throw new Error('Required consent is missing.');
    if (payload.interview_transcript &&
        SENSITIVE_PATTERNS.some((pattern) => pattern.test(payload.interview_transcript))) {
      throw new Error('Sensitive content is not allowed in transcript.');
    }
  }
```

(No change needed in `doPost`: `decoratePayload_` already strips `action`, and the existing upsert maps any payload keys present in `HEADERS` into the row.)

- [ ] **Step 3: Add an editor test function**

At the end of `apps-script/Code.gs`, add a manual test runnable from the Apps Script editor:

```js
function test_interview_doPost_() {
  const e = { postData: { contents: JSON.stringify({
    action: 'interview',
    lead_id: 'test-interview-1',
    email_normalized: 'tester@example.com',
    current_stage: 'job_seeker',
    consent_required: true,
    interview_transcript: '[{"role":"assistant","text":"무엇이 막혔나요?"},{"role":"user","text":"JPA N+1"}]',
    interview_turns: 1,
    ab_distilled_question: 'JPA N+1을 어떻게 푸나요?',
    recent_stuck_moment: 'JPA N+1을 어떻게 푸나요?',
    ab_context_side: '1',
    ab_user_choice: '1',
    ab_rating_1to5: 4,
    ab_completed_at: '2026-06-24T01:00:00.000Z',
    last_updated_at: '2026-06-24T01:00:00.000Z',
  }) } };
  Logger.log(doPost(e).getContent());
}
```

- [ ] **Step 4: Verify (manual — Apps Script editor)**

Deploy `Code.gs` to a test-bound Google Sheet (or paste into the bound script), then in the Apps Script editor run `test_interview_doPost_`.
Expected: log shows `{"ok":true,"lead_id":"test-interview-1","updated":false}` and the `leads` sheet gains the 7 new columns with a populated row. Delete the test row afterward.

(If Google account access is unavailable now, this step is deferred to Build D E2E; the code is still committed and reviewed.)

- [ ] **Step 5: Commit**

```bash
git add apps-script/Code.gs
git commit -m "feat(apps-script): add interview action and columns"
```

---

## Self-Review (completed by author)

- **Spec coverage (Build A scope):** §4.3 helpers (`buildInterviewPayload`, `pickBlindOrder`) → Tasks 1–2; `sanitizeTranscript` (transcript sensitive filtering, §8/§9) → Task 2; §9 new columns + `interview` action → Task 3. Deferred items (`interview_opt_in` removal, `CONSENT_VERSION` bump, consent copy) are explicitly assigned to Build C in Global Constraints.
- **Placeholder scan:** none — every code step shows complete code; every run step shows the command and expected result.
- **Type consistency:** `pickBlindOrder` returns `contextSide`/`order`; `buildInterviewPayload` reads `ab.contextSide`/`ab.userChoice`/`ab.rating`/`ab.distilledQuestion`; storage keys (`ab_context_side`, `ab_user_choice`, `ab_rating_1to5`, `ab_distilled_question`, `interview_transcript`, `interview_turns`) match the `HEADERS` additions in Task 3 and the API contract in spec §5.

---

## Next plans (this feature, written separately)

- **Build B** — Cloudflare Pages Functions (`/api/interview/turn`, `/api/interview/compare` SSE), `_lib/llm·guardrails·prompts`, KV + Turnstile; vitest/miniflare tests.
- **Build C** — frontend (`interview-ui.js`, `interview-client.js`), `index.html` interview section replacing the video-call copy, remove `interview_opt_in`, bump `CONSENT_VERSION` + consent copy, `styles.css`.
- **Build D** — integration/E2E + Sheets verification.
- **Build E** — Cloudflare Pages provisioning/deploy (needs user accounts/keys).
