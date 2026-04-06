---
description: 프로젝트 초기화 — .crew/ 워크스페이스 + 배포 환경 셋업
argument-hint: [프로젝트 설명]
---

# Bams Init

Bams 오케스트레이터로서 프로젝트의 `.crew/` 워크스페이스를 초기화하고 배포 환경을 점검합니다.

## Step 0: 코드 최신화

Bash로 `git rev-parse --is-inside-work-tree 2>/dev/null`를 실행하여 git 저장소인지 확인합니다.

**git 저장소인 경우**: Bash로 `git branch --show-current`를 실행하여 현재 브랜치를 확인한 뒤, `git pull origin {현재 브랜치}`를 실행하여 원격 저장소의 최신 코드를 가져옵니다. 충돌이 발생하면 사용자에게 알리고 중단합니다.

**git 저장소가 아닌 경우**: 이 단계를 스킵합니다.

## Step 1: 기존 상태 확인

Glob 도구로 `.crew/` 디렉토리가 이미 존재하는지 확인합니다.

**`.crew/`가 존재하지 않으면** -> Step 2로 진행 (신규 초기화).

**`.crew/`가 이미 존재하면** -> **AskUserQuestion**으로 선택을 요청:

Question: "이미 워크스페이스가 존재합니다. 어떻게 할까요?"
Header: "Init Mode"
Options:
- **유지** - "기존 상태를 그대로 유지하고 종료"
- **부분 재초기화** - "코드베이스 재스캔, config/컨벤션 업데이트 (board, history, artifacts 보존)"
- **전체 재초기화** - "모든 상태를 초기화 (board, history 포함)"

**유지** 선택 시: 여기서 중단.
**부분 재초기화** 선택 시: Step 2~4 실행 후 Step 5(디렉토리 생성) 스킵, Step 5.5(DB 초기화, idempotent) 실행, Step 6(분석)~Step 8(config) 실행, board/history 보존.
**전체 재초기화** 선택 시: 모든 Step을 처음부터 실행.

## Step 2: 언어 선택

**AskUserQuestion** 도구를 사용하여 프로그래밍 언어를 물어봅니다. **multiSelect** 질문입니다.

Question: "이 프로젝트에서 사용할 프로그래밍 언어를 선택하세요."
Header: "Languages"
Options (multiSelect: true):
- **TypeScript** - "TypeScript / JavaScript (ts, tsx, js, jsx)"
- **Python** - "Python (py, pyi)"
- **Go** - "Go (go)"
- **Rust** - "Rust (rs)"
- **Java** - "Java (java)"
- **Kotlin** - "Kotlin (kt, kts)"
- **Swift** - "Swift (swift)"

## Step 3: 프로젝트 컨텍스트 수집

사용자의 프로젝트 설명: $ARGUMENTS

기존 코드베이스를 분석하여 컨텍스트를 감지합니다:
1. `CLAUDE.md`가 있으면 읽어서 프로젝트 지침 확인
2. Glob으로 `package.json`, `go.mod`, `requirements.txt`, `pyproject.toml`, `Cargo.toml` 등 확인
3. 발견된 설정 파일을 읽어 프로젝트명과 프레임워크 추출
4. 기존 테스트 디렉토리 확인 (`**/*test*/**`, `**/*spec*/**`)

## Step 4: Git 저장소 확인

Bash로 `git rev-parse --git-dir 2>/dev/null` 실행.

**git 저장소가 아닌 경우:**
1. Bash로 `git init` 실행
2. `.gitignore`가 없으면 언어 기반으로 생성

**git 저장소인 경우** -> 다음 Step으로 진행.

## Step 5: 디렉토리 구조 생성

Bash `mkdir -p`로 다음 디렉토리를 생성합니다:

```
.crew/
.crew/sprints/
.crew/artifacts/prd/
.crew/artifacts/design/
.crew/artifacts/review/
.crew/artifacts/test/
.crew/artifacts/pipeline/
.crew/artifacts/agents/
.crew/artifacts/hr/
.crew/db/
```


## Step 5.2: 에이전트 Memory 디렉토리 자동 생성

`plugins/bams-plugin/agents/` 디렉토리의 `.md` 파일 목록을 기반으로 `.crew/memory/` 하위에 각 에이전트의 PARA 메모리 디렉토리를 생성합니다.

