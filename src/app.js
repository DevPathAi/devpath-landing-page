import {
  CONSENT_VERSION,
  SUBMISSION_STATES,
  buildStep1Payload,
  buildStep2Payload,
  createSafeDraft,
  createLeadId,
  parseAttribution,
  validateStep1,
  validateStep2,
} from './form-utils.js';

const STORAGE_KEYS = Object.freeze({
  leadId: 'devpath.validation.lead_id',
  draft: 'devpath.validation.draft',
});

const endpoint = window.DEVPATH_FORM_ENDPOINT || '';
const consentVersion = window.DEVPATH_CONSENT_VERSION || CONSENT_VERSION;
const landingVariant = window.DEVPATH_LANDING_VARIANT || 'smoke-test-v1';
const attribution = parseAttribution(window.location.href, document.referrer);

const form = document.querySelector('#lead-form');
const leadIdInput = document.querySelector('#lead-id');
const step2 = document.querySelector('[data-step="2"]');
const saveStep1Button = document.querySelector('#save-step1');
const statusNode = document.querySelector('#form-status');
const progressFill = document.querySelector('#progress-fill');
const progressLabels = document.querySelector('#progress-labels');
const thankyou = document.querySelector('#thankyou');

let state = SUBMISSION_STATES.idle;

function setState(nextState, message = '', tone = '') {
  state = nextState;
  const isSubmitting =
    nextState === SUBMISSION_STATES.submittingStep1 ||
    nextState === SUBMISSION_STATES.submittingStep2;
  for (const button of form.querySelectorAll('button')) {
    button.disabled = isSubmitting;
  }
  statusNode.textContent = message;
  if (tone) statusNode.dataset.tone = tone;
  else delete statusNode.dataset.tone;
}

function getOrCreateLeadId() {
  const existing = window.localStorage.getItem(STORAGE_KEYS.leadId);
  if (existing) return existing;
  const leadId = createLeadId();
  window.localStorage.setItem(STORAGE_KEYS.leadId, leadId);
  return leadId;
}

function readFormData() {
  const data = new FormData(form);
  return {
    lead_id: leadIdInput.value,
    email: data.get('email') || '',
    current_stage: data.get('current_stage') || '',
    consent_required: data.get('consent_required') === 'on',
    stack: data.get('stack') || '',
    recent_stuck_moment: data.get('recent_stuck_moment') || '',
    wtp_krw: data.get('wtp_krw') || '',
    interview_opt_in: data.get('interview_opt_in') === 'on',
  };
}

function storeDraft() {
  const data = readFormData();
  window.localStorage.setItem(STORAGE_KEYS.draft, JSON.stringify(createSafeDraft(data)));
}

function restoreDraft() {
  const raw = window.localStorage.getItem(STORAGE_KEYS.draft);
  if (!raw) return;
  try {
    const draft = JSON.parse(raw);
    for (const [name, value] of Object.entries(draft)) {
      const field = form.elements.namedItem(name);
      if (!field) continue;
      if (field.type === 'checkbox') field.checked = Boolean(value);
      else field.value = value;
    }
  } catch {
    window.localStorage.removeItem(STORAGE_KEYS.draft);
  }
}

function clearDraft() {
  window.localStorage.removeItem(STORAGE_KEYS.draft);
}

async function postPayload(payload) {
  if (!endpoint) {
    throw new Error('폼 저장 URL이 아직 설정되지 않았습니다. DEVPATH_FORM_ENDPOINT를 배포 URL로 설정해주세요.');
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`저장 서버 응답 오류 (${response.status})`);
  }

  const result = await response.json();
  if (!result.ok) {
    throw new Error(result.error || '저장에 실패했습니다.');
  }
  return result;
}

function showThankYou() {
  form.hidden = true;
  thankyou.hidden = false;
}

function updateProgress(step) {
  if (!progressFill) return;
  if (step === 1) {
    progressFill.style.width = '50%';
    if (progressLabels) {
      const labels = progressLabels.querySelectorAll('span:not(.done-label)');
      labels[0] && (labels[0].classList.add('active'));
      labels[1] && (labels[1].classList.remove('active'));
    }
  } else if (step === 2) {
    progressFill.style.width = '100%';
    if (progressLabels) {
      const labels = progressLabels.querySelectorAll('span:not(.done-label)');
      labels[0] && (labels[0].classList.remove('active'));
      labels[1] && (labels[1].classList.add('active'));
    }
  } else if (step === 'done') {
    progressFill.style.width = '100%';
    progressFill.style.background = 'var(--green)';
    if (progressLabels) {
      const labels = progressLabels.querySelectorAll('span:not(.done-label)');
      labels[0] && (labels[0].classList.remove('active'));
      labels[1] && (labels[1].classList.remove('active'));
      const doneLabel = progressLabels.querySelector('.done-label');
      doneLabel && (doneLabel.hidden = false);
    }
  }
}

