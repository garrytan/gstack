# Hotfix: Finalization — 개선점 수집 + 마무리 회고

> 이 파일은 `/bams:hotfix`의 마무리 단계를 실행합니다.
> 공통 규칙은 `_common.md`를 참조합니다 (엔트리포인트에서 이미 로드됨).

## 입력 컨텍스트

- slug: {엔트리포인트에서 결정된 slug}
- parent_pipeline_slug: {Step 0.6에서 결정된 parent 슬러그 또는 null}
- triage_artifacts: `.crew/artifacts/hotfix/{slug}-triage.md`

---

## Step 4.5 시작 — Viz 이벤트

Step 4.5 시작 전 step_start를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 5 "에이전트 개선점 수집" "finalization"
```

## Step 4.5: 에이전트 개선점 수집 (2단 위임 — 루프 A)

> `_shared_common.md` §위임 원칙 + 부록 루프 A 준수. orchestrator는 조언자로만 호출하고, 메인이 직접 대상 에이전트(없음 — 메인 직접 수행)를 실행합니다. 본 Step은 실제 파일 생성만 수행하므로 orchestrator 조언 후 메인이 직접 처리합니다.

**Phase 1: Advisor 호출 (pipeline-orchestrator, 조언자 모드)**

Bash로 agent_start를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-6-$(date -u +%Y%m%d)" "pipeline-orchestrator" "claude-opus-4-7[1m]" "Step 4.5: 에이전트 개선점 분석 조언"
```

서브에이전트 실행 (Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, model: **"claude-opus-4-7[1m]"**, **조언자 모드**):

> **조언자 요청** — 본 핫픽스의 근본 원인 에이전트 식별 및 개선점 기록 전략을 조언해 주세요. spawn 지시는 금지이며, Advisor Response 계약 형식(대상 에이전트/태스크 내역/주의사항/승인 조건)으로 반환합니다.
>
> **컨텍스트:**
> - triage: `.crew/artifacts/hotfix/{slug}-triage.md`
> - parent_pipeline_slug: {parent_slug or null}
> - 기존 improvements: `.crew/memory/{agent}/improvements/`
>
> **조언 필요 항목:**
> 1. 근본 원인 에이전트 후보 및 pattern_tag 추천
> 2. one-off / structural 분류 기준
> 3. improvements 파일 YAML front-matter 템플릿 검증
> 4. AskUserQuestion 트리거 조건 (structural 2회 이상 반복 시)

Bash로 agent_end를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-6-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "Step 4.5 조언 완료"
```

**Phase 2: 메인이 직접 실행**

메인 스레드가 Advisor Response를 파싱한 후 직접:
1. triage.md Read → 근본 원인 에이전트 식별
2. `.crew/memory/{agent}/improvements/` Glob → 동일 pattern_tag 검색 → type 결정
3. `.crew/memory/{agent}/improvements/{date}-{slug}.md` Write (아래 YAML)
4. structural + 2회 이상 반복 시 AskUserQuestion → Yes면 `references/agent-improvement-protocol.md` Evolution Hook 실행

```yaml
---
date: {YYYY-MM-DD}
pipeline_slug: {slug}
parent_pipeline_slug: {parent_slug or null}
agent: {agent_type}
pattern_tag: {카테고리 태그}
type: one-off | structural
severity: minor | major | critical
---

## 근본 원인
{triage 근본 원인}

## 개선 제안
{구체적 제안}

## 관련 파이프라인
- 원본: {parent_pipeline_slug}
- 핫픽스: {slug}
```

---

## 마무리: 자동 회고 (축소판, 2단 위임 — 루프 A 직접 호출)

> `_shared_common.md` §부록 루프 A 준수. Step 4.5 Phase 1의 Advisor 조언을 기반으로 메인이 부서장들을 직접 병렬 spawn합니다 (Advisor 2회 호출을 1회로 축소).

**메인이 직접 부서장 병렬 spawn**

Step 4.5 Phase 1의 Advisor Response에서 근본 원인 부서장 정보를 활용하여, 메인이 다음을 수행합니다:

1. 먼저 executive-reporter(+ 근본 원인 부서장) 전체의 `agent_start`를 Bash로 모두 emit
2. Task tool로 **병렬 호출**:
   - **executive-reporter**: 아래 3개 학습 카테고리 기록
     - `hotfix:` — 근본 원인 + 영향 범위 요약
     - `vulnerable:` — 같은 영역 반복 버그 감지 시 경고 수준 상향
     - `regression-test:` — 추가 회귀 테스트 경로
   - **근본 원인 부서장(동적)**: Step 4.5 Phase 1에서 식별된 부서장에게 자기 부서 관점 교훈 1~3줄 기록 위임
3. 각 호출 종료 후 `agent_end` emit
4. 메인이 직접 `.crew/board.md` 관련 태스크를 `Done`으로 변경
5. DB 상태 업데이트:

```bash
if [ -f "$HOME/.claude/plugins/marketplaces/my-claude/bams.db" ]; then
  bun -e "
    import { TaskDB } from './plugins/bams-plugin/tools/bams-db/index.ts';
    const db = new TaskDB();
    // db.updateTaskStatus('{task_id}', 'done', 'main');
    db.close();
  "
fi
```

---

## Step 4.5 완료 — Viz 이벤트

모든 finalization 작업 완료 후 step_end를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 5 "done" {duration_ms}
```

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
