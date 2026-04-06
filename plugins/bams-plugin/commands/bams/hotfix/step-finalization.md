# Hotfix: Finalization — 개선점 수집 + 마무리 회고

> 이 파일은 `/bams:hotfix`의 마무리 단계를 실행합니다.
> 공통 규칙은 `_common.md`를 참조합니다 (엔트리포인트에서 이미 로드됨).

## 입력 컨텍스트

- slug: {엔트리포인트에서 결정된 slug}
- parent_pipeline_slug: {Step 0.6에서 결정된 parent 슬러그 또는 null}
- triage_artifacts: `.crew/artifacts/hotfix/{slug}-triage.md`

---

## Step 4.5: 에이전트 개선점 수집

pipeline-orchestrator에게 개선점 수집을 지시합니다.

Bash로 agent_start를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-6-$(date -u +%Y%m%d)" "pipeline-orchestrator" "opus" "Step 4.5: 에이전트 개선점 분석 위임"
```

서브에이전트 실행 (Agent tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, model: **"opus"**):

> **에이전트 개선점 분석 모드** — 이 핫픽스의 근본 원인이 된 에이전트를 식별하고 개선점을 기록합니다.
>
> **수행할 작업:**
> 1. `.crew/artifacts/hotfix/{slug}-triage.md`를 읽어 근본 원인 분석
> 2. 이 버그를 만든 에이전트(또는 스킬)를 식별
> 3. 일회성 실수인지 구조적 개선이 필요한지 판별:
>    - `.crew/memory/{agent}/improvements/` 디렉토리에서 동일 pattern_tag 기존 레코드 검색
>    - 기존 레코드가 있으면 type: structural, 없으면 type: one-off
> 4. `.crew/memory/{agent}/improvements/{date}-{slug}.md` 파일 생성:
>    ```yaml
>    ---
>    date: {YYYY-MM-DD}
>    pipeline_slug: {slug}
>    parent_pipeline_slug: {parent_slug or null}
>    agent: {agent_type}
>    pattern_tag: {카테고리 태그}
>    type: one-off | structural
>    severity: minor | major | critical
>    ---
>
>    ## 근본 원인
>    {triage에서 식별된 근본 원인}
>
>    ## 개선 제안
>    {에이전트 또는 스킬에 대한 구체적 개선 제안}
>
>    ## 관련 파이프라인
>    - 원본: {parent_pipeline_slug}
>    - 핫픽스: {slug}
>    ```
> 5. structural 유형이고 동일 pattern_tag가 2회 이상이면:
>    - AskUserQuestion: "이 패턴이 반복되고 있습니다. 에이전트 개선을 진행할까요?"
>    - Yes → `references/agent-improvement-protocol.md`의 Evolution Hook 실행
>    - No → 기록만 남기고 종료

orchestrator 반환 후, Bash로 agent_end를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-6-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "Step 4.5 완료: 에이전트 개선점 분석 완료"
```

---

## 마무리: 자동 회고 (축소판)

pipeline_end 직전, pipeline-orchestrator에게 핫픽스 축소 회고를 지시합니다.

Bash로 agent_start를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-7-$(date -u +%Y%m%d)" "pipeline-orchestrator" "sonnet" "마무리: 핫픽스 축소 회고 위임"
```

서브에이전트 실행 (Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, model: **"sonnet"**):

> **핫픽스 축소 회고 모드** — 파이프라인 완료 후 핵심 학습만 빠르게 수집합니다.
>
> **위임 메시지:**
> ```
> phase: retro
> slug: {slug}
> pipeline_type: hotfix
> context:
>   triage: .crew/artifacts/hotfix/{slug}-triage.md
> ```
>
> **수행할 작업:**
> executive-reporter를 호출하여 다음 항목을 기록합니다:
> 1. `hotfix:` — 근본 원인 + 영향 범위 요약
> 2. `vulnerable:` — 같은 영역에서 반복 버그가 감지되면 경고 수준 상향
> 3. `regression-test:` — 추가된 회귀 테스트 경로
>
> `.crew/board.md`의 관련 태스크를 `Done`으로 변경합니다.
>
> **DB 상태 업데이트 (board.md Done 이동과 동시에 실행)**: `~/.claude/plugins/marketplaces/my-claude/bams.db`가 존재하면 해당 태스크의 상태를 `done`으로 업데이트한다:
> ```bash
> if [ -f "$HOME/.claude/plugins/marketplaces/my-claude/bams.db" ]; then
>   bun -e "
>     import { TaskDB } from './plugins/bams-plugin/tools/bams-db/index.ts';
>     const db = new TaskDB();
>     // 완료된 각 태스크 ID에 대해 호출:
>     // db.updateTaskStatus('{task_id}', 'done', 'pipeline-orchestrator');
>     db.close();
>   "
> fi
> ```

orchestrator 반환 후, Bash로 agent_end를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-7-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "마무리 완료: 축소 회고 및 board 업데이트 완료"
```

---

## Viz 이벤트: pipeline_end

파이프라인 종료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" pipeline_end "{slug}" "{status}" {total} {completed} {failed} {skipped}
```
(`{status}`는 `completed` / `paused` / `failed` 중 하나, `{total}`은 5)

**`references/completion-protocol.md` 참조.** 표준 프로토콜을 따릅니다.

이 파이프라인의 Learnings 카테고리:
1. `hotfix:` — 근본 원인 + 영향 범위
2. `vulnerable:` — 같은 영역 반복 버그 시 경고 수준 상향
3. `regression-test:` — 추가된 회귀 테스트 경로

`.crew/board.md` 업데이트: 관련 태스크 있으면 `Done`으로 변경.

---

## TaskDB 완료 처리

TaskDB 연동 규칙은 `_common.md` 참조.

파이프라인 완료 시:
```bash
if [ -f "$HOME/.claude/plugins/marketplaces/my-claude/bams.db" ]; then
  bun run plugins/bams-plugin/tools/bams-db/sync-board.ts {slug} --write
fi
```
