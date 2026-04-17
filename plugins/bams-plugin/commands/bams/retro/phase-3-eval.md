# Retro: Phase 3 — 에이전트 평가

> 이 파일은 `/bams:retro`의 Phase 3를 실행합니다.
> 공통 규칙은 `_common.md`를 참조합니다.

## 입력 컨텍스트
- slug: {엔트리포인트에서 결정된 retro slug}
- TARGET_SCOPE: {recent5 / all / slug:{값} / since_{N}d}
- Phase 1-2 산출물:
  - `.crew/artifacts/retro/{slug}/phase1-pipeline-metrics.md`
  - `.crew/artifacts/retro/{slug}/phase1-agent-metrics.md`
  - `.crew/artifacts/retro/{slug}/phase2-kpt-consolidated.md`
  - `.crew/artifacts/retro/{slug}/phase2-kpt-{부서명}.md` (참여 부서장별)

---

## Phase 3: 에이전트 평가

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 5 "에이전트 평가 (정량 + 정성 병렬)" "Phase 3: 에이전트 평가"
```

---

## Step 5: 정량 평가 (평가부장 1회 호출 → 내부 specialist spawn)

**2단 위임 — 루프 A**: orchestrator 조언 → 메인이 product-analytics(평가부장) 1회 직접 spawn. 평가부장이 내부적으로 performance-evaluation, business-kpi를 specialist로 spawn.

**Step 5a: Advisor 호출** — Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, 조언자 모드. 컨텍스트: phase1-pipeline-metrics.md, phase1-agent-metrics.md, phase2-kpt-consolidated.md, 이전 retro 디렉터리. Advisor Response: product-analytics(부서장)에게 전달할 task_description·quality_criteria·등급 기준 검증, 베이스라인 처리 규칙. spawn 지시 금지. (agent_start/end: `orchestrator-advisor-step5-{date}`)

**Step 5b: 메인이 product-analytics(평가부장) 1회 spawn**

Bash로 agent_start를 emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1)
[ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "product-analytics-5-$(date -u +%Y%m%d)" "product-analytics" "claude-opus-4-7[1m]" "Step 5: 정량 평가 (부서장 → specialist 내부 spawn)"
```

Task tool, subagent_type: **"bams-plugin:product-analytics"**, model: **"claude-opus-4-7[1m]"** — 평가부장이 내부적으로 performance-evaluation, business-kpi를 최대 1회씩 추가 spawn(harness 깊이 2 한도). 위임 메시지는 아래 원본을 따릅니다:

