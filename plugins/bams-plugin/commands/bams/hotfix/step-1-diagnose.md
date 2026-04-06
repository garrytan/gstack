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

pipeline-orchestrator에게 긴급 진단 및 수정을 지시합니다.

Bash로 agent_start를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-1-$(date -u +%Y%m%d)" "pipeline-orchestrator" "sonnet" "Step 1: 버그 진단 + 수정 위임"
```

서브에이전트 실행 (Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, model: **"sonnet"**):

> **핫픽스 긴급 진단 모드** — 버그를 즉시 진단하고 수정합니다.
>
> **위임 메시지:**
> ```
> phase: 1
> slug: {slug}
> pipeline_type: hotfix
> context:
>   config: .crew/config.md
>   bug_description: {$ARGUMENTS}
>   gotchas: [config.md에서 버그 영역 관련 항목 전달]
> constraints:
>   urgency: critical
> ```
>
> **수행할 작업:**
>
> 1. defect-triage를 호출하여 결함 분류 및 근본 원인 추적을 지시합니다:
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
> ```
>
> 2. defect-triage 결과를 바탕으로 개발부장에게 외과적 수정을 위임합니다:
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
> ```
>
> **기대 산출물**: 결함 분석 리포트, 수정된 코드, 회귀 테스트

orchestrator 반환 후, Bash로 agent_end를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-1-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "Step 1 완료: 결함 분석 + 수정 완료"
```

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
