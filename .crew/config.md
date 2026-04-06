# 프로젝트 설정

> Last updated: 2026-04-06

## 프로젝트 개요

| 항목 | 값 |
|------|-----|
| 이름 | gstack (Garry's Stack) |
| 버전 | v0.11.17.0 |
| 설명 | Claude Code skills + fast headless browser. AI 엔지니어링 워크플로우 플랫폼 |
| 런타임 | Bun >= 1.0.0 |
| 언어 | TypeScript, Python, Markdown, JSON |
| 라이선스 | MIT |

## 아키텍처

### 컴포넌트

| 컴포넌트 | 경로 | 런타임 | 포트 |
|----------|------|--------|------|
| gstack core | `/` | Bun | - |
| bams-plugin | `plugins/bams-plugin/` | Bun | - |
| bams-viz | `plugins/bams-plugin/tools/bams-viz/` | Next.js 15 | 3333 |
| bams-server | `plugins/bams-plugin/server/` | Bun HTTP | 3099 |
| bams-db | `plugins/bams-plugin/tools/bams-db/` | bun:sqlite | - |
| browse | `browse/` | Playwright + Bun | 3000 |

### DB 스키마 (v2 — FK 기반)

```
work_units → pipelines (work_unit_id FK) → tasks (pipeline_id FK)
                                          → task_events (task_id FK)
                                          → run_logs (pipeline_id FK)
hr_reports (독립)
```

DB 경로: `~/.claude/plugins/marketplaces/my-claude/bams.db`

### 에이전트 조직 (6부서 27에이전트)

위임 체계: `사용자 커맨드 → pipeline-orchestrator → 부서장 → 에이전트`

- 기획부: product-strategy, business-analysis, ux-research, project-governance
- 개발부: frontend-engineering, backend-engineering, platform-devops, data-integration
- 디자인부: design-director, ui-designer, ux-designer, graphic-designer, motion-designer, design-system-agent
- QA부: qa-strategy, automation-qa, defect-triage, release-quality-gate
- 평가부: product-analytics, experimentation, performance-evaluation, business-kpi
- 경영지원: executive-reporter, cross-department-coordinator, resource-optimizer, hr-agent

### 핵심 데이터 흐름

```
[사용자 /bams:* 커맨드]
       │
       ▼
[pipeline-orchestrator]  ──emit──▶  [NDJSON 이벤트 파일]
       │                                    │
       ▼                                    ▼
[부서장 에이전트]           [Control Plane API :3099]
       │                         │          │
       ▼                         │          ▼
[실행 에이전트]                  │   [SSE Broker]
       │                         ▼          │
       ▼                  [bams.db SQLite]   ▼
[코드 수정/산출물]                    [bams-viz :3333]
```

### 이벤트 타입

`pipeline_start`, `pipeline_end`, `step_start`, `step_end`, `agent_start`, `agent_end`, `error`

### 데이터 경로

- 이벤트 파일: `~/.bams/artifacts/pipeline/{slug}-events.jsonl`
- Work Unit 이벤트: `~/.bams/artifacts/pipeline/{slug}-workunit.jsonl`
- 에이전트 로그: `~/.bams/artifacts/agents/YYYY-MM-DD.jsonl`
- HR 보고서: `~/.bams/artifacts/hr/`
- 아티팩트: `.crew/artifacts/` (PRD, 설계 문서, 리뷰, 회고)

## 컨벤션

### TypeScript
- ESM (`"type": "module"`)
- `bun build --compile`로 단일 바이너리 생성
- DB: bun:sqlite 네이티브 (ORM 없음, raw SQL)
- 서버: `Bun.serve()` — Express/Fastify 없음
- `SKILL.md`는 `.tmpl` 템플릿에서 자동 생성 — 직접 편집 금지

### Git
- 커밋: 단일 논리적 변경 단위로 bisect
- `browse/dist/` 바이너리 커밋 금지
- `git add .` 사용 금지 — 파일명 개별 명시
- 파이프라인 슬러그: `{command}_{한글요약}` (immutable)

### 테스트
- 3-tier: 무료(`bun test`) / LLM eval / E2E (`claude -p`)
- Diff 기반 선택: `touchfiles.ts` 의존성 선언
- Gate/Periodic 분류: CI는 gate만, periodic은 주간 cron

## 배포 상태

- CI/CD: 미설정 (GitHub Actions 워크플로우 부재)
- 배포 방식: 로컬 수동 (`./setup`)
- 컨테이너화: 미구성

## 외부 서비스

- Anthropic Claude API (에이전트 실행, 테스트 전용)
- Playwright/Chromium (브라우저 자동화)
- OpenAI Codex CLI (세컨드 오피니언)
- GitHub CLI (PR/이슈 관리)
- SQLite (Bun 네이티브, 로컬 영구 저장)
- SEC EDGAR / GCS (금융 데이터)

## 주요 커맨드

```bash
bun install          # 의존성 설치
bun test             # 무료 테스트 (<2s)
bun run test:evals   # 유료 eval (diff 기반, ~$4/run)
bun run build        # SKILL.md 생성 + 바이너리 컴파일
bun run gen:skill-docs  # SKILL.md 재생성
bun run dev <cmd>    # CLI dev 모드
```