```bash
# bams-plugin agents 디렉토리 탐색 (소스 → 캐시 순)
_AGENTS_DIR=$(find . -path "*/bams-plugin/agents" -not -path "*/node_modules/*" 2>/dev/null | head -1)
[ -z "$_AGENTS_DIR" ] && _AGENTS_DIR=$(find ~/.claude/plugins/cache -path "*/bams-plugin/*/agents" 2>/dev/null | head -1)

if [ -n "$_AGENTS_DIR" ]; then
  for _MD in "$_AGENTS_DIR"/*.md; do
    _SLUG=$(basename "$_MD" .md)
    _MEM_BASE=".crew/memory/$_SLUG"

    # 이미 존재하면 스킵
    if [ -d "$_MEM_BASE" ]; then
      echo "[memory] $_SLUG: 이미 존재 — 스킵"
      continue
    fi

    mkdir -p "$_MEM_BASE/life/projects"
    mkdir -p "$_MEM_BASE/life/areas"
    mkdir -p "$_MEM_BASE/life/archives"
    mkdir -p "$_MEM_BASE/life/resources"
    mkdir -p "$_MEM_BASE/memory"

    cat > "$_MEM_BASE/MEMORY.md" << MEMEOF
# MEMORY.md — $_SLUG

> 역할: 
> 생성: $(date +%Y-%m-%d)
> 형식: PARA (Projects / Areas / Resources / Archives)

---

## 메모리 프로토콜

### 세션 시작 시
1. 이 파일(\`MEMORY.md\`)을 Read하여 이전 학습 항목과 gotcha를 컨텍스트에 로드한다
2. 현재 파이프라인 슬러그가 있으면 \`.crew/memory/$_SLUG/life/projects/{slug}/summary.md\`도 로드한다
3. qmd가 설치된 환경이면 \`qmd query "관련 키워드"\`로 연관 메모리 검색

### 세션 종료 시 (파이프라인 회고)
1. 이번 파이프라인에서 발견한 새로운 패턴/gotcha를 아래 "학습 항목" 섹션에 날짜와 함께 추가한다
2. 내구성 있는 사실은 PARA 구조(\`life/\`)에 기록한다
3. 오늘의 주요 작업은 \`memory/YYYY-MM-DD.md\`에 기록한다
4. 글로벌 gotcha는 pipeline-orchestrator 판단으로 \`.crew/gotchas.md\`로 승격된다

---

## 학습 항목 (Tacit Knowledge)

<!-- 형식:
## [YYYY-MM-DD] {pipeline-slug}
- 발견 사항: [설명]
- 적용 패턴: [설명]
- 주의사항: [설명]
-->

_아직 학습 항목 없음. 첫 파이프라인 실행 후 채워진다._

---

## PARA 구조 안내

| 경로 | 용도 |
|------|------|
| \`life/projects/\` | 목표/기한이 있는 활성 프로젝트 작업 기록 |
| \`life/areas/\` | 지속적 책임 영역 (프로젝트별 컨벤션, 패턴 등) |
| \`life/resources/\` | 참조 자료 (API 문서, 프로토콜, 설계 패턴 등) |
| \`life/archives/\` | 완료/중단된 항목 (영구 보존) |
| \`memory/YYYY-MM-DD.md\` | 일별 실행 raw 로그 |
MEMEOF

    echo "[memory] $_SLUG: 생성 완료"
  done
else
  echo "[memory] agents 디렉토리를 찾을 수 없습니다 — 스킵"
fi
```

이 단계는 idempotent합니다. 이미 존재하는 디렉토리는 스킵하므로, `부분 재초기화` 시에도 안전하게 실행됩니다. 새 에이전트가 추가될 때마다 재실행하면 누락된 디렉토리만 생성합니다.

## Step 5.5: TaskDB 초기화 (SQLite)

`~/.claude/plugins/marketplaces/my-claude/bams.db`를 생성하여 DB 기반 태스크 관리를 활성화합니다.

```bash
# bams-db init-db.ts 경로 탐색 (소스 → 캐시 순)
_INIT_DB=$(find . -path "*/bams-plugin/tools/bams-db/init-db.ts" -not -path "*/node_modules/*" 2>/dev/null | head -1)
[ -z "$_INIT_DB" ] && _INIT_DB=$(find ~/.claude/plugins/cache -path "*/bams-plugin/*/tools/bams-db/init-db.ts" 2>/dev/null | head -1)

if [ -n "$_INIT_DB" ]; then
  bun run "$_INIT_DB" --migrate 2>&1
else
  echo "[bams-db] init-db.ts를 찾을 수 없습니다 — DB 초기화 스킵"
fi
```

