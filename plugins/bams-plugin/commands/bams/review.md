---
description: 5관점 병렬 코드 리뷰 + 릴리스 품질 게이트
argument-hint: [파일, 디렉토리, 또는 "pr"]
---

> **사용 시점**: 코드 변경 후 5관점 병렬 리뷰 + 릴리스 품질 게이트가 필요할 때. deep-review보다 경량.

# Bams Review

Bams 오케스트레이터로서 5개 전문 병렬 qa-strategy 에이전트를 활용한 다관점 코드 리뷰를 실행하고, release-quality-gate 에이전트로 최종 판정합니다.

리뷰 대상: $ARGUMENTS

## Pre-flight

### Viz 이벤트: pipeline_start

사전 조건 확인 후, Bash로 다음을 실행합니다:

```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" pipeline_start "{slug}" "review" "/bams:review" "{arguments}"
```

## 코드 최신화

Bash로 `git rev-parse --is-inside-work-tree 2>/dev/null`를 실행하여 git 저장소인지 확인합니다.

**git 저장소인 경우**: Bash로 `git branch --show-current`를 실행하여 현재 브랜치를 확인한 뒤, `git pull origin {현재 브랜치}`를 실행합니다. 충돌이 발생하면 사용자에게 알리고 중단합니다.

**git 저장소가 아닌 경우**: 이 단계를 스킵합니다.

## 리뷰 범위 결정

**$ARGUMENTS가 비어있거나 제공되지 않은 경우:**
1. Bash로 `git diff` 실행하여 미스테이지 변경사항 확인
2. 미스테이지 변경이 없으면, `git diff --cached`로 스테이지된 변경사항 확인
3. 변경사항이 전혀 없으면, 사용자에게 무엇을 리뷰할지 물어보고 중단

**$ARGUMENTS가 파일이나 디렉토리를 지정한 경우:**
- Glob으로 존재 여부 검증, 해당 파일/디렉토리를 리뷰

**$ARGUMENTS가 "pr" 또는 PR 번호인 경우:**
- Bash로 `git diff main...HEAD`를 실행하여 PR diff 획득

## 사전 조건

`.crew/config.md`가 있으면 읽습니다. `CLAUDE.md`가 있으면 읽습니다.

## Phase 1: 파일 수집

1. 리뷰 범위의 모든 파일 식별
2. 각 파일 읽기 (15개 초과 시 우선순위: 변경된 파일 > 핵심 로직 > 생성/벤더 파일 스킵)
3. git 변경사항 리뷰 시, diff 출력 캡처

> **위임 체계 (Canonical)**: 이 커맨드는 `_shared_common.md` §위임 원칙 + 부록 **루프 B**(Advised)를 따른다. 메인(커맨드)이 qa-strategy(QA부장)를 **직접** Task tool로 spawn하며, pipeline-orchestrator는 조언자(Advisor) 모드로만 호출된다. orchestrator를 경유한 중첩 spawn 금지(harness 깊이 2 제약).

## Phase 2: 5관점 병렬 리뷰 — 루프 B (Advised, QA부장 직접 spawn)

### Phase 2-a. pipeline-orchestrator 조언 요청 (Advisor)

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-2-$(date -u +%Y%m%d)" "pipeline-orchestrator" "opus" "Phase 2: 5관점 리뷰 조언 요청"
```

Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, model: **"opus"** — **조언자 모드**:

> **Review Phase 2 Advisor 호출 — 5관점 리뷰 라우팅 권고**
>
> **컨텍스트:**
> ```
> phase: 2
> slug: {review_timestamp}
> pipeline_type: review
> config: .crew/config.md
> review_files: [Phase 1에서 수집한 파일 목록]
> diff: [git diff 내용 (해당 시)]
> ```
>
> **요청:** 메인이 spawn할 QA부장(qa-strategy) 위임 메시지 템플릿, 5관점(정확성/보안/성능/품질/테스트) specialist 라우팅 권고, 게이트 조건을 Advisor Response로 반환하세요. 직접 spawn 금지(harness 깊이 2 제약).

반환 후 agent_end emit + Advisor Response 파싱 + CHAIN_VIOLATION 체크:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-2-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "Phase 2 Advisor 응답 수신"
```

### Phase 2-b. 메인이 qa-strategy 직접 spawn (5관점 병렬 리뷰)

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "qa-strategy-2-$(date -u +%Y%m%d)" "qa-strategy" "opus" "Phase 2: 5관점 병렬 리뷰"
```

Task tool, subagent_type: **"bams-plugin:qa-strategy"**, model: **"opus"** — 메인이 직접 호출:

> **Review Phase 2 — 5관점 병렬 코드 리뷰**
>
> ```
> task_description: "5관점 병렬 코드 리뷰를 실행하라"
> input_artifacts:
>   - [파일 경로 목록 + 내용 또는 diff]
>   - CLAUDE.md
>   - .crew/config.md
> expected_output:
>   type: multi_perspective_review
> quality_criteria:
>   - 정확성: 기능적 정확성 중심
>   - 보안: OWASP Top 10 및 일반적인 취약점 점검
>   - 성능: 성능 엔지니어링 관점
>   - 코드 품질: 유지보수성과 코드 표준
>   - 테스트 커버리지: 테스트 충분성과 품질
> ```
>
> QA부장은 도메인 내 관점별 specialist(automation-qa, defect-triage 등)를 **최대 1회** 추가 spawn 가능(harness 깊이 2 한도).

반환 후 agent_end emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "qa-strategy-2-$(date -u +%Y%m%d)" "qa-strategy" "success" {duration_ms} "5관점 리뷰 완료"
```

