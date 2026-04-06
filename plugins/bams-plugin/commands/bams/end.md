---
description: 작업 단위 종료 — 현재 활성 작업을 완료 처리
argument-hint: [작업 slug (생략 시 목록에서 선택)]
---

# Bams End

작업 단위(Work Unit)를 종료합니다.
인자로 slug를 지정하면 해당 작업만 종료하고, 생략하면 활성 목록을 보여줍니다.

## 실행

### Step 1: 대상 Work Unit 결정

$ARGUMENTS가 있으면 해당 slug를 대상으로 합니다.

없으면 Bash로 활성 work unit 목록을 확인합니다:

```bash
if [ -f /tmp/bams-active-workunits.json ]; then
  COUNT=$(jq 'length' /tmp/bams-active-workunits.json 2>/dev/null || echo 0)
  if [ "$COUNT" -gt 0 ]; then
    echo "활성 작업 ${COUNT}개:"
    jq -r '.[] | "  [\(.slug)] \(.name) — 시작: \(.startedAt)"' /tmp/bams-active-workunits.json 2>/dev/null
  else
    echo "활성 작업 없음"
  fi
else
  # 레거시 단일 파일 확인 (하위 호환)
  if [ -f /tmp/bams-active-workunit ]; then
    ACTIVE=$(cat /tmp/bams-active-workunit)
    echo "활성 작업 1개:"
    echo "  [$ACTIVE] $ACTIVE"
  else
    echo "활성 작업 없음"
  fi
fi
```

활성 work unit이 없으면 "활성 작업이 없습니다. `/bams:start`로 작업을 시작하세요." 출력 후 종료.

활성 work unit이 1개이면 자동으로 해당 작업을 대상으로 선택합니다.

활성 work unit이 2개 이상이면 **AskUserQuestion**으로 사용자에게 선택하게 합니다:
Question: "어떤 작업을 종료할까요?"
Options: 각 활성 작업의 slug를 옵션으로 제시

### Step 2: 포함된 파이프라인 집계

Bash로 해당 work unit에 연결된 파이프라인을 확인합니다:

```bash
WU_FILE="$HOME/.bams/artifacts/pipeline/{slug}-workunit.jsonl"
if [ -f "$WU_FILE" ]; then
  echo "=== 연결된 파이프라인 ==="
  grep '"pipeline_linked"' "$WU_FILE" | jq -r '.pipeline_slug' 2>/dev/null
  echo "=== 총 개수 ==="
  grep -c '"pipeline_linked"' "$WU_FILE" 2>/dev/null || echo "0"
else
  echo "workunit 파일 없음"
fi
```

### Step 3: Work Unit 종료

Bash로 이벤트를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1)
[ -n "$_EMIT" ] && bash "$_EMIT" work_unit_end "{slug}" "completed"
```

DB에도 work unit 종료를 기록합니다 (DB가 존재하면):
```bash
if [ -f "$HOME/.claude/plugins/marketplaces/my-claude/bams.db" ]; then
  bun -e "
    import { WorkUnitDB } from './plugins/bams-plugin/tools/bams-db/index.ts';
    const db = new WorkUnitDB();
    db.endWorkUnit('{slug}', 'completed', new Date().toISOString());
    db.close();
  " 2>/dev/null || true
fi
```

### Step 4: 결과 출력

```
작업 종료
════════════════════
작업명: {작업명}
slug: {slug}
포함된 파이프라인: {N}개
  - {pipeline_slug_1} ({pipeline_type})
  - {pipeline_slug_2} ({pipeline_type})

남은 활성 작업: {M}개   ← 다른 작업이 아직 활성 상태인 경우만 표시
  - {other_slug_1}
```
