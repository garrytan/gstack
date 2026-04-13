# Dev: Phase 4 — 마무리 + 회고

> 이 파일은 `/bams:dev`의 Phase 4를 실행합니다.
> 공통 규칙은 `_common.md`를 참조합니다.

## 입력 컨텍스트
- slug: {엔트리포인트에서 결정된 slug}
- 이전 Phase 산출물:
  - `.crew/artifacts/prd/{slug}-prd.md`
  - `.crew/artifacts/review/{slug}-review.md`
  - `.crew/artifacts/evaluation/{slug}-eval.md`
  - `.crew/artifacts/qg/{slug}-qg-{final_iteration}.md`
  - `.crew/board.md`

---

## Phase 4: 마무리 + 회고

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 9 "마무리 + 회고" "Phase 4: 마무리"
```

### Step 9a. 성과 집계 (루프 A — executive-reporter 직접 spawn)

**루프 A (Simple) — 단일 부서장(executive-reporter)이므로 메인이 직접 spawn합니다.**

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "executive-reporter-9a-$(date -u +%Y%m%d)" "executive-reporter" "opus" "Step 9a: 성과 집계"
```

Task tool, subagent_type: **"bams-plugin:executive-reporter"**, model: **"opus"** — 메인이 직접 호출:

> **Phase 4 마무리 — 성과 집계**
>
> **컨텍스트:**
> ```
> phase: 4
> slug: {slug}
> pipeline_type: dev
> prd: .crew/artifacts/prd/{slug}-prd.md
> review_report: .crew/artifacts/review/{slug}-review.md
> evaluation_report: .crew/artifacts/evaluation/{slug}-eval.md
> qg_result: .crew/artifacts/qg/{slug}-qg-{final_iteration}.md
> board: .crew/board.md
> ```
>
> **수행할 작업:**
> 1. 파이프라인 성과 집계:
>    - 총 소요 시간, Phase별 소요 시간
>    - Step 성공률, 재시도 횟수
>    - 에이전트별 호출 통계
>    - 품질 지표 요약
>    - 이전 파이프라인 대비 트렌드
>
> 2. 보드 및 히스토리 업데이트:
>    - 완료된 모든 태스크를 board.md의 `## Done`으로 이동
>    - **DB 상태 업데이트 (board.md Done 이동과 동시에 실행)**: `~/.claude/plugins/marketplaces/my-claude/bams.db`가 존재하면 각 태스크의 상태를 `done`으로 업데이트한다:
>      ```bash
>      if [ -f "$HOME/.claude/plugins/marketplaces/my-claude/bams.db" ]; then
>        bun -e "
>          import { TaskDB } from './plugins/bams-plugin/tools/bams-db/index.ts';
>          const db = new TaskDB();
>          // 완료된 각 태스크 ID에 대해 호출:
>          // db.updateTaskStatus('{task_id}', 'done', 'pipeline-orchestrator');
>          db.close();
>        "
>      fi
>      ```
>    - `.crew/history.md`에 타임스탬프와 함께 추가
>    - board.md의 `> Last updated:` 업데이트
>
> 3. README.md에 영향을 줄 수 있는 변경이 있는지 판단하고 필요 시 업데이트
>
> **기대 산출물**: 성과 집계 리포트, 업데이트된 board.md/history.md

반환 후 agent_end emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "executive-reporter-9a-$(date -u +%Y%m%d)" "executive-reporter" "success" {duration_ms} "Step 9a 완료: 성과 집계 완료"
```

### Step 9b. 자동 회고 (루프 B — Advisor + 참여 부서장들 병렬 KPT 수집)

**루프 B — orchestrator 조언으로 회고 참여자 라우팅, 메인이 executive-reporter + 참여 부서장들을 병렬 직접 spawn.**

### Step 9b-a. pipeline-orchestrator 조언 요청 (retro-protocol 라우팅)

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-9b-$(date -u +%Y%m%d)" "pipeline-orchestrator" "opus" "Step 9b: 회고 조언 요청"
```

Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, model: **"opus"** — **조언자 모드**:

> **Phase 4 Step 9b Advisor 호출 — 회고 참여자 라우팅 권고**
>
> **컨텍스트:**
> ```
> phase: 4-retro
> slug: {slug}
> pipeline_type: dev
> all_artifacts: .crew/artifacts/
> board: .crew/board.md
> history: .crew/history.md
> ```
>
> **요청:** retro-protocol.md에 따라 이 파이프라인에 **실제로 참여한 부서장 목록**을 식별하고, 각 부서장별 KPT 수집 위임 메시지 템플릿, executive-reporter의 정량 데이터 수집 메시지 템플릿, 회고 결과 병합 절차를 Advisor Response로 반환하세요. 직접 spawn 금지(harness 깊이 2 제약).

반환 후 agent_end emit + Advisor Response 파싱 + CHAIN_VIOLATION 체크:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-9b-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "Step 9b Advisor 응답 수신"
```

### Step 9b-b. 메인이 executive-reporter + 참여 부서장들 병렬 직접 spawn

Advisor가 권고한 참여 부서장 목록에 대해, **단일 메시지에 복수 Task tool 호출**로 병렬 spawn합니다. 병렬 호출 전 각 부서장의 agent_start를 일괄 emit합니다.

1. Task tool, subagent_type: **"bams-plugin:executive-reporter"**, model: **"opus"** — 정량 데이터 수집:
> 총 소요 시간, Phase별 소요 시간, Step 성공률, 재시도 횟수, 에이전트별 호출 통계, 품질 지표, 이전 3회 대비 트렌드를 수집하여 반환.

2. Task tool, subagent_type: **"bams-plugin:{참여-부서장}"** (Advisor 권고 목록의 각 부서장에 대해 병렬로) — KPT 제출:
> 이 파이프라인에서 **Keep(유지)/Problem(문제)/Try(시도)** 항목을 제출하세요. 참여한 Phase/Step, 발생한 이슈, 개선 제안을 포함합니다.

병렬 완료 후 각 부서장 agent_end 일괄 emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1)
[ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "executive-reporter-9b-$(date -u +%Y%m%d)" "executive-reporter" "success" {duration_ms} "정량 데이터 수집 완료"
# 각 참여 부서장에 대해 agent_end 반복 emit
```

메인이 수집된 KPT를 종합하여:
- Problem 우선순위 정렬, 액션 아이템 확정, 교차 검증
- 에이전트 교훈 저장, gotchas 승격 검사, Pipeline Learnings 갱신, 프로세스 개선 제안
- 회고 결과를 tracking 파일에 기록

### 최종 요약 제시

최종 요약 제시: 피처명, 생성/수정 파일 목록, 테스트 파일 목록, 리뷰 이슈 요약, QG 결과, 성과 지표, 회고 KPT 요약, 아티팩트 경로, 완료 태스크 수.

Step 9 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 9 "done" {duration_ms}
```
