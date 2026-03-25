---
description: Crew 사용법 안내 — 커맨드, 워크플로, 옵션 등
argument-hint: <알고 싶은 내용 (예: dev 사용법, 워크플로, 에이전트 구성)>
---

아래 문서를 참고하여 사용자의 질문에 답변합니다. $ARGUMENTS가 비어있으면 전체 커맨드 목록과 빠른 시작 가이드를 요약하여 안내합니다. $ARGUMENTS가 있으면 해당 내용에 대해 문서에서 찾아 답변합니다.

---

# Crew — AI 멀티에이전트 개발팀 플러그인

소프트웨어 개발팀의 전문 역할(PM, Architect, Developer, Reviewer, QA)을 AI 에이전트로 시뮬레이션하는 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 커스텀 슬래시 커맨드입니다.

피처 기획부터 구현, 리뷰, 테스트, 디버그, CI/CD 전 검증까지 전체 개발 라이프사이클을 커버합니다.

## 설치

### 요구사항

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- Git

### 마켓플레이스 설치

```bash
# 마켓플레이스 등록 (최초 1회)
/plugin marketplace add https://bitbucket.org/ezardev-admin/marketplace-for-claude

# 플러그인 설치
/plugin install common-plugin@ezar-plugins
```

### 설치 확인

Claude Code에서 `/crew`를 입력하면 사용 가능한 커맨드가 표시됩니다:

```
/crew:init      /crew:plan      /crew:dev       /crew:debug
/crew:review    /crew:verify    /crew:sprint    /crew:status
/crew:q         /crew:README
```

## 빠른 시작

```bash
# 1. 워크스페이스 초기화 (최초 1회)
/crew:init 프로젝트 설명

# 2. 피처 개발
/crew:dev 사용자 인증 기능 추가

# 3. 코드 리뷰
/crew:review

# 4. CI/CD 전 검증
/crew:verify
```

## 커맨드

### `/crew:init` — 워크스페이스 초기화

프로젝트의 `.crew/` 워크스페이스를 생성하고 개발 환경을 설정합니다.

```bash
/crew:init REST API 기반의 할 일 관리 서비스
```

**수행 작업:**
- 프로그래밍 언어 선택 (10개 지원, 복수 선택)
- Git 저장소 확인 (미초기화 시 자동 `git init` + `.gitignore` 생성)
- 선택한 언어에 맞는 LSP 서버 자동 설치
- 기존 코드베이스 분석 (아키텍처, 컨벤션, 헬스 체크, 성능)
- `config.md`, `board.md`, `CLAUDE.md` 등 상태 파일 생성

**재초기화 옵션:** 이미 `.crew/`가 존재하면 3가지 선택:
- **유지** — 기존 상태 그대로
- **부분 재초기화** — 코드베이스 재스캔, board/history 보존
- **전체 재초기화** — 모든 상태 초기화

---

### `/crew:plan` — 피처 플래닝

PM과 Architect 에이전트가 피처를 기획하고 태스크로 분해합니다.

```bash
/crew:plan OAuth2 소셜 로그인 (Google, GitHub)
```

**파이프라인:**
1. **PM** (opus) → PRD 작성 (요구사항, 사용자 스토리, 인수 기준)
2. **Architect 2명** (sonnet, 병렬) → 코드베이스 분석 + 기술 설계
3. **태스크 분해** → 역할, 우선순위(P0/P1/P2), 의존성 할당
4. board.md에 태스크 등록

**산출물:**
- `.crew/artifacts/prd/[slug]-prd.md`
- `.crew/artifacts/design/[slug]-design.md`
- `.crew/board.md`에 TASK-NNN 추가

---

### `/crew:dev` — 풀 개발 파이프라인

기획부터 구현, 리뷰, 테스트까지 전체 개발 사이클을 실행합니다.