> **Phase 3 Step 5 — 정량 평가 3에이전트 병렬 실행**
>
> 컨텍스트:
>   pipeline_metrics: .crew/artifacts/retro/{slug}/phase1-pipeline-metrics.md
>   agent_metrics: .crew/artifacts/retro/{slug}/phase1-agent-metrics.md
>   kpt_consolidated: .crew/artifacts/retro/{slug}/phase2-kpt-consolidated.md
>   previous_retro_reports: .crew/artifacts/retro/ (이전 retro slug 디렉터리, 존재 시)
>
> **3개 에이전트 개별 위임 내역:**
>
> **1. product-analytics: 종합 등급 산출 (A/B/C/D)**
> ```
> task_description: "에이전트별 정량 평가 등급을 산출하라"
> input_artifacts:
>   - .crew/artifacts/retro/{slug}/phase1-agent-metrics.md
> expected_output:
>   type: quantitative_eval_report
>   path: .crew/artifacts/retro/{slug}/phase3-quantitative-eval.md
> quality_criteria:
>   - 에이전트별 종합 등급 (A/B/C/D) 명시
>   - 등급 산출 근거: 성공률 40% + 속도 30% + 재시도율 30% 가중 평균
>   - 부서별 비교 섹션 포함
>   - 전체 순위표 포함
> 등급 기준:
>   A: 성공률 ≥95%, 기준 시간 이하, 재시도율 <5%
>   B: 성공률 85-94%, 기준 시간 ±20%, 재시도율 5-15%
>   C: 성공률 70-84%, 기준 시간 +20-50%, 재시도율 15-30%
>   D: 성공률 <70%, 기준 시간 +50% 초과, 재시도율 >30%
> ```
>
> **2. performance-evaluation: 성능 벤치마크 비교**
> ```
> task_description: "이전 retro 대비 성능 추세를 분석하라"
> input_artifacts:
>   - .crew/artifacts/retro/{slug}/phase1-pipeline-metrics.md
>   - .crew/artifacts/retro/ (이전 retro 디렉터리, 존재 시 최근 3회)
> expected_output:
>   type: performance_eval_report
>   path: .crew/artifacts/retro/{slug}/phase3-performance-eval.md
> quality_criteria:
>   - 에이전트별 응답 시간 분포 (최소/중앙/최대/p95)
>   - 이상치 탐지 (평균 대비 2σ 초과 항목)
>   - 이전 retro 대비 개선/악화 추세 (20% 이상 변화 시 주석)
>   - 이전 retro 없으면 "비교 기준 없음 — 현재 측정값으로 베이스라인 수립" 기록
> ```
>
> **3. business-kpi: 비용 효율 분석**
> ```
> task_description: "토큰 사용량과 비용 효율을 분석하라"
> input_artifacts:
>   - .crew/artifacts/retro/{slug}/phase1-agent-metrics.md
> expected_output:
>   type: cost_eval_report
>   path: .crew/artifacts/retro/{slug}/phase3-cost-eval.md
> quality_criteria:
>   - 에이전트별 토큰 사용량 추정 (메타데이터 가용 시 실측, 불가 시 "데이터 없음")
>   - 파이프라인 총 토큰 추정 합산
>   - 비용 대비 가치 평가 (산출물 품질 대비 토큰 소모)
>   - 고비용 에이전트 식별 및 최적화 제안
>   - 토큰 데이터 없을 경우: "토큰 메타데이터 미수집 — Phase 3 비용 섹션 N/A" 명시
> ```
>
> **기대 산출물**:
> - `.crew/artifacts/retro/{slug}/phase3-quantitative-eval.md`
> - `.crew/artifacts/retro/{slug}/phase3-performance-eval.md`
> - `.crew/artifacts/retro/{slug}/phase3-cost-eval.md`

호출 종료 후, 메인이 agent_end를 emit합니다 (`product-analytics-5`). product-analytics 부서장이 내부적으로 performance-evaluation, business-kpi specialist를 spawn하여 3개 산출물을 모두 생성합니다.

---

## Step 6: 정성 평가 (각 부서장 병렬, 2단 위임 — 루프 B)

**Step 6a: Advisor 호출 (참여 부서장 동적 결정)**

Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, 조언자 모드. (agent_start/end: `orchestrator-advisor-step6-{date}`)

> **조언자 요청 — Phase 3 Step 6 정성 평가 참여 부서장 결정**
>
> 컨텍스트: phase1-agent-metrics.md, phase3-quantitative-eval.md, agents 정의 디렉터리, phase2-kpt-{부서명}.md
>
> **Advisor Response 반환 항목:**
> 1. 호출 이력이 있는 에이전트의 소속 부서장 목록 (동적)
> 2. 각 부서장별 task_description + input_artifacts + expected_output 경로
> 3. 병렬 호출 그룹(소수 부서는 단일 그룹, 많으면 배치 분할)
> 4. 정량/정성 불일치 검증 지시
>
> spawn 지시 금지. 메인이 파싱 후 각 부서장을 직접 병렬 spawn합니다.

**Step 6b: 메인이 부서장 병렬 spawn**

Advisor Response의 부서장 목록을 파싱하여:
1. 전원의 `agent_start`를 Bash로 일괄 emit (각 ID: `{부서장명}-6-{date}`)
2. Task tool 병렬 호출 (subagent_type: `bams-plugin:{부서장명}`)
3. 각 호출 완료 후 `agent_end` emit

각 부서장 위임 메시지(공통 템플릿) — 원본:

