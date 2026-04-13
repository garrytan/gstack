---
description: PRD + 기술 설계 + 태스크 분해 — 풀 피처 플래닝
argument-hint: <피처 또는 이슈 설명>
---

# Bams Plan

Bams 오케스트레이터로서 product-strategy, business-analysis, frontend/backend-engineering 에이전트를 활용한 플래닝 워크플로를 실행합니다.

기획할 피처/이슈: $ARGUMENTS

$ARGUMENTS가 비어있으면, 사용자에게 어떤 피처를 기획할지 물어보고 중단합니다.

## 코드 최신화

Bash로 `git rev-parse --is-inside-work-tree 2>/dev/null`를 실행하여 git 저장소인지 확인합니다.

**git 저장소인 경우**: Bash로 `git branch --show-current`를 실행하여 현재 브랜치를 확인한 뒤, `git pull origin {현재 브랜치}`를 실행하여 원격 저장소의 최신 코드를 가져옵니다. 충돌이 발생하면 사용자에게 알리고 중단합니다.

**git 저장소가 아닌 경우**: 이 단계를 스킵합니다.

## 사전 조건

Glob으로 `.crew/config.md`가 존재하는지 확인합니다. 없으면:
- 출력: "프로젝트가 초기화되지 않았습니다. `/bams:init`을 실행하여 설정하세요."
- 여기서 중단.

`.crew/config.md`와 `.crew/board.md`를 읽어 현재 상태를 파악합니다.

> **위임 체계 (Canonical)**: 이 커맨드는 `_shared_common.md` §위임 원칙 + 부록 **루프 B**(Advised)를 따른다. 메인(커맨드)이 부서장을 **직접** Task tool로 spawn하며, pipeline-orchestrator는 조언자(Advisor) 모드로 1회만 호출된다. orchestrator를 경유한 중첩 spawn 금지(harness 깊이 2 제약).

**공통 규칙 로드**: 반드시 `plugins/bams-plugin/commands/bams/_shared_common.md`를 Read합니다.

## Work Unit 선택

`_shared_common.md` §Work Unit 선택 규칙을 따릅니다. 활성 WU를 확인하고, 0개면 WU 없이 진행, 1개면 자동 선택, 2개 이상이면 AskUserQuestion으로 사용자에게 선택을 요청합니다.

## Viz 이벤트: pipeline_start

WU 선택 완료 후, Bash로 다음을 실행합니다:

```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1)
[ -n "$_EMIT" ] && bash "$_EMIT" recover "{slug}"
[ -n "$_EMIT" ] && bash "$_EMIT" pipeline_start "{slug}" "plan" "/bams:plan" "{arguments}" "" "${SELECTED_WU_SLUG:-}"
```

DB 연결 기록 (DB가 존재하면):
```bash
if [ -n "${SELECTED_WU_SLUG:-}" ] && [ -f "$HOME/.claude/plugins/marketplaces/my-claude/bams.db" ]; then
  BAMS_WU_SLUG="${SELECTED_WU_SLUG}" BAMS_PIPELINE_SLUG="{slug}" bun -e "
    import { TaskDB } from './plugins/bams-plugin/tools/bams-db/index.ts';
    const db = new TaskDB();
    const wu = process.env.BAMS_WU_SLUG;
    const pl = process.env.BAMS_PIPELINE_SLUG;
    db.upsertWorkUnit(wu);
    db.linkPipelineToWorkUnit(pl, wu);
    db.close();
  " 2>/dev/null || true
fi
```

> **참고**: `_EMIT` 변수는 위 pipeline_start 블록에서 한 번 설정됩니다. 이후 모든 emit 호출에서는 동일한 변수를 재사용합니다.

파이프라인 상태 추적 변수를 초기화합니다:
- `_TOTAL_STEPS=5`
- `_COMPLETED_STEPS=0`
- `_FAILED_STEPS=0`
- `_PIPELINE_STATUS="completed"`

## Phase 1: PRD 작성 — 루프 A (Simple, 단일 부서장 직접 spawn)

