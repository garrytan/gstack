# Hotfix: Step 1 — 버그 진단 + 수정

> 이 파일은 `/bams:hotfix`의 Step 1을 실행합니다.
> 공통 규칙은 `_common.md`를 참조합니다 (엔트리포인트에서 이미 로드됨).

## 입력 컨텍스트

- slug: {엔트리포인트에서 결정된 slug}
- bug_description: $ARGUMENTS
- gotchas: config.md에서 버그 영역 관련 항목

---

## Step 1: 버그 진단 + 수정

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 1 "버그 진단 + 수정" "Phase 1: 진단/수정"
```

**루프 B — Advisor 조언 후 메인이 qa-strategy(defect-triage) → 개발부장 순차 직접 spawn.**

### Step 1-a. pipeline-orchestrator 조언 요청 (Advisor)

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-1-$(date -u +%Y%m%d)" "pipeline-orchestrator" "claude-opus-4-7" "Step 1: 긴급 진단+수정 조언 요청"
```

Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"** — **조언자 모드**:

> **Hotfix Step 1 Advisor 호출 — 긴급 진단+수정 라우팅 권고**
>
> **컨텍스트:**
> ```
> phase: 1
> slug: {slug}
> pipeline_type: hotfix
> config: .crew/config.md
> bug_description: {$ARGUMENTS}
> gotchas: [config.md에서 버그 영역 관련 항목]
> urgency: critical
> ```
>
> **요청:** 메인이 순차 spawn할 부서장 목록과 위임 메시지 템플릿:
> 1. qa-strategy(QA부장) — defect-triage specialist를 활용한 결함 분류 및 근본 원인 추적
> 2. 버그 영역에 맞는 개발부장(frontend-engineering / backend-engineering / platform-devops) — 외과적 수정 + 회귀 테스트 생성
>
> 버그 영역 라우팅 결정, Scope Lock 확정 기준, Step 1 게이트 조건을 Advisor Response로 반환하세요. 직접 spawn 금지(harness 깊이 2 제약).

반환 후 agent_end emit + Advisor Response 파싱 + CHAIN_VIOLATION 체크:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-1-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "Step 1 Advisor 응답 수신"
```

**CHAIN_VIOLATION 체크**: orchestrator 반환 내용 첫 줄에 "CHAIN_VIOLATION" 포함 시 즉시 중단 — agent_end status="error" + pipeline_end status="failed".

### Step 1-b. 메인이 qa-strategy 직접 spawn (결함 분류)

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "qa-strategy-1-$(date -u +%Y%m%d)" "qa-strategy" "claude-opus-4-7" "Step 1: 결함 분류"
```

Task tool, subagent_type: **"bams-plugin:qa-strategy"** — 메인이 직접 호출:

> **Hotfix Step 1 — 결함 분류 + 근본 원인 추적**
>
> ```
> task_description: "버그를 긴급 분류하고 근본 원인을 추적하라"
> input_artifacts:
>   - .crew/config.md
>   - bug_description: {$ARGUMENTS}
> expected_output:
>   type: defect_analysis
>   paths: [.crew/artifacts/hotfix/{slug}-triage.md]
> quality_criteria:
>   - 근본 원인 식별
>   - 영향 범위(Impact Analysis) 완료
>   - Scope Lock 확정
> gotchas:
>   - {config.md에서 버그 영역 관련 항목}
> ```
>
> QA부장은 defect-triage specialist를 최대 1회 추가 spawn 가능(harness 깊이 2 한도).

반환 후 결과를 확인합니다:
- **성공 시**: agent_end status="success", Step 1-c로 진행
- **에러 시**: agent_end status="error". 사용자에게 에러를 보고하고 AskUserQuestion으로 계속/중단 확인. 중단 선택 시 pipeline_end status="failed" emit 후 종료.

```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "qa-strategy-1-$(date -u +%Y%m%d)" "qa-strategy" "{success|error}" {duration_ms} "Step 1 결함 분류 완료"
```

### Step 1-c. 메인이 개발부장 직접 spawn (외과적 수정)

Advisor가 권고한 개발부장(frontend-engineering / backend-engineering / platform-devops 중 하나)에 대해:

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "{dept}-1-$(date -u +%Y%m%d)" "{dept}" "claude-opus-4-7" "Step 1: 외과적 수정"
```

Task tool, subagent_type: **"bams-plugin:{dept}"** — 메인이 직접 호출:

> **Hotfix Step 1 — 외과적 수정 + 회귀 테스트**
>
> ```
> task_description: "근본 원인에 맞는 최소 범위 수정을 적용하고 회귀 테스트를 생성하라"
> input_artifacts:
>   - .crew/artifacts/hotfix/{slug}-triage.md
> expected_output:
>   type: code_fix + regression_tests
> quality_criteria:
>   - 수정 파일 최소화 (범위 외 변경 금지)
>   - Root Cause Verification 통과
>   - 회귀 테스트 생성 완료
> constraints:
>   urgency: critical
>   scope: scope_lock_from_triage
> ```

반환 후 결과를 확인합니다:
- **성공 시**: agent_end status="success", 다음 단계로 진행
- **에러 시**: agent_end status="error". 사용자에게 에러를 보고하고 AskUserQuestion으로 계속/중단 확인. 중단 선택 시 pipeline_end status="failed" emit 후 종료.

```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "{dept}-1-$(date -u +%Y%m%d)" "{dept}" "{success|error}" {duration_ms} "Step 1 외과적 수정 완료"
```

### 디자인부 연동 (FE 영역 수정 시)

수정 대상이 `*.tsx`, `*.css`, `src/components/**`, `src/app/**` (API 제외) 등 프론트엔드 파일인 경우, design-director를 병렬로 호출하여 UI 일관성을 검토합니다:

Task tool, subagent_type: **"bams-plugin:design-director"**:
> **FE 핫픽스 디자인 영향 검토**
> UI 변경이 디자인 시스템과 일관적인지 확인하고, 필요 시 디자인 가이드를 제공합니다.

FE 영역이 아닌 경우 이 호출을 건너뜁니다 (비용 최적화).

**기대 산출물**: 결함 분석 리포트, 수정된 코드, 회귀 테스트

**DB에 태스크 등록 (핫픽스 진단+수정 완료 후)**: `~/.claude/plugins/marketplaces/my-claude/bams.db`가 존재하면 태스크를 등록한다. 핫픽스는 진단+수정이 한 단계로 처리되므로 바로 `in_review` 상태로 등록한다:
```bash
if [ -f "$HOME/.claude/plugins/marketplaces/my-claude/bams.db" ]; then
  bun -e "
    import { TaskDB } from './plugins/bams-plugin/tools/bams-db/index.ts';
    const db = new TaskDB();
    db.createTask({ pipeline_slug: '{slug}', title: '버그 진단 + 수정: {$ARGUMENTS 요약}', status: 'in_review', assignee_agent: 'backend-engineering', phase: 1 });
    db.close();
  "
fi
```

Step 1 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 1 "done" {duration_ms}
```

---

## Step 1 게이트 조건

- [ ] `.crew/artifacts/hotfix/{slug}-triage.md` 생성 완료
- [ ] 근본 원인 식별 완료
- [ ] 수정 코드 적용 완료
- [ ] 회귀 테스트 생성 완료
- [ ] Critical 이슈 0건

Step 1 완료 → 엔트리포인트가 Step 2를 라우팅합니다.