> **Phase 3 Step 6 — 정성 평가 (자기 부서 관점)**
>
> **위임 메시지:**
> ```
> phase: 3-step6
> slug: {slug}
> pipeline_type: retro
> context:
>   agent_metrics: .crew/artifacts/retro/{slug}/phase1-agent-metrics.md
>   quantitative_eval: .crew/artifacts/retro/{slug}/phase3-quantitative-eval.md
>   agent_defs_dir: plugins/bams-plugin/agents/
>   kpt_dir: .crew/artifacts/retro/{slug}/  (phase2-kpt-{부서명}.md 파일들)
> ```
>
> **수행할 작업:**
>
> phase1-agent-metrics.md에서 호출된 에이전트 목록을 확인하고,
> 해당 에이전트를 보유한 부서장들에게 병렬로 정성 평가를 요청합니다.
> (agent_start를 먼저 모두 emit한 뒤 병렬 호출)
>
> **각 부서장 위임 메시지 (공통 형식):**
> ```
> task_description: "자기 부서 에이전트에 대한 정성 평가를 수행하라"
> input_artifacts:
>   - .crew/artifacts/retro/{slug}/phase1-agent-metrics.md
>   - .crew/artifacts/retro/{slug}/phase2-kpt-{부서명}.md  (존재 시)
>   - .crew/artifacts/retro/{slug}/phase3-quantitative-eval.md
>   - plugins/bams-plugin/agents/{에이전트명}.md  (자기 부서 에이전트 정의 파일)
> expected_output:
>   type: qualitative_eval_report
>   path: .crew/artifacts/retro/{slug}/phase3-qualitative-{부서명}.md
> quality_criteria:
>   - 에이전트 정의 파일(agents/*.md) Read하여 프롬프트 분석
>   - 강점/약점/개선점 평가 (각 항목 근거 포함)
>   - 4개 지표 각 5점 척도 평가:
>       산출물 품질: 실제 산출물 수준
>       요구사항 이해도: 재작업 횟수 기반
>       협업 원활도: 인터페이스 충돌 횟수
>       프롬프트 명확도: 에스컬레이션 횟수 기반
>   - 프롬프트 품질 3축 평가:
>       명확성: 역할과 지시가 모호하지 않은가
>       범위 적절성: 위임 범위가 과대/과소하지 않은가
>       학습 교훈 활용도: 이전 교훈이 행동에 반영되었는가
>   - 정량 등급(phase3-quantitative-eval.md)과 정성 평가 간 불일치 시 근거 설명
> ```
>
> **대상 부서장 목록 (phase1-agent-metrics.md 기반으로 참여 확인):**
> - product-strategy (기획부)
> - frontend-engineering (개발부-프론트)
> - backend-engineering (개발부-백엔드)
> - platform-devops (개발부-플랫폼)
> - data-integration (개발부-데이터)
> - qa-strategy (QA부)
> - product-analytics (평가부)
> - design-director (디자인부)
>
> **기대 산출물**: `.crew/artifacts/retro/{slug}/phase3-qualitative-{부서명}.md` (참여 부서장별)

(각 부서장 호출별 agent_end emit은 메인이 개별 수행)

---

## Phase 3 게이트

다음 조건을 확인합니다:

**필수 (GO 조건):**
- `.crew/artifacts/retro/{slug}/phase3-quantitative-eval.md` 존재
- 등급이 A~D 중 하나로 모든 호출된 에이전트에 부여됨

**권장 (CONDITIONAL-GO 허용):**
- `phase3-performance-eval.md` 존재 (이전 retro 없을 경우 베이스라인 수립으로 대체)
- `phase3-cost-eval.md` 존재 (토큰 데이터 없을 경우 "N/A" 처리로 대체)
- `phase3-qualitative-{부서명}.md` — 참여 부서장 중 50% 이상 제출

**결과 처리:**
- **GO**: 모든 필수 조건 통과 → Phase 4로 진행
- **CONDITIONAL-GO**: 필수 통과, 권장 미충족 → 이슈 목록 기록 후 Phase 4 진행
- **NO-GO**: 필수 미충족 → Step 5 재실행 지시

Phase 3 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 5 "done" {duration_ms}
```
