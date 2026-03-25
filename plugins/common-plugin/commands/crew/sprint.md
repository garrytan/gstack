---
description: 스프린트 플래닝, 관리, 진행 상황 추적
argument-hint: <plan|status|close>
---

# Crew Sprint

Crew 오케스트레이터로서 스프린트 운영을 관리합니다.

액션: $ARGUMENTS

$ARGUMENTS가 비어있으면, 아래 도움말 섹션을 표시하고 중단합니다.

## 코드 최신화

Bash로 `git rev-parse --is-inside-work-tree 2>/dev/null`를 실행하여 git 저장소인지 확인합니다.

**git 저장소인 경우**: Bash로 `git branch --show-current`를 실행하여 현재 브랜치를 확인한 뒤, `git pull origin {현재 브랜치}`를 실행하여 원격 저장소의 최신 코드를 가져옵니다. 충돌이 발생하면 사용자에게 알리고 중단합니다.

**git 저장소가 아닌 경우**: 이 단계를 스킵합니다.

## 사전 조건

Glob으로 `.crew/config.md`가 존재하는지 확인합니다. 없으면:
- 출력: "Crew가 초기화되지 않았습니다. `/crew:init`을 실행하여 설정하세요."
- 여기서 중단.

`.crew/config.md`와 `.crew/board.md`를 읽습니다.

Glob으로 `.crew/sprints/sprint-*.md`를 찾아 기존 스프린트를 확인합니다. 활성 스프린트는 YAML 프론트매터에 `completed: null`이 있습니다.

## 액션별 라우팅

---

### 액션: "plan" 또는 "start"

**1. 활성 스프린트 확인:**
활성 스프린트가 있으면 사용자에게 알림: "스프린트 [N]이 활성 상태입니다. `/crew:sprint close`로 먼저 종료하세요." 중단.

**2. 백로그 확인:**
board.md의 `## Backlog`에 있는 태스크 수를 셉니다. 0이면:
- 출력: "백로그에 태스크가 없습니다. `/crew:plan <feature>`로 먼저 태스크를 생성하세요."
- 중단.

**3. 스프린트 플래닝:**
모든 백로그 태스크를 테이블로 사용자에게 표시:

```
백로그 태스크:
  ID        | 제목                     | 우선순위 | 역할      | 의존성
  TASK-001  | 인증 API 구현             | P0       | Developer | 없음
  TASK-002  | 인증 테스트 작성           | P1       | QA        | TASK-001
  ...
```

사용자에게 질문: "이 스프린트에 어떤 태스크를 포함할까요? (all / P0만 / P0+P1 / 특정 ID 나열)"

사용자가 지정하지 않으면 기본값은 모든 P0 및 P1 태스크.

스프린트 목표도 물어봅니다 (한 문장).

**4. 스프린트 파일 생성:**

다음 스프린트 번호 결정:
- 스프린트가 없으면 1 사용
- 있으면 가장 높은 번호의 스프린트 파일을 읽고 증가

`.crew/sprints/sprint-[NNN].md` 작성 (NNN은 3자리 zero-padded):

```markdown
---
sprint: [N]
started: [현재 ISO timestamp]
completed: null
goal: [사용자의 스프린트 목표]
---

# 스프린트 [N]

## 목표
[스프린트 목표]

## 태스크

| ID | 제목 | 역할 | 우선순위 | 상태 | 비고 |
|----|------|------|----------|------|------|
| TASK-001 | [title] | Developer | P0 | Todo | |
| TASK-002 | [title] | QA | P1 | Todo | TASK-001 대기 중 |

## 로그
```

**5. 보드 업데이트:**
선택된 태스크를 board.md의 `## Backlog`에서 `## In Progress`로 이동합니다. 타임스탬프 업데이트.

**6. 확인:**
```
스프린트 [N] 시작!
목표: [goal]
태스크: [N]개 총 ([N] P0, [N] P1, [N] P2)
/crew:sprint status로 진행 상황을 추적하세요.
```

---

### 액션: "status"

**1. 활성 스프린트 찾기:**
활성 스프린트가 없으면 출력: "활성 스프린트가 없습니다. `/crew:sprint plan`으로 시작하세요." 중단.

**2. 활성 스프린트 파일과 board.md 읽기**

**3. 메트릭 계산:**
- 스프린트의 각 태스크에 대해 board.md의 현재 섹션 확인:
  - `## Done` → 완료됨
  - `## In Review` → 리뷰 중
  - `## In Progress` → 진행 중
  - `## Backlog` → 미시작 (발생하면 안 되지만 처리)
