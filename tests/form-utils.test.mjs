import test from 'node:test';
import assert from 'node:assert/strict';

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

test('normalizes and validates email addresses', () => {
  assert.equal(normalizeEmail('  User@Example.COM '), 'user@example.com');
  assert.equal(isValidEmail('user@example.com'), true);
  assert.equal(isValidEmail('not-an-email'), false);
});

test('captures UTM attribution and referrer', () => {
  const attribution = parseAttribution('https://devpath.ai/?utm_source=github&utm_medium=readme&utm_campaign=smoke&utm_content=top', 'https://github.com/DevPathAi');
  assert.deepEqual(attribution, {
    utm_source: 'github',
    utm_medium: 'readme',
    utm_campaign: 'smoke',
    utm_content: 'top',
    referrer: 'https://github.com/DevPathAi',
  });
});

test('validates Step 1 required fields', () => {
  assert.deepEqual(validateStep1({
    email: 'learner@example.com',
    current_stage: 'job_seeker',
    consent_required: true,
  }), []);

  assert.equal(validateStep1({
    email: 'bad',
    current_stage: '',
    consent_required: false,
  }).length, 3);
});

test('builds Step 1 payload with consent version and attribution', () => {
  const payload = buildStep1Payload({
    lead_id: 'lead-1',
    email: ' USER@EXAMPLE.COM ',
    current_stage: 'junior_dev',
    consent_required: true,
  }, {
    now: '2026-06-24T00:00:00.000Z',
    consentVersion: 'v-test',
    landingVariant: 'variant-a',
    utm_source: 'github',
  });

  assert.equal(payload.email_normalized, 'user@example.com');
  assert.equal(payload.consent_version, 'v-test');
  assert.equal(payload.utm_source, 'github');
  assert.equal(payload.landing_variant, 'variant-a');
});

test('detects sensitive input in recent stuck moment', () => {
  assert.deepEqual(detectSensitiveInput('JPA N+1에서 어디부터 봐야 할지 모르겠습니다.'), []);
  assert.ok(detectSensitiveInput('https://github.com/acme/private-repo').includes('GitHub URL'));
  assert.ok(detectSensitiveInput('password=secret').includes('password'));
  assert.ok(detectSensitiveInput('-----BEGIN PRIVATE KEY-----').includes('private key'));
});

test('validates Step 2 sensitive input and negative WTP', () => {
  assert.deepEqual(validateStep2({
    recent_stuck_moment: 'LazyInitializationException 원인을 어디서 봐야 할지 모르겠습니다.',
    wtp_krw: 15000,
  }), []);

  const errors = validateStep2({
    recent_stuck_moment: 'token: abc123',
    wtp_krw: -1000,
  });
  assert.equal(errors.length, 2);
});

test('builds Step 2 payload without erasing optional blanks', () => {
  const payload = buildStep2Payload({
    lead_id: 'lead-1',
    email: 'user@example.com',
    stack: 'Java, Spring, JPA',
    recent_stuck_moment: 'N+1 문제를 보고 있는데 fetch join 기준이 헷갈립니다.',
    wtp_krw: '',
    interview_opt_in: true,
  }, {
    now: '2026-06-24T00:05:00.000Z',
  });

  assert.equal(payload.wtp_krw, '');
  assert.equal(payload.interview_opt_in, true);
  assert.equal(payload.step2_submitted_at, '2026-06-24T00:05:00.000Z');
});

test('mergeRows keeps prior values when incoming values are empty', () => {
  assert.deepEqual(mergeRows({
    lead_id: 'lead-1',
    email_normalized: 'user@example.com',
    stack: 'Java',
  }, {
    stack: '',
    recent_stuck_moment: 'JPA transaction boundary가 헷갈립니다.',
  }), {
    lead_id: 'lead-1',
    email_normalized: 'user@example.com',
    stack: 'Java',
    recent_stuck_moment: 'JPA transaction boundary가 헷갈립니다.',
  });
});

test('createSafeDraft omits sensitive recent stuck moment from localStorage drafts', () => {
  assert.deepEqual(createSafeDraft({
    email: 'learner@example.com',
    current_stage: 'job_seeker',
    consent_required: true,
    stack: 'Spring',
    recent_stuck_moment: 'https://github.com/acme/private-repo 에러입니다',
    wtp_krw: '15000',
    interview_opt_in: true,
  }), {
    email: 'learner@example.com',
    current_stage: 'job_seeker',
    consent_required: true,
    stack: 'Spring',
    recent_stuck_moment: '',
    wtp_krw: '15000',
    interview_opt_in: true,
  });
});

test('pickBlindOrder maps even/odd seed to deterministic blind order', () => {
  assert.deepEqual(pickBlindOrder(0), { contextSide: 1, order: ['context', 'generic'] });
  assert.deepEqual(pickBlindOrder(1), { contextSide: 2, order: ['generic', 'context'] });
  assert.deepEqual(pickBlindOrder(2), { contextSide: 1, order: ['context', 'generic'] });
  assert.equal(pickBlindOrder(undefined).contextSide, 1);
});

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

test('sanitizeTranscript drops entries with unknown or missing role', () => {
  assert.deepEqual(sanitizeTranscript([
    { role: 'user', text: '막힘' },
    { role: undefined, text: '누가 말했는지 모름' },
    { role: 'system', text: 'x' },
    { role: 'assistant', text: '질문' },
  ]), [
    { role: 'user', text: '막힘' },
    { role: 'assistant', text: '질문' },
  ]);
});

test('pickBlindOrder handles negative seeds via absolute value', () => {
  assert.equal(pickBlindOrder(-1).contextSide, 2);
  assert.equal(pickBlindOrder(-2).contextSide, 1);
});
