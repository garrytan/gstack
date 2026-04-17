# Feature: Phase 1 — 기획 (기획부장 위임)

> 이 파일은 `/bams:feature`의 Phase 1을 실행합니다.
> 공통 규칙은 `_common.md`를 참조합니다 (엔트리포인트에서 이미 로드됨).

## 입력 컨텍스트

- slug: {엔트리포인트에서 결정된 slug}
- feature_description: {$ARGUMENTS}
- 이전 Phase 산출물:
  - 파이프라인 실행 계획: Phase 0에서 수신

---

## Step 1. PRD 작성

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 1 "PRD 작성" "Phase 1: 기획"
```

**컨텍스트 확인**: `.crew/artifacts/prd/[slug]-prd.md` 존재 시 건너뜁니다.

**루프 B — Advisor 조언 후 메인이 product-strategy 직접 spawn.**

### Step 1-a. pipeline-orchestrator 조언 요청 (Advisor)

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-1-$(date -u +%Y%m%d)" "pipeline-orchestrator" "claude-opus-4-7[1m]" "Step 1: PRD 작성 조언 요청"
```

Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, model: **"claude-opus-4-7[1m]"** — **조언자 모드**:

> **Phase 1 Step 1 Advisor 호출 — PRD 작성 라우팅 권고**
>
> **컨텍스트:**
> ```
> phase: 1
> slug: {slug}
> pipeline_type: feature
> config: .crew/config.md
> feature_description: {$ARGUMENTS}
> ```
>
> **요청:** 메인이 직접 spawn할 부서장(product-strategy 권고)과 위임 메시지 템플릿, PRD 게이트 조건을 Advisor Response로 반환하세요. 직접 spawn 금지(harness 깊이 2 제약).

반환 후 agent_end emit + Advisor Response 파싱 + CHAIN_VIOLATION 체크:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-1-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "Step 1 Advisor 응답 수신"
```

### Step 1-b. 메인이 product-strategy 직접 spawn

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "product-strategy-1-$(date -u +%Y%m%d)" "product-strategy" "claude-opus-4-7[1m]" "Step 1: PRD 작성"
```

Task tool, subagent_type: **"bams-plugin:product-strategy"**, model: **"claude-opus-4-7[1m]"** — 메인이 직접 호출:

> **Phase 1 Step 1 — PRD 작성**
>
> ```
> task_description: "피처 요청을 분석하고 PRD를 작성하라"
> input_artifacts:
>   - .crew/config.md
> expected_output:
>   type: prd_document
>   paths: [.crew/artifacts/prd/{slug}-prd.md]
> quality_criteria:
>   - 명확한 문제 정의와 목표
>   - 사용자 스토리 포함
>   - 인수 기준 정의
>   - 스코프 경계 명시
> ```
>
> product-strategy는 자신의 도메인 내에서 business-analysis / ux-research specialist를 최대 1회 추가 spawn 가능(harness 깊이 2 한도).
>
> **미결 질문이 있으면** 반드시 보고하세요.

반환 후 agent_end emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "product-strategy-1-$(date -u +%Y%m%d)" "product-strategy" "success" {duration_ms} "Step 1 완료: PRD 작성 완료"
```

**미결 질문이 있으면** 사용자에게 제시하고 답변을 기다립니다.

Step 1 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 1 "done" {duration_ms}
```

---

## Step 2. 기술 설계 + 태스크 분해 + 스프린트 설정

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 2 "기술 설계 + 태스크 분해 + 스프린트" "Phase 1: 기획"
```

**컨텍스트 확인**: `.crew/artifacts/design/[slug]-design.md` 존재 시 설계 단계를 건너뜁니다.

**루프 B — Advisor 조언 후 메인이 기획/개발 부서장 3명을 병렬 직접 spawn, 이어 project-governance 직접 spawn.**

### Step 2-a. pipeline-orchestrator 조언 요청 (Advisor)

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-2-$(date -u +%Y%m%d)" "pipeline-orchestrator" "claude-opus-4-7[1m]" "Step 2: 설계/태스크 조언 요청"
```

Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, model: **"claude-opus-4-7[1m]"** — **조언자 모드**:

