# DevPath AI — AI 질의응답 인터뷰(가이드 인터뷰형 데모) 설계

- 날짜: 2026-06-24
- 상태: 설계 승인됨(브레인스토밍 완료) → 구현 계획(writing-plans) 대기
- 작업 브랜치: `feat/ai-qa-interview` (← `feat/validation-smoke-test` 분기)
- 선행 의존: PR #1(`feat/validation-smoke-test` → `develop`) 머지 권장. 본 기능은 정적 베이스라인 위에 얹힌다.
- 구현 전략: **A. Lean MVP** (고른 경험 전부 + 최소 인프라)

---

## 1. 배경 & 목표

현재 랜딩(`index.html`)의 "인터뷰"는 **30분 화상 통화**(Zoom/Meet) 옵트인이다. 이를 **AI 적응형 가이드 인터뷰**로 대체한다.

- 화상 인터뷰의 **질문 흐름을 AI가 대체**한다(인터뷰 진행자 역할, 멀티턴, 적응형).
- 스모크 테스트 자체가 제품의 1차 아하 모먼트(**학습 맥락을 반영한 AI 답변**)를 실증하는 **데모**가 된다.
- 검증 지표: 인터뷰 끝에서 **A/B 블라인드 비교**(맥락 반영 답변 vs 맥락 무시 일반 답변) + **1~5점 + 선택**.
- 현재 페이지 evidence 섹션이 이미 약속한 검증 방식("일반 답변 vs 맥락 반영 답변을 1~5점으로 비교")을 사람 인터뷰 대신 AI 인터뷰로 자동화하는 것이다.

비목표(YAGNI): Durable Objects 세션 영속, 멀티에이전트, 결제/로그인, ai-svc(JVM) 재사용, 토큰단위 타이핑 정교화 이상의 UX.

---

## 2. 사용자 흐름 (상태 기계)

```
LANDING
  └─(CTA "AI 학습 진단 인터뷰 시작")→ INTERVIEW(turn 1)
INTERVIEW(turn n)              ; 익명 맛보기
  ├─ 사용자 답변 → /api/interview/turn → AI 다음 질문 (n+1)
  ├─ n == MAX_TURNS(=5) 또는 AI "맥락 충분" 신호 → EMAIL_GATE
  └─ (오류) → 재시도, 전사 보존
EMAIL_GATE                     ; 가장 비싼 A/B 직전 게이트
  └─ 이메일·현재단계·동의 제출(form-utils 검증) → AB_GENERATE
AB_GENERATE
  └─ /api/interview/compare (전사 → 답변 2개 스트리밍) → AB_RATE
AB_RATE
  └─ 블라인드 "답변 1/2" 무작위 표시 → 더 유용한 쪽 선택 + 1~5점 → SAVE
SAVE
  └─ 브라우저 → Apps Script(리드+전사+평점 저장) → THANKYOU(베타 우선 초대)
```

- 맛보기(턴 1~5)는 **익명**. 이메일은 A/B 결과를 보기 직전에만 받는다(하이브리드 게이트).
- 게이트에서 이탈해도 리드(이메일)는 확보, 또는 익명 이탈 시 부분 전사만 남는다(아래 §10 참조).

---

## 3. 아키텍처

### 호스팅
- **Cloudflare Pages**(정적: `index.html`/`styles.css`/`src/app.bundle.js`) + **Cloudflare Pages Functions**(`functions/api/...` — Workers 런타임). 동일 도메인이라 CORS 불필요. (정하신 "Pages + Workers"와 동일 — Pages Functions가 Workers 런타임)
- GitHub Pages(정적 전용)에서 Cloudflare Pages로 호스팅 이전(백엔드 공존을 위해).

### 컴포넌트 경계

