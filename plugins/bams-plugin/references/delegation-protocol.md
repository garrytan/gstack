# 위임 프로토콜

파이프라인의 작업 위임 구조를 정의합니다.
커맨드 → pipeline-orchestrator → 부서장 → 에이전트의 3단 위임 체계를 따르며,
각 단계의 메시지 형식, 결정 규칙, 핸드오프 체크리스트, 에스컬레이션 경로를 규정합니다.

## 1. 위임 구조 개요

```
사용자 커맨드 (/bams:dev, /bams:feature 등)
  │
  ▼
pipeline-orchestrator (총괄 지휘)
  │
  ├─▶ 기획부장 (product-strategy, business-analysis, ux-research, project-governance)
  ├─▶ 개발부장 (frontend-engineering, backend-engineering, platform-devops, data-integration)
  ├─▶ 디자인부장 (ui-designer, ux-designer, graphic-designer, motion-designer, design-system-agent)
  ├─▶ QA부장 (qa-strategy, automation-qa, defect-triage, release-quality-gate)
  ├─▶ 평가부장 (product-analytics, experimentation, performance-evaluation, business-kpi)
  ├─▶ 인사 관리 (hr-agent — 에이전트 생명주기 관리)
  └─▶ 경영지원 (executive-reporter, cross-department-coordinator, resource-optimizer)
```

각 부서장은 자신의 에이전트 팀에 하위 작업을 분배하고, 결과를 종합하여 오케스트레이터에 보고합니다.

## 2. 위임 메시지 형식

### 2-1. 커맨드 → pipeline-orchestrator

커맨드 스킬이 오케스트레이터를 호출할 때 전달하는 항목입니다.

| 항목 | 필수 | 설명 |
|------|------|------|
| `phase` | O | 현재 Phase 번호 (예: Phase 2) |
| `slug` | O | 파이프라인 식별자 |
| `pipeline_type` | O | feature / hotfix / dev / weekly 등 |
| `context` | O | PRD 경로, 설계 경로, 관련 아티팩트 경로 목록 |
| `constraints` | - | 시간 제약, 스킵할 단계, 사용자 지시사항 |

```
예시:
  phase: 2
  slug: add-payment-flow
  pipeline_type: feature
  context:
    prd: .crew/artifacts/prd/add-payment-flow.md
    design: .crew/artifacts/design/add-payment-flow.md
  constraints:
    skip_steps: [benchmark]
    user_note: "결제 모듈만 구현, 관리자 화면은 제외"
```

### 2-2. pipeline-orchestrator → 부서장

오케스트레이터가 부서장 역할의 에이전트를 호출할 때 전달하는 항목입니다.

| 항목 | 필수 | 설명 |
|------|------|------|
| `task_description` | O | 수행할 작업의 명확한 설명 |
| `input_artifacts` | O | 입력 산출물 경로 목록 |
| `expected_output` | O | 기대하는 산출물 형식과 경로 |
| `quality_criteria` | O | 품질 기준 (테스트 통과, 린트 통과 등) |
| `constraints` | - | 수정 가능 파일 범위, 금지 패턴, 시간 제한 |
| `gotchas` | - | 이 작업과 관련된 gotchas 항목 |

```
예시:
  task_description: "결제 플로우 프론트엔드 구현"
  input_artifacts:
    - .crew/artifacts/prd/add-payment-flow.md
    - .crew/artifacts/design/add-payment-flow.md
  expected_output:
    type: code_implementation
    paths: [src/app/payment/**, src/components/payment/**]
  quality_criteria:
    - TypeScript 타입 에러 0건
    - 린트 에러 0건
    - 모든 시각적 상태(로딩, 에러, 빈 상태, 성공) 처리
  constraints:
    allowed_files: [src/app/payment/**, src/components/payment/**]
  gotchas:
    - "결제 API 응답 지연 시 타임아웃 처리 필수 (이전 hotfix 참조)"
```

### 2-3. 부서장 → 에이전트

부서장이 소속 에이전트에게 하위 작업을 분배할 때 전달하는 항목입니다.

