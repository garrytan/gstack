## 1. 위임 원칙 (최우선 — 예외 없음)

**모든 코드 수정은 반드시 `커맨드 → 부서장 → (선택적) 도메인 에이전트` 2단 위임을 통해 수행한다.**

```
사용자 커맨드 → 부서장 → (선택적) 도메인 에이전트
              ↑
         pipeline-orchestrator는 계획/게이트 판정을 반환하는 "조언자" 모드로 동작
```

> **배경**: Claude Code harness에서 서브에이전트가 또 다른 서브에이전트를 Task tool로 spawn할 수 없다(중첩 제한). 따라서 기존 3단 위임(`orchestrator → 부서장 → 에이전트`)은 구조적으로 실행 불가이며, 2단 위임 + orchestrator 조언자 모드로 전환한다.

### 위임 규칙
- 허용: 커맨드 스킬(메인 대화)이 Agent tool로 부서장을 직접 spawn. 부서장이 자신의 도메인 내에서 specialist를 최대 1회 추가 spawn 가능.
- 금지: 메인 대화가 Edit/Write로 소스 코드 직접 변경 (읽기 전용 Bash/Glob/Grep/Read는 허용).
- 금지: 커맨드 레벨에서 Task tool을 중첩 호출하여 서브에이전트가 또 다른 서브에이전트를 spawn하는 시도 (harness 제약).
- 허용: Bash/Glob으로 상태 확인, 사용자에게 질문, 읽기 전용 응답.
- "내가 직접 하면 더 빠르다"는 판단으로 위임을 건너뛰지 않는다.
- 위반 감지 시: 즉시 중단하고 적절한 부서장에게 해당 작업을 위임.

### pipeline-orchestrator 역할 (조언자 모드)
- orchestrator는 **Task tool 호출자가 아님**. 서브에이전트 레벨에서 중첩 Task tool이 차단되기 때문.
- 역할:
  1. Phase 단위 실행 계획 수립 → 메인(커맨드)에 JSON/텍스트로 반환
  2. Phase 게이트 Go/No-Go 판단 → 메인에 보고
  3. 부서장 라우팅 조언 → 메인이 실제 spawn 수행
  4. 롤백 결정 및 회고 트리거 권고

### Work Unit 선택 규칙 준수 필수 (불변)
- 활성 WU 2개 이상이면 AskUserQuestion으로 사용자에게 선택 요청
- 커맨드 레벨에서 임의로 WU 결정 금지 (`_shared_common.md` §Work Unit 선택 참조)

## 2. 조직도 (8부서 27에이전트)

| 부서 | 부서장 | 소속 에이전트 |
|------|--------|--------------|
| 기획 | product-strategy | business-analysis, ux-research, project-governance |
| 개발(FE) | frontend-engineering | (직접 구현) |
| 개발(BE) | backend-engineering | (직접 구현) |
| 개발(인프라) | platform-devops | data-integration |
| 디자인 | design-director | ui-designer, ux-designer, graphic-designer, motion-designer, design-system-agent |
| QA | qa-strategy | automation-qa, defect-triage, release-quality-gate |
| 평가 | product-analytics | experimentation, performance-evaluation, business-kpi |
| 경영지원 | (독립 운영 — orchestrator 직접 조율) | executive-reporter, resource-optimizer, hr-agent, cross-department-coordinator |

**위임 라우팅 — 태그 우선, 파일 패턴 보조:**

| 태그/패턴 | 부서장 |
|-----------|--------|
| `frontend` / `*.tsx`, `src/app/**`, `src/components/**`, `*.css` | frontend-engineering |
| `backend` / `src/app/api/**`, `*.server.ts`, `prisma/**` | backend-engineering |
| `infra`/`devops` / `Dockerfile`, `.github/**` | platform-devops |
| `data` / `*.sql`, `scripts/etl/**` | platform-devops |
| `design`/`ui`/`ux` / `*.figma`, `design/**`, `src/assets/**` | design-director |
| `qa` | qa-strategy |
| `planning` | product-strategy |
| `security` | platform-devops |
| `agent-management` / `agents/*.md`, `jojikdo.json` | hr-agent |

## 3. 파이프라인 규칙

### 네이밍 (immutable)
- 형식: `{command}_{한글요약}` (예: `feature_결제플로우구현`, `hotfix_빌드에러수정`)
- slug는 파이프라인 수명 동안 불변. 상태는 이벤트로 판별 (`pipeline_end` 없음 → 진행 중)
- 상세: `.crew/references/pipeline-naming-convention.md`

### Work Unit 선택
- 활성 WU 0개 → 경고 후 WU 없이 진행
- 활성 WU 1개 → 자동 선택
- 활성 WU 2개+ → AskUserQuestion으로 사용자에게 선택 요청

