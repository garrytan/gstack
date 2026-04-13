# Retro: Phase 4 — 개선 실행

> 이 파일은 `/bams:retro`의 Phase 4를 실행합니다.
> 공통 규칙은 `_common.md`를 참조합니다.

## 입력 컨텍스트
- slug: {엔트리포인트에서 결정된 retro slug}
- TARGET_SCOPE: {recent5 / all / slug:{값} / since_{N}d}
- Phase 1-3 산출물:
  - `.crew/artifacts/retro/{slug}/phase1-agent-metrics.md`
  - `.crew/artifacts/retro/{slug}/phase2-kpt-consolidated.md`
  - `.crew/artifacts/retro/{slug}/phase3-quantitative-eval.md`
  - `.crew/artifacts/retro/{slug}/phase3-qualitative-{부서명}.md` (참여 부서장별)
  - `.crew/artifacts/retro/{slug}/phase3-performance-eval.md`
  - `.crew/artifacts/retro/{slug}/phase3-cost-eval.md`

---

## Phase 4: 개선 실행

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 7 "개선 실행 (개선안 수립 → 승인 → 적용)" "Phase 4: 개선 실행"
```

---

## Step 7: 개선안 수립 (각 부서장 병렬)

**2단 위임 — 루프 B (동적 부서장)**: orchestrator가 개선 대상 에이전트와 담당 부서장 목록을 Advisor Response로 반환하면, 메인이 직접 병렬 spawn합니다.

**개선 대상 에이전트 선정 기준:**
phase3-quantitative-eval.md에서 C등급 이하(C/D)인 에이전트와,
phase2-kpt-consolidated.md의 Problem 항목에서 명시적으로 지목된 에이전트를 대상으로 합니다. 두 기준 중 하나라도 해당하면 개선 대상에 포함합니다.

**Step 7a: Advisor 호출** — Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, 조언자 모드. 컨텍스트: phase3-quantitative-eval.md, phase2-kpt-consolidated.md, phase3-qualitative-*.md, agents 정의 디렉터리. (agent_start/end: `orchestrator-advisor-step7-{date}`)

> **조언자 요청 — Phase 4 Step 7 개선안 수립 대상 결정**
>
> Advisor Response 반환:
> 1. 개선 대상 에이전트 목록 + 각 담당 부서장 매핑 (동적)
> 2. 각 부서장별 task_description + 담당 에이전트 목록 + expected_output 경로
> 3. 중복/충돌 개선안 조정 우선순위 규칙
> 4. phase4-improvements-summary.md 종합 담당(메인 or executive-reporter) 지목
>
> spawn 지시 금지. 메인이 파싱 후 직접 spawn합니다.

**Step 7b: 메인이 부서장 병렬 spawn + 종합**

1. Advisor 반환 부서장 전원의 `agent_start` 일괄 emit (`{부서장명}-7-{date}`)
2. Task tool 병렬 호출 (subagent_type: `bams-plugin:{부서장명}`)
3. 각 호출 완료 후 `agent_end` emit
4. 모든 `phase4-improvement-*.md` 수집 후 메인 또는 Advisor 지정 에이전트가 `phase4-improvements-summary.md` 생성 (중복/충돌/우선순위 조정)

각 부서장 위임 메시지 템플릿 — 원본:

> **Phase 4 Step 7 — 개선안 수립 (자기 부서 에이전트 대상)**
>
> **위임 메시지:**
> ```
> phase: 4-step7
> slug: {slug}
> pipeline_type: retro
> context:
>   quantitative_eval: .crew/artifacts/retro/{slug}/phase3-quantitative-eval.md
>   kpt_consolidated: .crew/artifacts/retro/{slug}/phase2-kpt-consolidated.md
>   qualitative_dir: .crew/artifacts/retro/{slug}/  (phase3-qualitative-*.md)
>   agent_defs_dir: plugins/bams-plugin/agents/
> ```
>
> **수행할 작업:**
>
> 1. phase3-quantitative-eval.md에서 C등급 이하 에이전트 목록을 추출합니다.
> 2. phase2-kpt-consolidated.md Problem 항목에서 추가로 지목된 에이전트를 확인합니다.
> 3. 개선 대상 에이전트가 속한 각 부서장에게 병렬로 개선안 작성을 위임합니다.
>    (agent_start를 먼저 모두 emit한 뒤 병렬 호출)
> 4. orchestrator가 전체 개선안을 수집하고 우선순위를 결정합니다.
>
> **각 부서장 위임 메시지 (공통 형식):**
> ```
> task_description: "자기 부서 에이전트의 개선안을 작성하라"
> input_artifacts:
>   - .crew/artifacts/retro/{slug}/phase3-quantitative-eval.md
>   - .crew/artifacts/retro/{slug}/phase3-qualitative-{부서명}.md
>   - plugins/bams-plugin/agents/{에이전트명}.md  (현재 정의 파일 Read 필수)
> expected_output:
>   type: improvement_plan
>   path: .crew/artifacts/retro/{slug}/phase4-improvement-{에이전트명}.md
> quality_criteria:
>   - 개선안 형식 준수 (아래 형식 사용)
>   - 현재 행동 규칙 원문을 인용 후 변경안 제시
>   - 예상 효과를 정량적으로 서술 (가능한 경우)
>   - 적용 범위 체크박스 명시
> ```
>
> **개선안 파일 형식 (`phase4-improvement-{에이전트명}.md`):**
> ```markdown
> ## 개선안: {에이전트명}
>
> ### 평가 근거
> - 등급: {A/B/C/D}
> - 주요 문제: {Phase 3 산출물 핵심 요약 2-3줄}
>
> ### 현재 행동 규칙 (변경 대상)
> > 현재: {agents/*.md에서 인용한 원문}
>
> ### 제안 변경
> > 변경: {수정 제안 내용}
>
> ### 예상 효과
> {구체적 수치 또는 행동 변화 기술}
>
> ### 적용 범위
> [ ] 행동 규칙 수정
> [ ] 학습된 교훈 추가
> [ ] gotcha 승격
> ```
>
> **orchestrator 종합 작업:**
> - 모든 phase4-improvement-*.md 수집
> - 중복/충돌 개선안 식별 및 조정
> - 우선순위 결정: 등급 낮은 순 > 호출 빈도 높은 순
> - `.crew/artifacts/retro/{slug}/phase4-improvements-summary.md` 생성 (전체 목록)
>
> **기대 산출물**:
> - `.crew/artifacts/retro/{slug}/phase4-improvement-{에이전트명}.md` (개선 대상 에이전트별)
> - `.crew/artifacts/retro/{slug}/phase4-improvements-summary.md` (전체 요약)

(각 부서장 호출별 agent_end emit은 메인이 개별 수행)

---

## Step 8: 사용자 승인

phase4-improvements-summary.md를 Read하여 개선안 목록을 파악한 뒤,
AskUserQuestion으로 사용자에게 제시합니다.

**질문 형식:**
```
다음 에이전트 개선안이 준비되었습니다. 적용 방식을 선택하세요.

개선 대상 에이전트 ({N}개):
1. {에이전트명} — 등급 {C/D} — {주요 문제 1줄 요약}
   적용 범위: {행동 규칙 수정 / 학습된 교훈 추가 / gotcha 승격}
2. ...

선택지:
A) 전체 승인 — 모든 개선안을 hr-agent가 즉시 적용합니다
B) 선택 승인 — 적용할 에이전트 번호를 입력하세요 (예: 1,3)
C) 보류 — 개선안 파일만 저장하고 에이전트 파일은 수정하지 않습니다
```

- **전체 승인**: 모든 개선안 → Step 9 위임
- **선택 승인**: 선택된 에이전트 번호에 해당하는 개선안 → Step 9 위임, 나머지 "보류" 기록
- **보류**: Step 9 skip, Phase 5로 직행. 개선안 파일 경로를 최종 보고서에 포함

---

## Step 9: 개선 적용 (승인된 것만)

Step 8에서 승인(전체 또는 선택)된 개선안이 있을 경우에만 실행합니다.

**2단 위임 — 루프 A**: orchestrator 조언 → 메인이 hr-agent 직접 spawn.

**Step 9a: Advisor 호출** — Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, 조언자 모드. 컨텍스트: 승인된 phase4-improvement-*.md 경로 목록, agents 정의 디렉터리, retro-protocol.md. Advisor Response: hr-agent 태스크 초안, 수정 규칙 검증, gotcha 승격 후보 목록, 교훈 10개 유지 규칙 확인. spawn 지시 금지. (agent_start/end: `orchestrator-advisor-step9-{date}`)

**Step 9b: 메인이 hr-agent 직접 spawn**

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "hr-agent-9-$(date -u +%Y%m%d)" "hr-agent" "opus" "Step 9: 에이전트 파일 수정"
```

서브에이전트 실행 (Task tool, subagent_type: **"bams-plugin:hr-agent"**, model: **"opus"**):

> **Phase 4 Step 9 — 에이전트 정의 파일 수정 (승인 개선안 적용)**
>
> **hr-agent 위임 메시지:**
> ```
> task_description: "승인된 개선안에 따라 에이전트 정의 파일을 수정하라"
> input_artifacts: [{승인된 phase4-improvement-*.md 경로 목록}]
> target_files: plugins/bams-plugin/agents/
> modification_rules:
>   - 행동 규칙 수정: agents/{에이전트명}.md의 ## 행동 규칙 섹션 직접 수정
>   - 학습된 교훈 추가: retro-protocol.md §5-1 형식 준수
>       형식: ## 학습된 교훈 > ### [YYYY-MM-DD] 교훈 제목
>       포함 항목: 맥락, 문제, 교훈, 적용 범위, 출처(retro slug)
>   - gotcha 승격: .crew/gotchas.md에 항목 추가 (사용자 확인 완료 상태)
>   - 기존 교훈 갱신: 같은 맥락+문제면 날짜와 내용 업데이트 (중복 추가 금지)
>   - 교훈 최대 10개 유지: 초과 시 오래된 항목부터 제거
> quality_criteria:
>   - 각 수정 후 변경된 내용의 diff 요약 출력
>   - 수정 전 원문과 수정 후 내용 병기
>   - 의도치 않은 섹션 삭제 금지
> ```
>
> **gotcha 승격 검사:**
> phase2-kpt-consolidated.md에서 2회 이상 반복 등장한 동일 Problem이 있으면,
> .crew/gotchas.md 승격 조건을 충족한 것으로 판단하고 승격 항목을 목록화합니다.
> (사용자가 Step 8에서 이미 전체/선택 승인한 경우 gotcha 승격도 포함된 것으로 처리)
>
> **기대 산출물**:
> - `plugins/bams-plugin/agents/{에이전트명}.md` 갱신 (승인된 에이전트별)
> - `.crew/gotchas.md` 갱신 (gotcha 승격 대상 존재 시)
> - 수정 diff 요약 (각 파일별)

Bash로 agent_end emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "hr-agent-9-$(date -u +%Y%m%d)" "hr-agent" "success" {duration_ms} "Step 9 완료: 에이전트 파일 수정"
```

---

## Phase 4 게이트

다음 조건을 확인합니다:

**필수 (GO 조건):**
- `phase4-improvements-summary.md` 존재
- Step 8 사용자 승인 결과가 기록됨 (전체 승인 / 선택 승인 / 보류 중 하나)

**조건부 (선택 승인/전체 승인 시 추가 확인):**
- 승인된 에이전트 수만큼 에이전트 파일 수정 완료
- 수정 diff 요약이 보고서에 포함됨

**결과 처리:**
- **GO**: 필수 조건 통과 → Phase 5로 진행
- **NO-GO**: 필수 미충족 (예: 요약 파일 없음) → Step 7 재실행 지시

Phase 4 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 7 "done" {duration_ms}
```
