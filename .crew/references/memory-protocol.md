# 에이전트 메모리 로드/저장 프로토콜

> 참조: reference/paperclip/skills/para-memory-files/SKILL.md
> 작성일: 2026-04-03
> 버전: 1.0.0

---

## 1. 개요

bams-plugin의 모든 에이전트는 `.crew/memory/{agent-slug}/` 디렉터리에 PARA 방식으로
세션 간 학습과 컨텍스트를 영구 저장한다. 이 프로토콜은 메모리의 로드·저장·검색 절차를
표준화한다.

## 2. 디렉터리 구조

```
.crew/memory/{agent-slug}/
├── MEMORY.md              # Tacit knowledge — 패턴, 반복 실수, gotcha (세션 시작 시 필수 로드)
├── life/
│   ├── projects/          # 목표/기한이 있는 활성 파이프라인 작업
│   │   └── {slug}/
│   │       ├── summary.md # 빠른 컨텍스트 (먼저 로드)
│   │       └── items.yaml # 원자적 사실 목록 (필요 시 로드)
│   ├── areas/             # 지속적 책임 영역 (프로젝트별 컨벤션)
│   ├── resources/         # 참조 자료 (API 문서, 프로토콜)
│   └── archives/          # 완료/중단된 항목 (영구 보존)
└── memory/
    └── YYYY-MM-DD.md      # 일별 실행 raw 로그
```

## 3. 파이프라인 시작 시 메모리 로드 (pipeline-orchestrator 책임)

pipeline-orchestrator는 부서장 위임 메시지에 다음 지시를 포함해야 한다:

```
세션 시작 전 다음 순서로 메모리를 로드하라:
1. Read .crew/memory/{agent-slug}/MEMORY.md  (이전 학습, gotcha)
2. Read .crew/memory/{agent-slug}/life/projects/{현재-slug}/summary.md  (있는 경우)
3. 로드한 내용을 작업 수행 전 컨텍스트로 반영한다
```

### 3.1 위임 메시지 표준 섹션

```markdown
## 메모리 로드 지시
시작 전 `.crew/memory/{agent-slug}/MEMORY.md`를 Read하여 이전 학습 항목을 로드하라.
현재 파이프라인 `.crew/memory/{agent-slug}/life/projects/ref-analysis-paperclip/summary.md`도
존재하면 로드한다.
```

## 4. 파이프라인 종료 시 메모리 저장 (회고 단계)

pipeline-orchestrator가 회고 시 각 부서장에게 KPT 요청과 함께 메모리 저장을 지시한다.

### 4.1 저장 형식 (MEMORY.md 추가)

```markdown
## [YYYY-MM-DD] {pipeline-slug}
- 발견 사항: [이번 파이프라인에서 발견한 패턴 또는 문제]
- 적용 패턴: [성공적으로 적용한 접근 방식]
- 주의사항: [다음 실행 시 주의할 gotcha]
```

### 4.2 글로벌 gotcha 승격 기준

다음 조건 중 하나 이상 충족 시 pipeline-orchestrator가 `.crew/gotchas.md`로 승격:
- 동일 에이전트에서 2회 이상 발생한 실수
- 다른 에이전트에도 영향을 미치는 공통 패턴
- 프로젝트 전체에 적용되는 컨벤션

### 4.3 PARA 계층 저장 규칙

| 계층 | 저장 조건 | 아카이브 조건 |
|------|-----------|---------------|
| Projects | 목표/기한이 있는 진행 중 작업 | 완료 또는 중단 시 archives/ 이동 |
| Areas | 지속적 책임 (프로젝트별 컨벤션 등) | 해당 없음 (영구 유지) |
| Resources | 참조 자료 (API 문서, 프로토콜 등) | 오래된 버전은 archives/ 이동 |
| Archives | 비활성 항목 | 삭제 안 함 (영구 보존) |

## 5. 메모리 검색

### 5.1 qmd 환경 (권장)

```bash
qmd index .crew/memory/{agent-slug}
qmd query "검색 키워드"     # 시맨틱 검색
qmd search "정확한 구문"    # BM25 키워드 검색
```

### 5.2 Grep fallback (qmd 없는 환경)

```bash
# 특정 에이전트 메모리 전체 검색
grep -r "키워드" .crew/memory/{agent-slug}/

# 모든 에이전트 MEMORY.md 검색
grep -r "키워드" .crew/memory/*/MEMORY.md

# 특정 파이프라인 슬러그 관련 메모리 검색
grep -r "{slug}" .crew/memory/{agent-slug}/
```

## 6. 메모리 크기 관리

- 에이전트당 권장 메모리 크기: 10MB 이내
- `memory/YYYY-MM-DD.md` 파일이 30일 이상 된 경우: `life/archives/`로 이동
- `MEMORY.md`가 200줄 초과 시: 오래된 항목을 `life/archives/memory-archive.md`로 이동

## 7. 적용 대상 에이전트 (21개)

pipeline-orchestrator, cross-department-coordinator, executive-reporter,
resource-optimizer, product-strategy, business-analysis, ux-research,
project-governance, frontend-engineering, backend-engineering, platform-devops,
data-integration, product-analytics, experimentation, performance-evaluation,
business-kpi, qa-strategy, automation-qa, defect-triage, release-quality-gate,
hr-agent

---

> 이 프로토콜은 ref-analysis-paperclip 파이프라인 Phase 2에서 구현되었다.
> 참조: reference/paperclip/skills/para-memory-files/SKILL.md
