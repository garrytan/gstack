# Agent Tool Access Policy

## 원칙

에이전트는 역할에 따라 Write/Edit 도구 접근 권한이 구분된다.

### 구현 에이전트 (Write/Edit 가능)

코드나 파일을 직접 생성·수정하는 실행 역할:

- **engineering 부서**: frontend-engineering, backend-engineering, platform-devops, data-integration
- **qa 부서 (실행)**: automation-qa
- **design 부서 전체**: design-director, ui-designer, ux-designer, graphic-designer, motion-designer, design-system-agent
- **hr-agent**

### 분석/전략 에이전트 (Write/Edit 금지)

분석·판단·전략 수립을 담당하며 파일을 직접 수정하지 않는 역할:

- **planning 부서**: product-strategy, business-analysis, ux-research, project-governance
- **evaluation 부서**: product-analytics, experimentation, performance-evaluation, business-kpi
- **qa 부서 (전략)**: qa-strategy, defect-triage, release-quality-gate
- **executive 부서**: pipeline-orchestrator, cross-department-coordinator, executive-reporter, resource-optimizer

## 산출물 저장 규칙

### 분석/전략 에이전트의 산출물 저장 흐름

```
분석/전략 에이전트
  └─ 산출물을 Agent tool output으로 반환
        └─ 호출자(pipeline-orchestrator 또는 부서장)가
           Write 도구로 .crew/artifacts/에 저장
```

- 분석/전략 에이전트는 산출물을 직접 파일로 쓰지 않는다.
- 호출자가 반환된 output을 받아 `.crew/artifacts/{slug}/{phase}/` 경로에 저장한다.
- 산출물 경로는 호출자가 결정하고, 다음 위임 시 `input_artifacts`로 전달한다.

### 구현 에이전트의 산출물 저장 흐름

```
구현 에이전트
  └─ 프로젝트 코드 파일을 Write/Edit로 직접 생성·수정
  └─ 구현 요약을 Agent tool output으로 반환
        └─ 호출자가 요약을 .crew/artifacts/에 기록
```

## 예외

| 에이전트 | 예외 사항 |
|----------|----------|
| pipeline-orchestrator | Write/Edit 금지. tracking 파일 갱신은 Bash(`echo`, `tee`, `jq`)로만 수행 |
| executive-reporter | Write/Edit 금지. 보고서는 output으로 반환하고, 호출자가 저장 |
| automation-qa | Write/Edit 허용 — 테스트 코드 작성이 핵심 역할 |

## frontmatter 선언 방법

에이전트 .md의 frontmatter에 `disallowedTools`로 선언한다:

```yaml
# 분석/전략 에이전트 (Write/Edit 금지)
disallowedTools: Write, Edit

# 구현 전담 에이전트 (의도적 전체 허용)
disallowedTools: []
```

> `disallowedTools: []`는 "선언 누락"이 아니라 **"의도적으로 모든 도구를 허용한다"**는 감사 신호다. 아래 "구현 전담 에이전트 (disallowedTools: [])" 목록과 반드시 일치해야 한다.

## 구현 전담 에이전트 (`disallowedTools: []`)

아래 에이전트는 역할상 Write/Edit/Bash 등 모든 도구가 필수이며, frontmatter에 `disallowedTools: []`로 **명시적 전체 허용**을 선언한다. 신규 등록/삭제 시 본 목록을 동기 갱신해야 한다.

- **frontend-engineering**: React/TSX/CSS 구현을 위한 Write/Edit 필수
- **backend-engineering**: API 라우트/서버 코드/Prisma 스키마 구현을 위한 Write/Edit 필수
- **platform-devops**: Dockerfile/CI 워크플로우/인프라 스크립트 작성을 위한 Write/Edit 필수
- **data-integration**: SQL 마이그레이션/ETL 스크립트 작성을 위한 Write/Edit 필수
- **automation-qa**: 테스트 코드(Playwright/Vitest) 작성이 핵심 역할
- **design-director**: 디자인 시스템 토큰/가이드 문서 직접 편집 권한 필요
- **ui-designer**: 컴포넌트 마크업/스타일 자산 직접 생성
- **ux-designer**: 플로우/와이어프레임 산출물 파일 직접 생성
- **graphic-designer**: 이미지/아이콘 자산 및 메타데이터 파일 직접 생성
- **motion-designer**: 애니메이션 스펙/Lottie 자산 파일 직접 생성
- **design-system-agent**: 토큰 JSON/테마 파일 직접 편집
- **hr-agent**: 에이전트 md/jojikdo.json/plugin.json 등 조직 메타데이터 직접 편집

## 온보딩 체크리스트 (신규 에이전트 등록)

- [ ] 역할이 **구현 전담**인가?
  - 예 → 이 문서 "구현 전담 에이전트" 목록에 사유 1줄과 함께 등록하고, frontmatter에 `disallowedTools: []` 선언
- [ ] 역할이 **분석/전략/조율 전담**인가?
  - 예 → frontmatter에 `disallowedTools: Write, Edit` 선언 (산출물은 호출자가 저장)
- [ ] `pipeline-orchestrator` / `executive-reporter` 류의 **예외 사례**에 해당하는가?
  - 예 → "예외" 섹션에 사유와 함께 추가
- [ ] 본 문서의 구현/분석 에이전트 목록 및 조직도(`jojikdo.json`)와 일치하는지 재확인