이 단계는:
1. `~/.claude/plugins/marketplaces/my-claude/bams.db` SQLite 파일을 생성합니다
2. 스키마를 적용합니다 (tasks, task_events, token_usage, budget_policies, run_logs)
3. 기존 `board.md`가 있으면 태스크를 DB로 마이그레이션합니다
4. DB가 이미 존재하면 스키마만 idempotent하게 재확인합니다

DB가 활성화되면 이후 파이프라인 커맨드(`/bams:dev`, `/bams:feature` 등)에서 자동으로 DB 모드로 전환됩니다.

## Step 5.7: Claude Code 권한 설정

파이프라인 실행 시 불필요한 컨펌창을 제거하기 위해, 프로젝트 루트 하위 작업에 대한 자동 승인 규칙을 `.claude/settings.json`에 설정합니다.

**처리 순서:**

1. `.claude/settings.json`이 존재하는지 확인합니다.
2. 존재하면 Read하여 기존 내용을 파악합니다.
3. `permissions.allow` 배열에 아래 와일드카드 규칙이 **이미 포함되어 있으면 스킵**, 없으면 추가합니다.
4. `permissions.additionalDirectories`에 `~/.bams/artifacts/*` 경로들이 없으면 추가합니다.

**추가할 와일드카드 권한 규칙:**

```json
{
  "permissions": {
    "allow": [
      "Bash(ls *)",
      "Bash(cat *)",
      "Bash(grep *)",
      "Bash(find *)",
      "Bash(git *)",
      "Bash(bun *)",
      "Bash(npm *)",
      "Bash(pnpm *)",
      "Bash(yarn *)",
      "Bash(node *)",
      "Bash(python *)",
      "Bash(sqlite3 *)",
      "Bash(mkdir *)",
      "Bash(cp *)",
      "Bash(mv *)",
      "Bash(rm -f .crew/*)",
      "Bash(rm -f /tmp/bams-*)",
      "Bash(wc *)",
      "Bash(head *)",
      "Bash(tail *)",
      "Bash(echo *)",
      "Bash(bash *)",
      "Bash(sh *)",
      "Bash(sed *)",
      "Bash(awk *)",
      "Bash(sort *)",
      "Bash(uniq *)",
      "Bash(xargs *)",
      "Bash(chmod *)",
      "Bash(touch *)",
      "Bash(date *)",
      "Bash(gh *)",
      "Read(*)",
      "Edit(*)",
      "Write(*)"
    ],
    "additionalDirectories": [
      "~/.bams/artifacts/pipeline",
      "~/.bams/artifacts/hr",
      "~/.bams/artifacts/agents",
      "/tmp"
    ]
  }
}
```

**중요:**
- 기존 `permissions.allow`에 이미 있는 항목은 중복 추가하지 않습니다.
- 기존에 개별 명령어로 허용된 규칙(예: `Bash(git status)`)은 와일드카드 규칙(예: `Bash(git *)`)으로 대체됩니다. 와일드카드가 추가되면 해당 도구의 개별 규칙은 제거하여 설정을 깔끔하게 유지합니다.
- 기존 `additionalDirectories`는 보존하고, 누락된 경로만 추가합니다.
- `~` 경로는 실행 시점에 `$HOME`으로 확장하여 절대 경로로 저장합니다.

이 단계는 idempotent합니다. 이미 와일드카드 규칙이 설정되어 있으면 아무 변경도 하지 않습니다.

## Step 6-7: 코드베이스 분석 + 배포 환경 점검 (병렬 실행)

**코드가 존재하는 경우에만 실행.** 소스 파일이 없으면 Step 6 스킵.

**두 에이전트를 동시에 실행합니다:**

**Step 6 — product-strategy 에이전트 (opus):**
서브에이전트 실행 (Task tool, subagent_type: **"bams-plugin:product-strategy"**, model: **"opus"**):