### 커맨드 목록

| 커맨드 | 설명 |
|--------|------|
| **파이프라인** | |
| `/bams:init` | 프로젝트 초기화 |
| `/bams:start` | 작업 단위(WU) 시작 |
| `/bams:end` | 작업 단위 종료 |
| `/bams:plan` | PRD + 기술 설계 + 태스크 분해 |
| `/bams:feature` | 풀 피처 개발 사이클 |
| `/bams:dev` | 멀티에이전트 풀 개발 파이프라인 |
| `/bams:hotfix` | 버그 핫픽스 빠른 경로 |
| `/bams:debug` | 버그 분류 → 수정 → 회귀 테스트 |
| `/bams:deep-review` | 다관점 심층 코드 리뷰 (5관점 + 구조적 리뷰 + 세컨드 오피니언) |
| `/bams:review` | 5관점 병렬 코드 리뷰 |
| `/bams:ship` | PR 생성 + 머지 |
| `/bams:deploy` | 출시 검증 + Land & Deploy |
| `/bams:verify` | CI/CD 프리플라이트 (빌드, 린트, 타입체크, 테스트) |
| `/bams:performance` | 성능 측정/최적화 (benchmark 기반) |
| `/bams:security` | 보안 감사 (시크릿 체크 + OWASP/STRIDE) |
| `/bams:retro` | 파이프라인 회고 + 에이전트 평가 |
| `/bams:weekly` | 주간 루틴 (스프린트 마무리 + 회고 + 다음 계획) |
| **부서 허브** | |
| `/bams:engineering` | 개발부서 스킬 허브 (FE, BE, 플랫폼, 데이터) |
| `/bams:planning` | 기획부서 스킬 허브 (전략, 분석, UX, 거버넌스) |
| `/bams:evaluation` | 평가부서 스킬 허브 (분석, 실험, 성능, KPI) |
| `/bams:qc` | QA부서 스킬 허브 (전략, 자동화, 결함, 출시 검증) |
| `/bams:qa` | 브라우저 QA (자동화 테스트 + 브라우저 검증) |
| **유틸리티** | |
| `/bams:browse` | 인터랙티브 헤드리스 브라우저 |
| `/bams:export` | 조직 설정을 이식 가능한 패키지로 내보내기 |
| `/bams:import` | 패키지를 현재 프로젝트에 가져오기 |
| `/bams:q` | 코드베이스 질문 (자동 범위 감지 + 코드 기반 답변) |
| `/bams:status` | 프로젝트 대시보드 현황 |
| `/bams:sprint` | 스프린트 플래닝 및 관리 |
| `/bams:viz` | 파이프라인 실행 시각화 |

## 4. viz 이벤트 규칙

### emit 원칙
- 커맨드 레벨(메인): `pipeline_start`/`pipeline_end`, `step_start`/`step_end`, `recover`, `error` emit 가능
- `agent_start`/`agent_end`: 커맨드 → 부서장 → (선택적) 에이전트 2단 위임 체계 내에서만 emit

### 이벤트 타입 (10종)

| 타입 | 필수 필드 |
|------|----------|
| `pipeline_start` | pipeline_slug, pipeline_type, command, arguments, work_unit_slug? |
| `pipeline_end` | pipeline_slug, status(`completed`\|`failed`\|`paused`\|`rolled_back`), total_steps, completed_steps, failed_steps, skipped_steps, duration_ms |
| `step_start` | pipeline_slug, step_number, step_name, phase |
| `step_end` | pipeline_slug, step_number, status(`done`\|`fail`\|`skipped`), duration_ms |
| `agent_start` | call_id, agent_type, department, model, description, step_number |
| `agent_end` | call_id, agent_type, is_error, status, duration_ms, result_summary |
| `work_unit_start` | work_unit_slug, work_unit_name, started_at |
| `work_unit_end` | work_unit_slug, status(`completed`\|`failed`\|`cancelled`), ended_at, duration_ms |
| `error` | pipeline_slug, message, step_number |
| `recover` | 중단된 이벤트 자동 정리 |

### 데이터 경로
- 이벤트: `~/.bams/artifacts/pipeline/{slug}-events.jsonl`
- WU 이벤트: `~/.bams/artifacts/pipeline/{slug}-workunit.jsonl`
- 에이전트 로그: `~/.bams/artifacts/agents/YYYY-MM-DD.jsonl`
- HR 보고서: `~/.bams/artifacts/hr/`
- 프로젝트 아티팩트: `.crew/artifacts/` (prd/, design/, review/, report/)
- DB: `~/.claude/plugins/marketplaces/my-claude/bams.db`