```
브라우저 (정적, Cloudflare Pages)
  index.html ── styles.css
  src/app.js (엔트리, 기존 + 인터뷰 와이어링)
  src/interview-ui.js     채팅 UI·상태기계 (렌더/입력/스트리밍 표시)
  src/interview-client.js Functions 호출·SSE 파싱
  src/form-utils.js       (기존) 검증·lead_id·attribution·민감필터 + 인터뷰/평점 payload 빌더 추가
  build.mjs               번들에 신규 모듈 포함

Cloudflare Pages Functions (LLM 전용, 무PII)
  functions/api/interview/turn.js      적응형 다음 질문 (JSON 응답)
  functions/api/interview/compare.js   A/B 두 답변 (SSE 스트리밍)
  functions/api/_lib/llm.js            Anthropic 호출 래퍼(모델·메시지·스트림)
  functions/api/_lib/guardrails.js     Turnstile·rate limit(KV)·입력캡·예산캡
  functions/api/_lib/prompts.js        인터뷰어/AB 프롬프트·민감필터(공유 로직)
  KV namespace: INTERVIEW_KV           rate limit·일일 예산 카운터

저장 (기존 파이프라인 확장)
  apps-script/Code.gs  leads 시트에 인터뷰 필드 추가 (브라우저 → Apps Script)
```

**책임 분리(핵심 원칙)**: Functions = **LLM 전용, PII 없음**. 저장(이메일=PII) = **브라우저 → Apps Script**. Functions에는 이메일을 보내지 않는다 → 공격면·규정 리스크 축소.

---

## 4. 컴포넌트 명세

각 단위는 **역할 / 인터페이스 / 의존성**으로 정의한다.

### 4.1 `src/interview-ui.js`
- 역할: 채팅 UI 렌더(질문·답변 버블), 입력창, 진행률, 상태기계(INTERVIEW→EMAIL_GATE→AB→RATE→THANKYOU) 전이, A/B 카드 무작위 표시·평점 위젯.
- 인터페이스: `initInterview(rootEl, deps)` — `deps = { client, formUtils, config }`. 내부에서 DOM 이벤트만 처리, 네트워크는 client에 위임.
- 의존성: `interview-client.js`, `form-utils.js`, DOM.

### 4.2 `src/interview-client.js`
- 역할: Functions 호출, SSE 스트림 파싱, Turnstile 토큰 첨부, 오류→재시도 신호.
- 인터페이스:
  - `sendTurn({ history, turnstileToken }) → Promise<{ question, done }>`
  - `streamCompare({ transcript, onDelta }) → Promise<{ contextAnswer, genericAnswer }>`
- 의존성: `fetch`, SSE.

### 4.3 `src/form-utils.js` (기존 확장)
- 기존: `validateStep1`, `createLeadId`, `parseAttribution`, `detectSensitiveInput`, `buildStep1Payload` 등 재사용.
- 추가:
  - `buildInterviewPayload(data, transcript, ab, context)` — 저장용 payload(전사+평점 포함).
  - `pickBlindOrder(seedIndex)` — A/B 표시 순서 결정(테스트 가능한 순수 함수; 무작위성은 인덱스/시드로 주입).
- 의존성: 없음(순수). 테스트는 계속 `tests/form-utils.test.mjs`가 import.

### 4.4 `functions/api/interview/turn.js`
- 역할: `{ history[], turnstileToken? }` 수신 → 가드레일 통과 → Haiku로 다음 질문 1개 생성 → `{ question, done }` 반환.
- `done`: AI가 "맥락 충분" 신호를 내거나 서버가 `history` 길이로 MAX_TURNS 도달 판단 시 true.
- 비스트리밍(JSON). 질문은 1~2문장이라 지연 작음 → Lean 단순화. (스트리밍은 §7 참조)

### 4.5 `functions/api/interview/compare.js`
- 역할: `{ transcript, turnstileToken? }` 수신 → 가드레일 → (1) Haiku로 "핵심 질문 1문장" distill → (2) Sonnet으로 **일반 답변**(맥락 없음) + **맥락 반영 답변**(전사+단계+스택) 생성 → **SSE 스트리밍**.
- 응답(SSE 이벤트): `{type:'context'|'generic', delta}` 교차 또는 순차, 종료 `{type:'done'}`. 클라이언트가 두 버퍼에 누적.

