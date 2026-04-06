---
description: 성능 측정/최적화 — benchmark 기반 성능 관리
argument-hint: <url> [--baseline | --trend]
---

# Bams: Performance

bams benchmark 스킬을 활용한 성능 측정, 비교, 트렌드 분석입니다.

## Pre-flight

**`references/preflight-protocol.md` 참조.** 표준 프로토콜을 따릅니다.

차이점:
- benchmark 스킬 **필수** — 미설치 시 "bams benchmark 스킬이 필요합니다." 후 중단.
- URL 없으면 config.md에서 확인, 없으면 AskUserQuestion.
- 모드: `--baseline` (캡처), `--trend` (트렌드), 없으면 비교 모드.
- Gotchas 중 `perf-regression`, `perf-baseline` 관련 항목을 벤치마크 컨텍스트로 전달.
- 트렌드 모드: `performance-*.md` **최근 20개만** 읽기 (수정 날짜 기준).

스킬 로딩:

```bash
_BENCHMARK_SKILL=$(find ~/.claude/plugins/cache -path "*/bams-plugin/*/skills/benchmark/SKILL.md" 2>/dev/null | head -1)
```

`bams-plugin:performance-evaluation` 에이전트를 분석에 활용합니다.

진행 추적 파일: `templates/performance-tracking.md` 기반으로 생성.

### Viz 이벤트: pipeline_start

진행 추적 파일 및 lock 파일 생성 직후, Bash로 다음을 실행합니다:

```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" pipeline_start "{slug}" "performance" "/bams:performance" "{arguments}"
```

### ★ Viz Agent 이벤트 규칙

**`references/viz-agent-protocol.md` 참조.** 모든 서브에이전트 호출 전후에 반드시 agent_start/agent_end 이벤트를 emit한다. orchestrator 내부에서 부서장/에이전트를 호출할 때도 동일하게 적용한다.

## 베이스라인 모드 (--baseline)

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 1 "베이스라인 측정" "Phase 1: 측정"
```

`_BENCHMARK_SKILL` `--baseline` 모드로 실행.

베이스라인 모드 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 1 "done" {duration_ms}
```

## 비교 모드 (기본)

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 2 "비교 측정" "Phase 2: 비교"
```

`performance-*.md` 중 `mode: baseline`, `status: completed` 파일 확인.
없으면 먼저 캡처할지 AskUserQuestion.
있으면 `_BENCHMARK_SKILL` 비교 모드 실행.

비교 모드 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 2 "done" {duration_ms}
```

## 트렌드 모드 (--trend)

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 3 "트렌드 분석" "Phase 3: 트렌드"
```

최근 20개 `performance-*.md` 프론트매터에서 수치만 추출하여 시계열 구축.
`_BENCHMARK_SKILL` `--trend` 모드 실행.

트렌드 모드 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 3 "done" {duration_ms}
```

## 마무리

### Viz 이벤트: pipeline_end

파이프라인 종료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" pipeline_end "{slug}" "{status}" {total} {completed} {failed} {skipped}
```
(`{status}`는 `completed` / `paused` / `failed` 중 하나, `{total}`은 3)

**`references/completion-protocol.md` 참조.** 표준 프로토콜을 따릅니다.

이 파이프라인의 Learnings 카테고리:
1. `perf-baseline:` — 베이스라인 수치 (LCP, FCP, CLS, 번들 사이즈)
2. `perf-regression:` — 이전 대비 악화 지표
3. `perf-improvement:` — 최적화 적용 후 개선 수치


### TaskDB 연동 (DB가 존재하면 board.md 대신 DB 사용)

`~/.claude/plugins/marketplaces/my-claude/bams.db`가 존재하면 DB를 우선 사용합니다:

```bash
# DB 존재 확인
if [ -f "$HOME/.claude/plugins/marketplaces/my-claude/bams.db" ]; then
  echo "[bams-db] DB 모드 활성화"
fi
```

**태스크 등록 시 (DB가 존재하면):** Bash로 bun 스크립트를 실행하여 TaskDB에 태스크를 등록합니다.

```bash
# DB가 존재하면 TaskDB에 태스크 등록
if [ -f "$HOME/.claude/plugins/marketplaces/my-claude/bams.db" ]; then
  bun -e "
    import { TaskDB } from './plugins/bams-plugin/tools/bams-db/index.ts';
    const db = new TaskDB();
    db.createTask({ pipeline_slug: '{slug}', title: '{task_title}', status: 'in_progress', assignee_agent: '{agent}', phase: {phase} });
    db.close();
  "
fi
```

**파이프라인 완료 시 (DB가 존재하면):** board.md를 DB 스냅샷으로 갱신합니다.

```bash
if [ -f "$HOME/.claude/plugins/marketplaces/my-claude/bams.db" ]; then
  bun run plugins/bams-plugin/tools/bams-db/sync-board.ts {slug} --write
fi
```

DB가 없으면 기존 board.md 방식을 유지합니다.