> **프로젝트 초기 분석 모드**로 이 프로젝트의 전체 구조를 분석합니다.
>
> 수행 작업:
> 1. Glob으로 전체 디렉토리 구조 매핑 (node_modules, .git, vendor, dist 제외)
> 2. 엔트리포인트 식별 (main, index, app 파일)
> 3. 주요 파일(최대 20개) 읽어서 모듈, 패키지, 상호 관계 매핑
> 4. 외부 서비스 연동 식별 (DB, API, 메시지 큐)
> 5. 코딩 컨벤션, 테스트 패턴, CI/CD 설정 감지
>
> 반환: 아키텍처 요약, 모듈 맵, 컨벤션 목록, 권장사항

**Step 7 — platform-devops 에이전트 (sonnet):**
서브에이전트 실행 (Task tool, subagent_type: **"bams-plugin:platform-devops"**, model: **"sonnet"**):

> **배포 환경 점검 모드**로 현재 프로젝트의 인프라/배포 상태를 확인합니다.
>
> 수행 작업:
> 1. Dockerfile, docker-compose.yml 존재 여부 확인
> 2. CI/CD 설정 확인 (.github/workflows/, Jenkinsfile, .gitlab-ci.yml)
> 3. 환경 설정 파일 확인 (.env.example, config/)
> 4. 빌드 스크립트 확인 (Makefile, package.json scripts)
>
> 반환: 배포 준비 상태 요약, 누락 항목, 권장사항

**두 결과를 모두 수집한 후** 다음 단계로 진행합니다.
결과를 `.crew/artifacts/review/init-review.md`에 저장합니다.

## Step 8: config.md 생성

`.crew/config.md` 작성 (Step 6, 7 결과를 기반으로 프로젝트 개요, 아키텍처 요약, 컨벤션, 배포 상태 포함).

## Step 9: board.md 생성

`.crew/board.md` 작성:

```markdown
# 태스크 보드

> Last updated: [현재 ISO timestamp]

## Backlog

## In Progress

## In Review

## Done
```

## Step 10: gotchas.md 생성

`.crew/gotchas.md` 없으면 생성:

```markdown
# Gotchas

> 프로젝트 실행 중 발견한 주의사항을 기록합니다.
```

## Step 11: CLAUDE.md 업데이트

CLAUDE.md에 Bams 조직 운영 규칙을 추가합니다. 이 규칙은 Claude가 모든 `/bams:*` 커맨드에서 최우선으로 읽는 지침입니다.

**처리 순서:**

1. CLAUDE.md가 존재하는지 Glob으로 확인합니다.
2. **존재하는 경우**: 기존 내용을 Read한 후, `## ★ Bams 조직 운영 규칙 (최우선)` 섹션이 이미 있으면 최신 내용으로 교체합니다. 없으면 파일 최상단(첫 번째 `#` 제목 바로 다음 줄)에 삽입합니다. 기존 내용은 반드시 보존합니다.
3. **존재하지 않는 경우**: 아래 내용으로 새로 생성합니다.

**CLAUDE.md에 추가/교체할 섹션 내용:**

````markdown
## ★ Bams 조직 운영 규칙 (최우선)

> 이 규칙은 모든 /bams:* 커맨드에서 최우선으로 적용됩니다.
> 위반 시 즉시 중단하고 올바른 위임 경로로 전환하세요.

### 1. 위임 원칙 — 커맨드 레벨 직접 수정 절대 금지

**모든 코드 수정은 반드시 `pipeline-orchestrator → 부서장 → 에이전트` 위임 체계를 통해 수행합니다.**

- 허용: Bash/Glob으로 상태 확인, viz 이벤트 emit, 사용자에게 질문
- 금지: Edit/Write로 소스 코드 직접 변경, 에이전트 역할 대신 수행
- 위반 감지 시: 즉시 작업을 중단하고 pipeline-orchestrator에게 해당 작업을 위임

위임 구조:
```
사용자 커맨드 → pipeline-orchestrator → 부서장 → 에이전트
```

각 에이전트는 자신의 전문 분야에서만 작업합니다:
- 기획: product-strategy, business-analysis, ux-research, project-governance
- 개발: frontend-engineering, backend-engineering, platform-devops, data-integration
- 디자인: design-director, ui-designer, ux-designer, graphic-designer, motion-designer, design-system-agent
- QA: qa-strategy, automation-qa, defect-triage, release-quality-gate
- 평가: product-analytics, experimentation, performance-evaluation, business-kpi
- 경영지원: executive-reporter, cross-department-coordinator, resource-optimizer, hr-agent