Phase 1은 단일 도메인(기획)이므로 **루프 A**를 따른다. orchestrator 조언을 생략하고 메인이 product-strategy(기획부장)를 직접 호출한다.

Bash로 step_start + agent_start emit:
```bash
[ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 1 "PRD 작성" "Phase 1: 기획"
[ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "product-strategy-1-$(date -u +%Y%m%d)" "product-strategy" "opus" "Phase 1: PRD 작성"
```

Task tool, subagent_type: **"bams-plugin:product-strategy"**, model: **"opus"** — 메인이 직접 호출:

> **기획 Phase 1 — PRD 작성**
>
> ```
> task_description: "피처 요청을 분석하고 구조화된 PRD를 작성하라"
> input_artifacts:
>   - .crew/config.md
>   - feature_description: {$ARGUMENTS}
> expected_output:
>   type: prd_document
>   paths: [.crew/artifacts/prd/{slug}-prd.md]
> quality_criteria:
>   - 문제 정의 및 목표 명확
>   - 사용자 스토리 / 유스케이스 포함
>   - 기능 요구사항 (필수/선택) 구분
>   - 비기능 요구사항 (성능, 보안, 접근성) 포함
>   - 인수 기준 (테스트 가능한 구체적 기준) 정의
>   - 미결 질문 명시
> ```
>
> 기획부장은 도메인 내 business-analysis / ux-research specialist를 **최대 1회** 추가 spawn 가능(harness 깊이 2 한도).
>
> **미결 질문이 있으면** 반드시 보고하세요.

반환 후 결과를 확인합니다:
- **성공 시**: agent_end status="success" + step_end status="done" + `_COMPLETED_STEPS` 증가
- **에러 시**: agent_end status="error" + step_end status="fail" + `_FAILED_STEPS` 증가. 사용자에게 에러를 보고하고, 계속 진행할지 중단할지 AskUserQuestion으로 확인.

```bash
# 성공 시:
[ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "product-strategy-1-$(date -u +%Y%m%d)" "product-strategy" "success" {duration_ms} "PRD 작성 완료"
[ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 1 "done" {duration_ms}
_COMPLETED_STEPS=$((_COMPLETED_STEPS + 1))
# 에러 시:
# [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "product-strategy-1-$(date -u +%Y%m%d)" "product-strategy" "error" {duration_ms} "PRD 작성 실패: {에러 메시지}"
# [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 1 "fail" {duration_ms}
# _FAILED_STEPS=$((_FAILED_STEPS + 1))
# → AskUserQuestion: "Phase 1 PRD 작성이 실패했습니다. 계속 진행할까요, 중단할까요?"
# → 중단 선택 시: _PIPELINE_STATUS="failed" 설정 후 Phase 7(pipeline_end)으로 이동
```

**미결 질문이 있으면**: 불릿 포인트로 사용자에게 제시합니다. Phase 2로 진행하기 전에 사용자의 답변을 기다립니다. 이 단계를 절대 건너뛰지 마세요. 답변을 받은 후 PRD에 반영합니다.

## Phase 2: 기능 명세 + 기술 설계 — 루프 B (Advised, 다부서 병렬 직접 spawn)

Phase 2는 기획/개발 **다부서** 병렬 트랙이므로 **루프 B**를 따른다. orchestrator를 Advisor로 1회 호출하여 라우팅/게이트 권고를 받은 뒤, 메인이 권고된 부서장들을 단일 메시지 내 복수 Task 호출로 **직접 병렬 spawn**한다.

### Phase 2-a. pipeline-orchestrator 조언 요청 (Advisor)

Bash로 step_start + agent_start emit:
```bash
[ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 2 "명세+설계 계획" "Phase 2: Advisor"
[ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-2-$(date -u +%Y%m%d)" "pipeline-orchestrator" "opus" "Phase 2: 기능명세+기술설계 조언 요청"
```

Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, model: **"opus"** — **조언자 모드**:

> **Plan Phase 2 Advisor 호출 — 기능 명세 + 기술 설계 라우팅 권고**
>
> **컨텍스트:**
> ```
> phase: 2
> slug: {slug}
> pipeline_type: plan
> prd: .crew/artifacts/prd/{slug}-prd.md
> config: .crew/config.md
> ```
>
> **요청:** 메인이 병렬 spawn할 부서장 목록과 위임 메시지 템플릿(기능 명세는 product-strategy, FE/BE 기술 설계는 frontend-engineering / backend-engineering), 산출물 경로, 게이트 조건을 Advisor Response로 반환하세요. 직접 spawn 금지(harness 깊이 2 제약).

반환 후 agent_end emit + Advisor Response 파싱 + CHAIN_VIOLATION 체크:

**CHAIN_VIOLATION 체크**: orchestrator 반환 내용의 첫 줄에 "CHAIN_VIOLATION"이 포함되어 있으면:
- agent_end status="error" emit
- step_end status="fail" emit
- 사용자에게 위반 사항을 보고
- `_PIPELINE_STATUS="failed"` 설정
- pipeline_end emit 후 즉시 중단

```bash
# CHAIN_VIOLATION이 감지된 경우:
# [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-2-$(date -u +%Y%m%d)" "pipeline-orchestrator" "error" {duration_ms} "CHAIN_VIOLATION 감지"
# [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 2 "fail" {duration_ms}
# _FAILED_STEPS=$((_FAILED_STEPS + 1))
# _PIPELINE_STATUS="failed"
# → 사용자에게 위반 사항 보고 후 Phase 7(pipeline_end)으로 즉시 이동하여 파이프라인 종료

# 정상인 경우:
[ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-2-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "Phase 2 Advisor 응답 수신"
[ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 2 "done" {duration_ms}
_COMPLETED_STEPS=$((_COMPLETED_STEPS + 1))
```

### Phase 2-b. 메인이 부서장 3트랙 병렬 직접 spawn

Bash로 step_start + 3개 agent_start 일괄 emit:
```bash
[ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 3 "명세+설계 병렬 실행" "Phase 2: 실행"
[ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "product-strategy-2-$(date -u +%Y%m%d)" "product-strategy" "opus" "Phase 2: 기능 명세"
[ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "frontend-engineering-2-$(date -u +%Y%m%d)" "frontend-engineering" "opus" "Phase 2: FE 기술 설계"
[ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "backend-engineering-2-$(date -u +%Y%m%d)" "backend-engineering" "opus" "Phase 2: BE 기술 설계"
```

**단일 메시지에 3개 Task tool 호출을 동시에 발행하여 메인이 직접 병렬 spawn:**

1. Task tool, subagent_type: **"bams-plugin:product-strategy"**, model: **"opus"**
   > **Plan Phase 2 — 기능 명세**
   > ```
   > task_description: "PRD를 기반으로 상세 기능 명세를 작성하라"
   > input_artifacts: [.crew/artifacts/prd/{slug}-prd.md, .crew/config.md]
   > expected_output: { type: functional_spec, paths: [.crew/artifacts/design/{slug}-spec.md] }
   > quality_criteria:
   >   - 화면/API별 상세 동작 명세 완성
   >   - 데이터 모델 정의
   >   - 상태 전이 다이어그램 (필요 시)
   >   - 에러 시나리오 및 처리 방법
   >   - 외부 시스템 연동 명세
   > ```
   > 기획부장은 business-analysis specialist를 최대 1회 추가 spawn 가능.

2. Task tool, subagent_type: **"bams-plugin:frontend-engineering"**, model: **"opus"**
   > **Plan Phase 2 — FE 기술 설계**
   > ```
   > task_description: "PRD를 기반으로 프론트엔드 기술 설계를 작성하라"
   > input_artifacts: [.crew/artifacts/prd/{slug}-prd.md, .crew/config.md]
   > expected_output: { type: technical_design_fe, paths: [.crew/artifacts/design/{slug}-design-fe.md] }
   > quality_criteria:
   >   - 컴포넌트 구조 명확
   >   - 상태 관리/라우팅/스타일링 전략
   >   - 파일 목록
   > ```

