# MEMORY.md — defect-triage

> 역할: 
> 생성: 2026-04-03
> 형식: PARA (Projects / Areas / Resources / Archives)

---

## 메모리 프로토콜

### 세션 시작 시
1. 이 파일(`MEMORY.md`)을 Read하여 이전 학습 항목과 gotcha를 컨텍스트에 로드한다
2. 현재 파이프라인 슬러그가 있으면 `.crew/memory/defect-triage/life/projects/{slug}/summary.md`도 로드한다
3. qmd가 설치된 환경이면 `qmd query "관련 키워드"`로 연관 메모리 검색

### 세션 종료 시 (파이프라인 회고)
1. 이번 파이프라인에서 발견한 새로운 패턴/gotcha를 아래 "학습 항목" 섹션에 날짜와 함께 추가한다
2. 내구성 있는 사실은 PARA 구조(`life/`)에 기록한다
3. 오늘의 주요 작업은 `memory/YYYY-MM-DD.md`에 기록한다
4. 글로벌 gotcha는 pipeline-orchestrator 판단으로 `.crew/gotchas.md`로 승격된다

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
| `life/projects/` | 목표/기한이 있는 활성 프로젝트 작업 기록 |
| `life/areas/` | 지속적 책임 영역 (프로젝트별 컨벤션, 패턴 등) |
| `life/resources/` | 참조 자료 (API 문서, 프로토콜, 설계 패턴 등) |
| `life/archives/` | 완료/중단된 항목 (영구 보존) |
| `memory/YYYY-MM-DD.md` | 일별 실행 raw 로그 |