### 4.6 `functions/api/_lib/*`
- `llm.js`: `callClaude({model, system, messages, stream})` — Anthropic Messages API(raw fetch 또는 `@anthropic-ai/sdk`). API 키는 env(`ANTHROPIC_API_KEY`).
- `guardrails.js`: `verifyTurnstile(token, ip)`, `checkRateLimit(ip)`, `checkBudget(estTokens)`, `enforceInputCaps(history)`.
- `prompts.js`: `INTERVIEWER_SYSTEM`, `DISTILL_PROMPT`, `CONTEXT_ANSWER_PROMPT`, `GENERIC_ANSWER_PROMPT`, `SENSITIVE_PATTERNS`(클라이언트와 동일 규칙).

### 4.7 `apps-script/Code.gs` (확장)
- `HEADERS`에 인터뷰 필드 추가(§10). `interview_opt_in` 제거.
- `doPost` 검증에 전사 길이 상한·민감필터 유지.

---

## 5. API 계약

### POST `/api/interview/turn`
```jsonc
// 요청
{
  "history": [ {"role":"assistant","text":"..."}, {"role":"user","text":"..."} ],
  "turnstileToken": "..."   // 첫 턴 필수
}
// 응답 200
{ "question": "다음 질문 텍스트", "done": false }
// 오류: 429(rate/budget), 403(turnstile), 400(입력캡 초과), 503(LLM 일시 오류)
```

### POST `/api/interview/compare` (SSE)
```jsonc
// 요청
{ "transcript": [ ... ], "turnstileToken": "..." }
// SSE 이벤트 스트림
data: {"type":"distilled","question":"핵심 질문 1문장"}
data: {"type":"generic","delta":"..."}
data: {"type":"context","delta":"..."}
data: {"type":"done"}
```

### 브라우저 → Apps Script (저장, 기존 패턴 `text/plain`)
```jsonc
{
  "action": "interview",
  "lead_id": "...", "email_normalized": "...", "current_stage": "...",
  "consent_required": true, "consent_version": "2026-06-24-aiqa-v1",
  "interview_transcript": "[{...}]",   // JSON 문자열(민감필터 통과분)
  "interview_turns": 5,
  "ab_distilled_question": "...",
  "ab_context_side": "1",              // 표시 위치 1/2 중 맥락답변 쪽
  "ab_user_choice": "1",               // 사용자가 더 유용하다고 고른 위치
  "ab_rating_1to5": 4,
  "ab_completed_at": "ISO", "last_updated_at": "ISO",
  ...attribution
}
```

---

## 6. LLM 사용 (모델·프롬프트·비용)

- **인터뷰 턴**: `claude-haiku-4-5` ($1/$5 per 1M). 저렴·빠름. 주의: Haiku는 `effort`/adaptive thinking 미지원 → thinking/effort 파라미터 **미사용**.
- **A/B 최종 답변**: `claude-sonnet-4-6` ($3/$15 per 1M). 검증 품질이 결정되는 지점. (품질 부족 시 `claude-opus-4-8`로 상향 검토 — 비용↑, 리뷰 후 결정.)
- **distill**: `claude-haiku-4-5` (핵심 질문 1문장).
- 스트리밍: `compare`는 SSE. Functions가 Anthropic `stream:true` 응답을 받아 자체 SSE로 중계.
- 비용 추정(rough): 세션당 Haiku 인터뷰 ~5턴 + distill + Sonnet A/B 2회 ≈ **$0.03~0.05/세션**. 1,000세션 ≈ **$30~50**. 스모크 트래픽에선 무시할 수준. (정확치는 구현 후 `count_tokens`로 재측정.)
- 프롬프트 캐싱: 인터뷰어 시스템 프롬프트가 Haiku 최소 캐시 프리픽스(4096 토큰) 미만이면 캐시 미적용 — 비용 영향 미미하므로 MVP는 무시.