3. Task tool, subagent_type: **"bams-plugin:backend-engineering"**, model: **"opus"**
   > **Plan Phase 2 — BE 기술 설계**
   > ```
   > task_description: "PRD를 기반으로 백엔드 기술 설계를 작성하라"
   > input_artifacts: [.crew/artifacts/prd/{slug}-prd.md, .crew/config.md]
   > expected_output: { type: technical_design_be, paths: [.crew/artifacts/design/{slug}-design-be.md] }
   > quality_criteria:
   >   - API 엔드포인트 정의 완료
   >   - DB 스키마 / 비즈니스 로직
   >   - 인증/권한
   >   - 파일 목록
   > ```

3개 반환 후 각 에이전트 결과를 확인합니다:
- **성공 시**: agent_end status="success" + `_COMPLETED_STEPS` 증가 (step_end 시점에)
- **에러 시**: agent_end status="error" + `_FAILED_STEPS` 증가. 사용자에게 어떤 트랙이 실패했는지 보고하고, 계속 진행할지 중단할지 AskUserQuestion으로 확인.

```bash
# 각 에이전트별로 성공/에러 분기 처리:
# product-strategy — 성공 시:
[ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "product-strategy-2-$(date -u +%Y%m%d)" "product-strategy" "success" {duration_ms} "기능 명세 완료"
# product-strategy — 에러 시:
# [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "product-strategy-2-$(date -u +%Y%m%d)" "product-strategy" "error" {duration_ms} "기능 명세 실패: {에러 메시지}"

# frontend-engineering — 성공 시:
[ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "frontend-engineering-2-$(date -u +%Y%m%d)" "frontend-engineering" "success" {duration_ms} "FE 설계 완료"
# frontend-engineering — 에러 시:
# [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "frontend-engineering-2-$(date -u +%Y%m%d)" "frontend-engineering" "error" {duration_ms} "FE 설계 실패: {에러 메시지}"

# backend-engineering — 성공 시:
[ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "backend-engineering-2-$(date -u +%Y%m%d)" "backend-engineering" "success" {duration_ms} "BE 설계 완료"
# backend-engineering — 에러 시:
# [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "backend-engineering-2-$(date -u +%Y%m%d)" "backend-engineering" "error" {duration_ms} "BE 설계 실패: {에러 메시지}"

# 에러가 하나라도 있으면 _FAILED_STEPS 증가, 모두 성공이면 _COMPLETED_STEPS 증가
# _STEP3_ERRORS=0  (에러 발생한 트랙 수 카운트)
# [ $_STEP3_ERRORS -gt 0 ] && _FAILED_STEPS=$((_FAILED_STEPS + 1)) || _COMPLETED_STEPS=$((_COMPLETED_STEPS + 1))
# 에러 시 → AskUserQuestion: "Phase 2-b에서 {실패 트랙}이 실패했습니다. 계속 진행할까요, 중단할까요?"
# 중단 선택 시: _PIPELINE_STATUS="failed" 설정 후 Phase 7(pipeline_end)으로 이동

# step_end — 에러가 없으면 "done", 있으면 "fail"
[ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 3 "done" {duration_ms}
_COMPLETED_STEPS=$((_COMPLETED_STEPS + 1))
```

**기대 산출물**: 기능 명세, FE 기술 설계, BE 기술 설계 (3트랙 병렬 결과)

## Phase 3: 태스크 분해

Bash로 step_start emit:
```bash
[ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 4 "태스크 분해" "Phase 3: 분해"
```

pipeline-orchestrator가 반환한 Phase 2 결과를 종합하여 구체적인 태스크로 분해합니다:

1. 기능 명세(spec)와 기술 설계(design) 문서 읽기
2. 기능 명세와 기술 설계를 병합
3. 작업을 개별 태스크로 분해. 각 태스크는:
   - 한 세션에서 완료 가능 (생성/수정 파일 5개 이하, 변경 라인 200줄 이하 목표)
   - 명확한 입력(읽을 것)과 출력(만들 것) 보유
   - 명시적 파일 범위
   - 역할 할당: Developer, Reviewer, 또는 QA
   - 우선순위: P0 (핵심 경로), P1 (중요), P2 (있으면 좋음)
