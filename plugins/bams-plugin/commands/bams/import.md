---
name: bams:import
description: >
  bams:export로 생성한 tar.gz 패키지를 현재 프로젝트에 가져온다.
  .crew/ 구조를 생성하고 config.md의 프로젝트명/버전을 인터랙티브하게 업데이트한다.
---

# bams:import — Org 포터빌리티 Import

`bams:export`로 생성한 패키지를 현재 프로젝트에 가져온다.

**사용법:**
- `/bams:import bams-org-20260403120000/`  (압축 해제된 디렉터리)
- `/bams:import bams-org-20260403120000.tar.gz`  (압축 파일)

## Step 1 — 인자 파싱 및 입력 검증

사용자가 제공한 경로(압축 파일 또는 디렉터리)를 확인한다.

인자가 없으면 AskUserQuestion으로 패키지 경로를 물어본다:

> 가져올 bams-org 패키지 경로를 입력해주세요.
> (예: bams-org-20260403120000.tar.gz 또는 압축 해제된 디렉터리 경로)

## Step 2 — 패키지 해제

입력이 .tar.gz 파일이면 임시 디렉터리에 해제한다.

```bash
# 인자가 .tar.gz이면:
# PKG_PATH="$1"
# tar -xzf "$PKG_PATH" -C /tmp
# SOURCE_DIR=$(tar -tzf "$PKG_PATH" | head -1 | cut -d/ -f1)
# SOURCE_DIR="/tmp/$SOURCE_DIR"

# 인자가 디렉터리면:
# SOURCE_DIR="$1"

# MANIFEST.md 존재 확인
ls "${SOURCE_DIR}/MANIFEST.md" 2>/dev/null && echo "MANIFEST.md 확인됨" || echo "ERROR: MANIFEST.md 없음 — 유효한 bams-org 패키지가 아닙니다"
ls "${SOURCE_DIR}/agents/" 2>/dev/null | head -5
```

## Step 3 — 기존 .crew/ 충돌 검사

현재 프로젝트에 이미 .crew/ 디렉터리가 있으면 충돌 항목을 보여준다.

```bash
if [ -d ".crew" ]; then
  echo "=== 기존 .crew/ 감지됨 ==="
  echo "충돌 가능 항목:"
  echo "  - .crew/agents/ (에이전트 정의)"
  echo "  - .crew/skills/"
  echo "  - .crew/references/"
  echo "  - .crew/config.md"
  echo "  - .crew/gotchas.md"
  ls .crew/
else
  echo ".crew/ 없음 — 전체 새로 생성"
fi
```

기존 .crew/가 있으면 AskUserQuestion으로 처리 방법을 물어본다:

> 현재 프로젝트에 이미 .crew/ 디렉터리가 있습니다. 어떻게 처리할까요?
> 1. 충돌 항목만 선택적으로 덮어쓰기 (권장)
> 2. 전체 덮어쓰기 (기존 .crew/ 완전 교체)
> 3. 취소

## Step 4 — 파일 복사

사용자 선택에 따라 파일을 복사한다.

```bash
SOURCE_DIR="<패키지 경로>"

# 옵션 1 (선택적 덮어쓰기) 또는 옵션 2 (전체 덮어쓰기):
mkdir -p .crew/agents .crew/skills .crew/references

# agents 복사
cp -r "$SOURCE_DIR/agents/." .crew/agents/
echo "에이전트 복사: $(ls .crew/agents/ | wc -l)개"

# skills 복사
if [ -d "$SOURCE_DIR/skills" ]; then
  cp -r "$SOURCE_DIR/skills/." .crew/skills/
  echo "스킬 복사 완료"
fi

# references 복사
if [ -d "$SOURCE_DIR/references" ]; then
  cp -r "$SOURCE_DIR/references/." .crew/references/
  echo "레퍼런스 복사 완료"
fi

# gotchas.md 복사 (있는 경우)
[ -f "$SOURCE_DIR/gotchas.md" ] && cp "$SOURCE_DIR/gotchas.md" .crew/gotchas.md && echo "gotchas.md 복사됨"
```

