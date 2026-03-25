---
description: Crew 프로젝트 대시보드 및 태스크 보드 현황
---

# Crew Status

Crew 오케스트레이터로서 종합 프로젝트 현황 대시보드를 표시합니다.

## 사전 조건

Glob으로 `.crew/config.md`가 존재하는지 확인합니다. 없으면:
- 출력: "Crew가 초기화되지 않았습니다. `/crew:init`을 실행하여 설정하세요."
- 여기서 중단.

## 상태 수집

다음 파일을 읽습니다 (존재하지 않는 것은 스킵):
1. `.crew/config.md` - 프로젝트 컨텍스트
2. `.crew/board.md` - 현재 태스크 보드
3. `.crew/history.md` - 완료된 작업

Glob으로 확인:
4. `.crew/sprints/sprint-*.md` - 가장 최근 스프린트 파일 찾기. 발견되면 읽기. 활성 스프린트는 프론트매터에 `completed: null`이 있음.
5. `.crew/artifacts/prd/*.md` - PRD 파일 수 집계
6. `.crew/artifacts/design/*.md` - 설계 파일 수 집계
7. `.crew/artifacts/review/*.md` - 리뷰 파일 수 집계
8. `.crew/artifacts/test/*.md` - 테스트 파일 수 집계

## 태스크 집계

`board.md`에서 각 섹션의 태스크 수를 `## Section` 아래의 `### TASK-` 헤딩 수로 집계:
- Backlog 수
- In Progress 수
- In Review 수
- Done 수

`history.md`에서 아카이브된 태스크 수를 집계합니다.

## 대시보드 표시

포맷된 대시보드를 출력합니다:

```
Crew 대시보드
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
  아카이브:      [N]개 태스크 (history)
```

활성 스프린트가 있으면 추가 표시:

```
스프린트 [NNN]
──────────────────────────────────────
  목표: [스프린트 목표]
  시작일: [date]
  진행률: [completed/total] 태스크 ([percentage]%)
  [진행 바 시각화]
```

In Progress 또는 In Review에 태스크가 있으면 나열:

```
진행 중인 작업
──────────────────────────────────────
  진행 중:
    - TASK-001: [title] ([role])
    - TASK-002: [title] ([role])
  리뷰 중:
    - TASK-003: [title]
```

아티팩트 수 표시:

```
아티팩트
──────────────────────────────────────
  PRD:     [N]
  설계:    [N]
  리뷰:    [N]
  테스트:  [N]
```

사용 가능한 커맨드로 마무리:

```
커맨드
──────────────────────────────────────
  /crew:plan <feature>          피처 플래닝
  /crew:dev <feature|task>      개발
  /crew:review [scope]          코드 리뷰
  /crew:sprint <action>         스프린트 관리
```
