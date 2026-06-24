# AI Q&A Interview — Build D: Integration & E2E — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Verify the whole feature end-to-end on a local Cloudflare Pages dev server — adaptive turns, email gate, streamed A/B, rating, and the Apps Script save — including the parts unit tests can't cover (SSE over the real runtime, Turnstile, KV, guardrails).

**Architecture:** Run static + Functions together with `wrangler pages dev`, using Cloudflare's Turnstile **test keys** and a local KV namespace, then drive the funnel in a browser and confirm a row lands in a test Google Sheet.

**Tech Stack:** `wrangler` (Cloudflare CLI), Chrome/Firefox, Apps Script test deployment.

**Spec:** `docs/superpowers/specs/2026-06-24-ai-qa-interview-design.md` (§10, §11).

## Carry-in from final review (REQUIRED before live deploy)

**X-1 (Important) — Turnstile single-use token reuse on `/compare`.** The frontend currently sends one `window.__turnstileToken` (minted on initial solve) on both the first `/turn` and on `/compare`. Cloudflare Turnstile tokens are single-use (~300s); after `/turn` redeems it, `/compare`'s `siteverify` will reject the duplicate → `/compare` 403 → user never reaches A/B+rating. Spec §8 requires a **fresh token minted at the email gate**. Fix in Build C's files (`src/interview-ui.js` / `index.html`) by re-executing Turnstile at the gate (e.g. `turnstile.reset()`/`render`/`execute`, refresh `window.__turnstileToken`, await it) before `runCompare`, then **E2E-verify with a real sitekey here** (Task 2 Step 2 must confirm the A/B step actually streams after the gate). Also re-check the gate→`runCompare` path is retryable (don't strand the user on a `/compare` error). This MUST be resolved and verified before Build E live deploy.

## Global Constraints

- Turnstile test keys (no account needed for local): sitekey `1x00000000000000000000AA` (always passes), secret `1x0000000000000000000000000000000AA` (always passes). Use a fail sitekey `2x00000000000000000000AB` to test the 403 path.
- Live LLM E2E requires a real `ANTHROPIC_API_KEY` in `.dev.vars` (never committed).
- `.dev.vars` and any local KV state are git-ignored (already covered by `.env*`? add `.dev.vars` explicitly).
- Branch `feat/ai-qa-interview`.

---

## File Structure

- Modify: `.gitignore` — add `.dev.vars` and `.wrangler/`.
- Create: `.dev.vars.example` — documents required local vars (no secrets).
- (No product code; this build is verification. Any defect found is fixed in the owning build's files with a regression test.)

---

## Task 1: Local dev harness

- [ ] **Step 1: Ignore local dev files**

Append to `.gitignore`:

```
.dev.vars
.wrangler/
```

- [ ] **Step 2: Add `.dev.vars.example`**

Create `.dev.vars.example`:

```
# Copy to .dev.vars (git-ignored) and fill in.
ANTHROPIC_API_KEY=sk-ant-...
TURNSTILE_SECRET=1x0000000000000000000000000000000AA
```

- [ ] **Step 3: Set the local Turnstile sitekey + endpoint**

For local E2E only, temporarily set in `index.html`: `window.DEVPATH_TURNSTILE_SITEKEY = '1x00000000000000000000AA';` and `window.DEVPATH_FORM_ENDPOINT = '<test Apps Script /exec URL>';`. (Revert before commit — production values are set in Build E. Do not commit these.)

- [ ] **Step 4: Start the dev server**

Run:
```bash
npx wrangler pages dev . --kv INTERVIEW_KV --compatibility-date 2024-09-01
```
Expected: serves the static root + `functions/` on `http://localhost:8788` with a local `INTERVIEW_KV`.

- [ ] **Step 5: Commit harness files**

```bash
git add .gitignore .dev.vars.example
git commit -m "chore(dev): wrangler pages dev harness for interview E2E"
```

---

## Task 2: Happy-path E2E (manual, browser)

- [ ] **Step 1: Apps Script test endpoint ready**

Deploy `apps-script/Code.gs` (from Build A) as a Web App bound to a throwaway Google Sheet; put its `/exec` URL in `index.html` (Task 1 Step 3, local only).

- [ ] **Step 2: Drive the funnel**

Open `http://localhost:8788`, scroll to "AI 학습 진단 인터뷰", then:
1. Answer the opening question → verify a follow-up question streams/appears (adaptive).
2. Continue answering → verify it ends by turn 5 or earlier (`[READY]`), then the **email gate** appears.
3. Submit email + stage + consent → verify two answer cards render and **both stream** token-by-token (`generic` and `context`).
4. Pick the more useful answer + set rating → submit.
5. Verify the completion message.

Expected: each transition works; no console errors.

- [ ] **Step 3: Verify storage**

In the test Google Sheet `leads` tab, confirm a new row with: `email_normalized`, `current_stage`, `interview_transcript` (JSON), `interview_turns`, `ab_distilled_question`, `recent_stuck_moment`, `ab_context_side`, `ab_user_choice`, `ab_rating_1to5`, `ab_completed_at`, `landing_variant=aiqa-v1`.

- [ ] **Step 4: Record evidence**

Save 2–3 screenshots (interview, A/B streaming, completion) to `docs/superpowers/` for the PR. No commit of secrets/URLs.

---

## Task 3: Guardrail & error paths (manual)

- [ ] **Step 1: Sensitive input blocked**

In an interview answer, paste `https://github.com/acme/repo` → expect an inline error (`sensitive_blocked`), no LLM call, transcript preserved.

- [ ] **Step 2: Turnstile failure**

Temporarily set the sitekey to `2x00000000000000000000AB` (always fails), reload, attempt the first turn → expect `turnstile_failed` (403) surfaced as a friendly error. Revert to the pass key.

- [ ] **Step 3: Rate limit**

Lower `RL_PER_MIN` locally to 2 (in `functions/api/_lib/guardrails.js`), restart dev, send 3 quick turns → expect `rate_limited` (429) friendly message. Revert the constant.

- [ ] **Step 4: LLM failure fallback**

Temporarily set an invalid `ANTHROPIC_API_KEY` in `.dev.vars`, restart, run a turn → expect `llm_unavailable` (503) friendly message, transcript preserved (no data loss). Restore the key.

- [ ] **Step 5: Empty endpoint fail-closed**

Set `window.DEVPATH_FORM_ENDPOINT = ''`, complete to rating, submit → expect the "저장 URL이 설정되지 않았습니다" error (no false success). Restore.

- [ ] **Step 6: Full unit suite green**

Run: `node --test`
Expected: all PASS (Build A + B + C suites). If any E2E defect was fixed in code, ensure a regression unit test was added in the owning build's test file.

---

## Self-Review (completed by author)

- **Spec coverage:** §11 E2E (start→turns→gate→A/B→rate→Sheets) → Task 2; §8 guardrails live (sensitive/Turnstile/rate/budget) → Task 3; §10 error handling (LLM fail, fail-closed, transcript preserved) → Task 3.
- **Placeholder scan:** none — every step is an executable command or a concrete browser action with an expected result.
- **Type consistency:** column names checked in Task 2 Step 3 match Build A `HEADERS`/`buildInterviewPayload`; error codes (`sensitive_blocked`/`turnstile_failed`/`rate_limited`/`llm_unavailable`) match Build B endpoints.

---

## Depends on / feeds

- Depends on: Builds A, B, C.
- Feeds: Build E (deploy) proceeds once E2E is green.