- 총, 완료, 진행 중, 리뷰 중, 블록됨 (의존성이 Done에 없는 것)
- 완료율 = 완료 / 총 * 100

**4. 스프린트 파일 업데이트:**
스프린트 태스크 테이블의 상태 컬럼을 현재 보드 상태에 맞게 업데이트합니다. 오늘 날짜 로그 항목이 아직 없으면 추가합니다.

**5. 표시:**

```
스프린트 [N] 현황
══════════════════════════════════════
목표: [goal]
시작일: [date] ([N]일 전)

진행률: [completed]/[total] 태스크 ([percentage]%)
[████████░░░░░░░░░░░░] 40%

완료됨:
  ✓ TASK-001: [title]
  ✓ TASK-003: [title]

리뷰 중:
  ◎ TASK-004: [title]

진행 중:
  ▸ TASK-002: [title]

블록됨:
  ✕ TASK-005: [title] (TASK-002 대기 중)

미시작:
  ○ TASK-006: [title]

커맨드:
  /crew:dev TASK-NNN    특정 태스크 개발
  /crew:sprint close    이 스프린트 종료
```

---

### 액션: "close"

**1. 활성 스프린트 찾기:**
활성 스프린트가 없으면 출력: "종료할 활성 스프린트가 없습니다." 중단.

**2. 최종 메트릭 계산:**
- 완료된 태스크 (`## Done`에 있는 것)
- 미완료 태스크 (나머지)
- Velocity = 완료된 태스크 수
- 기간 = 스프린트 시작 이후 일 수

**3. 스프린트 파일 업데이트:**
- 프론트매터에 `completed: [현재 ISO timestamp]` 설정
- 테이블의 모든 태스크 상태 업데이트
- 종료 로그 항목 추가

**4. 완료된 태스크 아카이브:**
board.md의 `## Done`에서 완료된 태스크를 `.crew/history.md`로 이동:
```markdown
### [ISO date] - 스프린트 [N]
- **TASK-NNN**: [title] (Feature: [slug])
- **TASK-NNN**: [title] (Feature: [slug])
```

board.md의 `## Done` 섹션을 비웁니다.

**5. 미완료 태스크 처리:**

In Progress 태스크가 있으면 사용자에게 경고합니다:

```
⚠ 진행 중 태스크의 부분 구현 코드가 있을 수 있습니다.
```

Bash로 `git diff --stat`을 실행하여 미커밋 변경사항이 있는지 확인합니다. 미커밋 변경이 있으면 **AskUserQuestion**:

Question: "미커밋 변경사항이 있습니다. 어떻게 할까요?"
Header: "Changes"
Options:
- **유지** - "변경사항을 그대로 두고 태스크만 Backlog으로 이동"
- **커밋** - "현재 상태를 WIP 커밋으로 저장"
- **되돌리기** - "모든 미커밋 변경을 되돌리기"

**커밋** 선택 시: `git add -A && git commit -m "WIP: [미완료 태스크 제목들]"` 실행.
**되돌리기** 선택 시: `git checkout -- .`로 되돌림 (새 파일은 사용자에게 목록을 보여주고 확인 후 삭제).

미완료 태스크를 board.md의 `## Backlog`으로 되돌립니다.

**6. 회고 표시:**

```
스프린트 [N] 종료
══════════════════════════════════════
기간: [N]일
목표: [goal]

결과:
  완료됨:      [N]/[total] 태스크
  Velocity:    [N] 태스크/스프린트
  완료율:      [percentage]%

완료됨:
  ✓ TASK-001: [title]
  ✓ TASK-003: [title]

백로그로 이월됨:
  → TASK-005: [title] (진행 중이었음)
  → TASK-006: [title] (리뷰 중이었음)

다음: /crew:sprint plan으로 새 스프린트 시작
```

---

### CLAUDE.md 상태 업데이트 (plan, status, close 공통)

"help" 액션을 제외한 모든 액션 완료 후, `CLAUDE.md`의 `## Crew 현재 상태` 섹션을 업데이트합니다 (없으면 파일 끝에 추가, 있으면 Edit으로 교체). `.crew/board.md`를 읽어 다음을 포함:
- 마지막 업데이트 타임스탬프
- 진행 중인 작업 (In Progress/In Review 태스크)
- 활성 스프린트 정보
- 최근 산출물 경로
- 다음 명령 제안

---

### 액션: 기타 또는 "help"

표시:

```
Crew 스프린트 커맨드
══════════════════════════════════════
  /crew:sprint plan     스프린트 플래닝 및 시작
  /crew:sprint status   현재 스프린트 진행 상황 확인
  /crew:sprint close    회고와 함께 스프린트 종료
```
