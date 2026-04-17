# Dev: Phase 3 — 검증

> 이 파일은 `/bams:dev`의 Phase 3를 실행합니다.
> 공통 규칙은 `_common.md`를 참조합니다.

## 입력 컨텍스트
- slug: {엔트리포인트에서 결정된 slug}
- 이전 Phase 산출물:
  - `.crew/artifacts/prd/{slug}-prd.md`
  - `.crew/artifacts/design/{slug}-design.md`
  - `.crew/artifacts/test/{slug}-tests.md`
  - 수정/생성된 모든 파일 목록

---

## Phase 3: 검증 (QA부장 + 평가부장 병렬)

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 7 "검증 (QA + 평가 병렬)" "Phase 3: 검증"
```

### Step 7. 3관점 리뷰 + 성과 평가 (루프 B — Advisor + QA/평가 부서장 병렬 직접 spawn)

**루프 B — orchestrator는 조언자, 메인이 QA부장/평가부장을 단일 메시지 병렬 spawn.**

### Step 7-a. pipeline-orchestrator 조언 요청 (Advisor)

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-7-$(date -u +%Y%m%d)" "pipeline-orchestrator" "claude-opus-4-7" "Step 7: 검증 Phase 조언 요청"
```

Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"** — **조언자 모드**:

> **Phase 3 Step 7 Advisor 호출 — 3관점 리뷰 + 성과 평가 라우팅 권고**
>
> **컨텍스트:**
> ```
> phase: 3
> slug: {slug}
> pipeline_type: dev
> prd: .crew/artifacts/prd/{slug}-prd.md
> design: .crew/artifacts/design/{slug}-design.md
> changed_files: [{수정/생성된 모든 파일 목록}]
> test_results: .crew/artifacts/test/{slug}-tests.md
> config: .crew/config.md
> ```
>
> **요청:** 병렬 spawn할 부서장 목록(qa-strategy, product-analytics 권고), 각 부서장별 위임 메시지 템플릿, Phase 3 검증 게이트 기준을 Advisor Response로 반환하세요. 직접 spawn 금지(harness 깊이 2 제약).

반환 후 agent_end emit + Advisor Response 파싱 + CHAIN_VIOLATION 체크:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-7-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "Step 7 Advisor 응답 수신"
```

### Step 7-b. 메인이 QA부장 + 평가부장 병렬 직접 spawn (단일 메시지 복수 Task)

병렬 호출 전 2개의 agent_start를 일괄 emit (qa-strategy / product-analytics).

**단일 메시지에 2개 Task tool 호출을 묶어** 병렬 spawn합니다:

1. Task tool, subagent_type: **"bams-plugin:qa-strategy"**:
> ```
> task_description: "3관점(정확성, 보안+성능, 코드품질) 병렬 리뷰를 실행하라"
> input_artifacts:
>   - .crew/artifacts/prd/{slug}-prd.md
>   - {변경된 파일 목록}
> expected_output:
>   type: review_report
>   paths: [.crew/artifacts/review/{slug}-review.md]
> quality_criteria:
>   - 3관점 모두 커버
>   - 심각도별 분류 (Critical/Major/Minor)
>   - 중복 제거
> ```
> QA부장은 자신의 도메인 내에서 automation-qa / defect-triage / release-quality-gate specialist를 최대 1회 추가 spawn 가능(harness 깊이 2 한도). 3관점:
> - 관점 1: 기능적 정확성
> - 관점 2: 보안 + 성능
> - 관점 3: 코드 품질 + 유지보수성

2. Task tool, subagent_type: **"bams-plugin:product-analytics"**:
> ```
> task_description: "구현 결과의 성능과 비즈니스 지표를 평가하라"
> input_artifacts:
>   - .crew/artifacts/prd/{slug}-prd.md
>   - {변경된 파일 목록}
> expected_output:
>   type: evaluation_report
>   paths: [.crew/artifacts/evaluation/{slug}-eval.md]
> quality_criteria:
>   - 성능 기준 측정 (있는 경우)
>   - 비즈니스 KPI 영향 분석
> ```
> 평가부장은 performance-evaluation / business-kpi specialist를 최대 1회 추가 spawn 가능.

병렬 완료 후 2개의 agent_end를 일괄 emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1)
[ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "qa-strategy-7-$(date -u +%Y%m%d)" "qa-strategy" "success" {duration_ms} "3관점 리뷰 완료"
[ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "product-analytics-7-$(date -u +%Y%m%d)" "product-analytics" "success" {duration_ms} "성과 평가 완료"
```

### 리뷰 결과 처리

1. 모든 발견 사항 수집, 중복 제거, 심각도 순 정렬
2. 리뷰 리포트를 `.crew/artifacts/review/{slug}-review.md`에 저장
3. 평가 리포트를 `.crew/artifacts/evaluation/{slug}-eval.md`에 저장

**Critical 이슈 발견 시:** 사용자에게 제시 후 Edit 도구로 수정 적용.
**Major 이슈 발견 시:** 사용자에게 제시 후 수정 여부 확인.

Phase 3 검증 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 7 "done" {duration_ms}
```
