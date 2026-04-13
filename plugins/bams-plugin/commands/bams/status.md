---
description: 프로젝트 대시보드 및 태스크 보드 현황
---

# Bams Status

Bams 오케스트레이터로서 종합 프로젝트 현황 대시보드를 표시합니다.

## 사전 조건

Glob으로 `.crew/config.md`가 존재하는지 확인합니다. 없으면:
- 출력: "프로젝트가 초기화되지 않았습니다. `/bams:init`을 실행하여 설정하세요."
- 여기서 중단.

## 상태 수집 (2개 배치 병렬)

**배치 A** — 다음 4개 파일을 **동시에** 읽습니다 (존재하지 않는 것은 스킵):
1. `.crew/config.md` - 프로젝트 컨텍스트
2. `.crew/board.md` - 현재 태스크 보드
3. `.crew/history.md` - 완료된 작업
4. `.crew/gotchas.md` - 주의사항

**배치 B** — 다음 5개 Glob을 **동시에** 실행합니다:
5. `.crew/sprints/sprint-*.md` - 가장 최근 스프린트 파일 찾기. 활성 스프린트는 `completed: null`.
6. `.crew/artifacts/prd/*.md` - PRD 파일 수 집계
7. `.crew/artifacts/design/*.md` - 설계 파일 수 집계
8. `.crew/artifacts/review/*.md` - 리뷰 파일 수 집계
9. `.crew/artifacts/test/*.md` - 테스트 파일 수 집계

배치 A와 B는 **독립적이므로 동시에** 실행 가능합니다.

## 상태 분석 (executive-reporter + project-governance 병렬)

**2개 서브에이전트를 동시에 실행합니다:**

### A. executive-reporter 에이전트 (opus):

서브에이전트 실행 (Task tool, subagent_type: **"bams-plugin:executive-reporter"**, model: **"opus"**):

> **상태 집계 모드**로 프로젝트 현황을 대시보드로 요약합니다.
>
> **board.md**: [board.md 내용 삽입]
> **config.md**: [config.md 내용 삽입]
> **활성 스프린트**: [스프린트 파일 내용 삽입 — 있으면]
> **파이프라인 이벤트**: [최신 pipeline events — 있으면]
>
> 집계:
> 1. 태스크 보드 수치 요약 (Backlog/In Progress/In Review/Done)
> 2. 스프린트 진행률 및 번다운 분석
> 3. 최근 파이프라인 실행 현황
> 4. 에이전트 활동 요약

### B. project-governance 에이전트 (opus):

서브에이전트 실행 (Task tool, subagent_type: **"bams-plugin:project-governance"**, model: **"opus"**):

> **상태 분석 모드**로 프로젝트 리스크와 다음 액션을 분석합니다.
>
> **board.md**: [board.md 내용 삽입]
> **config.md**: [config.md 내용 삽입]
> **활성 스프린트**: [스프린트 파일 내용 삽입 — 있으면]
>
> 분석:
> 1. 태스크 진행 상황 (병목, 블로킹 태스크 식별)
> 2. 스프린트 건강도 (목표 대비 진행률)
> 3. 위험 요소 (지연, 의존성 문제)
> 4. 다음 추천 액션

두 에이전트 결과를 종합하여 대시보드에 표시합니다.

## 대시보드 표시

```
Bams 대시보드
══════════════════════════════════════
프로젝트: [config에서 이름]
언어: [config에서]
활성 스프린트: [스프린트 번호 또는 "없음"]

태스크 보드
──────────────────────────────────────
  Backlog:       [N]개 태스크
  In Progress:   [N]개 태스크
  In Review:     [N]개 태스크
  Done:          [N]개 태스크
```

활성 스프린트가 있으면 추가 표시:

```
스프린트 [NNN]
──────────────────────────────────────
  목표: [스프린트 목표]
  진행률: [completed/total] 태스크 ([percentage]%)
  [진행 바 시각화]
```

In Progress 또는 In Review에 태스크가 있으면 나열.

project-governance 에이전트의 분석 결과 (위험 요소, 추천 액션)를 표시합니다.

```
아티팩트
──────────────────────────────────────
  PRD:     [N]
  설계:    [N]
  리뷰:    [N]
  테스트:  [N]

커맨드
──────────────────────────────────────
  /bams:plan <feature>          피처 플래닝
  /bams:dev <feature|task>      개발
  /bams:review [scope]          코드 리뷰
  /bams:sprint <action>         스프린트 관리
  /bams:verify                  CI/CD 프리플라이트
```
