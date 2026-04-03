# Hotfix: bams:init Step 11 — CLAUDE.md 강제 규칙 세팅

## 슬러그
`hotfix_위임규칙CLAUDE.md강제세팅_완료`

## 문제 상황
- Claude가 커맨드 레벨에서 직접 코드를 수정하는 위임 원칙 위반 반복
- `bams:init` Step 11이 CLAUDE.md에 단순 커맨드 목록만 추가하고 강제 규칙을 포함하지 않음
- CLAUDE.md는 Claude가 모든 세션에서 최우선 읽는 파일 → 여기에 규칙이 없으면 위반이 반복됨

## 근본 원인
`plugins/bams-plugin/commands/bams/init.md` Step 11이 한 줄짜리 설명만 있었음:
> "CLAUDE.md가 있으면 Bams 플러그인 섹션을 추가. 없으면 기본 CLAUDE.md를 생성하고 Bams 커맨드 목록을 포함합니다."

강제 위임 원칙, 네이밍 규칙, 데이터 기록 규칙이 모두 누락됨.

## 수정 내용

### 1. `plugins/bams-plugin/commands/bams/init.md` Step 11 확장
- 기존: 한 줄 설명
- 변경: 구체적인 CLAUDE.md 삽입 내용 명시
  - `## ★ Bams 조직 운영 규칙 (최우선)` 섹션 전체 포함
  - 위임 원칙 (커맨드 레벨 직접 수정 금지)
  - 파이프라인 네이밍 규칙
  - 데이터 기록 규칙
  - Bams 커맨드 목록
  - 이미 섹션이 있으면 교체, 없으면 최상단 삽입 로직 포함

### 2. 현재 프로젝트 CLAUDE.md 즉시 적용
- 파일 최상단(첫 번째 `#` 제목 바로 다음)에 `## ★ Bams 조직 운영 규칙 (최우선)` 삽입
- 기존 gstack 개발 규칙 내용 완전 보존

## 수정 파일
- `plugins/bams-plugin/commands/bams/init.md` (Step 11)
- `CLAUDE.md` (★ Bams 조직 운영 규칙 섹션 추가)

## 완료 시각
2026-04-03

## 검증
- init.md Step 11: `## Step 11: CLAUDE.md 업데이트` 이후 구체적 규칙 내용 포함 확인
- CLAUDE.md: 문자 위치 22 (파일 최상단 직후)에 `## ★ Bams 조직 운영 규칙 (최우선)` 삽입 확인