**기대 산출물**: 5관점 리뷰 결과 (관점별 발견 사항 목록)

## Phase 3: 리뷰 종합

pipeline-orchestrator(QA부장)가 반환한 후, 5관점 리뷰 결과를 종합합니다:

1. 모든 발견 사항 수집
2. **중복 제거**: 같은 파일, 같은 라인, 같은 개념의 이슈 병합
3. **정렬**: Critical -> Major -> Minor 순. 같은 심각도 내에서는 신뢰도 높은 순
4. 심각도별 총 이슈 수 집계

## Phase 4: 릴리스 품질 게이트 — 루프 A (Simple, QA부장 직접 spawn)

Phase 4는 단일 도메인(QA)의 판정 작업이므로 **루프 A**를 따른다. orchestrator 조언을 생략하고 메인이 qa-strategy를 직접 호출한다.

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "qa-strategy-4-$(date -u +%Y%m%d)" "qa-strategy" "opus" "Phase 4: 릴리스 품질 게이트"
```

Task tool, subagent_type: **"bams-plugin:qa-strategy"**, model: **"opus"** — 메인이 직접 호출:

> **Review Phase 4 — 릴리스 품질 게이트**
>
> ```
> task_description: "코드 리뷰 결과를 종합 판정하라"
> input_artifacts:
>   - review_result: [Phase 3 종합 결과 — 심각도별 이슈 수, 상세 이슈 목록]
>   - changed_files: [파일 목록]
>   - .crew/config.md
> expected_output:
>   type: release_gate_verdict
> quality_criteria:
>   판정 기준:
>     PASS: Critical 0건, Major 2건 이하
>     CONDITIONAL: Critical 0건이지만 Major 3건 이상, 또는 테스트 커버리지 미흡
>     FAIL: Critical 1건 이상
> ```
>
> QA부장은 도메인 내 release-quality-gate specialist를 **최대 1회** 추가 spawn 가능(harness 깊이 2 한도).

반환 후 agent_end emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "qa-strategy-4-$(date -u +%Y%m%d)" "qa-strategy" "success" {duration_ms} "릴리스 게이트 판정 완료"
```

**기대 산출물**: 판정 결과, 근거, 필수 수정 사항, 권장 수정 사항

## Phase 5: 리포트 저장

타임스탬프 slug 생성 (예: `2026-03-31-143052`).

리뷰 리포트를 `.crew/artifacts/review/review-[timestamp].md`에 저장합니다:
- **요약**: 심각도별 이슈 건수, 릴리스 게이트 판정
- **Critical/Major/Minor 이슈**: 각 이슈 상세 (카테고리, file:line, 설명, 수정안)
- **릴리스 게이트 판정**: PASS/CONDITIONAL/FAIL + 근거
- **긍정적 관찰**: 잘된 점

## Phase 6: 결과 제시

사용자에게 결과를 표시합니다:

```
코드 리뷰 완료
══════════════════════════════════════
리뷰 범위: [파일/디렉토리/PR]
리포트: .crew/artifacts/review/review-[timestamp].md

이슈 요약:
  Critical: [N]건
  Major:    [N]건
  Minor:    [N]건

릴리스 게이트: [PASS/CONDITIONAL/FAIL]
```

그 다음 모든 Critical 및 Major 이슈를 상세와 함께 나열합니다.

## Phase 7: 이슈 수정 제안

Critical 또는 Major 이슈가 있으면, **AskUserQuestion** (multiSelect: true)으로 수정할 이슈를 선택받습니다.

선택된 이슈들에 대해:
1. 각 이슈의 수정사항을 Edit 도구로 적용
2. 수정된 이슈를 리포트에서 `[수정됨]` 태그 추가
3. 수정 완료 후 요약 표시

git 저장소인 경우, 수정 후 `git diff --stat` 표시하고 적용/되돌리기 확인.

## Phase 8: CLAUDE.md 상태 업데이트

`CLAUDE.md`의 `## Bams 현재 상태` 섹션을 업데이트합니다.

### Viz 이벤트: pipeline_end

파이프라인 종료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" pipeline_end "{slug}" "{status}" {total} {completed} {failed} {skipped}
```
(`{status}`는 `completed` / `paused` / `failed` 중 하나, `{total}`은 8)
