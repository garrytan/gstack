---
description: CI/CD 프리플라이트 — 빌드, 린트, 타입체크, 테스트 실행 및 결과 검증
argument-hint: [test command override]
---

# Verify

코드 변경사항의 CI/CD 프리플라이트 검증을 수행합니다.

입력: $ARGUMENTS

## 사전 조건

### Viz 이벤트: pipeline_start

사전 조건 확인 후, Bash로 다음을 실행합니다:

```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" pipeline_start "{slug}" "verify" "/bams:verify" "{arguments}"
```

`.crew/config.md`가 있으면 읽어서 프로젝트 설정(테스트 명령어, 빌드 명령어 등)을 파악합니다.
`CLAUDE.md`가 있으면 읽어서 빌드/테스트 가이드라인을 파악합니다.

> **위임 체계 (Canonical)**: 이 커맨드는 `_shared_common.md` §위임 원칙 + 부록 **루프 A**(Simple, 단일 도메인)를 따른다. 메인(커맨드)이 automation-qa와 release-quality-gate 에이전트를 **직접** Task tool로 spawn한다. orchestrator를 경유한 중첩 spawn 금지(harness 깊이 2 제약).

## Phase 1: 자동화 QA 검증

Task tool을 사용하여 서브에이전트를 실행합니다 (subagent_type: **"bams-plugin:automation-qa"**):

---

**CI 프리플라이트 모드**로 현재 프로젝트의 빌드, 린트, 타입체크, 테스트를 실행합니다.

**프로젝트 설정**: [config.md 내용 삽입]
**CLAUDE.md 가이드라인**: [CLAUDE.md 내용 삽입]
**테스트 명령어 오버라이드**: [$ARGUMENTS가 있으면 삽입]

다음 4개 검증을 **병렬로** 실행합니다 (각각 별도의 Bash 호출):
1. 빌드 (build command)
2. 린트 (lint command)
3. 타입체크 (type-check command)
4. 테스트 (test command)

4개를 동시에 실행하되, 각 결과를 개별적으로 PASS/FAIL로 보고합니다.
명령어가 없는 항목은 `skipped`로 처리합니다.

---

## Phase 2: 릴리즈 품질 게이트

Phase 1 결과를 기반으로 릴리즈 준비 상태를 판단합니다.

Task tool (subagent_type: **"bams-plugin:release-quality-gate"**):

---

**프리플라이트 게이트 모드**로 CI 결과를 검토합니다.

**CI 결과**: [Phase 1 결과 삽입]
**변경된 파일**: `git diff --stat` 결과
**미해결 이슈**: `.crew/board.md`의 In Progress 항목

---

## Phase 3: 결과 보고

검증 결과를 요약합니다:

```
Verify 결과
────────────────────
빌드:     PASS/FAIL
린트:     PASS/FAIL
타입체크: PASS/FAIL
테스트:   PASS/FAIL ([N] passed, [N] failed)
────────────────────
종합:     GO / NO-GO
```

FAIL 항목이 있으면 상세 에러를 표시합니다.

### Viz 이벤트: pipeline_end

파이프라인 종료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" pipeline_end "{slug}" "{status}" {total} {completed} {failed} {skipped}
```
(`{status}`는 `completed` / `paused` / `failed` 중 하나, `{total}`은 3)