### 프롬프트 개요(요지)
- `INTERVIEWER_SYSTEM`: "너는 Java/Spring 학습 진단 인터뷰 진행자다. 한 번에 한 질문, 이전 답을 반영해 막힌 지점을 구체화. 최대 5턴. 코드/로그/시크릿을 요구하지 말 것. 충분하면 `[READY]` 토큰으로 종료 신호."
- `DISTILL_PROMPT`: 전사 → "학습자가 막힌 핵심 질문 1문장".
- `GENERIC_ANSWER_PROMPT`: distill 질문만(맥락 없음) → 일반 답변.
- `CONTEXT_ANSWER_PROMPT`: distill 질문 + 전사 + 단계 + 스택 → 맥락 반영 답변.
- 두 답변은 **같은 distill 질문**에 답해 맥락 효과만 분리(공정한 A/B).

---

## 7. 데이터 흐름 & PII 분리

- 브라우저 ⇄ Functions: 대화 텍스트만(이메일 미전송).
- 브라우저 → Apps Script: 리드(PII) + 전사 + 평점.
- Functions = 무PII / Apps Script = PII·저장.
- (Lean 단순화) `/turn`은 비스트리밍, `/compare`만 SSE 스트리밍 — 긴 답변에서 체감 지연을 줄이는 지점에만 스트리밍을 둔다. 추후 `/turn`도 스트리밍 가능.

---

## 8. 가드레일 (공개 LLM 방어)

- **Turnstile**: 프론트에 위젯(sitekey), 서버에서 토큰 검증(secret=env), 실패 시 403. 토큰은 단일 사용·단기 만료(~300s)이므로 **각 보호 지점에서 새 토큰을 발급**한다: (a) 인터뷰 시작 시 1회 → `/turn` turn-1 검증, (b) 이메일 게이트 제출 시 위젯 재실행 1회 → `/compare` 검증. turn-2~5는 비용이 낮은 Haiku 호출이라 per-턴 Turnstile 없이 IP rate limit로만 보호(turn-1 토큰 + 세션 카운터로 충분).
- **Rate limit (KV)**: `rl:<ip>:<yyyymmddhhmm>` 분당 턴 카운터, `sess:<ip>:<yyyymmdd>` 일당 세션 카운터. 초과 429.
- **입력 캡**: 메시지당 최대 글자수(예 600), 세션당 최대 턴(5), 전사 총 글자 상한.
- **Injection 방어**: 시스템 프롬프트로 역할 고정·사용자 지시 무시. 사용자 입력은 항상 user 메시지로만 주입(시스템 프롬프트에 보간 금지). 기존 민감정보 필터로 코드/시크릿/URL 차단(주제 이탈도 방지).
- **일일 예산 캡 (KV)**: `budget:<yyyymmdd>` 토큰 누적. 초과 시 우아한 안내 + 이메일 수집 폴백(리드는 확보).
- KV는 결과적 일관성 → 소프트 캡 용도로 충분.

---

## 9. 데이터 모델 (Sheets 확장)

- `leads` 추가 필드: `interview_transcript`, `interview_turns`, `ab_distilled_question`, `ab_context_side`, `ab_user_choice`, `ab_rating_1to5`, `ab_completed_at`.
- 폐기: `interview_opt_in`(인터뷰가 온페이지라 무의미) — `HEADERS`에서 제거, app.js/form-utils.js/tests 정리.
- 변경: 전체 전사는 `interview_transcript`(JSON)에 저장하고, `recent_stuck_moment`에는 **distill된 핵심 질문 1문장**을 채워 빠른 스캔·하위호환을 유지한다.
- 동의: copy를 "인터뷰 전사 저장·AI 처리"까지 포함하도록 갱신, `CONSENT_VERSION = 2026-06-24-aiqa-v1`로 상향.

---

## 10. 에러 처리