```bash
# 새 피처 개발 (기획부터 시작)
/crew:dev 결제 시스템 연동

# 기존 계획의 피처 개발
/crew:dev payment-integration

# 특정 태스크만 개발
/crew:dev TASK-003
```

**파이프라인:**
1. **기획** (기존 계획 없을 때) — PM + Architect
2. **Git 체크포인트** — Feature branch / Stash / 스킵 선택
3. **구현** — Developer (opus, 병렬 가능) + 변경사항 확인
4. **테스트 생성** — QA (sonnet)
5. **리뷰** — 3관점 Reviewer (sonnet, 병렬)
6. **PM Quality Gate** — 인수 기준 대조 검증 (최대 3회 반복)
7. **마무리** — board/history 업데이트

**특수 기능:**
- 배치 기반 의존성 관리 (겹치지 않는 태스크는 병렬 실행)
- 구현 후 `git diff`로 변경사항 확인 → 적용/되돌리기/부분 되돌리기
- PM Quality Gate 실패 시 Developer 재구현 + Reviewer 재리뷰 자동 실행
- 마무리 단계에서 README.md 자동 동기화 (API, 설정, 사용법 등 변경 시)

---

### `/crew:debug` — 버그 조사 및 수정

버그 원인을 분석하고 사이드이펙트를 방어하며 외과적으로 수정합니다.

```bash
/crew:debug 로그인 시 500 에러 발생, 스택 트레이스: NullPointerException at AuthService.java:42
/crew:debug 페이지네이션이 두 번째 페이지부터 빈 결과를 반환
```

**파이프라인:**
1. **재현** (sonnet) — 에러/스택 트레이스 파싱, 관련 코드 검색
2. **Git 체크포인트**
3. **원인 분석** — 3명 Investigator 병렬 (코드 흐름 / 변경 이력 / 엣지 케이스)
4. **영향 분석** — Impact Analyzer + 범위 잠금
5. **수정** — Developer (opus) + 범위 위반 검증
6. **근본 원인 검증** — PM이 "증상 우회 vs 원인 해결" 판별
7. **회귀 테스트** — 기존 테스트 전수 실행 + 재현 테스트 생성

**사이드이펙트 방어 4단계:**

| 방어 | 내용 |
|------|------|
| Impact Analyzer | 호출자/의존 코드 추적, "버그 의존 코드" 식별 |
| Scope Lock | 수정 허용 파일 확정, 벗어나면 경고 |
| 근본 원인 검증 | 증상만 가린 건 아닌지 PASS/WARN/FAIL 판정 |
| 회귀 테스트 | 기존 테스트 + 버그 재현 테스트 생성 |

**마무리:** 수정 완료 후 README.md에 영향이 있으면 (API 동작, 설정, 제약사항 변경 등) 자동 동기화

---

### `/crew:review` — 5관점 코드 리뷰

5개 전문 에이전트가 병렬로 코드를 분석합니다.

```bash
# 현재 git 변경사항 리뷰
/crew:review

# 특정 파일/디렉토리 리뷰
/crew:review src/auth/

# PR 리뷰
/crew:review pr
```

**5개 리뷰어:**
1. **정확성** — 로직 오류, null 처리, 레이스 컨디션
2. **보안** — OWASP Top 10, 인젝션, 시크릿 노출
3. **성능** — N+1 쿼리, 메모리 누수, 비효율 알고리즘
4. **코드 품질** — DRY, SRP, 네이밍, 복잡성
5. **테스트** — 커버리지 누락, 엣지 케이스, 테스트 품질

**충돌 감지:**
- Trade-off (예: "캐싱 추가" vs "민감 데이터 보호")가 발견되면 Architect 중재 에이전트가 통합 해결안 제시
- Race condition (±5줄 내 겹치는 수정)도 자동 감지

**이슈 수정:** multiSelect로 수정할 이슈를 선택하면 자동 적용

---

### `/crew:verify` — CI/CD 전 최종 검증