### DB 스키마 (v2 — FK 기반)
```
work_units → pipelines (work_unit_id FK) → tasks (pipeline_id FK)
                                          → task_events (task_id FK)  -- immutable event sourcing
                                          → run_logs (pipeline_id FK) -- 30일 auto-cleanup
hr_reports (독립)
```

## 5. 회고 규칙

- 파이프라인 완료(정상/실패) 시 **무조건 회고 실행** (사용자 명시적 스킵 요청만 예외)
- KPT 프레임워크: Keep(유지) / Problem(문제) / Try(시도)
- 정량 지표 수집: 소요 시간, 성공률, 재시도 횟수, 토큰 사용량
- 학습 → 에이전트 `.crew/memory/{agent-slug}/MEMORY.md` 기록 (max 10개, 6개월 후 삭제)
- gotchas 승격 → `.crew/gotchas.md` 갱신

## 6. 에이전트 동작 규칙

### 작업 시작 시 참조
- `.crew/config.md` — 프로젝트 설정, 아키텍처, 컨벤션
- `.crew/gotchas.md` — 프로젝트 주의사항
- `.crew/board.md` — 현재 태스크 상태
- `.crew/memory/{agent-slug}/MEMORY.md` — 학습된 지식

### 작업 완료 시
1. 변경 사항 요약 반환
2. viz 이벤트(`agent_end`) emit
3. 에러 시 `status="error"`로 보고 (근본 원인 + 영향 범위 포함)
4. 마지막 에이전트는 `pipeline_end` emit

### Context 관리
- 파이프라인 완료 후: completion-protocol Step 4.9에 따라 context health를 평가하고 `/compact` 제안
- 비파이프라인 장기 작업 완료 후: Edit/Write 30회 이상 수행했으면 `/compact` 제안
- `/compact` 제안 시 반드시 요약 메시지를 포함: `/compact {작업 요약 — 완료 상태, 다음 단계}`
- context rot 징후 감지 시 (이전 대화 참조 실패, 파일 경로 혼동 등): 즉시 `/compact` 제안

### Critical Gotchas
- **[G-A]** FE 배치 분할 필수: 변경 10파일 초과 또는 600초 이상 예상 시
- **[G-B]** Agent tool 호출 시 `subagent_type` 필수 지정
- **[G-C]** PRD DoD에 `pipeline_end` 기록 조건 포함 필수
- **[G-D]** 부서장이 spawn한 모든 에이전트는 `agent_start` emit 의무화 (부서장 자신도 커맨드에 의해 spawn될 때 emit)
- **[G-SIDECAR]** Tauri sidecar stale 시 빈 화면 — `curl localhost:3099/api/agents/data` 404면 `build-sidecar.sh` 재빌드 (상세: `.crew/gotchas.md`)
- Tool 권한 에러(`Write`/`Edit` 금지) → **재시도 0회, 즉시 에스컬레이션**
- 위임 20회 이상 예상 → **사전 분할 전략 필수** (Phase당 max 8회)

## 7. 컨벤션

- TypeScript ESM, `bun:sqlite` (ORM 없음), `Bun.serve()`
- `SKILL.md`는 `.tmpl`에서 자동 생성 — 직접 편집 금지
- `git add .` 금지 — 파일명 개별 명시
- `browse/dist/` 바이너리 커밋 금지
- 상세: `.crew/config.md` 참조

## 현재 상태

> Last updated: 2026-04-17

### 진행 중
- **`plan_에이전트모델opus47업그레이드`** (Backlog, 6 tasks)
  - Work Unit: 전체bams리뷰
  - PRD: `.crew/artifacts/prd/plan_에이전트모델opus47업그레이드-prd.md`
  - Spec: `.crew/artifacts/design/plan_에이전트모델opus47업그레이드-spec.md`
  - Design: `.crew/artifacts/design/plan_에이전트모델opus47업그레이드-design.md`
  - 영향: 38파일 / 95개소 (agents 5 + commands 30 + tests 3)
  - 다음: `/bams:dev plan_에이전트모델opus47업그레이드` 또는 `/bams:sprint plan`

### 완료 파이프라인
- `dev_vizDB재설계` — viz DB 전면 재설계 + UI 2페이지 구조 (12태스크, 92 tests, 87.9/100)
- `dev_워크상세파이프라인탭` — work/[slug] 탭 구조 개편 (6태스크)
- `feature_HR회고페이지` — HR 별도 페이지 + AppHeader 네비 (4파일)

### viz UI 구조 (v3.0)
- `/` (홈): Work Units 카드 그리드 + StatusFilter
- `/work/[slug]`: WU 3탭(Metaverse/Pipeline/Retro), Pipeline 서브탭(Agent/Timeline/DAG/Logs)
- `/hr`: HR 대시보드 (회고 기록, 에이전트 성과)
