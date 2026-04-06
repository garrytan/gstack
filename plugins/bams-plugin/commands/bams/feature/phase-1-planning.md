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

pipeline-orchestrator에게 기획 Phase의 PRD 작성을 지시합니다.

Bash로 agent_start를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-1-$(date -u +%Y%m%d)" "pipeline-orchestrator" "sonnet" "Step 1: PRD 작성 위임"
```

서브에이전트 실행 (Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, model: **"sonnet"**):

> **Phase 1 기획 실행 — PRD 작성**
>
> **위임 메시지:**
> ```
> phase: 1
> slug: {slug}
> pipeline_type: feature
> context:
>   config: .crew/config.md
>   feature_description: {$ARGUMENTS}
> ```
>
> **수행할 작업:**
> product-strategy(기획부장)에게 다음을 위임합니다:
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
> product-strategy는 내부적으로 business-analysis, ux-research 에이전트를 활용하여 PRD를 작성합니다.
>
> **미결 질문이 있으면** 반드시 보고하세요.

orchestrator 반환 후, Bash로 agent_end를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-1-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "Step 1 완료: PRD 작성 완료"
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

pipeline-orchestrator에게 기술 설계, 태스크 분해, 스프린트 설정을 지시합니다.

Bash로 agent_start를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-2-$(date -u +%Y%m%d)" "pipeline-orchestrator" "sonnet" "Step 2: 기술 설계 + 태스크 분해 위임"
```

서브에이전트 실행 (Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, model: **"sonnet"**):

> **Phase 1 기획 실행 — 기술 설계 + 태스크 분해 + 스프린트 설정**
>
> **위임 메시지:**
> ```
> phase: 1
> slug: {slug}
> pipeline_type: feature
> context:
>   prd: .crew/artifacts/prd/{slug}-prd.md
>   config: .crew/config.md
>   board: .crew/board.md
> ```
>
> **수행할 작업 (병렬 위임):**
>
> 1. product-strategy(기획부장)에게 business-analysis를 통한 기능 명세 작성을 위임:
> ```
> task_description: "PRD 기반 상세 동작 명세를 작성하라"
> input_artifacts:
>   - .crew/artifacts/prd/{slug}-prd.md
> expected_output:
>   type: functional_spec
>   paths: [.crew/artifacts/design/{slug}-spec.md]
> quality_criteria:
>   - 모든 유저 플로우 커버
>   - 엣지 케이스 정의
>   - 데이터 모델 명시
> ```
>
> 2. 개발부장에게 프론트엔드/백엔드 기술 설계를 위임:
>    - frontend-engineering: UI 설계, 컴포넌트 구조, 상태 관리 설계
>    - backend-engineering: API 설계, DB 스키마, 비즈니스 로직 설계
>    (두 에이전트를 병렬로 실행)
>
> ```
> task_description: "PRD 기반 프론트엔드/백엔드 기술 설계를 작성하라"
> input_artifacts:
>   - .crew/artifacts/prd/{slug}-prd.md
>   - .crew/config.md
> expected_output:
>   type: technical_design
>   paths: [.crew/artifacts/design/{slug}-design.md]
> quality_criteria:
>   - 컴포넌트 구조 명확
>   - API 엔드포인트 정의
>   - 데이터 흐름 명시
> ```
>
> 3. 3개 결과를 종합하여 태스크를 분해:
>    - 각 태스크에 명확한 범위, 역할 할당, 우선순위, 의존성, 인수 기준 포함
>    - board.md에 추가할 형식으로 정리
>
> 4. project-governance에게 스프린트 설정을 위임:
>    - 분해된 태스크를 board.md의 `## Backlog`에 추가
>    - 스프린트 계획 수립 (`/bams:sprint plan` 실행)
>    - `.crew/config.md`의 `last_task_id` 업데이트
>
> 5. **TaskDB 동기화**: board.md에 태스크를 추가한 직후, DB가 존재하면 각 태스크를 DB에도 등록합니다:
>    ```bash
>    if [ -f "$HOME/.claude/plugins/marketplaces/my-claude/bams.db" ]; then
>      bun -e "
>        import { TaskDB } from './plugins/bams-plugin/tools/bams-db/index.ts';
>        const db = new TaskDB();
>        db.createTask({ pipeline_slug: '{slug}', title: '{task_title}', status: 'backlog', assignee_agent: '{agent}', phase: {phase}, priority: '{priority}', size: '{size}' });
>        db.close();
>      "
>    fi
>    ```
>    각 태스크마다 반복 실행합니다.
>
> **기대 산출물**: 기능 명세, 기술 설계, 태스크 분해 결과, 스프린트 설정 완료

orchestrator 반환 후, Bash로 agent_end를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-2-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "Step 2 완료: 기술 설계 + 태스크 분해 완료"
```

---

## 기획 → 구현 핸드오프

pipeline-orchestrator에게 Phase 전환 핸드오프를 지시합니다.

Bash로 agent_start를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-handoff1-$(date -u +%Y%m%d)" "pipeline-orchestrator" "sonnet" "기획→구현 핸드오프 위임"
```

서브에이전트 실행 (Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, model: **"sonnet"**):

> **Phase 1 → Phase 2 핸드오프 실행**
>
> **위임 메시지:**
> ```
> phase: 1→2 handoff
> slug: {slug}
> pipeline_type: feature
> context:
>   prd: .crew/artifacts/prd/{slug}-prd.md
>   design: .crew/artifacts/design/{slug}-design.md
>   board: .crew/board.md
> ```
>
> **수행할 작업:**
> 1. Phase 게이트 판단: Phase 1 완료 조건 검증 (PRD 승인, 기술 설계 완료, 태스크 분해 완료, 스프린트 설정 완료)
> 2. cross-department-coordinator에게 기획→구현 핸드오프 조율 위임:
>    - 기획부장의 산출물(PRD, 설계, 태스크)이 개발부장에게 올바르게 전달되는지 확인
>    - 부서 간 인터페이스(API 계약, 데이터 스키마) 정합성 확인
>    - 누락되거나 모호한 인터페이스 항목이 있으면 보고
> 3. executive-reporter에게 Phase 1 완료 상태 보고 요청
>
> **기대 산출물**: Phase 게이트 판단 결과 (GO/NO-GO/CONDITIONAL-GO), 핸드오프 체크리스트 결과

orchestrator 반환 후, Bash로 agent_end를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-handoff1-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "기획→구현 핸드오프 완료"
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
