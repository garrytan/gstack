---
description: 작업 단위 시작 — 여러 파이프라인을 하나의 작업으로 그룹핑
argument-hint: <작업명>
---

# Bams Start

사용자가 정의하는 작업 단위(Work Unit)를 시작합니다.
하나의 작업 안에 여러 파이프라인(dev, hotfix, debug 등)이 포함될 수 있습니다.
**여러 work unit을 동시에 활성 상태로 유지할 수 있습니다 (병렬 작업 지원).**

## 실행

$ARGUMENTS가 비어있으면 **AskUserQuestion**으로 작업명을 물어봅니다:
Question: "어떤 작업을 시작할까요?"
Header: "Work Unit"

작업명: $ARGUMENTS

### Step 1: Slug 생성

작업명에서 slug를 생성합니다. 규칙:
- 공백 제거
- 한글 허용
- 예: "결제 시스템 리팩토링" → `결제시스템리팩토링`

### Step 2: 현재 활성 Work Unit 목록 확인

Bash로 현재 활성 work unit 목록을 확인합니다:

```bash
if [ -f /tmp/bams-active-workunits.json ]; then
  COUNT=$(jq 'length' /tmp/bams-active-workunits.json 2>/dev/null || echo 0)
  if [ "$COUNT" -gt 0 ]; then
    echo "현재 활성 작업 ${COUNT}개:"
    jq -r '.[] | "  - \(.slug) (시작: \(.startedAt))"' /tmp/bams-active-workunits.json 2>/dev/null
  else
    echo "활성 작업 없음"
  fi
else
  # 레거시 단일 파일 확인 (하위 호환)
  if [ -f /tmp/bams-active-workunit ]; then
    ACTIVE=$(cat /tmp/bams-active-workunit)
    echo "현재 활성 작업 1개:"
    echo "  - $ACTIVE (레거시)"
  else
    echo "활성 작업 없음"
  fi
fi
```

활성 work unit이 1개 이상 있더라도 **새 작업을 추가로 시작할 수 있습니다.**
기존 작업 목록을 사용자에게 안내하고 새 작업을 병렬로 시작함을 알립니다.

### Step 3: Work Unit 시작

Bash로 이벤트를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1)
[ -n "$_EMIT" ] && bash "$_EMIT" work_unit_start "{slug}" "{작업명}"
```

DB에도 work unit을 기록합니다 (DB가 존재하면):
```bash
if [ -f "$HOME/.claude/plugins/marketplaces/my-claude/bams.db" ]; then
  bun -e "
    import { TaskDB } from './plugins/bams-plugin/tools/bams-db/index.ts';
    const db = new TaskDB();
    db.upsertWorkUnit('{slug}', '{작업명}');
    db.close();
  " 2>/dev/null || true
fi
```

### Step 4: 결과 출력

```
작업 시작
════════════════════
작업명: {작업명}
slug: {slug}

현재 활성 작업 목록:
  - {slug} (방금 시작)
  - {기존_slug_1} (진행 중)   ← 기존 작업이 있는 경우만 표시

이후 실행하는 파이프라인은 가장 최근에 시작된 이 작업에 자동으로 포함됩니다.
특정 작업 종료: /bams:end {slug}
전체 목록 확인: /bams:end (인자 없이 실행)
```