## Step 5 — config.md 인터랙티브 업데이트

패키지의 config.md를 복사한 후, 현재 프로젝트에 맞게 핵심 필드를 업데이트한다.

먼저 패키지의 config.md를 복사한다:

```bash
SOURCE_DIR="<패키지 경로>"
cp "$SOURCE_DIR/config.md" .crew/config.md
echo "config.md 복사됨"
cat .crew/config.md
```

AskUserQuestion으로 프로젝트 정보를 순차 수집한다:

> 이 프로젝트의 정보를 입력해주세요.
>
> **프로젝트명** (현재: {config.md에서 읽은 값}):
> (예: my-saas-project)

> **버전** (현재: {config.md 값}, 신규 프로젝트 권장: 0.1.0):

> **런타임** (현재: {config.md 값}):
> (예: Bun 1.x, Node.js 20, Python 3.12)

수집한 값으로 .crew/config.md의 해당 필드를 업데이트한다. Edit 도구를 사용하여 최소 편집(해당 행만 수정)한다.

## Step 6 — board.md 초기 생성

새 프로젝트를 위한 빈 board.md를 생성한다 (기존 board.md가 있으면 건드리지 않는다).

```bash
if [ ! -f ".crew/board.md" ]; then
  cat > .crew/board.md << 'EOF'
# Task Board

> 프로젝트: {프로젝트명}
> 생성: $(date +%Y-%m-%d)

## In Progress

_진행 중인 태스크 없음_

## Backlog

_백로그 태스크 없음_

## Done

_완료된 태스크 없음_
EOF
  echo "board.md 생성됨"
else
  echo "board.md 이미 존재 — 건드리지 않음"
fi
```

## Step 7 — 메모리 디렉터리 초기화

PARA 메모리 구조를 생성한다 (기존 메모리가 있으면 유지한다).

```bash
AGENTS=(
  "pipeline-orchestrator" "cross-department-coordinator" "executive-reporter"
  "resource-optimizer" "product-strategy" "business-analysis" "ux-research"
  "project-governance" "frontend-engineering" "backend-engineering"
  "platform-devops" "data-integration" "product-analytics" "experimentation"
  "performance-evaluation" "business-kpi" "qa-strategy" "automation-qa"
  "defect-triage" "release-quality-gate" "hr-agent"
)

for agent in "${AGENTS[@]}"; do
  mkdir -p ".crew/memory/$agent/life/projects"
  mkdir -p ".crew/memory/$agent/life/areas"
  mkdir -p ".crew/memory/$agent/life/resources"
  mkdir -p ".crew/memory/$agent/life/archives"
  mkdir -p ".crew/memory/$agent/memory"
  # MEMORY.md가 없으면 기본 파일 생성 (기존 메모리 보존)
  if [ ! -f ".crew/memory/$agent/MEMORY.md" ]; then
    echo "# MEMORY.md — $agent
> 생성: $(date +%Y-%m-%d)

_아직 학습 항목 없음. 첫 파이프라인 실행 후 채워진다._" > ".crew/memory/$agent/MEMORY.md"
  fi
done
echo "메모리 구조 초기화 완료"
```

## Step 8 — 동작 검증

가져오기가 완료되면 `/bams:status`를 실행하여 즉시 동작 여부를 확인한다.

```bash
echo "=== .crew 구조 확인 ==="
ls -la .crew/
echo ""
echo "에이전트 수: $(ls .crew/agents/ 2>/dev/null | wc -l)"
echo "스킬 수: $(find .crew/skills -name '*.md' 2>/dev/null | wc -l)"
echo "레퍼런스 수: $(ls .crew/references/ 2>/dev/null | wc -l)"
```

`/bams:status`를 실행하여 최종 동작을 확인한다.

## Step 9 — 완료 보고

```bash
echo "=== bams:import 완료 ==="
echo ""
echo "다음 단계:"
echo "  1. .crew/config.md를 검토하여 프로젝트별 설정을 확인한다"
echo "  2. /bams:status로 조직 현황을 확인한다"
echo "  3. /bams:dev 또는 /bams:feature로 첫 파이프라인을 시작한다"
```

