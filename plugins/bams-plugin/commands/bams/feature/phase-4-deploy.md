# Feature: Phase 4 — 배포

> 이 파일은 `/bams:feature`의 Phase 4를 실행합니다.
> 공통 규칙은 `_common.md`를 참조합니다 (엔트리포인트에서 이미 로드됨).

## 입력 컨텍스트
- slug: {엔트리포인트에서 결정된 slug}
- 이전 Phase 산출물:
  - `.crew/artifacts/review/{slug}-review.md`
  - `.crew/artifacts/qa/{slug}-qa.md`
  - `.crew/artifacts/performance/{slug}-performance.md`
  - `.crew/artifacts/security/{slug}-security.md`
  - Phase 3 게이트 판단: GO / CONDITIONAL-GO

---

**스킬 미설치 시**: Step 9 `skipped` (수동 PR 생성 안내) → Phase 5로.

---

### Step 9. Ship (executive-reporter 보고 + bams ship 스킬)

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 9 "Ship" "Phase 4: 배포"
```

**루프 B — Advisor 조언 후 메인이 executive-reporter + platform-devops 순차 직접 spawn.**

### Step 9-a. pipeline-orchestrator 조언 요청 (Advisor)

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-9-$(date -u +%Y%m%d)" "pipeline-orchestrator" "claude-opus-4-7[1m]" "Step 9: Ship 조언 요청"
```

Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, model: **"claude-opus-4-7[1m]"** — **조언자 모드**:

> **Phase 4 Step 9 Advisor 호출 — Ship 라우팅 권고**
>
> **컨텍스트:**
> ```
> phase: 4
> slug: {slug}
> pipeline_type: feature
> all_artifacts: .crew/artifacts/
> config: .crew/config.md
> ```
>
> **요청:** 메인이 spawn할 부서장(executive-reporter — 배포 전 상태 보고, platform-devops — `_SHIP_SKILL` 실행) 목록과 각각의 위임 메시지 템플릿, 순차/병렬 실행 권고, Ship 게이트 기준(잔여 리스크, Critical 이슈 유무)을 Advisor Response로 반환하세요. 직접 spawn 금지(harness 깊이 2 제약).

반환 후 agent_end emit + Advisor Response 파싱 + CHAIN_VIOLATION 체크:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-9-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "Step 9 Advisor 응답 수신"
```

### Step 9-b. 메인이 executive-reporter 직접 spawn (배포 전 상태 보고)

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "executive-reporter-9-$(date -u +%Y%m%d)" "executive-reporter" "claude-opus-4-7[1m]" "Step 9: 배포 전 상태 보고"
```

Task tool, subagent_type: **"bams-plugin:executive-reporter"**, model: **"claude-opus-4-7[1m]"** — 메인이 직접 호출:

> **Phase 4 Step 9 — 배포 전 상태 보고**
>
> ```
> task_description: "배포 전 전체 Phase 상태를 보고하라"
> input_artifacts:
>   - .crew/artifacts/
> expected_output:
>   type: exec_report
> quality_criteria:
>   - 전체 Phase 진행 상황 요약
>   - 잔여 리스크 항목 정리
>   - Ship 준비 상태 판단 (GO/HOLD)
> ```

반환 후 agent_end emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "executive-reporter-9-$(date -u +%Y%m%d)" "executive-reporter" "success" {duration_ms} "Step 9 배포 전 보고 완료"
```

### Step 9-c. 메인이 platform-devops 직접 spawn (Ship 실행)

GO 판정 시 진행. HOLD이면 사용자에게 보고 후 해결.

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "platform-devops-9-$(date -u +%Y%m%d)" "platform-devops" "claude-opus-4-7[1m]" "Step 9: Ship 실행"
```

Task tool, subagent_type: **"bams-plugin:platform-devops"**, model: **"claude-opus-4-7[1m]"** — 메인이 직접 호출:

> **Phase 4 Step 9 — Ship 실행 (`_SHIP_SKILL`)**
>
> ```
> task_description: "_SHIP_SKILL을 실행하여 PR을 생성하라"
> input_artifacts:
>   - .crew/artifacts/
> expected_output:
>   type: pr_created
> quality_criteria:
>   - 베이스 머지 → 테스트 → 리뷰 → 버전범프 → CHANGELOG → PR 생성 완료
>   - PR 번호 반환
> ```
>
> **기대 산출물**: PR 번호, Ship 결과 보고

반환 후 agent_end emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "platform-devops-9-$(date -u +%Y%m%d)" "platform-devops" "success" {duration_ms} "Step 9 Ship 완료"
```

AskUserQuestion — "PR 생성됨. 즉시 배포?"
- **나중에 (Recommended)**
- **배포** — Step 10 실행.

Step 9 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 9 "{status}" {duration_ms}
```

---

### Step 10. Land & Deploy (선택)

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 10 "Land & Deploy" "Phase 4: 배포"
```

배포 전 체크리스트 확인: (1) PR 머지 완료, (2) CI 통과, (3) Step 4-8 검증 통과.
모두 통과 시 `_DEPLOY_SKILL` 실행.

Step 10 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 10 "{status}" {duration_ms}
```