async function submitStep1() {
  const data = readFormData();
  const errors = validateStep1(data);
  if (errors.length > 0) {
    setState(SUBMISSION_STATES.idle, errors[0], 'error');
    return;
  }

  setState(SUBMISSION_STATES.submittingStep1, '대기자 정보를 저장하고 있습니다...');
  storeDraft();

  try {
    const payload = buildStep1Payload(data, {
      ...attribution,
      consentVersion,
      landingVariant,
    });
    await postPayload(payload);
    step2.hidden = false;
    updateProgress(2);
    setState(SUBMISSION_STATES.profilingStep2, '등록 완료. 한 가지만 더 답하면 인터뷰 우선순위를 정할 수 있습니다.', 'success');

    // Scroll to step 2 smoothly
    step2.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) {
    setState(SUBMISSION_STATES.failedRetryable, error.message, 'error');
  }
}

async function submitStep2(event) {
  event.preventDefault();
  const data = readFormData();
  const errors = [...validateStep1(data), ...validateStep2(data)];
  if (errors.length > 0) {
    setState(SUBMISSION_STATES.profilingStep2, errors[0], 'error');
    return;
  }

  setState(SUBMISSION_STATES.submittingStep2, '인터뷰 신청 정보를 저장하고 있습니다...');
  storeDraft();

  try {
    const payload = buildStep2Payload(data);
    await postPayload(payload);
    clearDraft();
    updateProgress('done');
    showThankYou();
  } catch (error) {
    setState(SUBMISSION_STATES.failedRetryable, error.message, 'error');
  }
}

/* ── Initialize ── */
leadIdInput.value = getOrCreateLeadId();
restoreDraft();
updateProgress(1);
saveStep1Button.addEventListener('click', submitStep1);
form.addEventListener('submit', submitStep2);
form.addEventListener('input', () => {
  if (state !== SUBMISSION_STATES.savedStep2) storeDraft();
});

/* ── Navigation hamburger ── */
(function initNav() {
  const hamburger = document.getElementById('nav-hamburger');
  const links = document.getElementById('nav-links');
  if (!hamburger || !links) return;

  hamburger.addEventListener('click', () => {
    const expanded = hamburger.getAttribute('aria-expanded') === 'true';
    hamburger.setAttribute('aria-expanded', String(!expanded));
    links.classList.toggle('open');
  });

  // Close menu when a link is clicked
  links.querySelectorAll('a').forEach(a => {
    a.addEventListener('click', () => {
      hamburger.setAttribute('aria-expanded', 'false');
      links.classList.remove('open');
    });
  });
})();

/* ── Scroll fade-in (IntersectionObserver) ── */
(function initScrollFade() {
  const elements = document.querySelectorAll('.scroll-fade');
  if (!elements.length) return;

  // Respect reduced motion
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    elements.forEach(el => el.classList.add('visible'));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, {
    threshold: 0.15,
    rootMargin: '0px 0px -40px 0px',
  });

  elements.forEach(el => observer.observe(el));
})();

/* ── Particle background ── */
(function initParticles() {
  const canvas = document.getElementById('particle-canvas');
  if (!canvas) return;

  // Respect reduced motion
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    canvas.style.display = 'none';
    return;
  }

  const ctx = canvas.getContext('2d');
  let width, height;
  let particles = [];
  let animId;

  const PARTICLE_COUNT = 40;
  const CONNECT_DIST = 140;

  function resize() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  }

  function createParticle() {
    return {
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      r: Math.random() * 1.5 + 0.5,
    };
  }

  function init() {
    resize();
    particles = [];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push(createParticle());
    }
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;

      // Wrap around
      if (p.x < -10) p.x = width + 10;
      if (p.x > width + 10) p.x = -10;
      if (p.y < -10) p.y = height + 10;
      if (p.y > height + 10) p.y = -10;

      // Draw particle
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(57, 197, 207, 0.35)';
      ctx.fill();

      // Draw connections
      for (let j = i + 1; j < particles.length; j++) {
        const q = particles[j];
        const dx = p.x - q.x;
        const dy = p.y - q.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < CONNECT_DIST) {
          const alpha = (1 - dist / CONNECT_DIST) * 0.12;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
          ctx.strokeStyle = `rgba(57, 197, 207, ${alpha})`;
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
      }
    }

    animId = requestAnimationFrame(draw);
  }

  init();
  draw();

  window.addEventListener('resize', () => {
    resize();
  });
})();