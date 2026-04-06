## ★ Bams 조직 운영 규칙 (최우선)

> 이 규칙은 모든 /bams:\* 커맨드에서 최우선으로 적용됩니다.
> 위반 시 즉시 중단하고 올바른 위임 경로로 전환하세요.

### 1. 위임 원칙 — 커맨드 레벨 직접 수정 절대 금지

**모든 코드 수정은 반드시 `pipeline-orchestrator → 부서장 → 에이전트` 위임 체계를 통해 수행합니다.**

- 허용: Bash/Glob으로 상태 확인, 사용자에게 질문
- 금지: Edit/Write로 소스 코드 직접 변경, 에이전트 역할 대신 수행
- 위반 감지 시: 즉시 작업을 중단하고 pipeline-orchestrator에게 해당 작업을 위임
- "내가 직접 하면 더 빠르다"는 판단으로 위임을 건너뛰지 않는다
- 간단한 수정이라도 예외 없이 orchestrator → 부서장 → 에이전트 3단 위임 구조 준수

위임 구조:

```
사용자 커맨드 → pipeline-orchestrator → 부서장 → 에이전트
```

각 에이전트는 자신의 전문 분야에서만 작업합니다:

- 기획: product-strategy, business-analysis, ux-research, project-governance
- 개발: frontend-engineering, backend-engineering, platform-devops, data-integration
- 디자인: design-director, ui-designer, ux-designer, graphic-designer, motion-designer, design-system-agent
- QA: qa-strategy, automation-qa, defect-triage, release-quality-gate
- 평가: product-analytics, experimentation, performance-evaluation, business-kpi
- 경영지원: executive-reporter, cross-department-coordinator, resource-optimizer, hr-agent

### 2. viz 이벤트 emit 규칙

커맨드 레벨에서 viz 이벤트(step_start, step_end, agent_start, agent_end)를 직접 Bash로 emit하지 않는다.
모든 viz 이벤트 emit은 pipeline-orchestrator → 부서장 → 에이전트 위임 체계 내에서 수행한다.
커맨드 레벨에서는 pipeline_start/pipeline_end만 emit 가능 (엔트리포인트 수준).

### 3. Work Unit 선택 규칙

활성 work unit이 2개 이상일 때 파이프라인 시작 전 반드시 AskUserQuestion으로 어떤 작업에 연결할지 사용자에게 물어야 한다.
- 1개면 자동 선택
- 0개면 경고 후 WU 없이 진행

### 4. 파이프라인 네이밍 규칙

모든 파이프라인 slug는 다음 형식을 따릅니다:

```
{command}_{한글요약}
```

- command: feature, hotfix, dev, debug
- 한글요약: 공백 없이 작업 내용 요약

예: `feature_결제플로우구현`, `hotfix_빌드에러수정`

**slug는 파이프라인 수명 동안 불변(immutable)입니다.** 상태는 slug에 포함하지 않으며,
이벤트 파일 내 `pipeline_start` / `pipeline_end` 이벤트로 자동 판별합니다.

- `pipeline_end` 없음 → 진행 중
- `pipeline_end` 있음 → 완료 (status 필드 기준)

이 규칙은 이벤트 파일, PRD, 설계문서, 리뷰, board.md 태스크 ID에 모두 적용됩니다.
상세: `.crew/references/pipeline-naming-convention.md` 참조

### 5. 데이터 기록 규칙

- 파이프라인 시작/종료 시 반드시 viz 이벤트를 emit합니다
- 모든 아티팩트는 `.crew/artifacts/` 하위에 네이밍 규칙에 따라 저장합니다
- board.md 업데이트는 project-governance 에이전트를 통해 수행합니다

### 6. Bams 커맨드 목록

| 커맨드          | 설명                            |
| --------------- | ------------------------------- |
| `/bams:init`    | 프로젝트 초기화                 |
| `/bams:plan`    | PRD + 기술 설계 + 태스크 분해   |
| `/bams:feature` | 풀 피처 개발 사이클             |
| `/bams:dev`     | 멀티에이전트 풀 개발 파이프라인 |
| `/bams:hotfix`  | 버그 핫픽스 빠른 경로           |
| `/bams:debug`   | 버그 분류 → 수정 → 회귀 테스트  |
| `/bams:review`  | 5관점 병렬 코드 리뷰            |
| `/bams:ship`    | PR 생성 + 머지                  |
| `/bams:status`  | 프로젝트 대시보드 현황          |
| `/bams:sprint`  | 스프린트 플래닝 및 관리         |
| `/bams:viz`     | 파이프라인 실행 시각화          |

### 7. 에이전트 필수 활용 원칙

**Claude Code로 코드를 수정하는 모든 작업은 Bams 조직의 에이전트를 통해 수행합니다.**

- 코드 수정이 필요한 요청 → pipeline-orchestrator에게 위임
- orchestrator가 판단: 파이프라인 필요 여부 결정
  - 복잡한 작업 → `/bams:dev`, `/bams:feature` 등 파이프라인으로 처리
  - 단순 작업 → 해당 부서 에이전트에게 직접 위임
- 읽기 전용 작업(질문, 상태 확인 등)은 직접 응답 가능

### 8. Reference 참조 규칙

에이전트는 작업 시작 시 다음을 참조합니다:

- `.crew/config.md` — 프로젝트 설정, 아키텍처, 컨벤션
- `.crew/gotchas.md` — 프로젝트 주의사항
- `.crew/board.md` — 현재 태스크 상태
- 각 에이전트의 `.crew/memory/{agent-slug}/MEMORY.md` — 학습된 지식

### 9. 에이전트 동작 완료 규칙

모든 에이전트는 작업 완료 시:

1. 변경 사항 요약을 반환합니다
2. viz 이벤트(agent_end)를 emit합니다
3. 에러 발생 시 status="error"로 보고하고, 근본 원인과 영향 범위를 포함합니다
4. 파이프라인의 마지막 에이전트는 pipeline_end를 emit합니다

## Bams 현재 상태

> Last updated: 2026-04-06

### 완료 파이프라인

- `dev_vizDB재설계` — viz DB 전면 재설계 + UI 2페이지 구조 전환 (12태스크, 92 tests, 87.9/100)

### 아티팩트

- PRD: `.crew/artifacts/prd/dev_vizDB재설계-prd.md`
- 성과 보고서: `.crew/artifacts/report/dev_vizDB재설계-report.md`
- 테스트: `plugins/bams-plugin/tools/bams-db/test/pipeline-crud.test.ts` (34 tests)

### DB 스키마 (v2 — FK 기반)

- `work_units` → `pipelines` (work_unit_id FK) → `tasks` (pipeline_id FK)
- `run_logs` (pipeline_id FK), `task_events` (task_id FK)
- 제거: token_usage, budget_policies, pipeline_work_unit, retro_slug

### viz UI 구조

- 랜딩 (`/`): Work 카드 그리드 + StatusFilter
- 상세 (`/work/[slug]`): Pipeline 아코디언 + TaskTable + Agents/Timeline 탭
