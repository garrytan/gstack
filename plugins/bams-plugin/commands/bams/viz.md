---
description: 파이프라인 실행 시각화 — DAG, 간트 차트, 조직도, 실시간 대시보드
argument-hint: <slug|org|start|stop>
---

# Bams Viz

파이프라인 실행을 시각화합니다. 에이전트 호출 관계, 타임라인, 실시간 상태를 볼 수 있습니다.

입력: $ARGUMENTS

## 모드 결정

$ARGUMENTS를 분석하여 모드를 결정합니다:

- **`org`** → 조직도 모드
- **`start`** 또는 **`live`** → 대시보드 빌드 + 실행 모드
- **`stop`** → 대시보드 서버 종료 모드
- **그 외 (slug 또는 비어있음)** → 정적 시각화 모드

---

## 모드 1: 정적 시각화 (`/bams:viz` 또는 `/bams:viz <slug>`)

### Step 1: slug 결정

$ARGUMENTS가 비어있으면:
1. Glob으로 `.crew/artifacts/pipeline/*-events.jsonl` 파일을 검색합니다.
2. 파일이 없으면: "이벤트 파일이 없습니다. 파이프라인을 실행한 후 다시 시도하세요." 후 종료.
3. 파일이 1개면: 자동 선택.
4. 파일이 여러 개면: AskUserQuestion으로 선택.

$ARGUMENTS가 slug이면: `.crew/artifacts/pipeline/{slug}-events.jsonl` 존재 확인.

### Step 2: 이벤트 파싱

이벤트 파일을 Read로 읽고, 각 줄을 JSON으로 파싱합니다.
파싱 실패 줄은 건너뛰고 경고를 출력합니다.

이벤트에서 다음을 추출합니다:
- 파이프라인 메타: type, status, 시작/종료 시각
- Step 목록: 번호, 이름, Phase, 상태, 시간
- 에이전트 목록: call_id, type, model, 상태, 시간, 병렬 그룹

### Step 3: Mermaid DAG 생성

에이전트 호출 관계를 Mermaid flowchart로 출력합니다:

```
## Pipeline DAG: {slug}

```mermaid
flowchart LR
  subgraph 기획["기획"]
    S1["PRD+설계+태스크<br/>product-strategy (opus)<br/>2m 13s"]
  end
  subgraph 구현["구현"]
    S3{"멀티에이전트 개발"}
    S3 --> FE["frontend-engineering<br/>opus · 8m"]
    S3 --> BE["backend-engineering<br/>opus · 12m"]
  end
  S1 --> S3
  style S1 fill:#22c55e,stroke:#16a34a,color:#fff
  style FE fill:#22c55e,stroke:#16a34a,color:#fff
  style BE fill:#3b82f6,stroke:#2563eb,color:#fff
```
```

노드 스타일:
- **done/success**: `fill:#22c55e` (녹색)
- **fail**: `fill:#ef4444` (적색)
- **skipped**: `fill:#9ca3af` (회색)
- **running**: `fill:#3b82f6` (파랑)
- **pending**: `fill:#e5e7eb` (연회색)

병렬 에이전트: fork 노드(`{}` 다이아몬드)에서 분기하여 같은 rank에 배치.

### Step 4: Mermaid 간트 차트 생성

타임라인을 Mermaid gantt로 출력합니다:

```
## Timeline: {slug}

```mermaid
gantt
  title {type}: {slug}
  dateFormat YYYY-MM-DDTHH:mm:ss
  axisFormat %H:%M
  section 기획
  product-strategy (opus)    :done, ps, {startedAt}, 133s
  business-analysis (opus)   :done, ba, {startedAt}, 105s
  frontend-engineering (sonnet) :done, fe, {startedAt}, 80s
  section 구현
  frontend-engineering (opus) :active, fe2, {startedAt}, 480s
  backend-engineering (opus)  :done, be2, {startedAt}, 720s
```
```

병렬 에이전트: 동일 시작 시각으로 겹쳐 표시.
fail: `crit` 태그. running: `active` 태그.

### Step 5: 요약 통계

```
Pipeline: {type} — {slug}
상태: {status}
시작: {startedAt}
소요: {duration}
Steps: {completed}/{total} done, {failed} fail, {skipped} skipped
에이전트 호출: {agent_count}회 (병렬 최대 {max_parallel}개)
```

---

## 모드 2: 조직도 (`/bams:viz org`)

### Step 1: jojikdo.json 로딩

Glob으로 `references/jojikdo.json` 검색. 없으면 에러.

### Step 2: Mermaid 조직도 생성

4부서 16에이전트의 관계를 flowchart로 출력합니다:

```
## Bams Agent Organization

```mermaid
flowchart TB
  ROOT(("bams-plugin<br/>v1.2.0"))
  ROOT --> planning["기획부서"]
  ROOT --> engineering["개발부서"]
  ROOT --> evaluation["평가부서"]
  ROOT --> qa["QA부서"]

  planning --> ps["Product Strategy"]
  planning --> ba["Business Analysis"]
  planning --> ux["UX Research"]
  planning --> pg["Project Governance"]

  engineering --> fe["Frontend Engineering"]
  engineering --> be["Backend Engineering"]
  engineering --> pd["Platform DevOps"]
  engineering --> di["Data Integration"]

  style planning fill:#3b82f6,stroke:#2563eb,color:#fff
  style engineering fill:#22c55e,stroke:#16a34a,color:#fff
  style evaluation fill:#f97316,stroke:#ea580c,color:#fff
  style qa fill:#a855f7,stroke:#9333ea,color:#fff