| 항목 | 필수 | 설명 |
|------|------|------|
| `sub_task` | O | 하위 작업 설명 |
| `input_artifacts` | O | 입력 산출물 경로 |
| `deadline_hint` | - | 예상 소요 시간 또는 기한 힌트 |
| `quality_criteria` | O | 이 하위 작업의 품질 기준 |
| `reference` | - | 참고할 기존 코드, 패턴, 문서 |

### 2-4. 에이전트 → 부서장 (보고)

에이전트가 작업 완료 후 부서장에게 보고하는 항목입니다.

| 항목 | 필수 | 설명 |
|------|------|------|
| `output_artifacts` | O | 생성/수정한 산출물 경로 목록 |
| `issues` | - | 발견한 이슈, 우려사항, 미해결 항목 |
| `duration_ms` | O | 실제 소요 시간 (밀리초) |
| `status` | O | `done` / `fail` / `partial` |
| `notes` | - | 특이사항, 결정 근거, 후속 작업 제안 |

### 2-5. 부서장 → pipeline-orchestrator (종합 보고)

부서장이 오케스트레이터에게 종합 결과를 보고하는 항목입니다.

| 항목 | 필수 | 설명 |
|------|------|------|
| `aggregated_output` | O | 종합 산출물 경로 목록 |
| `quality_status` | O | `PASS` / `FAIL` / `CONDITIONAL` |
| `quality_detail` | O | 품질 기준별 충족 여부 상세 |
| `issues` | - | 에스컬레이션 필요 이슈 |
| `recommendations` | - | 다음 단계를 위한 권고사항 |

**품질 상태 정의:**

| 상태 | 의미 | 오케스트레이터 행동 |
|------|------|---------------------|
| `PASS` | 모든 품질 기준 충족 | 다음 Phase 진행 |
| `FAIL` | 필수 품질 기준 미충족 | 재작업 지시 또는 에스컬레이션 |
| `CONDITIONAL` | 필수 충족, 권장 미충족 | 조건부 진행 (이슈 기록 후 계속) |

## 3. 부서장 결정 규칙

태스크가 어느 부서장에게 위임되는지 결정하는 규칙입니다.

### 3-1. 태그 기반 결정 (최우선)

태스크 또는 PRD에 명시적 태그가 있으면 해당 태그로 부서장을 결정합니다.

| 태그 | 부서장 | 에이전트 풀 |
|------|--------|-------------|
| `frontend` | frontend-engineering | frontend-engineering (리드) |
| `backend` | backend-engineering | backend-engineering (리드) |
| `infra` / `devops` | platform-devops | platform-devops (리드) |
| `data` | data-integration | data-integration (리드) |
| `qa` | qa-strategy | qa-strategy, automation-qa, defect-triage |
| `planning` | product-strategy | product-strategy, business-analysis, ux-research |
| `design` / `ui` / `ux` | design-director | ui-designer, ux-designer, graphic-designer, motion-designer, design-system-agent |
| `security` | platform-devops | platform-devops (보안 전문) |
| `agent-management` | hr-agent | hr-agent (에이전트 생명주기 관리) |

### 3-2. 파일 패턴 기반 결정 (태그 없을 때)

태그가 없으면 pipeline-orchestrator가 변경 대상 파일 패턴으로 판단합니다.

| 파일 패턴 | 부서장 |
|-----------|--------|
| `src/app/**`, `src/components/**`, `src/hooks/**`, `*.tsx`, `*.css` | frontend-engineering |
| `src/app/api/**`, `src/lib/**`, `*.server.ts`, `prisma/**` | backend-engineering |
| `Dockerfile`, `.github/**`, `deploy/**`, `infra/**` | platform-devops |
| `src/lib/data/**`, `scripts/etl/**`, `*.sql` | data-integration |
| `src/styles/**`, `src/design/**`, `*.figma`, `design-tokens/**`, `src/components/**/style*` | design-director |
| `agents/*.md`, `references/jojikdo.json`, `agents-config.ts` | hr-agent |

### 3-3. 혼합 패턴 (복수 부서)

