---
description: 주간 루틴 — 스프린트 마무리 + 회고 + 다음 스프린트 계획
argument-hint:
---

# Bams: Weekly

매주 금요일(또는 스프린트 종료 시) 실행하는 주간 루틴입니다.

## Pre-flight

**`references/preflight-protocol.md` 참조.** 표준 프로토콜을 따릅니다.

추가 항목:
- **`.crew/sprints/`** — 활성 스프린트 정보.
- **`.crew/artifacts/pipeline/`** — 이전 `weekly-*.md`의 `started_at` 이후 실행된 **모든 타입** 파이프라인 기록 (feature, hotfix, deep-review, security, performance).
  - 각 파일의 **프론트매터 + Execution Log 마지막 줄만** 추출 (전체 파일 읽지 않음).
- **config.md의 `## Pipeline Learnings`** 에서 `trend:`, `vulnerable:`, `critical:` 항목을 추출 → Step 3(회고), Step 4(다음 스프린트) 의사결정에 활용.

스킬 로딩:

```bash
_RETRO_SKILL=$(find ~/.claude/plugins/cache -path "*/bams-plugin/*/skills/retro/SKILL.md" 2>/dev/null | head -1)
```

`bams-plugin:project-governance` 에이전트를 거버넌스에 활용.
`bams-plugin:product-analytics` 에이전트를 분석에 활용.

진행 추적 파일: `templates/weekly-tracking.md` 기반으로 생성.

### Viz 이벤트: pipeline_start

진행 추적 파일 및 lock 파일 생성 직후, Bash로 다음을 실행합니다:

```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" pipeline_start "{slug}" "weekly" "/bams:weekly" "{arguments}"
```

### ★ Viz Agent 이벤트 규칙

**`references/viz-agent-protocol.md` 참조.** 모든 서브에이전트 호출 전후에 반드시 agent_start/agent_end 이벤트를 emit한다. orchestrator 내부에서 부서장/에이전트를 호출할 때도 동일하게 적용한다.

## Step 1: 스프린트 현황 확인

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 1 "스프린트 현황 확인" "Phase 1: 현황"
```

활성 스프린트 없으면 `skipped` → Step 3으로.

board.md에서 태스크 현황 파악 + 이번 주 파이프라인 기록과 태스크 매핑.
`/bams:sprint status` 실행.

Step 1 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 1 "{status}" {duration_ms}
```

## Step 2: 스프린트 종료

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 2 "스프린트 종료" "Phase 2: 종료"
```

AskUserQuestion — "현재 스프린트를 종료할까요?"
- **종료 (Recommended)** — `/bams:sprint close` 실행
- **계속 진행**

Step 2 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 2 "{status}" {duration_ms}
```

## Step 3-4: 회고 + 다음 스프린트 (병렬 준비)

### Step 3: 엔지니어링 회고 (bams retro 스킬)

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 3 "엔지니어링 회고" "Phase 3: 회고 + 계획"
```

**스킬 미설치 시**: `skipped`.

AskUserQuestion — "회고와 다음 스프린트 계획을 어떻게 진행할까요?"
- **둘 다 (Recommended)** — 회고 + 스프린트 계획 순차 실행
- **회고만** — `_RETRO_SKILL` 실행
- **스프린트만** — `/bams:sprint plan` 실행
- **건너뛰기**

**회고 진행 시**: `_RETRO_SKILL` 실행. 이전 weekly 회고 결과 있으면 트렌드 비교 전달.
**최적화**: 회고 실행 중 백그라운드로 백로그 태스크 분석을 시작하여 Step 4의 스프린트 플래닝을 가속합니다.

Step 3 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 3 "{status}" {duration_ms}
```

### Step 4: 다음 스프린트 계획

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 4 "다음 스프린트 계획" "Phase 3: 회고 + 계획"
```

백로그 비어있으면 `/bams:plan` 제안.
있으면 `/bams:sprint plan` 실행.

Step 4 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 4 "{status}" {duration_ms}
```

### Step 5: 문서 Drift 감지 (doc-drift)

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 5 "문서 Drift 감지" "Phase 4: doc-drift"
```

`.crew/skills/doc-drift/SKILL.md`를 Read하여 doc-drift 스킬을 실행한다.

**doc-drift 실행 목적:**
- 이번 스프린트에서 변경된 커밋을 스캔하여 문서 drift 감지
- Feature/Breaking/Structural 변경 분류
- drift 발견 시 브랜치 생성 + 최소 편집 + PR 자동 생성
- drift 없으면 `.doc-review-cursor`만 업데이트

**스킬 파일이 없는 경우:** `skipped`.

Step 5 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 5 "{status}" {duration_ms}
```


## 마무리

### Viz 이벤트: pipeline_end

파이프라인 종료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" pipeline_end "{slug}" "{status}" {total} {completed} {failed} {skipped}
```
(`{status}`는 `completed` / `paused` / `failed` 중 하나, `{total}`은 4)

**`references/completion-protocol.md` 참조.** 표준 프로토콜을 따릅니다.

이 파이프라인의 Learnings 카테고리:
1. `weekly:` — 이번 주 생산성 요약 (feature N개, hotfix N개, 완료율)
2. `retro:` — 회고 핵심 인사이트
3. `trend:` — 반복 이슈 트렌드

### Gotchas 정리 (주간 전용)

weekly는 gotchas의 **정기 정리** 담당:
1. 6개월간 관련 이슈 없는 항목 → "강등 후보" 제안.
2. 이번 주 해결된 이슈와 gotchas 매칭 → `resolved` 처리 제안.
3. gotchas 총 50개 초과 시 → 아카이브 프로세스 제안.
4. 90일 이상 경과한 `completed` pipeline 추적 파일 → 아카이브 제안.


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

