---
description: 버그 분류 -> 수정 -> 회귀 테스트 파이프라인
argument-hint: <버그 설명, 에러 메시지, 또는 증상>
---

# Bams Debug

Bams 오케스트레이터로서 버그 분류 -> 원인 분석 -> 수정 -> 회귀 테스트 파이프라인을 실행합니다.

입력: $ARGUMENTS

$ARGUMENTS가 비어있으면, 사용자에게 어떤 버그를 조사할지 물어보고 중단합니다.

## 코드 최신화

Bash로 `git rev-parse --is-inside-work-tree 2>/dev/null`를 실행하여 git 저장소인지 확인합니다.

**git 저장소인 경우**: Bash로 `git branch --show-current`를 실행하여 현재 브랜치를 확인한 뒤, `git pull origin {현재 브랜치}`를 실행하여 원격 저장소의 최신 코드를 가져옵니다. 충돌이 발생하면 사용자에게 알리고 중단합니다.

**git 저장소가 아닌 경우**: 이 단계를 스킵합니다.

## 사전 조건

Glob으로 `.crew/config.md`가 존재하는지 확인합니다. 없으면:
- 출력: "프로젝트가 초기화되지 않았습니다. `/bams:init`을 실행하여 설정하세요."
- 여기서 중단.

`.crew/config.md`와 `.crew/board.md`를 읽습니다.

### TaskDB 연동 (DB가 존재하면 board.md 대신 DB 사용)

`~/.claude/plugins/marketplaces/my-claude/bams.db`가 존재하면 DB를 우선 사용합니다:

```bash
# DB 존재 확인
if [ -f "$HOME/.claude/plugins/marketplaces/my-claude/bams.db" ]; then
  echo "[bams-db] DB 모드 활성화"
fi
```

**태스크 등록 시 (DB가 존재하면):** Bash로 bun 스크립트를 실행하여 TaskDB에 태스크를 등록합니다.

```bash
# DB가 존재하면 TaskDB에 태스크 등록
if [ -f "$HOME/.claude/plugins/marketplaces/my-claude/bams.db" ]; then
  bun -e "
    import { TaskDB } from './plugins/bams-plugin/tools/bams-db/index.ts';
    const db = new TaskDB();
    db.createTask({ pipeline_slug: '{slug}', title: '{task_title}', status: 'in_progress', assignee_agent: '{agent}', phase: {phase} });
    db.close();
  "
fi
```

**파이프라인 완료 시 (DB가 존재하면):** board.md를 DB 스냅샷으로 갱신합니다.

```bash
if [ -f "$HOME/.claude/plugins/marketplaces/my-claude/bams.db" ]; then
  bun run plugins/bams-plugin/tools/bams-db/sync-board.ts {slug} --write
fi
```

DB가 없으면 기존 board.md 방식을 유지합니다.


### Viz 이벤트: pipeline_start

사전 조건 확인 후, Bash로 다음을 실행합니다:

```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" pipeline_start "{slug}" "debug" "/bams:debug" "{arguments}"
```

### ★ Viz Agent 이벤트 규칙

**`references/viz-agent-protocol.md` 참조.** 모든 서브에이전트 호출 전후에 반드시 agent_start/agent_end 이벤트를 emit한다. orchestrator 내부에서 부서장/에이전트를 호출할 때도 동일하게 적용한다.

## Phase 1: 버그 분류 및 재현 (defect-triage)

### 1a. 버그 정보 파싱

$ARGUMENTS에서 다음을 추출합니다:
- **증상**: 무엇이 잘못되었는가?
- **에러 메시지**: 스택 트레이스, 에러 로그 (있으면)
- **재현 조건**: 어떤 상황에서 발생하는가? (있으면)

정보가 불충분하면 **AskUserQuestion**으로 추가 정보를 요청:

Question: "버그에 대해 추가 정보가 필요합니다."
Header: "Bug Info"
Options:
- **에러 메시지 있음** - "스택 트레이스나 에러 로그를 붙여넣기"
- **재현 방법 있음** - "재현 단계를 설명"
- **증상만 있음** - "현재 정보로 조사 시작"

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 1 "버그 분류 및 재현" "Phase 1: 진단"
```

### 1b. qa-strategy 부서장 (defect-triage 위임)

서브에이전트 실행 (Task tool, subagent_type: **"bams-plugin:qa-strategy"**, model: **"opus"**):

> **버그 분류 및 재현 모드**로 보고된 버그를 분류하고 재현을 시도합니다.
>
> **버그 리포트**: [$ARGUMENTS + 추가 정보 삽입]
> **프로젝트 컨텍스트**: [.crew/config.md 내용 삽입]
>
> 수행 작업:
> 1. 버그 분류 (심각도: Critical/Major/Minor, 유형: 로직 오류/엣지 케이스/레이스 컨디션/회귀/타입 불일치/환경)
> 2. 에러 메시지/스택 트레이스에서 관련 파일과 라인 추출
> 3. Grep으로 관련 코드 검색, Read로 파일 읽기
> 4. 코드 흐름 추적 — 버그 발생 경로 매핑
> 5. 최근 변경 이력 분석 (git log, git blame)
> 6. 근본 원인 후보 식별 (최소 1개, 최대 3개)
> 7. 영향 범위 분석 — 이 버그가 영향 미치는 다른 기능/파일
>
> 반환 내용:
> - **분류**: 심각도, 유형, 카테고리
> - **근본 원인**: 후보별 위치(file:line), 설명, 신뢰도
> - **영향 범위**: 직접/간접 영향 파일 수, 위험 등급
> - **수정 허용 범위**: 수정 필요한 파일 목록 + 이유
> - **재현 단계**: 확인된 재현 경로

defect-triage 반환 후, 결과를 사용자에게 표시:

```
버그 분류 완료
──────────────────────────────────────
심각도: [Critical/Major/Minor]
유형: [로직 오류 / 엣지 케이스 / ...]
근본 원인: [한 줄 요약]
위치: [file:line]
신뢰도: [높음/중간/낮음]
영향 범위: [Low/Medium/High] ([N]개 파일)
수정 대상: [N]개 파일
```

Phase 1 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 1 "done" {duration_ms}
```

