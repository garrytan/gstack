# Retro: Phase 2 — KPT 회고

> 이 파일은 `/bams:retro`의 Phase 2를 실행합니다.
> 공통 규칙은 `_common.md`를 참조합니다 (엔트리포인트에서 이미 로드됨).

## 입력 컨텍스트

- slug: {slug}
- Phase 1 산출물:
  - 파이프라인 통계: `.crew/artifacts/retro/{slug}/phase1-pipeline-metrics.md`
  - 에이전트 성과 지표: `.crew/artifacts/retro/{slug}/phase1-agent-metrics.md`

---

## Step 3: 부서장 KPT 수집 (병렬)

**참여 부서장 결정**: `phase1-agent-metrics.md`의 부서장 매핑 테이블에서 호출 이력이 있는 부서장만 KPT 요청 대상으로 선정합니다.

Bash로 step_start를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 3 "부서장 KPT 수집" "Phase 2: KPT 회고"
```

**2단 위임 — 루프 B (동적 부서장)**: orchestrator가 참여 부서장 목록을 Advisor Response로 반환하면, 메인이 파싱 후 각 부서장을 직접 병렬 spawn합니다.

**Phase 3a: Advisor 호출 (참여 부서장 결정)**

Bash로 agent_start를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1)
[ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "orchestrator-advisor-step3-$(date -u +%Y%m%d)" "pipeline-orchestrator" "opus" "Step 3 advisor: 참여 부서장 결정"
```

서브에이전트 실행 (Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, model: **"opus"**, **조언자 모드**):

> **조언자 요청 — Phase 2 KPT 참여 부서장 동적 결정**
>
> 컨텍스트: phase1-agent-metrics.md (부서 매핑), phase1-pipeline-metrics.md, retro-protocol.md
>
> **Advisor Response 계약으로 반환:**
> 1. 호출 이력이 있는 부서장 목록 (예: product-strategy, backend-engineering, qa-strategy, product-analytics ...)
> 2. 각 부서장별 task_description 초안 + expected_output 경로
> 3. 병렬 vs 순차 권장
> 4. 50% 제출 CONDITIONAL-GO 조건 재확인
>
> spawn 지시 금지. 메인이 파싱 후 직접 병렬 호출합니다.

