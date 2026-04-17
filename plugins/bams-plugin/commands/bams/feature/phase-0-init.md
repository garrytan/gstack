# Feature: Phase 0 — 파이프라인 초기화

> 이 파일은 `/bams:feature`의 Phase 0을 실행합니다.
> 공통 규칙은 `_common.md`를 참조합니다 (엔트리포인트에서 이미 로드됨).

## 입력 컨텍스트

- slug: {엔트리포인트에서 결정된 slug}
- feature_description: {$ARGUMENTS}
- 이전 Phase 산출물: 없음 (초기 Phase)

---

## Viz 이벤트: pipeline_start

Step 0 시작 전, Bash로 다음을 실행합니다:

```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" pipeline_start "{slug}" "feature" "/bams:feature" "{arguments}"
```

## Step 0. resource-optimizer 전략 수립

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 0 "파이프라인 초기화" "Phase 0: 초기화"
```

**루프 A (Simple) — 메인이 resource-optimizer를 직접 spawn합니다.** (orchestrator 조언 생략, `_shared_common.md` 부록 참조)

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "resource-optimizer-0-$(date -u +%Y%m%d)" "resource-optimizer" "claude-opus-4-7[1m]" "Step 0: feature 파이프라인 전략 수립"
```

Task tool, subagent_type: **"bams-plugin:resource-optimizer"**, model: **"claude-opus-4-7[1m]"** — 메인이 직접 호출:

> **파이프라인 초기화 — feature 파이프라인 전략 수립**
>
> **컨텍스트:**
> ```
> phase: 0
> slug: {slug}
> pipeline_type: feature
> config: .crew/config.md
> board: .crew/board.md
> feature_description: {$ARGUMENTS}
> user_note: "{사용자 지시사항이 있으면 삽입}"
> ```
>
> **수행할 작업:**
> 1. 파이프라인 유형(feature)과 규모를 분석하여 각 에이전트별 모델 선택(opus/sonnet/haiku)과 병렬화 전략을 수립합니다. feature는 dev보다 확장된 파이프라인이므로 검증/배포/마무리 Phase의 리소스도 계획합니다.
> 2. Pre-flight 체크리스트를 확인합니다: config.md, gotchas, 기존 아티팩트 존재 여부.
> 3. 파이프라인 실행 계획을 수립하여 보고합니다 (13단계 전체 범위).
>
> **기대 산출물**: 파이프라인 실행 계획 (모델 전략, 병렬화 가능 구간, 예상 Phase 수, 게이트 조건)

반환 후 agent_end emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "resource-optimizer-0-$(date -u +%Y%m%d)" "resource-optimizer" "success" {duration_ms} "Step 0 완료: 파이프라인 실행 계획 수립"
```

resource-optimizer의 실행 계획을 수신하고, 이후 Phase에서 이 계획(모델 전략, 병렬화 전략)을 참조합니다. `pipeline_start` 이벤트는 엔트리포인트에서 이미 emit되었습니다.

Step 0 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 0 "done" {duration_ms}
```

---

## Phase 0 게이트 조건

- [ ] resource-optimizer 실행 계획 수신 완료
- [ ] pipeline_start 이벤트 기록 완료
- [ ] Pre-flight 체크리스트 통과
- [ ] 파이프라인 실행 계획 수립 완료

Phase 0 완료 → 엔트리포인트가 Phase 1 (기획)을 라우팅합니다.
