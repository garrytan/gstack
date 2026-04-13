# Dev: Phase 2.5 — 테스트 코드 생성

> 이 파일은 `/bams:dev`의 Phase 2.5를 실행합니다.
> 공통 규칙은 `_common.md`를 참조합니다.

## 입력 컨텍스트
- slug: {엔트리포인트에서 결정된 slug}
- 이전 Phase 산출물:
  - `.crew/artifacts/prd/{slug}-prd.md`
  - `.crew/artifacts/design/{slug}-design.md`
  - 구현에서 수정/생성된 파일 목록

---

## Phase 2.5: 테스트 코드 생성 (QA부장 위임)

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 6 "테스트 코드 생성" "Phase 2.5: 테스트"
```

### Step 6a. 테스트 작성 여부 묻기

**AskUserQuestion**:
Question: "구현과 병렬로 테스트 코드를 작성할까요?"
Header: "Tests"
Options:
- **Yes** - "각 배치 완료 즉시 테스트 작성 (구현과 병렬)"
- **나중에** - "모든 구현 완료 후 일괄 작성"
- **Skip** - "이번에는 테스트 스킵"

**Skip 선택 시**: Phase 2.5를 건너뛰고 Phase 3으로 진행합니다.

### Step 6b. 테스트 작성 (루프 A — 메인이 qa-strategy 직접 spawn)

단일 도메인/낮은 복잡도이므로 orchestrator 조언을 생략하고 메인이 qa-strategy(QA부장)를 **직접** spawn합니다. (`_shared_common.md` 부록 루프 A 참조)

Bash로 agent_start를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "qa-strategy-6-$(date -u +%Y%m%d)" "qa-strategy" "opus" "Step 6: 테스트 작성"
```

Task tool, subagent_type: **"bams-plugin:qa-strategy"**, model: **"opus"** — 메인이 직접 호출:

> **Phase 2.5 테스트 작성**
>
> **컨텍스트:**
> ```
> phase: 2.5
> slug: {slug}
> prd: .crew/artifacts/prd/{slug}-prd.md
> design: .crew/artifacts/design/{slug}-design.md
> changed_files: [{구현에서 수정/생성된 파일 목록}]
> test_dir: {config.md의 test_dir 설정}
> ```
>
> **위임:**
> ```
> task_description: "최근 구현된 코드에 대한 테스트를 작성하라"
> input_artifacts:
>   - .crew/artifacts/prd/{slug}-prd.md
>   - {테스트 커버리지가 없는 파일 목록}
> expected_output:
>   type: test_code
>   paths: [{test_dir}/**]
> quality_criteria:
>   - 핵심 유저 플로우 커버
>   - 엣지 케이스 테스트 포함
>   - 인수 기준 검증
> ```
>
> qa-strategy는 자신의 도메인 내에서 automation-qa specialist를 최대 1회 추가 spawn 가능(harness 깊이 2 한도).
> 테스트 러너가 있으면 실행하여 결과를 보고합니다.
>
> **기대 산출물**: 테스트 코드, 테스트 계획 (.crew/artifacts/test/{slug}-tests.md), 실행 결과

qa-strategy 반환 후, Bash로 agent_end를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "qa-strategy-6-$(date -u +%Y%m%d)" "qa-strategy" "success" {duration_ms} "Step 6 완료: 테스트 작성 완료"
```

**Yes 선택 시**: 배치별 오버랩 - `배치 N 테스트 작성 || 배치 N+1 구현`이 병렬로 진행됩니다.
**나중에 선택 시**: 모든 구현 완료 후 일괄 실행.

Phase 2.5 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 6 "{status}" {duration_ms}
```