Bash로 agent_end를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1)
[ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "orchestrator-advisor-step3-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "Step 3 advisor 완료"
```

**CHAIN_VIOLATION 체크**: orchestrator 반환 내용 첫 줄에 "CHAIN_VIOLATION" 포함 시 즉시 중단 — agent_end status="error" + pipeline_end status="failed".

**Phase 3b: 메인이 부서장 병렬 spawn**

Advisor Response에서 반환된 참여 부서장 목록을 파싱 후, 메인이 다음을 수행합니다:
1. 부서장 전원의 `agent_start` Bash emit (병렬 호출 직전 일괄)
2. Task tool 병렬 호출 — 각 subagent_type은 `bams-plugin:{부서장명}`
3. 각 호출 종료 후 `agent_end` emit

각 부서장에게 전달할 공통 위임 메시지 템플릿:

> **KPT 제출 요청 — {부서명}**
>
> 컨텍스트: phase1-agent-metrics.md, phase1-pipeline-metrics.md, retro-protocol.md §3-1
>
> 대상 부서장 예시(Advisor가 동적 선정):
>
> 1. **product-strategy (기획부장)**: 기획 프로세스 KPT
>    ```
>    task_description: "기획 부서 관점 KPT 제출 — 기획 패턴, 요구사항 모호성, 의사결정 프로세스"
>    input_artifacts: [.crew/artifacts/retro/{slug}/phase1-agent-metrics.md]
>    expected_output: .crew/artifacts/retro/{slug}/phase2-kpt-product-strategy.md
>    quality_criteria:
>      - Keep/Problem/Try 각 섹션 존재
>      - 모든 Problem에 최소 1개의 Try 연결
>      - 정량 근거 포함 (지표 수치 인용)
>    ```
>
> 2. **backend-engineering (개발부장)**: 구현 프로세스 KPT
>    ```
>    task_description: "개발 부서 관점 KPT 제출 — 코드 품질, 구현 속도, 부서간 협업"
>    expected_output: .crew/artifacts/retro/{slug}/phase2-kpt-backend-engineering.md
>    ```
>
> 3. **qa-strategy (QA부장)**: 검증 프로세스 KPT
>    ```
>    task_description: "QA 부서 관점 KPT 제출 — 리뷰 품질, 테스트 커버리지, 결함 탐지율"
>    expected_output: .crew/artifacts/retro/{slug}/phase2-kpt-qa-strategy.md
>    ```
>
> 4. **product-analytics (평가부장)**: 평가 프로세스 KPT
>    ```
>    task_description: "평가 부서 관점 KPT 제출 — 지표 정확성, 벤치마크 활용도"
>    expected_output: .crew/artifacts/retro/{slug}/phase2-kpt-product-analytics.md
>    ```
>
> KPT 형식 (retro-protocol.md §3-1 준수):
> ```markdown
> ## KPT — {부서명} ({날짜})
> ### Keep
> - [항목] 내용 (근거: 정량 데이터 또는 구체적 사례)
> ### Problem
> - [항목] 내용 (영향: 지연 시간, 재작업 횟수, 품질 저하 정도)
> ### Try
> - [항목] 내용 (대상 Problem: #N, 예상 효과: ...)
> ```
>
> 참여 이력이 없는 부서장은 건너뜁니다. 50% 이상 제출 시 GO 처리합니다.
>
> **기대 산출물**: 참여 부서장별 `phase2-kpt-{부서명}.md`

(각 부서장 호출별 agent_end emit은 메인이 개별 수행)

---

## Step 4: KPT 종합 (2단 위임 — 루프 A)

**Phase 4a: Advisor 호출** — Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, 조언자 모드. 컨텍스트: phase2-kpt-*.md 전체, retro-protocol.md. Advisor Response: 병합/우선순위 전략, 교차 검증 항목, 담당자 할당 기준. spawn 지시 금지. (agent_start/end: `orchestrator-advisor-step4-{date}`)

**Phase 4b: 메인이 종합 직접 수행 또는 executive-reporter 위임**

Advisor가 별도 실행 에이전트를 지목하지 않은 경우 메인이 직접 수행:
1. 수집된 phase2-kpt-*.md 전체를 Read
2. 병합/우선순위 정렬/교차 검증
3. `.crew/artifacts/retro/{slug}/phase2-kpt-consolidated.md` Write

Advisor가 executive-reporter 등을 지목한 경우 해당 에이전트를 메인이 직접 spawn (agent_start/end emit은 대상 에이전트명으로).

참조 지시 원본:

> **Phase 2 KPT 종합 — 우선순위 결정 및 액션 아이템 확정**
>
> **위임 메시지:**
> ```
> phase: 2-synthesize
> slug: {slug}
> context:
>   kpt_files: .crew/artifacts/retro/{slug}/phase2-kpt-*.md
>   retro_protocol: plugins/bams-plugin/references/retro-protocol.md
> ```
>
> **수행할 작업:**
> 1. 수집된 모든 phase2-kpt-*.md를 병합
> 2. Problem 우선순위 정렬: 지연 시간 + 재작업 횟수 기반 영향도 산출
> 3. 각 Try에 담당 부서장 및 적용 시점 지정
> 4. 부서 간 교차 검증 — 한 부서의 Problem이 다른 부서의 Keep과 모순되지 않는지 확인
> 5. 액션 아이템 목록 확정 (담당자 + 시점 포함)
> ```
> expected_output: .crew/artifacts/retro/{slug}/phase2-kpt-consolidated.md
> quality_criteria:
>   - 모든 Problem에 최소 1개의 Try + 담당자 연결
>   - 우선순위 1-3위 Problem 명시
>   - 교차 검증 결과 포함
> ```
>
> **기대 산출물**: `.crew/artifacts/retro/{slug}/phase2-kpt-consolidated.md`

(agent_end emit은 메인이 실행 주체별로 수행)

KPT 종합 완료 후 사용자에게 다음을 제시합니다:
- Top 3 Problem 요약
- 확정된 액션 아이템 목록 (담당자, 적용 시점 포함)

Step 3-4 완료 시, Bash로 step_end를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 3 "done" {duration_ms}
```

---

## Phase 2 게이트

pipeline-orchestrator가 다음 조건을 확인합니다:

- [ ] 참여 부서장 50% 이상 KPT 제출 (`phase2-kpt-*.md` 파일 수 기준)
- [ ] `.crew/artifacts/retro/{slug}/phase2-kpt-consolidated.md` 생성 완료
- [ ] 모든 Problem에 Try 1개 이상 연결
- [ ] 액션 아이템 목록 확정 (담당자 + 적용 시점)

**결과 처리**:
- **GO**: 모든 조건 통과 → Phase 3 진행
- **CONDITIONAL-GO**: 50% 이상 제출, consolidated 생성 — 미제출 부서 "N/A" 기록 후 진행
- **NO-GO**: consolidated 미생성 또는 Problem에 Try 미연결 → 재작업 지시
