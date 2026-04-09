## 1. 위임 원칙 (최우선 — 예외 없음)

**모든 코드 수정은 반드시 `pipeline-orchestrator → 부서장 → 에이전트` 3단 위임을 통해 수행한다.**

```
사용자 커맨드 → pipeline-orchestrator → 부서장 → 에이전트
```

- 허용: Bash/Glob으로 상태 확인, 사용자에게 질문, 읽기 전용 응답
- 금지: Edit/Write로 소스 코드 직접 변경, 에이전트 역할 대신 수행
- "내가 직접 하면 더 빠르다"는 판단으로 위임을 건너뛰지 않는다
- 위반 감지 시: 즉시 중단하고 pipeline-orchestrator에게 해당 작업을 위임
- **Work Unit 선택 규칙 준수 필수**: 활성 WU가 2개 이상이면 반드시 AskUserQuestion으로 사용자에게 선택을 요청한다. 커맨드 레벨에서 임의로 WU를 결정하지 않는다 (`_shared_common.md` §Work Unit 선택 참조)

## 2. 조직도 (6부서 27에이전트)

| 부서 | 부서장 | 소속 에이전트 |
|------|--------|--------------|
| 기획 | product-strategy | business-analysis, ux-research, project-governance |
| 개발(FE) | frontend-engineering | (직접 구현) |
| 개발(BE) | backend-engineering | (직접 구현) |
| 개발(인프라) | platform-devops | data-integration |
| 디자인 | design-director | ui-designer, ux-designer, graphic-designer, motion-designer, design-system-agent |
| QA | qa-strategy | automation-qa, defect-triage, release-quality-gate |
| 평가 | product-analytics | experimentation, performance-evaluation, business-kpi |
| 경영지원 | executive-reporter, resource-optimizer, hr-agent, cross-department-coordinator | (각자 독립) |

> 개발부서는 라우팅 편의상 FE/BE/인프라 3분할로 표현. jojikdo.json에서는 단일 engineering 부서. data-integration은 platform-devops 하위.

**위임 라우팅 — 태그 우선, 파일 패턴 보조:**

| 태그/패턴 | 부서장 |
|-----------|--------|
| `frontend` / `*.tsx`, `src/app/**`, `src/components/**`, `*.css` | frontend-engineering |
| `backend` / `src/app/api/**`, `*.server.ts`, `prisma/**` | backend-engineering |
| `infra`/`devops` / `Dockerfile`, `.github/**` | platform-devops |
| `data` / `*.sql`, `scripts/etl/**` | data-integration |
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
| `/bams:init` | 프로젝트 초기화 |
| `/bams:start` | 작업 단위(WU) 시작 |
| `/bams:end` | 작업 단위 종료 |
| `/bams:plan` | PRD + 기술 설계 + 태스크 분해 |
| `/bams:feature` | 풀 피처 개발 사이클 |
| `/bams:dev` | 멀티에이전트 풀 개발 파이프라인 |
| `/bams:hotfix` | 버그 핫픽스 빠른 경로 |
| `/bams:debug` | 버그 분류 → 수정 → 회귀 테스트 |
| `/bams:review` | 5관점 병렬 코드 리뷰 |
| `/bams:ship` | PR 생성 + 머지 |
| `/bams:status` | 프로젝트 대시보드 현황 |
| `/bams:sprint` | 스프린트 플래닝 및 관리 |
| `/bams:viz` | 파이프라인 실행 시각화 |

## 4. viz 이벤트 규칙

### emit 원칙
- 커맨드 레벨: `pipeline_start`/`pipeline_end`만 emit 가능
- 나머지(`step_*`, `agent_*`, `error`): orchestrator → 부서장 → 에이전트 위임 체계 내에서만 emit

### 이벤트 타입 (8종)

| 타입 | 필수 필드 |
|------|----------|
| `pipeline_start` | pipeline_slug, pipeline_type, command, arguments, work_unit_slug? |
| `pipeline_end` | pipeline_slug, status(`completed`\|`failed`\|`paused`\|`rolled_back`), total_steps, completed_steps, failed_steps, duration_ms |
| `step_start` | pipeline_slug, step_number, step_name, phase |
| `step_end` | pipeline_slug, step_number, status(`done`\|`fail`\|`skipped`), duration_ms |
| `agent_start` | call_id, agent_type, department, model, description, step_number |
| `agent_end` | call_id, agent_type, is_error, status, duration_ms, result_summary |
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

### Critical Gotchas
- **[G-A]** FE 배치 분할 필수: 변경 10파일 초과 또는 600초 이상 예상 시
- **[G-B]** Agent tool 호출 시 `subagent_type` 필수 지정
- **[G-C]** PRD DoD에 `pipeline_end` 기록 조건 포함 필수
- **[G-D]** 모든 에이전트 `agent_start` emit 의무화
- Tool 권한 에러(`Write`/`Edit` 금지) → **재시도 0회, 즉시 에스컬레이션**
- 위임 20회 이상 예상 → **사전 분할 전략 필수** (Phase당 max 8회)

## 7. 컨벤션

- TypeScript ESM, `bun:sqlite` (ORM 없음), `Bun.serve()`
- `SKILL.md`는 `.tmpl`에서 자동 생성 — 직접 편집 금지
- `git add .` 금지 — 파일명 개별 명시
- `browse/dist/` 바이너리 커밋 금지
- 상세: `.crew/config.md` 참조

## 현재 상태

> Last updated: 2026-04-06

### 완료 파이프라인
- `dev_vizDB재설계` — viz DB 전면 재설계 + UI 2페이지 구조 (12태스크, 92 tests, 87.9/100)
- `dev_워크상세파이프라인탭` — work/[slug] 탭 구조 개편 (6태스크)
- `feature_HR회고페이지` — HR 별도 페이지 + AppHeader 네비 (4파일)

### viz UI 구조 (v3.0)
- `/` (홈): Work Units 카드 그리드 + StatusFilter
- `/work/[slug]`: WU 3탭(Metaverse/Pipeline/Retro), Pipeline 서브탭(Agent/Timeline/DAG/Logs)
- `/hr`: HR 대시보드 (회고 기록, 에이전트 성과)
