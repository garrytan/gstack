---
name: bams:export
description: >
  bams-plugin 조직 설정(에이전트 정의, 스킬, 레퍼런스, config.md, gotchas.md)을
  이식 가능한 tar.gz 패키지로 내보낸다. MANIFEST.md와 COMPANY.md(agentcompanies/v1)를
  자동 생성한다.
---

# bams:export — Org 포터빌리티 Export

bams-plugin 조직 설정을 새 프로젝트에 이식할 수 있는 패키지로 내보낸다.

## Step 1 — 환경 확인

작업 디렉터리에 `.crew/` 구조가 존재하는지 확인한다.

```bash
ls .crew/agents/ 2>/dev/null | wc -l
ls .crew/skills/ 2>/dev/null | wc -l
ls .crew/references/ 2>/dev/null | wc -l
cat .crew/config.md 2>/dev/null | head -20
```

.crew/agents/ 디렉터리가 없으면 사용자에게 `/bams:init`을 먼저 실행하라고 안내하고 중단한다.

## Step 2 — 버전 및 메타데이터 수집

config.md에서 프로젝트 버전과 이름을 읽는다.

```bash
cat .crew/config.md
git remote get-url origin 2>/dev/null || echo "no-remote"
git rev-parse HEAD 2>/dev/null || echo "no-git"
date -u +"%Y-%m-%dT%H:%M:%SZ"
```

## Step 3 — 임시 패키징 디렉터리 준비

타임스탬프 기반 패키지 디렉터리를 생성한다.

```bash
TIMESTAMP=$(date +%Y%m%d%H%M%S)
PKG_DIR="/tmp/bams-org-${TIMESTAMP}"
mkdir -p "$PKG_DIR/agents"
mkdir -p "$PKG_DIR/skills"
mkdir -p "$PKG_DIR/references"
echo "패키지 디렉터리: $PKG_DIR"
echo "TIMESTAMP=$TIMESTAMP"
```

## Step 4 — 에이전트 정의 복사

.crew/agents/ 아래 모든 에이전트 정의 파일을 복사한다.

```bash
TIMESTAMP=$(date +%Y%m%d%H%M%S)
PKG_DIR="/tmp/bams-org-${TIMESTAMP}"

# agents 복사
if [ -d ".crew/agents" ]; then
  cp -r .crew/agents/. "$PKG_DIR/agents/"
  echo "에이전트 복사: $(ls "$PKG_DIR/agents/" | wc -l)개"
fi

# skills 복사 (doc-drift 등 커스텀 스킬)
if [ -d ".crew/skills" ]; then
  cp -r .crew/skills/. "$PKG_DIR/skills/"
  echo "스킬 복사: $(find "$PKG_DIR/skills" -name "*.md" | wc -l)개"
fi

# references 복사
if [ -d ".crew/references" ]; then
  cp -r .crew/references/. "$PKG_DIR/references/"
  echo "레퍼런스 복사: $(ls "$PKG_DIR/references/" | wc -l)개"
fi

# config.md, gotchas.md 복사
cp .crew/config.md "$PKG_DIR/config.md" 2>/dev/null && echo "config.md 복사됨"
cp .crew/gotchas.md "$PKG_DIR/gotchas.md" 2>/dev/null && echo "gotchas.md 복사됨"
```

## Step 5 — MANIFEST.md 생성

패키지에 포함된 모든 파일 목록과 SHA256 체크섬을 기록한 MANIFEST.md를 생성한다.

아래 정보를 수집한다:
- 에이전트 목록 (agents/ 디렉터리 파일명에서 추출)
- 스킬 목록 (skills/ 디렉터리 파일명)
- 레퍼런스 목록
- git 정보

```bash
TIMESTAMP=$(ls /tmp/ | grep "bams-org-" | tail -1 | sed 's/bams-org-//')
PKG_DIR="/tmp/bams-org-${TIMESTAMP}"

GIT_REMOTE=$(git remote get-url origin 2>/dev/null || echo "no-remote")
GIT_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "no-git")
GEN_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
VERSION=$(grep -E "^\| 버전" .crew/config.md 2>/dev/null | head -1 | awk -F'|' '{gsub(/ /,"",$3); print $3}' || echo "0.0.0")
PROJECT=$(grep -E "^\| 프로젝트명" .crew/config.md 2>/dev/null | head -1 | awk -F'|' '{gsub(/^ /,"",$3); gsub(/ $/,"",$3); print $3}' || echo "unknown")

echo "# BAMS Org Manifest
> Generated: ${GEN_DATE}
> Version: ${VERSION}
> Project: ${PROJECT}
> Source: ${GIT_REMOTE}
> Commit: ${GIT_COMMIT}

## Agents ($(ls "$PKG_DIR/agents/" 2>/dev/null | wc -l | tr -d ' '))

| Slug | Description |
|------|-------------|" > "$PKG_DIR/MANIFEST.md"

for f in "$PKG_DIR/agents/"*.md; do
  slug=$(basename "$f" .md)
  desc=$(grep -m1 "^>" "$f" 2>/dev/null | sed 's/^> //' || echo "-")
  echo "| $slug | $desc |" >> "$PKG_DIR/MANIFEST.md"
done

echo "
## Skills

| Name | Path |
|------|------|" >> "$PKG_DIR/MANIFEST.md"

find "$PKG_DIR/skills" -name "*.md" 2>/dev/null | while read f; do
  name=$(dirname "$f" | xargs basename)
  echo "| $name | skills/$(basename $(dirname $f))/$(basename $f) |" >> "$PKG_DIR/MANIFEST.md"
done

echo "
## References

| File | Description |
|------|-------------|" >> "$PKG_DIR/MANIFEST.md"

ls "$PKG_DIR/references/"*.md 2>/dev/null | while read f; do
  fname=$(basename "$f")
  echo "| $fname | - |" >> "$PKG_DIR/MANIFEST.md"
done

echo "
## Checksums

| File | SHA256 |
|------|--------|" >> "$PKG_DIR/MANIFEST.md"

find "$PKG_DIR" -type f ! -name "MANIFEST.md" | sort | while read f; do
  rel="${f#$PKG_DIR/}"
  hash=$(shasum -a 256 "$f" | awk '{print $1}')
  echo "| $rel | $hash |" >> "$PKG_DIR/MANIFEST.md"
done

echo "MANIFEST.md 생성 완료"
cat "$PKG_DIR/MANIFEST.md" | head -30
```