실제 도구(테스트 러너, 린터, 빌더)를 실행하여 CI/CD 통과 여부를 사전 확인합니다.

```bash
# 검증만 (기본값)
/crew:verify

# 자동 수정 가능한 항목은 수정
/crew:verify --fix
```

**5개 검증 (Check 1-4 순차, Check 5 시크릿 점검은 병렬 가능):**

| 검증 | 감지 도구 |
|------|----------|
| 테스트 | pytest, go test, npm test, cargo test 등 |
| 린트 | eslint, ruff, golangci-lint, clippy 등 |
| 포맷팅 | prettier, black, gofmt, rustfmt 등 |
| 빌드 | tsc, go build, cargo build 등 |
| 시크릿 | API 키, AWS 키, 개인키, 토큰 패턴 |

**판정:** PASS / WARN / FAIL → FAIL 시 자동 수정 옵션 제공

---

### `/crew:sprint` — 스프린트 관리

```bash
/crew:sprint plan     # 스프린트 플래닝 및 시작
/crew:sprint status   # 현재 스프린트 진행 상황
/crew:sprint close    # 회고와 함께 스프린트 종료
```

---

### `/crew:q` — 코드베이스 질문

코드베이스에 대한 질문에 관련 코드를 자동 수집하여 프로젝트 컨텍스트 기반으로 답변합니다.

```bash
# 파일 기반 (파일 경로 자동 감지)
/crew:q src/auth/middleware.ts 이 파일 뭐하는 파일이야?

# 함수 기반 (함수명 자동 감지)
/crew:q handleAuth에서 토큰 만료 처리가 왜 이렇게 되어있어?

# 기능 설명 기반 (자연어 자동 감지)
/crew:q 결제 모듈에서 환불 처리 흐름이 어떻게 되어있어?
```

**자동 범위 감지:**
- 질문에 파일 경로가 포함되면 → 해당 파일을 직접 읽어서 답변
- 함수/클래스명이 포함되면 → 정의 위치 + 호출자를 검색하여 답변
- 기능 설명만 있으면 → Explore 에이전트가 관련 코드를 탐색하여 답변
- 판별 불가 시에만 범위 선택 요청

**에이전트:** Explore (haiku/sonnet) → Answerer (sonnet)

**Q&A 히스토리:** 질문-답변 쌍이 `.crew/artifacts/qa/[slug]-qa.md`에 자동 저장. 같은 주제 질문은 누적됨.

---

### `/crew:status` — 프로젝트 대시보드

태스크 보드, 스프린트 진행률, 아티팩트 현황을 한눈에 보여줍니다.

```bash
/crew:status
```

### `/crew:README` — 사용법 안내

Crew 플러그인의 사용법을 안내합니다. 궁금한 내용을 뒤에 입력하면 해당 내용을 찾아 답변합니다.

```bash
# 전체 커맨드 요약
/crew:README

# 특정 커맨드 사용법
/crew:README dev 커맨드 사용법
/crew:README debug 옵션

# 워크플로/구조 질문
/crew:README 에이전트 모델 배정 기준
/crew:README 아티팩트 디렉토리 구조
```

---

## 개발 파이프라인

### 일반적인 워크플로

```
/crew:init          최초 1회. 프로젝트 환경 설정
     │
     ▼
/crew:plan          피처 기획 (PRD + 설계 + 태스크 분해)
     │
     ▼
/crew:sprint plan   스프린트 시작 (태스크 선택)
     │
     ▼
/crew:dev           구현 (기획 → 코딩 → 리뷰 → 테스트)
     │
     ├──→ 코드 궁금? ──→ /crew:q
     ├──→ 버그 발견? ──→ /crew:debug
     │
     ▼
/crew:review        추가 리뷰 (필요 시)
     │
     ▼
/crew:verify        CI/CD 전 최종 검증
     │
     ▼
/crew:sprint close  스프린트 종료 (회고)
```

### 단축 워크플로 (빠른 개발)