> **Phase 1 Step 2 Advisor 호출 — 기술 설계 + 태스크 분해 라우팅 권고**
>
> **컨텍스트:**
> ```
> phase: 1
> slug: {slug}
> pipeline_type: feature
> prd: .crew/artifacts/prd/{slug}-prd.md
> config: .crew/config.md
> board: .crew/board.md
> ```
>
> **요청:** 병렬로 spawn할 부서장 목록(product-strategy, frontend-engineering, backend-engineering 권고), 각 부서장별 위임 메시지 템플릿, 이후 project-governance 스프린트 설정 위임 메시지, Phase 게이트 기준을 Advisor Response로 반환하세요. 직접 spawn 금지.

반환 후 agent_end emit + Advisor Response 파싱 + CHAIN_VIOLATION 체크:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-2-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "Step 2 Advisor 응답 수신"
```

### Step 2-b. 메인이 기획/FE/BE 부서장 3명 병렬 직접 spawn (단일 메시지 복수 Task)

병렬 호출 전 3개의 agent_start를 일괄 emit (product-strategy / frontend-engineering / backend-engineering).

**단일 메시지에 3개 Task tool 호출을 묶어** 병렬 spawn합니다:

1. Task tool, subagent_type: **"bams-plugin:product-strategy"**, model: **"claude-opus-4-7[1m]"** — 기능 명세:
> ```
> task_description: "PRD 기반 상세 동작 명세를 작성하라"
> input_artifacts: [.crew/artifacts/prd/{slug}-prd.md]
> expected_output:
>   type: functional_spec
>   paths: [.crew/artifacts/design/{slug}-spec.md]
> quality_criteria:
>   - 모든 유저 플로우 커버
>   - 엣지 케이스 정의
>   - 데이터 모델 명시
> ```
> product-strategy는 business-analysis specialist를 최대 1회 추가 spawn 가능.

2. Task tool, subagent_type: **"bams-plugin:frontend-engineering"**, model: **"claude-opus-4-7[1m]"** — FE 기술 설계:
> ```
> task_description: "PRD 기반 프론트엔드 기술 설계(UI/컴포넌트/상태관리)를 작성하라"
> input_artifacts: [.crew/artifacts/prd/{slug}-prd.md, .crew/config.md]
> expected_output:
>   type: technical_design
>   paths: [.crew/artifacts/design/{slug}-design.md (FE 섹션)]
> quality_criteria:
>   - 컴포넌트 구조 명확
>   - 데이터 흐름 명시
> ```

3. Task tool, subagent_type: **"bams-plugin:backend-engineering"**, model: **"claude-opus-4-7[1m]"** — BE 기술 설계:
> ```
> task_description: "PRD 기반 백엔드 기술 설계(API/DB/비즈니스 로직)를 작성하라"
> input_artifacts: [.crew/artifacts/prd/{slug}-prd.md, .crew/config.md]
> expected_output:
>   type: technical_design
>   paths: [.crew/artifacts/design/{slug}-design.md (BE 섹션)]
> quality_criteria:
>   - API 엔드포인트 정의
>   - DB 스키마 명확
> ```

3개 결과 수신 후 메인이 종합하여 태스크를 분해합니다 (각 태스크에 범위, 역할 할당, 우선순위, 의존성, 인수 기준 포함, board.md 형식).

병렬 완료 후 3개의 agent_end를 일괄 emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1)
[ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "product-strategy-2-$(date -u +%Y%m%d)" "product-strategy" "success" {duration_ms} "기능 명세 완료"
[ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "frontend-engineering-2-$(date -u +%Y%m%d)" "frontend-engineering" "success" {duration_ms} "FE 설계 완료"
[ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "backend-engineering-2-$(date -u +%Y%m%d)" "backend-engineering" "success" {duration_ms} "BE 설계 완료"
```

### Step 2-c. 메인이 project-governance 직접 spawn (스프린트 설정)

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "project-governance-2-$(date -u +%Y%m%d)" "project-governance" "claude-opus-4-7[1m]" "Step 2: 스프린트 설정"
```

Task tool, subagent_type: **"bams-plugin:project-governance"**, model: **"claude-opus-4-7[1m]"** — 메인이 직접 호출:

> **스프린트 설정 — 태스크 등록 + 스프린트 플랜**
>
> - 분해된 태스크를 board.md의 `## Backlog`에 추가
> - 스프린트 계획 수립 (`/bams:sprint plan` 실행)
> - `.crew/config.md`의 `last_task_id` 업데이트
>
> **TaskDB 동기화**: board.md에 태스크를 추가한 직후, DB가 존재하면 각 태스크를 DB에도 등록합니다:
> ```bash
> if [ -f "$HOME/.claude/plugins/marketplaces/my-claude/bams.db" ]; then
>   bun -e "
>     import { TaskDB } from './plugins/bams-plugin/tools/bams-db/index.ts';
>     const db = new TaskDB();
>     db.createTask({ pipeline_slug: '{slug}', title: '{task_title}', status: 'backlog', assignee_agent: '{agent}', phase: {phase}, priority: '{priority}', size: '{size}' });
>     db.close();
>   "
> fi
> ```
> 각 태스크마다 반복 실행합니다.
>
> **기대 산출물**: 스프린트 설정 완료, board.md 태스크 등록 완료

