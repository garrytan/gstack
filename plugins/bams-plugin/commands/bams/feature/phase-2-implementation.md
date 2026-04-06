# Feature: Phase 2 — 구현 (개발부장 위임)

> 이 파일은 `/bams:feature`의 Phase 2를 실행합니다.
> 공통 규칙은 `_common.md`를 참조합니다 (엔트리포인트에서 이미 로드됨).

## 입력 컨텍스트

- slug: {엔트리포인트에서 결정된 slug}
- 이전 Phase 산출물:
  - PRD: `.crew/artifacts/prd/{slug}-prd.md`
  - 설계: `.crew/artifacts/design/{slug}-design.md`
  - board.md: 태스크 목록 포함

---

## Step 3. 멀티에이전트 개발

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 3 "멀티에이전트 개발" "Phase 2: 구현"
```

**컨텍스트 활용**: config.md의 기술스택 + design 문서의 파일 계획/인터페이스를 전달.
**Gotchas 경고**: Pre-flight에서 추출한 관련 gotchas를 개발 에이전트에 경고로 전달.

board.md에서 태스크 목록을 의존성 순서로 정렬합니다. 배치로 그룹화:
- **배치 1**: 의존성 없는 태스크
- **배치 2**: 의존성이 모두 배치 1에 있는 태스크
- **배치 N**: 모든 태스크가 스케줄될 때까지 계속

각 배치에 대해 pipeline-orchestrator에게 구현을 지시합니다.

각 배치 호출 전, Bash로 agent_start를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-3-{N}-$(date -u +%Y%m%d)" "pipeline-orchestrator" "sonnet" "Step 3: 구현 배치 {N} 위임"
```

서브에이전트 실행 (Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, model: **"sonnet"**):

> **Phase 2 구현 실행 — 배치 {N}**
>
> **위임 메시지:**
> ```
> phase: 2
> slug: {slug}
> pipeline_type: feature
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
> ★ UI/UX 태스크가 포함된 배치에서는 반드시 디자인 부서장(design-director)에게 먼저 디자인 산출물을 요청한 후 frontend-engineering에게 구현을 위임합니다. 디자인 없이 프론트엔드 UI/UX를 임의로 구현하지 않습니다.
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
> gotchas:
>   - {관련 gotchas 목록}
> ```
>
> 같은 배치의 파일 겹침이 없는 태스크는 **병렬로** 실행합니다.
> 각 부서장은 소속 에이전트에게 하위 작업을 분배하여 구현합니다.
>
> **기대 산출물**: 구현된 코드, 각 태스크별 완료 상태 보고

각 배치의 orchestrator 반환 후, Bash로 agent_end를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-3-{N}-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "Step 3 배치 {N} 완료: 구현 완료"
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
- git 저장소인 경우 `git diff --stat` 표시

---

## 구현 → 검증 핸드오프

pipeline-orchestrator에게 Phase 전환 핸드오프를 지시합니다.

Bash로 agent_start를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-handoff2-$(date -u +%Y%m%d)" "pipeline-orchestrator" "sonnet" "구현→검증 핸드오프 위임"
```

서브에이전트 실행 (Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, model: **"sonnet"**):

> **Phase 2 → Phase 3 핸드오프 실행**
>
> **위임 메시지:**
> ```
> phase: 2→3 handoff
> slug: {slug}
> pipeline_type: feature
> context:
>   prd: .crew/artifacts/prd/{slug}-prd.md
>   design: .crew/artifacts/design/{slug}-design.md
>   changed_files: [{구현에서 수정/생성된 파일 목록}]
>   board: .crew/board.md
> ```
>
> **수행할 작업:**
> 1. Phase 게이트 판단: Phase 2 완료 조건 검증 (빌드 성공, 타입 체크 통과, 린트 통과)
> 2. cross-department-coordinator에게 구현→검증 핸드오프 조율 위임:
>    - 개발부장의 산출물이 QA부장에게 올바르게 전달되는지 확인
>    - 검증 대상 파일 목록, 테스트 범위 확인
> 3. executive-reporter에게 Phase 2 완료 상태 보고 요청
>
> **기대 산출물**: Phase 게이트 판단 결과 (GO/NO-GO/CONDITIONAL-GO), 핸드오프 체크리스트 결과

orchestrator 반환 후, Bash로 agent_end를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-handoff2-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "구현→검증 핸드오프 완료"
```

**Phase 게이트 결과가 NO-GO이면**: 미충족 항목을 사용자에게 보고하고, 해결 후 재시도합니다.

AskUserQuestion — "구현 완료. 검증 단계로 진행?"
- **검증 진행 (Recommended)**
- **구현까지만** — `status: paused_at_step_3` 기록 후 종료.

Step 3 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 3 "done" {duration_ms}
```

---

## Phase 2 게이트 조건

- [ ] 모든 배치의 구현 완료
- [ ] 빌드 성공
- [ ] 타입 체크 통과
- [ ] 린트 통과
- [ ] board.md 태스크 In Review 이동 완료
- [ ] 핸드오프 체크리스트 GO 판정

Phase 2 완료 → 엔트리포인트가 Phase 3 (검증)을 라우팅합니다.
