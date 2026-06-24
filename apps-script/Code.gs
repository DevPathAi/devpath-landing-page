const LEADS_SHEET_NAME = 'leads';

const HEADERS = [
  'lead_id',
  'email_normalized',
  'email_raw',
  'consent_required',
  'consent_version',
  'consent_accepted_at',
  'step1_submitted_at',
  'step2_submitted_at',
  'last_updated_at',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'referrer',
  'landing_variant',
  'current_stage',
  'stack',
  'recent_stuck_moment',
  'wtp_krw',
  'pain_specificity_score',
  'spring_fit_score',
  'source_quality_score',
  'lead_score',
  'status',
  'shortlisted_at',
  'invited_at',
  'scheduled_at',
  'completed_at',
  'honorarium_paid_at',
  'insight_coded_at',
  'interview_transcript',
  'interview_turns',
  'ab_distilled_question',
  'ab_context_side',
  'ab_user_choice',
  'ab_rating_1to5',
  'ab_completed_at',
];

const SENSITIVE_PATTERNS = [
  /github\.com\/[\w.-]+\/[\w.-]+/i,
  /https?:\/\//i,
  /\bpassword\s*=/i,
  /\b(token|api[_-]?key|secret)\s*[:=]/i,
  /BEGIN\s+(RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE KEY/i,
  /\.env\b/i,
  /jdbc:[a-z]+:\/\//i,
  /\n\s+at\s+[\w.$<>]+/i,
  /(?:\n.*){5,}/,
];

function doPost(e) {
  try {
    const payload = parsePayload_(e);
    validatePayload_(payload);

    const sheet = getLeadsSheet_();
    ensureHeaders_(sheet);
    const headers = getHeaders_(sheet);
    const rowNumber = findRow_(sheet, headers, payload.lead_id, payload.email_normalized);
    const existing = rowNumber ? rowToObject_(sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0], headers) : {};
    const merged = mergeRows_(existing, decoratePayload_(payload));

    if (!merged.status) merged.status = 'new';
    recomputeScores_(merged);

    if (rowNumber) {
      sheet.getRange(rowNumber, 1, 1, headers.length).setValues([objectToRow_(merged, headers)]);
    } else {
      sheet.appendRow(objectToRow_(merged, headers));
    }

    return json_({ ok: true, lead_id: merged.lead_id, updated: Boolean(rowNumber) });
  } catch (error) {
    return json_({ ok: false, error: error.message });
  }
}

function parsePayload_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error('Missing request body.');
  }
  return JSON.parse(e.postData.contents);
}

function validatePayload_(payload) {
  if (!payload.lead_id && !payload.email_normalized) {
    throw new Error('lead_id or email_normalized is required.');
  }
  if (payload.action === 'step1') {
    if (!payload.email_normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email_normalized)) {
      throw new Error('Valid email is required.');
    }
    if (!payload.current_stage) throw new Error('current_stage is required.');
    if (payload.consent_required !== true) throw new Error('Required consent is missing.');
  }
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
  if (payload.recent_stuck_moment && SENSITIVE_PATTERNS.some((pattern) => pattern.test(payload.recent_stuck_moment))) {
    throw new Error('Sensitive code, URL, token, or log-like input is not allowed.');
  }
}

function decoratePayload_(payload) {
  const decorated = Object.assign({}, payload);
  delete decorated.action;
  if (decorated.email_normalized) decorated.email_normalized = String(decorated.email_normalized).trim().toLowerCase();
  return decorated;
}

function recomputeScores_(row) {
  row.pain_specificity_score = scorePainSpecificity_(row.recent_stuck_moment);
  row.spring_fit_score = scoreSpringFit_(row.stack);
  row.source_quality_score = scoreSourceQuality_(row.utm_source);
  row.lead_score = Number(row.pain_specificity_score || 0) + Number(row.spring_fit_score || 0) + Number(row.source_quality_score || 0);
}

function mergeRows_(existing, incoming) {
  const merged = Object.assign({}, existing);
  Object.keys(incoming).forEach((key) => {
    const value = incoming[key];
    if (value === '' || value === null || typeof value === 'undefined') return;
    merged[key] = value;
  });
  return merged;
}

function getLeadsSheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  const spreadsheet = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('Spreadsheet not found. Set SHEET_ID or bind this script to a sheet.');
  return spreadsheet.getSheetByName(LEADS_SHEET_NAME) || spreadsheet.insertSheet(LEADS_SHEET_NAME);
}

function ensureHeaders_(sheet) {
  const current = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), HEADERS.length)).getValues()[0];
  const missing = HEADERS.filter((header) => !current.includes(header));
  if (sheet.getLastRow() === 0 || current.every((value) => value === '')) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    return;
  }
  if (missing.length > 0) {
    sheet.getRange(1, current.length + 1, 1, missing.length).setValues([missing]);
  }
}

function getHeaders_(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
}

function findRow_(sheet, headers, leadId, emailNormalized) {
  if (sheet.getLastRow() < 2) return 0;
  const leadIdIndex = headers.indexOf('lead_id');
  const emailIndex = headers.indexOf('email_normalized');
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (leadId && row[leadIdIndex] === leadId) return index + 2;
    if (emailNormalized && row[emailIndex] === emailNormalized) return index + 2;
  }
  return 0;
}

function rowToObject_(row, headers) {
  return headers.reduce((acc, header, index) => {
    acc[header] = row[index];
    return acc;
  }, {});
}

function objectToRow_(object, headers) {
  return headers.map((header) => Object.prototype.hasOwnProperty.call(object, header) ? object[header] : '');
}

function scorePainSpecificity_(text) {
  const value = String(text || '').trim();
  if (!value) return 0;
  if (value.length >= 80) return 3;
  if (value.length >= 35) return 2;
  return 1;
}

function scoreSpringFit_(stack) {
  const value = String(stack || '').toLowerCase();
  let score = 0;
  if (value.includes('java')) score += 1;
  if (value.includes('spring')) score += 2;
  if (value.includes('jpa')) score += 1;
  return score;
}

function scoreSourceQuality_(source) {
  const value = String(source || '').toLowerCase();
  if (['github', 'docs', 'blog', 'readme'].includes(value)) return 2;
  if (value) return 1;
  return 0;
}

function json_(object) {
  return ContentService
    .createTextOutput(JSON.stringify(object))
    .setMimeType(ContentService.MimeType.JSON);
}

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