반환 후 agent_end emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "project-governance-2-$(date -u +%Y%m%d)" "project-governance" "success" {duration_ms} "Step 2 완료: 스프린트 설정 완료"
```

---

## 기획 → 구현 핸드오프

**루프 B — Advisor 게이트 판정 후 메인이 cross-department-coordinator 직접 spawn.**

### 핸드오프-a. pipeline-orchestrator 조언 요청 (Phase 게이트 판정)

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-handoff1-$(date -u +%Y%m%d)" "pipeline-orchestrator" "claude-opus-4-7[1m]" "기획→구현 게이트 판정 조언"
```

Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, model: **"claude-opus-4-7[1m]"** — **조언자 모드**:

> **Phase 1 → Phase 2 Advisor 호출 — 게이트 판정 + 핸드오프 라우팅**
>
> **컨텍스트:**
> ```
> phase: 1→2 handoff
> slug: {slug}
> pipeline_type: feature
> prd: .crew/artifacts/prd/{slug}-prd.md
> design: .crew/artifacts/design/{slug}-design.md
> board: .crew/board.md
> ```
>
> **요청:** Phase 1 완료 조건 검증 결과(GO/NO-GO/CONDITIONAL-GO) — PRD 승인, 기술 설계, 태스크 분해, 스프린트 설정 — 와, 핸드오프 조율을 위해 메인이 spawn할 조율자(cross-department-coordinator 권고)의 위임 메시지를 Advisor Response로 반환하세요. 직접 spawn 금지.

반환 후 agent_end emit + 파싱 + CHAIN_VIOLATION 체크:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-handoff1-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "기획→구현 Advisor 응답 수신"
```

### 핸드오프-b. 메인이 cross-department-coordinator 직접 spawn

Advisor 판정이 GO 또는 CONDITIONAL-GO인 경우에 진행. NO-GO이면 미충족 항목을 사용자에게 보고하고 해결 후 재시도.

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "cross-department-coordinator-handoff1-$(date -u +%Y%m%d)" "cross-department-coordinator" "claude-opus-4-7[1m]" "기획→구현 핸드오프 조율"
```

Task tool, subagent_type: **"bams-plugin:cross-department-coordinator"**, model: **"claude-opus-4-7[1m]"** — 메인이 직접 호출:

> **Phase 1→2 핸드오프 조율**
>
> - 기획부장의 산출물(PRD, 설계, 태스크)이 개발부장에게 올바르게 전달되는지 확인
> - 부서 간 인터페이스(API 계약, 데이터 스키마) 정합성 확인
> - 누락되거나 모호한 인터페이스 항목 보고
>
> **기대 산출물**: 핸드오프 체크리스트 결과

반환 후 agent_end emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "cross-department-coordinator-handoff1-$(date -u +%Y%m%d)" "cross-department-coordinator" "success" {duration_ms} "기획→구현 핸드오프 완료"
```

**Phase 게이트 결과가 NO-GO이면**: 미충족 항목을 사용자에게 보고하고, 해결 후 재시도합니다.

AskUserQuestion — "기획 완료. 구현을 진행할까요?"
- **진행 (Recommended)**
- **기획까지만** — `status: paused_at_step_2` 기록 후 종료.

Step 2 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 2 "done" {duration_ms}
```

---

## Phase 1 게이트 조건

- [ ] PRD 작성 완료 (`.crew/artifacts/prd/{slug}-prd.md`)
- [ ] 기술 설계 완료 (`.crew/artifacts/design/{slug}-design.md`)
- [ ] 태스크 분해 완료 (board.md Backlog에 추가)
- [ ] 스프린트 설정 완료
- [ ] 핸드오프 체크리스트 GO 판정

Phase 1 완료 → 엔트리포인트가 Phase 1.5 (Git 체크포인트)를 라우팅합니다.