### 2. 파이프라인 네이밍 규칙

모든 파이프라인 slug는 다음 형식을 따릅니다:
```
{command}_{한글요약}
```
- command: feature, hotfix, dev, debug
- 한글요약: 공백 없이 작업 내용 요약

예: `feature_결제플로우구현`, `hotfix_빌드에러수정`

**slug는 파이프라인 수명 동안 불변(immutable)입니다.** 상태는 slug에 포함하지 않으며,
이벤트 파일 내 `pipeline_start` / `pipeline_end` 이벤트로 자동 판별합니다.
- `pipeline_end` 없음 → 진행 중
- `pipeline_end` 있음 → 완료 (status 필드 기준)

이 규칙은 이벤트 파일, PRD, 설계문서, 리뷰, board.md 태스크 ID에 모두 적용됩니다.
상세: `.crew/references/pipeline-naming-convention.md` 참조

### 3. 데이터 기록 규칙

- 파이프라인 시작/종료 시 반드시 viz 이벤트를 emit합니다
- 모든 아티팩트는 `.crew/artifacts/` 하위에 네이밍 규칙에 따라 저장합니다
- board.md 업데이트는 project-governance 에이전트를 통해 수행합니다

### 5. 에이전트 필수 활용 원칙

**Claude Code로 코드를 수정하는 모든 작업은 Bams 조직의 에이전트를 통해 수행합니다.**

- 코드 수정이 필요한 요청 → pipeline-orchestrator에게 위임
- orchestrator가 판단: 파이프라인 필요 여부 결정
  - 복잡한 작업 → `/bams:dev`, `/bams:feature` 등 파이프라인으로 처리
  - 단순 작업 → 해당 부서 에이전트에게 직접 위임
- 읽기 전용 작업(질문, 상태 확인 등)은 직접 응답 가능

### 6. Reference 참조 규칙

에이전트는 작업 시작 시 다음을 참조합니다:
- `.crew/config.md` — 프로젝트 설정, 아키텍처, 컨벤션
- `.crew/gotchas.md` — 프로젝트 주의사항
- `.crew/board.md` — 현재 태스크 상태
- 각 에이전트의 `.crew/memory/{agent-slug}/MEMORY.md` — 학습된 지식

### 7. 에이전트 동작 완료 규칙

모든 에이전트는 작업 완료 시:
1. 변경 사항 요약을 반환합니다
2. viz 이벤트(agent_end)를 emit합니다
3. 에러 발생 시 status="error"로 보고하고, 근본 원인과 영향 범위를 포함합니다
4. 파이프라인의 마지막 에이전트는 pipeline_end를 emit합니다

### 4. Bams 커맨드 목록

| 커맨드 | 설명 |
|--------|------|
| `/bams:init` | 프로젝트 초기화 |
| `/bams:plan` | PRD + 기술 설계 + 태스크 분해 |
| `/bams:feature` | 풀 피처 개발 사이클 |
| `/bams:dev` | 멀티에이전트 풀 개발 파이프라인 |
| `/bams:hotfix` | 버그 핫픽스 빠른 경로 |
| `/bams:debug` | 버그 분류 → 수정 → 회귀 테스트 |
| `/bams:review` | 5관점 병렬 코드 리뷰 |
| `/bams:ship` | PR 생성 + 머지 |
| `/bams:status` | 프로젝트 대시보드 현황 |
| `/bams:sprint` | 스프린트 플래닝 및 관리 |
| `/bams:viz` | 파이프라인 실행 시각화 |
````

## Step 12: 결과 보고

```
프로젝트 초기화 완료
════════════════════
프로젝트: [이름]
언어: [선택한 언어]
Git: [초기화/기존]
배포 환경: [준비됨/미설정]
코드베이스 분석: [완료/스킵]
TaskDB: [활성화됨 (~/.claude/plugins/marketplaces/my-claude/bams.db) / 스킵]
Memory: [에이전트 {N}개 디렉토리 생성 / 이미 존재]
권한 설정: [와일드카드 규칙 적용됨 / 이미 설정됨]

다음: /bams:plan <feature> | /bams:status | /bams:sprint plan
```
