# DevPath AI landing validation page

48-hour smoke-test landing page for DevPath AI pre-validation.

This repo intentionally starts smaller than the long-term Jaspr landing plan. It ships a static one-screen page plus a Google Apps Script + Google Sheets evidence pipeline so user interviews can start before the polished marketing site.

## What This Captures

- Step 1: email, current stage, required consent, UTM/referrer/variant.
- Step 2: stack, recent stuck moment, optional WTP, interview opt-in.
- Lead identity: stable `lead_id`, normalized email, consent version.
- Data quality: Step 1 insert, Step 2 upsert, duplicate-submit protection.
- Privacy: blocks obvious source code, stack traces, GitHub URLs, tokens, DB URLs, and long logs.

## Files

- `index.html` — static smoke-test page.
- `styles.css` — responsive landing styles.
- `src/form-utils.js` — testable form, validation, state, and payload helpers.
- `src/app.js` — browser form controller and Apps Script submission.
- `apps-script/Code.gs` — Google Apps Script Web App backend for Sheets upsert.
- `tests/form-utils.test.mjs` — Node built-in test suite.

## Configure

1. Create a Google Sheet with these tabs:
   - `leads`
   - `interview_pipeline`
   - `report_waitlist`
   - `report_wtp`
   - `report_lcs_evidence`
   - `report_beta_candidates`
2. Open Apps Script for the sheet.
3. Paste `apps-script/Code.gs`.
4. Set Script Property `SHEET_ID` to the target spreadsheet ID, or leave it unset if the script is bound to that sheet.
5. Deploy as Web App with access set for the form audience.
6. Put the Web App URL into `index.html`:

```html
<script>
  window.DEVPATH_FORM_ENDPOINT = 'https://script.google.com/macros/s/.../exec';
</script>
```

## Run Locally

Open `index.html` in a browser. If `DEVPATH_FORM_ENDPOINT` is empty, submissions stop with a retryable setup error instead of pretending success.

## Test

Use Node 20+:

```bash
node --test
```

If Node is not on PATH inside Codex Desktop, use the bundled runtime:

```powershell
& "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" --test
```

## Privacy Rule

The public form must only collect a short situation description. Do not collect source code, stack traces, GitHub repository URLs, API keys, tokens, DB URLs, company confidential information, or long logs through this page. Real code/log review belongs in a concierge session after separate consent.