## Phase 1.5: Git 체크포인트

**AskUserQuestion**으로 체크포인트 방식을 선택받습니다:

Question: "수정 시작 전 코드를 어떻게 보존할까요?"
Header: "Git"
Options:
- **Feature branch** - "새 브랜치를 생성하여 작업 (예: bams/fix-[slug])"
- **Stash** - "현재 변경사항을 stash"
- **스킵** - "체크포인트 없이 바로 진행"

## Phase 2: 수정 (frontend/backend-engineering)

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 2 "버그 수정" "Phase 2: 수정"
```

defect-triage 결과의 수정 대상 파일에 따라 적절한 에이전트를 선택합니다:
- UI/컴포넌트 관련 파일 -> frontend-engineering
- API/DB/비즈니스 로직 관련 파일 -> backend-engineering
- 양쪽 모두 -> 두 에이전트를 병렬 실행

서브에이전트 실행 (Task tool, subagent_type: **"bams-plugin:frontend-engineering"** 또는 **"bams-plugin:backend-engineering"**, model: **"opus"**):

> **버그 수정 모드**로 버그를 최소 범위로 수정합니다.
>
> **근본 원인**: [Phase 1 결과]
> **수정 허용 파일**: [defect-triage가 확정한 목록]
> **영향 분석**: [직접/간접 영향 요약]
> **코드베이스 컨벤션**: [CLAUDE.md와 .crew/config.md에서]

에이전트 반환 후:
- 수정된 파일이 허용 범위 내인지 검증
- 범위 위반 시 사용자에게 경고하고 처리 방식 확인

### 변경사항 확인

git 저장소인 경우, `git diff --stat` 표시.

**AskUserQuestion**: 적용 / 되돌리기 / 부분 되돌리기

Phase 2 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 2 "done" {duration_ms}
```

## Phase 3: 회귀 테스트 (automation-qa) — 병렬 실행

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 3 "회귀 테스트" "Phase 3: 테스트"
```

### 3a + 3b: 기존 테스트 실행 ∥ 회귀 테스트 생성 (동시)

**기존 테스트 실행과 회귀 테스트 생성은 독립적이므로 동시에 실행합니다:**

**3a — 기존 테스트 실행:**
프로젝트에 테스트 러너가 있으면 Bash로 실행. 실패 시 사용자에게 수정/조사/스킵 선택.

**3b — 회귀 테스트 생성:**
서브에이전트 실행 (Task tool, subagent_type: **"bams-plugin:qa-strategy"**, model: **"sonnet"**):

> **회귀 테스트 모드**로 버그 수정에 대한 회귀 테스트를 작성합니다.
>
> **원래 버그**: [$ARGUMENTS]
> **근본 원인**: [Phase 1 결과]
> **수정된 파일**: [Phase 2에서 수정된 파일 목록]
> **수정 내용**: [변경 요약]
> **테스트 위치**: [.crew/config.md의 test_dir]
> **기존 테스트 패턴**: [프로젝트의 테스트 프레임워크와 패턴]

생성된 테스트를 실행하여 통과 여부 확인 (최대 2회 재시도).

Phase 3 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 3 "{status}" {duration_ms}
```

## Phase 4: 마무리

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 4 "마무리" "Phase 4: 마무리"
```

### 4a. 아티팩트 저장

디버그 리포트를 `.crew/artifacts/review/debug-[slug].md`에 저장.

### 4b. 보드 업데이트

`.crew/board.md`의 `## Done`에 버그 수정 태스크 추가.

### 4c. 최종 요약

버그 증상, 근본 원인, 영향 분석, 수정 내용, 테스트 결과, 리포트 경로, 태스크 ID 제시.

Step 4 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 4 "done" {duration_ms}
```

## Phase 5: CLAUDE.md 상태 업데이트

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 5 "CLAUDE.md 상태 업데이트" "Phase 5: 상태 업데이트"
```

`CLAUDE.md`의 `## Bams 현재 상태` 섹션을 업데이트합니다.

업데이트 완료 후, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 5 "done" {duration_ms}
```

### Viz 이벤트: pipeline_end

파이프라인 종료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" pipeline_end "{slug}" "{status}" {total} {completed} {failed} {skipped}
```
(`{status}`는 `completed` / `paused` / `failed` 중 하나, `{total}`은 5)
