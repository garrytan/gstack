# Dev: Phase 2 — 구현

> 이 파일은 `/bams:dev`의 Phase 2를 실행합니다.
> 공통 규칙은 `_common.md`를 참조합니다.

## 입력 컨텍스트
- slug: {엔트리포인트에서 결정된 slug}
- 이전 Phase 산출물:
  - `.crew/artifacts/prd/{slug}-prd.md`
  - `.crew/artifacts/design/{slug}-design.md`
  - `.crew/board.md` (태스크 분해 결과)
  - Phase 0에서 받은 모델 전략

---

## Phase 2: 구현

### Step 5. 멀티에이전트 구현 (개발부장 위임)

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 5 "멀티에이전트 구현" "Phase 2: 구현"
```

board.md에서 태스크 목록을 의존성 순서로 정렬합니다. 배치로 그룹화:
- **배치 1**: 의존성 없는 태스크
- **배치 2**: 의존성이 모두 배치 1에 있는 태스크
- **배치 N**: 모든 태스크가 스케줄될 때까지 계속

각 배치에 대해 pipeline-orchestrator에게 구현을 지시합니다.

각 배치 호출 전, Bash로 agent_start를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-5-{N}-$(date -u +%Y%m%d)" "pipeline-orchestrator" "sonnet" "Step 5: 구현 배치 {N} 위임"
```

서브에이전트 실행 (Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, model: **"sonnet"**):

> **Phase 2 구현 실행 — 배치 {N}**
>
> **위임 메시지:**
> ```
> phase: 2
> slug: {slug}
> pipeline_type: dev
> context:
>   prd: .crew/artifacts/prd/{slug}-prd.md
>   design: .crew/artifacts/design/{slug}-design.md
>   board: .crew/board.md
>   model_strategy: {Phase 0에서 받은 모델 전략}
> constraints:
>   batch: {N}
>   tasks: [{이 배치의 태스크 ID 목록}]
> ```
>
> **수행할 작업:**
> 태스크의 파일 범위와 태그에 따라 적절한 부서장을 결정하여 위임합니다 (delegation-protocol.md 3-1, 3-2, 3-3 참조):
>
> - UI/컴포넌트/스타일 관련 -> frontend-engineering(부서장)에게 위임
> - API/DB/비즈니스 로직 관련 -> backend-engineering(부서장)에게 위임
> - 인프라/배포 관련 -> platform-devops(부서장)에게 위임
> - 데이터 관련 -> data-integration(부서장)에게 위임
> - 겹치는 경우 -> 파일 기준으로 분리하여 병렬 위임, cross-department-coordinator에게 조율 요청
>
> 각 부서장에게 delegation-protocol.md 2-2 형식으로 위임 메시지를 전달합니다:
> ```
> task_description: "{태스크 제목과 설명}"
> input_artifacts:
>   - .crew/artifacts/prd/{slug}-prd.md
>   - .crew/artifacts/design/{slug}-design.md
> expected_output:
>   type: code_implementation
>   paths: [{태스크에서 정의된 파일 경로}]
> quality_criteria:
>   - 인수 기준 충족
>   - 타입 에러 0건
>   - 린트 에러 0건
> constraints:
>   allowed_files: [{태스크 파일 범위}]
> ```
>
> 같은 배치의 파일 겹침이 없는 태스크는 **병렬로** 실행합니다.
> 각 부서장은 소속 에이전트에게 하위 작업을 분배하여 구현합니다.
>
> **기대 산출물**: 구현된 코드, 각 태스크별 완료 상태 보고

각 배치의 orchestrator 반환 후, Bash로 agent_end를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-5-{N}-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "Step 5 배치 {N} 완료: 구현 완료"
```

그 후:
- 파일을 읽어 올바르게 생성/수정되었는지 확인
- board.md에서 해당 태스크를 `## In Review`로 이동
- **DB 상태 업데이트 (board.md 이동과 동시에 실행)**: `~/.claude/plugins/marketplaces/my-claude/bams.db`가 존재하면 해당 태스크의 상태를 `in_review`로 업데이트한다:
  ```bash
  if [ -f "$HOME/.claude/plugins/marketplaces/my-claude/bams.db" ]; then
    bun -e "
      import { TaskDB } from './plugins/bams-plugin/tools/bams-db/index.ts';
      const db = new TaskDB();
      // 배치의 각 태스크 ID에 대해 호출 (task_id는 createTask() 반환값 또는 board.md에서 조회):
      // db.updateTaskStatus('{task_id}', 'in_review', 'pipeline-orchestrator');
      db.close();
    "
  fi
  ```

### 구현 변경사항 확인

git 저장소인 경우, 각 배치 완료 후 `git diff --stat` 표시.

**AskUserQuestion**으로 확인:
Question: "구현 결과를 적용할까요?"
Header: "Confirm"
Options:
- **적용** - "변경사항을 유지하고 다음 단계로 진행"
- **되돌리기** - "모든 변경사항을 되돌리고 중단"
- **부분 되돌리기** - "특정 파일만 되돌리기"

Phase 2 구현 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 5 "done" {duration_ms}
```