```
```

`agent_calls` 정보가 있으면 에이전트 간 협업 관계도 점선 화살표(`-.->`)로 표시.

---

## 모드 3: 대시보드 빌드 + 실행 (`/bams:viz start` 또는 `/bams:viz live`)

bams-viz Next.js 대시보드를 빌드하고 실행합니다.

### Step 1: bams-viz 디렉토리 찾기

소스 디렉토리를 우선 검색합니다 (캐시에는 구버전이 남아있을 수 있으므로).
핵심 검증: `src/app/` 디렉토리가 반드시 존재해야 합니다 (Next.js App Router 필수).

```bash
# 1순위: 현재 프로젝트 내 소스 (src/app 존재 검증)
_VIZ_DIR=$(find . -path "*/bams-plugin/tools/bams-viz/src/app/page.tsx" -not -path "*/node_modules/*" 2>/dev/null | head -1 | sed 's|/src/app/page.tsx||')
# 2순위: 플러그인 캐시 (src/app 존재 검증)
[ -z "$_VIZ_DIR" ] && _VIZ_DIR=$(find ~/.claude/plugins/cache -path "*/bams-plugin/*/tools/bams-viz/src/app/page.tsx" 2>/dev/null | head -1 | sed 's|/src/app/page.tsx||')
```

그래도 없으면: "bams-viz v2 (Next.js)를 찾을 수 없습니다. `src/app/` 디렉토리가 포함된 버전이 필요합니다." 후 종료.

### Step 2: 의존성 설치

```bash
cd "$_VIZ_DIR" && npm install 2>&1
```

### Step 2.5: bams-server 기동

bams-viz가 API 데이터를 올바르게 표시하려면 Control Plane 서버(port 3099)가 필요합니다.

```bash
if ! curl -sf http://localhost:3099/health > /dev/null 2>&1; then
  echo "[bams] Control Plane 서버 기동 중..."
  _SERVER_SCRIPT=$(find . -path "*/bams-plugin/server/src/app.ts" -not -path "*/node_modules/*" 2>/dev/null | head -1)
  [ -z "$_SERVER_SCRIPT" ] && _SERVER_SCRIPT=$(find ~/.claude/plugins/cache -path "*/bams-plugin/*/server/src/app.ts" 2>/dev/null | head -1)
  if [ -n "$_SERVER_SCRIPT" ]; then
    nohup bun run "$_SERVER_SCRIPT" > /tmp/bams-server.log 2>&1 &
    sleep 1
    if curl -sf http://localhost:3099/health > /dev/null 2>&1; then
      echo "[bams] Control Plane 서버 기동 완료 (http://localhost:3099)"
    else
      echo "[bams] WARNING: 서버 기동 실패 — 파일 fallback 모드로 진행"
    fi
  else
    echo "[bams] WARNING: server/src/app.ts를 찾을 수 없음 — 파일 fallback 모드로 진행"
  fi
else
  echo "[bams] Control Plane 서버 이미 실행 중 (http://localhost:3099)"
fi
```

### Step 3: 빌드 + 실행

```bash
cd "$_VIZ_DIR" && npx next build 2>&1 && npx next start --port 3333 &
```

빌드 실패 시 에러를 표시하고 종료합니다.

### Step 4: URL 안내

```
bams-viz 대시보드
══════════════════════════════════════
URL: http://localhost:3333
감시: .crew/artifacts/pipeline/ + .crew/artifacts/agents/

8개 뷰:
  DAG        — 에이전트 호출 관계 플로우차트
  Gantt      — 시간축 간트 차트
  Org        — 조직도
  Agents     — 에이전트 호출 목록/통계
  Timeline   — 고수준 이벤트 타임라인
  Logs       — NDJSON 로그 뷰어
  Traces     — Langfuse 스타일 트레이싱
  Metaverse  — 2D 에이전트 맵

종료: /bams:viz stop
```

---

## 모드 4: 서버 종료 (`/bams:viz stop`)

bams-viz 대시보드와 Control Plane 서버를 모두 종료합니다.

```bash
echo "=== bams 서버 종료 ==="

# 1. bams-viz (Next.js, port 3333)
if pkill -f "next.*3333" 2>/dev/null; then
  echo "✓ bams-viz (port 3333) 종료됨"
else
  echo "- bams-viz: 실행 중이 아님"
fi

# 2. Control Plane (bams-server, port 3099)
if pkill -f "bams.*app.ts" 2>/dev/null || pkill -f "bun.*3099" 2>/dev/null; then
  echo "✓ Control Plane (port 3099) 종료됨"
else
  echo "- Control Plane: 실행 중이 아님"
fi

# 3. 포트 점유 프로세스 잔여 확인 (위 pkill로 안 잡힌 경우)
for port in 3333 3099; do
  pid=$(lsof -ti :$port 2>/dev/null)
  if [ -n "$pid" ]; then
    kill $pid 2>/dev/null && echo "✓ port $port 잔여 프로세스($pid) 종료됨"
  fi
done

echo "=== 완료 ==="
```