## Step 6 — COMPANY.md 생성 (agentcompanies/v1)

agentcompanies/v1 스펙에 맞는 COMPANY.md를 생성한다.

```bash
TIMESTAMP=$(ls /tmp/ | grep "bams-org-" | tail -1 | sed 's/bams-org-//')
PKG_DIR="/tmp/bams-org-${TIMESTAMP}"
VERSION=$(grep -E "^\| 버전" .crew/config.md 2>/dev/null | head -1 | awk -F'|' '{gsub(/ /,"",$3); print $3}' || echo "0.0.0")

cat > "$PKG_DIR/COMPANY.md" << EOF
---
schema: agentcompanies/v1
name: BAMS Agent Organization
slug: bams-plugin
description: >
  5부서 20+ 에이전트로 구성된 파일 기반 멀티에이전트 파이프라인 조직.
  기획 → 구현 → 검증 → 리뷰 → 배포 파이프라인을 자동화한다.
version: ${VERSION}
adapter: claude_local
---

# BAMS Agent Organization

## 조직 구조

파이프라인 워크플로우: pipeline-orchestrator가 중앙 지휘하고,
단계별로 부서장(product-strategy, frontend-engineering, backend-engineering,
platform-devops, qa-strategy)에게 위임하는 Hub-and-Spoke + Pipeline 혼합 구조.

## 부서 구성

| 부서 | 부서장 | 에이전트 수 |
|------|--------|-------------|
| 기획부 | product-strategy | 4 |
| 프론트엔드 | frontend-engineering | 1 |
| 백엔드 | backend-engineering | 1 |
| 플랫폼/DevOps | platform-devops | 1 |
| QA부 | qa-strategy | 3 |
| 평가부 | product-analytics | 3 |
| 경영지원 | executive-reporter | 4 |
| HR | hr-agent | 1 |

---
Generated from bams-plugin with the company-creator skill from [Paperclip](https://github.com/paperclipai/paperclip)
EOF

echo "COMPANY.md 생성 완료"
```

## Step 7 — .paperclip.yaml 생성

```bash
TIMESTAMP=$(ls /tmp/ | grep "bams-org-" | tail -1 | sed 's/bams-org-//')
PKG_DIR="/tmp/bams-org-${TIMESTAMP}"

cat > "$PKG_DIR/.paperclip.yaml" << 'YAML'
schema: paperclip/v1
agents:
  pipeline-orchestrator:
    adapter:
      type: claude_local
      config:
        model: claude-sonnet-4-6
  backend-engineering:
    adapter:
      type: claude_local
      config:
        model: claude-opus-4-5
  frontend-engineering:
    adapter:
      type: claude_local
      config:
        model: claude-sonnet-4-6
  platform-devops:
    adapter:
      type: claude_local
      config:
        model: claude-sonnet-4-6
  product-strategy:
    adapter:
      type: claude_local
      config:
        model: claude-opus-4-5
  qa-strategy:
    adapter:
      type: claude_local
      config:
        model: claude-sonnet-4-6
  product-analytics:
    adapter:
      type: claude_local
      config:
        model: claude-sonnet-4-6
  executive-reporter:
    adapter:
      type: claude_local
      config:
        model: claude-haiku-3-5
  resource-optimizer:
    adapter:
      type: claude_local
      config:
        model: claude-haiku-3-5
  cross-department-coordinator:
    adapter:
      type: claude_local
      config:
        model: claude-sonnet-4-6
  hr-agent:
    adapter:
      type: claude_local
      config:
        model: claude-haiku-3-5
YAML

echo ".paperclip.yaml 생성 완료"
```

## Step 8 — tar.gz 패키징 및 산출물 배치

임시 디렉터리를 tar.gz로 압축하여 현재 디렉터리에 배치한다.

```bash
TIMESTAMP=$(ls /tmp/ | grep "bams-org-" | tail -1 | sed 's/bams-org-//')
PKG_DIR="/tmp/bams-org-${TIMESTAMP}"
OUTPUT="bams-org-${TIMESTAMP}.tar.gz"

tar -czf "$OUTPUT" -C /tmp "bams-org-${TIMESTAMP}"
echo "패키지 생성: $OUTPUT ($(du -sh "$OUTPUT" | cut -f1))"
ls -lh "$OUTPUT"
```

## Step 9 — 완료 보고

```bash
TIMESTAMP=$(ls . | grep "bams-org-" | tail -1 | sed 's/bams-org-//' | sed 's/.tar.gz//')
OUTPUT="bams-org-${TIMESTAMP}.tar.gz"

echo "=== bams:export 완료 ==="
echo "패키지: $OUTPUT"
echo ""
echo "배포 방법:"
echo "  tar -xzf $OUTPUT"
echo "  # 대상 프로젝트 루트에서:"
echo "  # /bams:import bams-org-${TIMESTAMP}/"
```