변경 대상이 여러 부서에 걸치면:
1. 파일 수 기준 **주요 부서장**을 1명 선정 (전체 조율 책임)
2. 나머지 부서장은 **협력 부서장**으로 병렬 위임
3. cross-department-coordinator가 부서 간 인터페이스 조율

## 4. 핸드오프 체크리스트

Phase 전환 시 pipeline-orchestrator가 확인하는 항목입니다.

### Phase 전환 공통 체크리스트

| # | 확인 항목 | 미충족 시 행동 |
|---|----------|---------------|
| 1 | 현재 Phase의 모든 필수 Step이 `done` 상태인가 | 미완료 Step 재실행 또는 에스컬레이션 |
| 2 | Critical 이슈가 0건인가 | FAIL — 이슈 해결 후 재시도 |
| 3 | 필수 산출물이 모두 생성되었는가 | 누락 산출물 생성 지시 |
| 4 | 다음 Phase의 선행 조건이 충족되었는가 | 선행 조건 해결 대기 |
| 5 | tracking 파일에 현재 Phase 결과가 기록되었는가 | 기록 후 진행 |
| 6 | viz 이벤트(`step_end`)가 모든 Step에 대해 기록되었는가 | 누락 이벤트 보충 |

### Phase별 추가 확인

| 전환 | 추가 확인 항목 |
|------|---------------|
| Phase 1 → 2 (기획 → 구현) | PRD 승인 상태, 기술 설계 완료, 태스크 분해 완료 |
| Phase 2 → 3 (구현 → 검증) | 빌드 성공, 타입 체크 통과, 린트 통과 |
| Phase 3 → 4 (검증 → 리뷰) | 테스트 전체 통과, QA 리포트 생성, 성능 기준 충족 |
| Phase 4 → 5 (리뷰 → 배포) | 코드 리뷰 승인, 보안 스캔 통과, 릴리즈 품질 게이트 PASS |

## 5. 에스컬레이션 경로

문제 발생 시 단계적으로 상위로 에스컬레이션합니다.

```
에이전트 (자체 해결 시도)
  │ 실패
  ▼
부서장 (대안 전략 수립, 다른 에이전트 재배정)
  │ 실패
  ▼
pipeline-orchestrator (Phase 재설계, 롤백, 스킵 판단)
  │ 실패 또는 사용자 판단 필요
  ▼
사용자 (AskUserQuestion으로 최종 결정)
```

### 에스컬레이션 트리거 조건

| 레벨 | 트리거 | 예시 |
|------|--------|------|
| 에이전트 → 부서장 | 작업 실패, 모호한 요구사항, 권한 밖 작업 | 빌드 실패, API 스키마 불일치 |
| 부서장 → 오케스트레이터 | 부서 내 해결 불가, 부서 간 충돌, 품질 기준 미달 | 프론트-백엔드 인터페이스 불일치, 테스트 커버리지 기준 미달 |
| 오케스트레이터 → 사용자 | Phase 전체 실패, 롤백 필요, 전략적 판단 필요 | 핵심 기능 구현 불가, 일정 초과, 아키텍처 변경 필요 |

### 에스컬레이션 메시지 형식

에스컬레이션 시 반드시 포함할 항목:

| 항목 | 설명 |
|------|------|
| `issue` | 문제 설명 |
| `attempted` | 시도한 해결 방법 |
| `impact` | 미해결 시 영향 범위 |
| `options` | 가능한 대안 목록 (최소 2개) |
| `recommendation` | 권장 대안과 근거 |

### 자동 해결 vs. 에스컬레이션 판단 기준

| 상황 | 행동 |
|------|------|
| 린트/타입 에러 | 에이전트가 자동 수정 → 재검증 |
| 테스트 1~2개 실패 | 에이전트가 수정 시도 (최대 2회) → 실패 시 부서장 |
| 빌드 실패 | 부서장이 원인 분석 → 에이전트 재배정 |
| 전체 테스트 실패 | 즉시 오케스트레이터 에스컬레이션 |
| 보안 Critical 발견 | 즉시 오케스트레이터 에스컬레이션 → 사용자 보고 |
| 요구사항 모호 | 즉시 사용자 에스컬레이션 (AskUserQuestion) |
