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

**루프 B — 각 배치마다 Advisor 조언 → 메인이 권고된 부서장들 병렬 직접 spawn.**

### Step 5-a. pipeline-orchestrator 조언 요청 (배치 {N} 라우팅)

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-5-{N}-$(date -u +%Y%m%d)" "pipeline-orchestrator" "opus" "Step 5: 배치 {N} 라우팅 조언 요청"
```

Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, model: **"opus"** — **조언자 모드**:

> **Phase 2 배치 {N} Advisor 호출 — 부서장 라우팅 권고**
>
> **컨텍스트:**
> ```
> phase: 2
> slug: {slug}
> prd: .crew/artifacts/prd/{slug}-prd.md
> design: .crew/artifacts/design/{slug}-design.md
> board: .crew/board.md
> model_strategy: {Phase 0에서 받은 모델 전략}
> batch: {N}
> tasks: [{이 배치의 태스크 ID 목록}]
> ```
>
> **요청:** 태스크의 파일 범위/태그에 따라 적절한 부서장을 결정(`delegation-protocol.md` 3-1/3-2/3-3 참조):
>
> - UI/컴포넌트/스타일 → frontend-engineering
> - API/DB/비즈니스 로직 → backend-engineering
> - 인프라/배포 → platform-devops
> - 데이터 → data-integration
> - 겹치는 경우 → 파일 기준 분리 + cross-department-coordinator 조율 권고
>
> 각 부서장별 위임 메시지 템플릿, 병렬/순차 실행 권고, Phase 2 게이트 기준을 Advisor Response로 반환하세요. 직접 spawn 금지.

반환 후 agent_end emit + Advisor Response 파싱 + CHAIN_VIOLATION 체크:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-5-{N}-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "Step 5 배치 {N} Advisor 응답 수신"
```

### Step 5-b. 메인이 권고된 부서장들 병렬 직접 spawn

파일 겹침이 없는 태스크는 **단일 메시지에 복수 Task 호출**로 병렬 spawn합니다.

각 부서장 호출 전 agent_start를 일괄 emit한 뒤, Task tool, subagent_type: **"bams-plugin:{dept}-lead"** (frontend-engineering / backend-engineering / platform-devops / data-integration), model: 배치 전략 기반으로 **직접** 호출합니다. 위임 메시지는 Advisor Response 템플릿(`delegation-protocol.md` 2-2 형식)을 사용:

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

각 부서장은 자신의 도메인 내 specialist를 최대 1회 추가 spawn 가능(harness 깊이 2 한도). 파일 겹침 태스크는 cross-department-coordinator(메인이 추가로 직접 spawn)로 조율합니다.

### 디자인부 연동 (FE 태스크 포함 시)

Advisor Response에 프론트엔드 태스크가 포함되어 있으면, design-director(디자인부장)를 FE 부서장과 **병렬로** 추가 호출합니다:

Task tool, subagent_type: **"bams-plugin:design-director"**, model: **"opus"**:
> **디자인 검토 및 UI 가이드 제공**
> 
> FE 구현 태스크에 대한 디자인 검토를 수행합니다:
> - UI 컴포넌트 설계 리뷰
> - 디자인 시스템 일관성 확인
> - 접근성(a11y) 가이드라인 제공
> 
> design-director는 내부적으로 ui-designer, ux-designer, design-system-agent 등 specialist를 최대 1회 추가 spawn 가능.

디자인부장은 FE 태스크가 없으면 호출하지 않습니다 (비용 최적화).

모든 부서장 완료 후, 각 부서장에 대해 결과를 확인합니다:
- **성공 시**: agent_end status="success", step 계속 진행
- **에러 시**: agent_end status="error". 사용자에게 에러를 보고하고 AskUserQuestion으로 계속/중단 확인. 중단 선택 시 pipeline_end status="failed" emit 후 종료.

```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "{dept}-5-{N}-$(date -u +%Y%m%d)" "{dept}" "{success|error}" {duration_ms} "Step 5 배치 {N} 부서장 완료"
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
