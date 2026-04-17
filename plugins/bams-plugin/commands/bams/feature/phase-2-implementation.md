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

**루프 B — 각 배치마다 Advisor 조언 → 메인이 권고된 부서장들 병렬 직접 spawn.**

### Step 3-a. pipeline-orchestrator 조언 요청 (배치 {N} 라우팅)

각 배치 호출 전, Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-3-{N}-$(date -u +%Y%m%d)" "pipeline-orchestrator" "claude-opus-4-7[1m]" "Step 3: 배치 {N} 라우팅 조언 요청"
```

Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, model: **"claude-opus-4-7[1m]"** — **조언자 모드**:

> **Phase 2 배치 {N} Advisor 호출 — 부서장 라우팅 권고**
>
> **컨텍스트:**
> ```
> phase: 2
> slug: {slug}
> pipeline_type: feature
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
> ★ UI/UX 태스크가 포함된 배치는 반드시 design-director를 선행 spawn 권고에 포함(디자인 산출물 확보 후 frontend-engineering 구현).
>
> 각 부서장별 위임 메시지 템플릿, 병렬/순차 실행 권고, Phase 2 게이트 기준을 Advisor Response로 반환하세요. 직접 spawn 금지(harness 깊이 2 제약).

반환 후 agent_end emit + Advisor Response 파싱 + CHAIN_VIOLATION 체크:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-3-{N}-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "Step 3 배치 {N} Advisor 응답 수신"
```

### Step 3-b. 메인이 권고된 부서장들 병렬 직접 spawn

UI/UX 태스크가 포함된 경우 먼저 design-director를 spawn하여 디자인 산출물을 확보한 뒤, 파일 겹침이 없는 태스크는 **단일 메시지에 복수 Task 호출**로 병렬 spawn합니다.

각 부서장 호출 전 agent_start를 일괄 emit한 뒤, Task tool, subagent_type: **"bams-plugin:{dept}"** (frontend-engineering / backend-engineering / platform-devops / data-integration / design-director), model: 배치 전략 기반으로 **직접** 호출. 위임 메시지는 Advisor Response 템플릿(`delegation-protocol.md` 2-2 형식):

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

각 부서장은 자신의 도메인 내 specialist를 최대 1회 추가 spawn 가능(harness 깊이 2 한도). 파일 겹침 태스크는 cross-department-coordinator(메인이 추가로 직접 spawn)로 조율합니다.

모든 부서장 완료 후 각 부서장에 대해 agent_end 일괄 emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "{dept}-3-{N}-$(date -u +%Y%m%d)" "{dept}" "success" {duration_ms} "Step 3 배치 {N} 부서장 완료"
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

**루프 B — Advisor 게이트 판정 후 메인이 cross-department-coordinator 직접 spawn.**

### 핸드오프-a. pipeline-orchestrator 조언 요청 (Phase 게이트 판정)

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-handoff2-$(date -u +%Y%m%d)" "pipeline-orchestrator" "claude-opus-4-7[1m]" "구현→검증 게이트 판정 조언"
```

Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, model: **"claude-opus-4-7[1m]"** — **조언자 모드**:

> **Phase 2 → Phase 3 Advisor 호출 — 게이트 판정 + 핸드오프 라우팅**
>
> **컨텍스트:**
> ```
> phase: 2→3 handoff
> slug: {slug}
> pipeline_type: feature
> prd: .crew/artifacts/prd/{slug}-prd.md
> design: .crew/artifacts/design/{slug}-design.md
> changed_files: [{구현에서 수정/생성된 파일 목록}]
> board: .crew/board.md
> ```
>
> **요청:** Phase 2 완료 조건 검증 결과(GO/NO-GO/CONDITIONAL-GO) — 빌드 성공, 타입 체크, 린트 — 와, 메인이 spawn할 cross-department-coordinator의 위임 메시지를 Advisor Response로 반환하세요. 직접 spawn 금지.

반환 후 agent_end emit + 파싱 + CHAIN_VIOLATION 체크:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-handoff2-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "구현→검증 Advisor 응답 수신"
```

### 핸드오프-b. 메인이 cross-department-coordinator 직접 spawn

Advisor 판정이 GO 또는 CONDITIONAL-GO인 경우에 진행. NO-GO이면 미충족 항목을 사용자에게 보고하고 해결 후 재시도.

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "cross-department-coordinator-handoff2-$(date -u +%Y%m%d)" "cross-department-coordinator" "claude-opus-4-7[1m]" "구현→검증 핸드오프 조율"
```

Task tool, subagent_type: **"bams-plugin:cross-department-coordinator"**, model: **"claude-opus-4-7[1m]"** — 메인이 직접 호출:

> **Phase 2→3 핸드오프 조율**
>
> - 개발부장의 산출물이 QA부장에게 올바르게 전달되는지 확인
> - 검증 대상 파일 목록, 테스트 범위 확인
>
> **기대 산출물**: 핸드오프 체크리스트 결과

반환 후 agent_end emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "cross-department-coordinator-handoff2-$(date -u +%Y%m%d)" "cross-department-coordinator" "success" {duration_ms} "구현→검증 핸드오프 완료"
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