4. 태스크 간 의존성 식별
5. 병렬 실행 가능한 태스크 식별

Bash로 step_end emit:
```bash
[ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 4 "done" {duration_ms}
_COMPLETED_STEPS=$((_COMPLETED_STEPS + 1))
```

## Phase 4: 아티팩트 저장 및 보드 업데이트

Bash로 step_start emit:
```bash
[ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 5 "아티팩트 저장" "Phase 4: 저장"
```

`.crew/board.md`가 존재하지 않으면 기본 템플릿으로 생성합니다:
```markdown
# Task Board

> Last updated: {현재 날짜}

## Backlog

## In Progress

## In Review

## Done
```

1. 피처명에서 slug 생성 (소문자, 하이픈, 특수문자 없음)

2. PRD를 `.crew/artifacts/prd/[slug]-prd.md`에 저장

3. 기술 설계를 `.crew/artifacts/design/[slug]-design.md`에 저장 (기능 명세 + 프론트엔드 설계 + 백엔드 설계 통합)

4. `.crew/config.md` 프론트매터에서 현재 `last_task_id` 읽기

5. `.crew/board.md` 업데이트: 각 태스크를 `## Backlog` 섹션에 다음 형식으로 추가:

```markdown
### TASK-[NNN]: [태스크 제목]
- **Role**: Developer | Reviewer | QA
- **Priority**: P0 | P1 | P2
- **Depends on**: TASK-[NNN] | none
- **Feature**: [slug]
- **Files**: [생성/수정할 파일 목록]
- **Description**: [1-2문장 설명]
- **Acceptance criteria**: [구체적이고 테스트 가능한 기준]
```

6. `.crew/config.md` 프론트매터의 `last_task_id`를 업데이트

7. `board.md`의 `> Last updated:` 타임스탬프 업데이트

Bash로 step_end emit:
```bash
[ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 5 "done" {duration_ms}
_COMPLETED_STEPS=$((_COMPLETED_STEPS + 1))
```

## Phase 5: 사용자에게 계획 제시

간결한 요약을 제시합니다:

```
피처: [name]
PRD: .crew/artifacts/prd/[slug]-prd.md
설계: .crew/artifacts/design/[slug]-design.md

태스크 ([N]개 총):
  [의존성 트리 보여주는 정렬된 목록]
  예시:
    TASK-001: [title] (P0, Developer)
    TASK-002: [title] (P0, Developer) - TASK-001에 블록됨
    TASK-003: [title] (P1, Developer) - TASK-001과 병렬 실행 가능

병렬 실행 가능: [N]개 태스크 동시 실행 가능
핵심 경로: TASK-XXX -> TASK-XXX -> TASK-XXX

개발 시작하려면: /bams:dev [slug]
```

## Phase 6: CLAUDE.md 상태 업데이트

`CLAUDE.md`의 `## Bams 현재 상태` 섹션을 업데이트합니다 (없으면 파일 끝에 추가, 있으면 Edit으로 교체). `.crew/board.md`를 읽어 다음을 포함:
- 마지막 업데이트 타임스탬프
- 진행 중인 작업 (In Progress/In Review 태스크)
- 활성 스프린트 정보
- 이번 실행에서 생성된 아티팩트 경로 (PRD, 설계)
- 다음 명령 제안 (`/bams:dev`, `/bams:sprint plan`)

## Phase 7: 파이프라인 종료

Bash로 pipeline_end를 동적 카운터 값으로 emit합니다:

```bash
_STATUS=$( [ "$_FAILED_STEPS" -gt 0 ] && echo "failed" || echo "completed" )
[ -n "$_EMIT" ] && bash "$_EMIT" pipeline_end "{slug}" "$_STATUS" $_TOTAL_STEPS $_COMPLETED_STEPS $_FAILED_STEPS 0
```

**DB 연동** (DB가 존재하면):
```bash
if [ -f "$HOME/.claude/plugins/marketplaces/my-claude/bams.db" ]; then
  bun run plugins/bams-plugin/tools/bams-db/sync-board.ts {slug} --write
fi
```
