---
description: 스프린트 플래닝, 관리, 진행 상황 추적
argument-hint: <plan|status|close>
---

# Bams Sprint

Bams 오케스트레이터로서 스프린트 운영을 관리합니다.

액션: $ARGUMENTS

$ARGUMENTS가 비어있으면, 아래 도움말 섹션을 표시하고 중단합니다.

## Pre-flight

### Viz 이벤트: pipeline_start

사전 조건 확인 후, Bash로 다음을 실행합니다:

```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" pipeline_start "{slug}" "sprint" "/bams:sprint" "{arguments}"
```

## 코드 최신화

Bash로 `git rev-parse --is-inside-work-tree 2>/dev/null`를 실행하여 git 저장소인지 확인합니다.

**git 저장소인 경우**: Bash로 `git branch --show-current`를 실행하여 현재 브랜치를 확인한 뒤, `git pull origin {현재 브랜치}`를 실행하여 원격 저장소의 최신 코드를 가져옵니다. 충돌이 발생하면 사용자에게 알리고 중단합니다.

**git 저장소가 아닌 경우**: 이 단계를 스킵합니다.

## 사전 조건

Glob으로 `.crew/config.md`가 존재하는지 확인합니다. 없으면:
- 출력: "프로젝트가 초기화되지 않았습니다. `/bams:init`을 실행하여 설정하세요."
- 여기서 중단.

`.crew/config.md`와 `.crew/board.md`를 읽습니다.

Glob으로 `.crew/sprints/sprint-*.md`를 찾아 기존 스프린트를 확인합니다. 활성 스프린트는 YAML 프론트매터에 `completed: null`이 있습니다.

> **위임 체계 (Canonical)**: 이 커맨드는 `_shared_common.md` §위임 원칙 + 부록 **루프 A**(Simple, 단일 도메인)를 따른다. 메인(커맨드)이 project-governance(기획부 소속)를 **직접** Task tool로 spawn한다. orchestrator를 경유한 중첩 spawn 금지(harness 깊이 2 제약).

## 액션별 라우팅

---

### 액션: "plan" 또는 "start"

**1. 활성 스프린트 확인:**
활성 스프린트가 있으면 사용자에게 알림: "스프린트 [N]이 활성 상태입니다. `/bams:sprint close`로 먼저 종료하세요." 중단.

**2. 백로그 확인:**
board.md의 `## Backlog`에 있는 태스크 수를 셉니다. 0이면:
- 출력: "백로그에 태스크가 없습니다. `/bams:plan <feature>`로 먼저 태스크를 생성하세요."
- 중단.

**3. project-governance 에이전트로 스프린트 플래닝:**

서브에이전트 실행 (Task tool, subagent_type: **"bams-plugin:project-governance"**, model: **"claude-opus-4-7[1m]"**):

> **스프린트 플래닝 모드**로 백로그 태스크를 분석하고 스프린트 구성을 제안합니다.
>
> **백로그 태스크**: [board.md의 Backlog 섹션 삽입]
> **프로젝트 컨텍스트**: [config.md 삽입]
> **이전 스프린트**: [있으면 velocity 정보 삽입]
>
> 분석:
> 1. 태스크 우선순위와 의존성 기반 최적 순서
> 2. 예상 작업량 기반 스프린트 범위 제안
> 3. 리스크 요소 식별

모든 백로그 태스크를 테이블로 사용자에게 표시합니다.

사용자에게 질문: "이 스프린트에 어떤 태스크를 포함할까요? (all / P0만 / P0+P1 / 특정 ID 나열)"

스프린트 목표도 물어봅니다 (한 문장).

**4. 스프린트 파일 생성:**

`.crew/sprints/sprint-[NNN].md` 작성 (NNN은 3자리 zero-padded, YAML 프론트매터 포함).

**5. 보드 업데이트:**
선택된 태스크를 board.md의 `## Backlog`에서 `## In Progress`로 이동합니다.

---

### 액션: "status"

**1. 활성 스프린트 찾기.** 없으면 안내 후 중단.

**2. project-governance 에이전트로 상태 분석:**

서브에이전트 실행 (Task tool, subagent_type: **"bams-plugin:project-governance"**, model: **"claude-opus-4-7[1m]"**):

> **스프린트 상태 분석 모드**
> **스프린트 파일**: [활성 스프린트 내용]
> **board.md**: [보드 내용]
>
> 분석: 진행률, 병목, 위험 요소, 다음 추천 태스크

**3. 메트릭 계산 및 표시:**

```
스프린트 [N] 현황
══════════════════════════════════════
목표: [goal]
진행률: [completed]/[total] 태스크 ([percentage]%)
[████████░░░░░░░░░░░░] 40%

완료됨:     ✓ TASK-001: [title]
리뷰 중:    @ TASK-004: [title]
진행 중:    > TASK-002: [title]
블록됨:     x TASK-005: [title] (TASK-002 대기 중)
```

---

### 액션: "close"

**1. 활성 스프린트 찾기.** 없으면 안내 후 중단.

**2. 최종 메트릭 계산** (완료/미완료 태스크, velocity, 기간).

**3. 스프린트 파일 업데이트** (completed 타임스탬프 설정).

**4. 완료 태스크 아카이브:** board.md `## Done` -> `.crew/history.md`.

**5. 미완료 태스크를 `## Backlog`으로 되돌리기.**

**6. 회고 표시:**

```
스프린트 [N] 종료
══════════════════════════════════════
기간: [N]일
완료됨: [N]/[total] 태스크
Velocity: [N] 태스크/스프린트

다음: /bams:sprint plan으로 새 스프린트 시작
```

---

### CLAUDE.md 상태 업데이트 (plan, status, close 공통)

`CLAUDE.md`의 `## Bams 현재 상태` 섹션을 업데이트합니다.

---

### 액션: 기타 또는 "help"

```
Bams 스프린트 커맨드
══════════════════════════════════════
  /bams:sprint plan     스프린트 플래닝 및 시작
  /bams:sprint status   현재 스프린트 진행 상황 확인
  /bams:sprint close    회고와 함께 스프린트 종료
```

### Viz 이벤트: pipeline_end

모든 액션(plan, status, close) 완료 후, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" pipeline_end "{slug}" "{status}" {total} {completed} {failed} {skipped}
```
(`{status}`는 `completed` / `paused` / `failed` 중 하나, `{total}`은 해당 액션의 총 step 수)