- LLM 타임아웃/503 → 재시도 안내, **전사 보존**(입력 유실 금지).
- Turnstile 실패 → 위젯 재챌린지.
- rate/예산 초과 → 친절 안내 + 이메일 수집 폴백.
- Apps Script 미설정/오류 → 기존 fail-closed 유지(거짓 성공 금지).
- 익명 이탈(게이트 전): 리드 없음 — 익명 부분 전사 저장은 MVP 비포함(개인정보 최소화). 필요 시 후속.

---

## 11. 테스트 전략

- **단위(node:test)**: `form-utils` 기존 + 신규 `buildInterviewPayload`, `pickBlindOrder`(무작위 순서 분기), `detectSensitiveInput`(전사 적용).
- **Functions 단위(vitest + workers/miniflare)**: 가드레일(Turnstile mock·rate limit·입력캡·예산캡), 프롬프트 조립, SSE 직렬화, distill→2답변 흐름. Anthropic은 mock(네트워크 없이).
- **E2E(수동/스크립트)**: dev Functions 상대로 시작→턴(적응형)→게이트→A/B(스트리밍)→평점→Sheets 행 생성.
- A/B 블라인드 순서·`ab_context_side` 기록 정확성 단위 검증.

---

## 12. 보안 & 프라이버시

- 시크릿: `ANTHROPIC_API_KEY`, `TURNSTILE_SECRET`을 Cloudflare Pages 환경변수(암호화)로. 코드/저장소에 두지 않음.
- 동의 copy 갱신 + 동의 버전 상향(§9).
- 전사에 코드/시크릿/URL 유입 차단(클라이언트+서버 이중 필터). README 프라이버시 규칙 유지.

---

## 13. 배포 & 설정

- Cloudflare Pages 프로젝트 생성, 빌드 명령 `npm run build`, 출력 루트=레포 루트(정적 파일), Functions=`functions/`.
- 환경변수: `ANTHROPIC_API_KEY`, `TURNSTILE_SECRET`, Turnstile sitekey(프론트 공개), KV 바인딩 `INTERVIEW_KV`.
- 브랜치 전략(글로벌 규칙): 작업 `feat/ai-qa-interview` → `develop` PR → 머지 → 릴리스 시 `develop` → `main`. main 직접 push 금지.
- 선행: PR #1(정적 베이스라인) develop 머지 후 본 기능 진행 권장.

---

## 14. 단계/빌드 분해 (writing-plans 입력)

- **Build A — 데이터/유틸**: `form-utils` 확장(`buildInterviewPayload`·`pickBlindOrder`), `interview_opt_in` 제거, 단위 테스트. Apps Script `HEADERS`/검증 확장.
- **Build B — Functions(백엔드)**: `_lib/llm·guardrails·prompts`, `/turn`, `/compare`(SSE), KV·Turnstile. Functions 단위 테스트(mock).
- **Build C — 프런트 UI**: `interview-ui.js`·`interview-client.js`, `index.html` 인터뷰 섹션 교체(화상 copy 제거), `styles.css`, 번들.
- **Build D — 통합·E2E**: 동의/CONSENT_VERSION 갱신, dev 끝단간 검증, Sheets 저장 확인.
- **Build E — 배포 설정**: Cloudflare Pages 프로젝트·env·KV·도메인 이전, 라이브 스모크.

각 빌드는 develop 경유 PR. writing-plans가 빌드별 Task로 세분화.

---

## 15. 미해결 가정 & 리스크

- 턴 수 `MAX_TURNS=5` 가정(조정 가능).
- Cloudflare 계정·Turnstile·Anthropic API 키 발급은 **사용자 준비 필요**(배포 시점).
- 모델 비용은 추정치 — 구현 후 `count_tokens`로 재측정.
- Sonnet A/B 품질이 데모 설득력의 핵심 — 골든 eval로 검증, 부족 시 Opus 4.8 상향 검토.
- 익명 맛보기의 비용/abuse는 Turnstile+rate+예산캡으로 방어하되 라이브 모니터링 필요.