기획 없이 바로 개발할 수도 있습니다. `/crew:dev`가 기획 단계를 자동으로 포함합니다:

```bash
/crew:init 프로젝트 설명
/crew:dev 로그인 기능 추가       # 기획 + 구현 + 리뷰 + 테스트 한 번에
/crew:verify                    # 최종 검증
```

### 코드 이해 워크플로

```bash
# 코드베이스에 대한 질문
/crew:q 이 프로젝트에서 인증은 어떻게 처리하고 있어?
/crew:q src/api/routes.ts 라우팅 구조 설명해줘
/crew:q processOrder 함수가 왜 이렇게 복잡해?
```

### 버그 수정 워크플로

```bash
/crew:debug 결제 API에서 금액이 음수일 때 500 에러
# → 재현 → 원인 분석 → 영향 분석 → 수정 → 검증 → 회귀 테스트
/crew:verify
```

## 프로젝트 상태 디렉토리

`/crew:init` 실행 후 생성되는 `.crew/` 디렉토리 구조:

```
.crew/
├── config.md                 프로젝트 설정 (YAML 프론트매터 + 아키텍처/컨벤션)
├── board.md                  칸반 보드 (Backlog → In Progress → In Review → Done)
├── history.md                완료 태스크 아카이브
├── sprints/
│   └── sprint-NNN.md         스프린트 추적
├── artifacts/
│   ├── prd/                  제품 요구사항 문서 ([slug]-prd.md)
│   ├── design/               기술 설계 문서 ([slug]-design.md)
│   ├── review/               리뷰/디버그 리포트
│   ├── test/                 테스트 계획, 검증 리포트
│   └── qa/                   Q&A 히스토리 ([slug]-qa.md)
└── plugins/
    └── crew-lsp/             LSP 서버 설정
```

## 에이전트 구성

### 역할별 에이전트

| 역할 | 하는 일 | 사용 커맨드 |
|------|---------|------------|
| **PM** | 요구사항 분석, PRD, Quality Gate | plan, dev |
| **Architect** | 기술 설계, 충돌 중재 | plan, dev, review |
| **Developer** | 코드 구현/수정 | dev, debug |
| **Reviewer** | 다관점 코드 리뷰 | dev, review |
| **Investigator** | 버그 원인 분석 | debug |
| **QA** | 테스트 생성, 버그 재현 | dev, debug |
| **Answerer** | 코드 기반 질문 답변 | q |

### 모델 배정

| 모델 | 역할 | 이유 |
|------|------|------|
| **opus** | PM, Developer, Quality Gate | 판단/구현 품질 최우선 |
| **sonnet** | Architect, Reviewer, QA, Investigator | 분석 품질 + 비용 균형 |
| **haiku** | init 스캐너, 시크릿 점검 | 패턴 매칭 중심, 속도 우선 |

## 코드 작성 방침

`/crew:init`이 생성하는 CLAUDE.md에 포함되며, 모든 Developer 에이전트가 준수합니다:

### 1. 코딩 전에 생각하기
- 가정을 명시적으로 밝히고, 불확실하면 질문
- 여러 해석이 가능하면 선택지를 제시
- 더 간단한 접근이 있으면 제안

### 2. 단순성 우선
- 요청된 것 이상의 기능을 추가하지 않음
- 한 번만 쓰이는 코드에 추상화를 만들지 않음
- 50줄이면 될 것을 200줄로 만들지 않음

### 3. 외과적 변경
- 관련 없는 코드, 주석, 포맷을 개선하지 않음
- 기존 스타일을 따름
- 모든 변경된 줄은 요청에 직접 연결되어야 함

### 4. 목표 기반 실행
- 인수 기준을 체크리스트로 삼아 구현
- 다단계 작업에는 체크포인트 기반 계획 수립

