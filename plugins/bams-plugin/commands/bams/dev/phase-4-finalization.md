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

### Step 9a. 성과 집계 (executive-reporter 위임)

pipeline-orchestrator에게 마무리를 지시합니다.

Bash로 agent_start를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-9a-$(date -u +%Y%m%d)" "pipeline-orchestrator" "sonnet" "Step 9a: 성과 집계 위임"
```

서브에이전트 실행 (Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, model: **"sonnet"**):

> **Phase 4 마무리 실행 — 성과 집계**
>
> **위임 메시지:**
> ```
> phase: 4
> slug: {slug}
> pipeline_type: dev
> context:
>   prd: .crew/artifacts/prd/{slug}-prd.md
>   review_report: .crew/artifacts/review/{slug}-review.md
>   evaluation_report: .crew/artifacts/evaluation/{slug}-eval.md
>   qg_result: .crew/artifacts/qg/{slug}-qg-{final_iteration}.md
>   board: .crew/board.md
> ```
>
> **수행할 작업:**
> 1. executive-reporter에게 파이프라인 성과 집계를 요청:
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

orchestrator 반환 후, Bash로 agent_end를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-9a-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "Step 9a 완료: 성과 집계 완료"
```

### Step 9b. 자동 회고 (retro-protocol.md)

pipeline-orchestrator에게 회고를 지시합니다.

Bash로 agent_start를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-9b-$(date -u +%Y%m%d)" "pipeline-orchestrator" "sonnet" "Step 9b: 회고 위임"
```

서브에이전트 실행 (Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, model: **"sonnet"**):

> **Phase 4 회고 실행**
>
> retro-protocol.md에 따라 파이프라인 회고를 **반드시** 실행합니다.
>
> **위임 메시지:**
> ```
> phase: 4-retro
> slug: {slug}
> pipeline_type: dev
> context:
>   all_artifacts: .crew/artifacts/
>   board: .crew/board.md
>   history: .crew/history.md
> ```
>
> **수행할 작업 (retro-protocol.md 절차):**
> 1. executive-reporter에게 정량 데이터 수집 요청: 총 소요 시간, Phase별 소요 시간, Step 성공률, 재시도 횟수, 에이전트별 호출 통계, 품질 지표, 이전 3회 대비 트렌드
> 2. 각 부서장에게 KPT 항목 제출 요청: Keep(유지), Problem(문제), Try(시도). 이 파이프라인에 참여한 부서장만 대상
> 3. 합의 도출: 수집된 KPT를 종합하여 Problem 우선순위 정렬, 액션 아이템 확정, 교차 검증
> 4. 피드백 반영: 에이전트 교훈 저장, gotchas 승격 검사, Pipeline Learnings 갱신, 프로세스 개선 제안
> 5. 회고 결과를 tracking 파일에 기록
>
> **기대 산출물**: 회고 결과 (KPT 요약, 액션 아이템, 피드백 반영 내역)

orchestrator 반환 후, Bash로 agent_end를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-9b-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "Step 9b 완료: 회고 완료"
```

### 최종 요약 제시

최종 요약 제시: 피처명, 생성/수정 파일 목록, 테스트 파일 목록, 리뷰 이슈 요약, QG 결과, 성과 지표, 회고 KPT 요약, 아티팩트 경로, 완료 태스크 수.

Step 9 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 9 "done" {duration_ms}
```
