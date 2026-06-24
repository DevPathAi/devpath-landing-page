export const CONSENT_VERSION = '2026-06-24-smoke-v1';

export const SUBMISSION_STATES = Object.freeze({
  idle: 'idle',
  submittingStep1: 'submitting_step1',
  savedStep1: 'saved_step1',
  profilingStep2: 'profiling_step2',
  submittingStep2: 'submitting_step2',
  savedStep2: 'saved_step2',
  failedRetryable: 'failed_retryable',
});

const SENSITIVE_PATTERNS = [
  { name: 'GitHub URL', pattern: /github\.com\/[\w.-]+\/[\w.-]+/i },
  { name: 'URL', pattern: /https?:\/\//i },
  { name: 'password', pattern: /\bpassword\s*=/i },
  { name: 'token', pattern: /\b(token|api[_-]?key|secret)\s*[:=]/i },
  { name: 'private key', pattern: /BEGIN\s+(RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE KEY/i },
  { name: 'env file', pattern: /\.env\b/i },
  { name: 'JDBC URL', pattern: /jdbc:[a-z]+:\/\//i },
  { name: 'stack trace', pattern: /\n\s+at\s+[\w.$<>]+/i },
  { name: 'long multiline log', pattern: /(?:\n.*){5,}/ },
];

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

export function createLeadId(randomSource = globalThis.crypto) {
  if (randomSource && typeof randomSource.randomUUID === 'function') {
    return randomSource.randomUUID();
  }
  const random = Math.random().toString(36).slice(2, 10);
  return `lead_${Date.now().toString(36)}_${random}`;
}

export function parseAttribution(urlLike, referrer = '') {
  const url = new URL(urlLike, 'https://devpath.ai/');
  return {
    utm_source: url.searchParams.get('utm_source') || '',
    utm_medium: url.searchParams.get('utm_medium') || '',
    utm_campaign: url.searchParams.get('utm_campaign') || '',
    utm_content: url.searchParams.get('utm_content') || '',
    referrer: referrer || '',
  };
}

export function detectSensitiveInput(value) {
  const text = String(value || '');
  return SENSITIVE_PATTERNS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ name }) => name);
}

export function validateStep1(data) {
  const errors = [];
  if (!isValidEmail(data.email)) errors.push('올바른 이메일을 입력해주세요.');
  if (!data.current_stage) errors.push('현재 단계를 선택해주세요.');
  if (!data.consent_required) errors.push('필수 개인정보 수집·이용에 동의해주세요.');
  return errors;
}

export function validateStep2(data) {
  const errors = [];
  const sensitiveMatches = detectSensitiveInput(data.recent_stuck_moment);
  if (sensitiveMatches.length > 0) {
    errors.push(`코드·로그·URL·비밀값은 제출하지 말아주세요. 감지: ${sensitiveMatches.join(', ')}`);
  }
  if (Number(data.wtp_krw) < 0) errors.push('가격은 0 이상이어야 합니다.');
  return errors;
}

export function buildStep1Payload(data, context = {}) {
  const now = context.now || new Date().toISOString();
  return {
    action: 'step1',
    lead_id: data.lead_id,
    email_raw: String(data.email || '').trim(),
    email_normalized: normalizeEmail(data.email),
    current_stage: data.current_stage || '',
    consent_required: Boolean(data.consent_required),
    consent_version: context.consentVersion || CONSENT_VERSION,
    consent_accepted_at: now,
    step1_submitted_at: now,
    last_updated_at: now,
    utm_source: context.utm_source || '',
    utm_medium: context.utm_medium || '',
    utm_campaign: context.utm_campaign || '',
    utm_content: context.utm_content || '',
    referrer: context.referrer || '',
    landing_variant: context.landingVariant || 'smoke-test-v1',
  };
}

export function buildStep2Payload(data, context = {}) {
  const now = context.now || new Date().toISOString();
  return {
    action: 'step2',
    lead_id: data.lead_id,
    email_normalized: normalizeEmail(data.email),
    stack: String(data.stack || '').trim(),
    recent_stuck_moment: String(data.recent_stuck_moment || '').trim(),
    wtp_krw: data.wtp_krw === '' || data.wtp_krw == null ? '' : Number(data.wtp_krw),
    interview_opt_in: Boolean(data.interview_opt_in),
    step2_submitted_at: now,
    last_updated_at: now,
  };
}

export function createSafeDraft(data) {
  const recentStuckMoment = String(data.recent_stuck_moment || '');
  return {
    email: data.email || '',
    current_stage: data.current_stage || '',
    consent_required: Boolean(data.consent_required),
    stack: data.stack || '',
    recent_stuck_moment: detectSensitiveInput(recentStuckMoment).length > 0 ? '' : recentStuckMoment,
    wtp_krw: data.wtp_krw || '',
    interview_opt_in: Boolean(data.interview_opt_in),
  };
}

export function pickBlindOrder(seed) {
  const contextFirst = (Math.abs(Math.trunc(Number(seed) || 0)) % 2) === 0;
  return {
    contextSide: contextFirst ? 1 : 2,
    order: contextFirst ? ['context', 'generic'] : ['generic', 'context'],
  };
}

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

export function mergeRows(existing, incoming) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === '' || value === null || typeof value === 'undefined') continue;
    merged[key] = value;
  }
  return merged;
}