### 5. 문서 동기화
- 코드 변경이 README.md에 영향을 줄 때 (API, 설정, 사용법 등) 반드시 함께 업데이트
- `/crew:dev`, `/crew:debug` 마무리 단계에서 자동으로 README.md 동기화 확인

## 컨벤션

| 항목 | 규칙 |
|------|------|
| Task ID | `TASK-NNN` (3자리 zero-padded) |
| 아티팩트 파일명 | slugified (예: `user-auth-prd.md`) |
| 보드 섹션 | `## Backlog` → `## In Progress` → `## In Review` → `## Done` |
| 리뷰 신뢰도 | >= 80%인 이슈만 보고 |
| 산출물 언어 | 한글 (코드/변수명/커밋 메시지는 영어) |
| 상태 파일 접근 | 오케스트레이터만 `.crew/` 읽기/쓰기 |

## 세션 복구

Claude를 종료 후 다시 시작해도 작업 상태가 유지됩니다:

- 모든 커맨드가 실행 후 `CLAUDE.md`의 `## Crew 현재 상태` 섹션을 자동 업데이트
- Claude 재시작 시 `CLAUDE.md`가 자동 로드되어 이전 상태를 인식
- `.crew/board.md`에 태스크 상태가 영구 저장

## Best Practices

### 초기화

- 프로젝트 시작 시 반드시 `/crew:init` 실행
- 프로젝트 설명을 상세히 입력하면 PM/Architect의 컨텍스트가 풍부해짐
- 언어 선택 시 실제 사용할 언어만 선택 (불필요한 LSP 설치 방지)

### 기획

- 큰 피처는 `/crew:plan`으로 먼저 기획 → 태스크 분해 후 `/crew:dev TASK-NNN`으로 개별 개발
- PRD의 미결 질문에 반드시 답변 (에이전트가 가정하지 않도록)
- P0 태스크를 먼저 개발하면 의존성 체인이 자연스럽게 해소

### 개발

- 작은 피처는 `/crew:dev 피처 설명`으로 한 번에 처리
- Git 체크포인트는 **Feature branch**를 권장 (되돌리기가 가장 깔끔)
- 구현 후 변경사항 확인에서 diff를 꼼꼼히 검토
- Quality Gate 실패 시 자동 재시도를 신뢰하되, 3회 초과 시 수동 확인

### 디버그

- 에러 메시지/스택 트레이스를 가능한 한 자세히 제공
- 영향 분석에서 위험 등급이 High이면 신중하게 진행
- 근본 원인 검증에서 WARN이 나오면 추가 수정을 고려

### 리뷰

- 커밋 전에 `/crew:review` 실행을 습관화
- Critical/Major 이슈는 반드시 수정
- 충돌 이슈에서 Architect의 통합 해결안을 우선 고려

### 검증 & 배포

- CI/CD 파이프라인에 push 하기 전 반드시 `/crew:verify` 실행
- 시크릿 점검에서 Critical이 나오면 절대 커밋하지 않기
- `--fix` 옵션으로 린트/포맷 자동 수정 후 반드시 테스트 재실행

### 스프린트

- P0 + P1 태스크로 스프린트를 구성하면 적절한 크기
- `/crew:sprint status`로 주기적으로 진행률 확인
- 스프린트 종료 시 미완료 태스크는 자동으로 백로그에 이월

## 지원 언어

| 언어 | LSP 서버 | 린터 | 포매터 |
|------|----------|------|--------|
| TypeScript/JS | typescript-language-server | eslint | prettier |
| Python | pyright | ruff, flake8 | black, ruff format |
| Go | gopls | golangci-lint, go vet | gofmt |
| Rust | rust-analyzer | clippy | rustfmt |
| Java | jdtls | — | — |
| C/C++ | clangd | — | — |
| Ruby | solargraph | rubocop | rubocop |
| Kotlin | kotlin-language-server | — | — |
| Swift | sourcekit-lsp | — | — |
| PHP | intelephense | — | — |

## 라이선스

MIT
