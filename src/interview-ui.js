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
    wrap.setEnabled = (on) => { ta.disabled = !on; btn.disabled = !on; };
    wrap.addEventListener('submit', (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      const v = ta.value.trim();
      if (!v) return;
      onSend(v, wrap);
    });
    root.append(wrap); ta.focus(); return wrap;
  }

  async function nextTurn(inputWrap) {
    setStatus('생각 중...');
    if (inputWrap) inputWrap.setEnabled(false);
    try {
      const { question, done } = await client.sendTurn({ history, turnstileToken: config.turnstileToken() });
      setStatus('');
      if (question) { addBubble('assistant', question); history.push({ role: 'assistant', text: question }); }
      if (done) { if (inputWrap) inputWrap.remove(); renderGate(); }
      else if (inputWrap) { inputWrap.setEnabled(true); inputWrap.querySelector('textarea').focus(); }
      return true;
    } catch (err) {
      setStatus(`오류: ${err.message}. 다시 시도해주세요.`, 'error');
      if (inputWrap) inputWrap.setEnabled(true);
      return false;
    }
  }

  function startInterview() {
    const opener = '최근 Java/Spring을 공부하다 가장 막혔던 순간은 무엇이었나요?';
    addBubble('assistant', opener); history.push({ role: 'assistant', text: opener });
    const wrap = renderInput(async (v, w) => {
      const bubble = addBubble('user', v);
      history.push({ role: 'user', text: v });
      w.querySelector('textarea').value = '';
      const ok = await nextTurn(w);
      if (!ok) {
        history.pop();
        bubble.remove();
        w.querySelector('textarea').value = v;
      }
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
      if (btn.disabled) return;
      btn.disabled = true;
      const ok = await save(Number(range.value));
      if (ok) form.remove();
      else btn.disabled = false;
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
    if (!config.endpoint) { setStatus('저장 URL이 설정되지 않았습니다. 잠시 후 다시 시도해주세요.', 'error'); return false; }
    try {
      const res = await fetch(config.endpoint, { method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error(`저장 서버 오류 (${res.status})`);
      const result = await res.json();
      if (!result.ok) throw new Error(result.error || '저장 실패');
      setStatus('');
      root.append(el('div', 'iv-done', '신청이 완료되었습니다! 베타 우선 초대 대상자에게 이메일로 연락드리겠습니다.'));
      return true;
    } catch (err) { setStatus(`저장 오류: ${err.message}`, 'error'); return false; }
  }

  if (!window.DEVPATH_TURNSTILE_SITEKEY) {
    setStatus('데모 준비 중입니다(보안 위젯 미설정).', 'error');
    return;
  }
  startInterview();
}
