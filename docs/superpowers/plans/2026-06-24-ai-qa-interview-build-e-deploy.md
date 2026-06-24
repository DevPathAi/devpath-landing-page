# AI Q&A Interview — Build E: Cloudflare Pages Deploy & Provisioning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship the feature on Cloudflare Pages + Functions with secrets, KV, and Turnstile wired, and verify a live end-to-end run.

**Architecture:** A Cloudflare Pages project serves the static root and the `functions/` Functions on one domain; secrets (`ANTHROPIC_API_KEY`, `TURNSTILE_SECRET`) and a KV binding (`INTERVIEW_KV`) are configured in the project; public frontend values (Turnstile sitekey, Apps Script endpoint) are set in `index.html`.

**Tech Stack:** Cloudflare Pages/Workers, Cloudflare KV, Turnstile, Google Apps Script Web App.

**Spec:** `docs/superpowers/specs/2026-06-24-ai-qa-interview-design.md` (§3, §13).

## Global Constraints

- **User-provisioned prerequisites (account access required):** Cloudflare account; Anthropic API key; a Turnstile site (sitekey + secret); the Apps Script Web App `/exec` URL (deploy `apps-script/Code.gs` to the production Sheet — see the landing deploy memory).
- Secrets live **only** in Cloudflare project settings (never in the repo). Public values (Turnstile sitekey, Apps Script URL) are committed in `index.html`.
- Branch flow: production `index.html` value edits go via `feat/ai-qa-interview` → `develop` → `main`. The hosting move means the **static baseline (PR #1) should be merged first**, then this feature.
- Supersedes the earlier GitHub Pages target for this repo (Pages can't run the backend).

---

## File Structure

- Modify: `index.html` — set production `DEVPATH_TURNSTILE_SITEKEY`, widget `data-sitekey`, and `DEVPATH_FORM_ENDPOINT` to real values.
- Create: `README` deploy section update (Cloudflare Pages instructions) — optional but recommended.
- (Infra config lives in the Cloudflare dashboard / `wrangler`, not the repo.)

---

## Task 1: Provision Cloudflare resources (user)

- [ ] **Step 1: KV namespace**

Run (authenticated `wrangler`):
```bash
npx wrangler kv namespace create INTERVIEW_KV
```
Record the namespace id.

- [ ] **Step 2: Turnstile site**

In the Cloudflare dashboard → Turnstile, create a widget for the production domain. Record **sitekey** (public) and **secret**.

- [ ] **Step 3: Create the Pages project**

Connect the GitHub repo `DevPathAi/devpath-landing-page` as a Cloudflare Pages project (or `npx wrangler pages project create devpath-landing-page`). Build settings:
- Build command: `npm run build`
- Build output directory: `.` (repo root; static files + `functions/` are served automatically)
- Production branch: `main`

- [ ] **Step 4: Bind secrets + KV (Production and Preview)**

In Pages project → Settings → Functions/Environment:
- Secret `ANTHROPIC_API_KEY` = the Anthropic key
- Secret `TURNSTILE_SECRET` = the Turnstile secret
- KV binding: variable name `INTERVIEW_KV` → the namespace from Step 1

---

## Task 2: Set production frontend values

- [ ] **Step 1: Edit `index.html`**

Set the real public values:
- `window.DEVPATH_TURNSTILE_SITEKEY = '<production sitekey>';`
- `window.DEVPATH_FORM_ENDPOINT = '<Apps Script /exec URL>';`
- The `#turnstile-widget` `data-sitekey` is populated from `DEVPATH_TURNSTILE_SITEKEY` by the existing DOMContentLoaded script (Build C), so no manual `data-sitekey` edit is required.

- [ ] **Step 2: Build + clean-bundle check**

```bash
npm run build
grep -nE "^(import|export)\b" src/app.bundle.js || echo "BUNDLE_CLEAN"
node --test
```
Expected: `BUNDLE_CLEAN`, all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add index.html src/app.bundle.js
git commit -m "chore(deploy): set production Turnstile sitekey and form endpoint"
```

---

## Task 3: Deploy + live smoke

- [ ] **Step 1: Merge through the branch flow**

Open `feat/ai-qa-interview` → `develop` PR; after review/merge, open `develop` → `main` release PR. Cloudflare Pages builds `main` automatically (or `npx wrangler pages deploy .`).

- [ ] **Step 2: Live smoke test**

On the production URL:
1. Complete one interview → gate → A/B → rating → submit.
2. Confirm a row in the production `leads` sheet.
3. Confirm the Turnstile widget renders and the first turn requires it.

Expected: full funnel works on the live domain.

- [ ] **Step 3: Cost/abuse watch**

Confirm KV keys appear (`rl:*`, `budget:*`). Note the daily budget cap (`BUDGET_PER_DAY`) and watch Anthropic usage for the first day of real traffic.

- [ ] **Step 4: Custom domain (optional)**

Attach the production domain in Pages → Custom domains; re-issue the Turnstile widget for that hostname if needed.

---

## Self-Review (completed by author)

- **Spec coverage:** §3 hosting (Cloudflare Pages + Functions, one domain) → Tasks 1/3; §13 deploy/env/KV/Turnstile/branch-flow → Tasks 1–3.
- **Placeholder scan:** none — steps are concrete commands/dashboard actions; `<production sitekey>`/`<Apps Script /exec URL>` are user-supplied secrets/values by design, not unspecified plan content.
- **Type consistency:** binding name `INTERVIEW_KV` and secret names `ANTHROPIC_API_KEY`/`TURNSTILE_SECRET` match Build B `env.*` usage; `DEVPATH_TURNSTILE_SITEKEY`/`DEVPATH_FORM_ENDPOINT` match Build C `index.html`/`app.js`.

---

## Depends on / feeds

- Depends on: Builds A–D green; user-provisioned accounts/keys.
- Feeds: production launch. Update the landing deploy memory once live.
