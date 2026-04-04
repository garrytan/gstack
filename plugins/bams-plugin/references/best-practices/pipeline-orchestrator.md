# Pipeline Orchestrator Best Practices

## Responsibility: 모든 파이프라인의 단일 진입점 — Phase 위임, 게이트 판단, 롤백 결정, 회고 트리거

---

### 부서장 위임 및 조율 (delegate_to_department_head)

**언제 참조:** 커맨드로부터 Phase 실행 요청을 수신했을 때, 또는 새 Phase로 전환할 때

**협업 대상:**
- resource-optimizer: 파이프라인 시작 시 모델 선택과 병렬화 전략 조회
- cross-department-coordinator: 복수 부서 참여 시 인터페이스 정합성 조율
- executive-reporter: 위임 전 pipeline_start 이벤트 기록 요청

**작업 절차:**
1. 커맨드 위임 메시지에서 phase, slug, pipeline_type, context, constraints를 파싱한다
2. `.crew/artifacts/pipeline/` 에서 기존 진행 상태를 확인하여 중단 파이프라인 재개 여부를 판단한다
3. `pipeline_type`과 context 내용의 정합성을 검증한다 (hotfix인데 신규 기능 요청이면 재분류 제안)
4. resource-optimizer에게 모델 선택과 병렬화 전략을 조회한다
5. Phase의 작업 성격(태그, 파일 패턴)으로 부서장을 결정한다
6. viz `agent_start` 이벤트를 emit한 후 Agent tool로 부서장을 호출한다
7. 호출 완료 후 viz `agent_end` 이벤트를 emit한다

**산출물:** 부서장에게 전달된 위임 메시지(task_description, input_artifacts, expected_output, quality_criteria, constraints, gotchas 포함)

**주의사항:**
- 텍스트로 "위임한다"고 쓰는 것은 위임이 아니다 — 반드시 Agent tool 호출이 위임이다
- slug는 커맨드에서 받은 값을 그대로 사용한다. 자체 slug 생성 절대 금지
- 모든 Agent tool 호출 전후에 viz 이벤트를 빠짐없이 emit해야 한다

---

### Phase 게이트 판단 (evaluate_phase_gate)

**언제 참조:** 부서장으로부터 Phase 완료 보고를 수신했을 때

**협업 대상:**
- cross-department-coordinator: Phase 전환 핸드오프 조율 요청
- executive-reporter: GO/NO-GO 판단 결과와 다음 Phase 시작을 기록 요청

**작업 절차:**
1. 현재 Phase의 모든 필수 Step이 `done` 상태인지 확인한다
2. Critical 이슈가 0건인지 확인한다
3. 필수 산출물이 모두 생성되었는지 확인한다
4. 다음 Phase의 선행 조건이 충족되었는지 확인한다
5. tracking 파일에 현재 Phase 결과가 기록되었는지 확인한다
6. Phase별 추가 확인 항목을 검토한다 (예: Phase 2→3이면 빌드 성공, 타입 체크 통과, 린트 통과)
7. GO/NO-GO/CONDITIONAL-GO를 판단하고 근거를 기록한다

**산출물:** Gate Decision 문서 (상태, 근거, 체크리스트, 핸드오프 조율 내용 포함)

**주의사항:**
- CONDITIONAL-GO는 권장 미충족 항목이 있을 때 — 필수 항목 미충족은 반드시 NO-GO다
- NO-GO 시 재작업 지시는 최대 2회까지 동일 부서장에게 재위임한다
- 2회 재시도 후에도 실패하면 Phase 재설계를 검토하거나 사용자에게 에스컬레이션한다

---

### 병렬화 전략 수립 (plan_parallelization)

**언제 참조:** 대규모 파이프라인(예상 20회 이상 위임)을 시작할 때

**협업 대상:**
- resource-optimizer: 모델별 비용/속도/품질 트레이드오프 조회

**작업 절차:**
1. resource-optimizer에게 파이프라인 유형과 규모를 전달하여 전략을 조회한다
2. 독립적인 부서장 작업(의존성 없는 Phase)을 병렬 실행 그룹으로 분류한다
3. Phase별 최대 위임 횟수를 8회로 제한하여 컨텍스트 폭발을 방지한다
4. 중간 산출물을 Check Point로 설정하여 실패 시 전체 재시작을 방지한다
5. 병렬 호출 시 각 agent_start를 먼저 모두 emit한 후 Agent tool을 병렬 호출한다

**산출물:** Pipeline Plan 문서 (Phase/Step 테이블, 병렬화 구간, 모델 전략 포함)

**주의사항:**
- 병렬 실행 중 하나가 실패하면 의존하는 다른 그룹을 즉시 중단하고 롤백을 검토한다
- Cross-department 작업은 cross-department-coordinator를 통해 인터페이스를 먼저 합의한다

---

### 롤백 결정 (decide_rollback)

**언제 참조:** 부서장이 FAIL을 보고하거나 이상 징후(테스트 실패, 성능 저하, 보안 취약점)가 감지될 때

**협업 대상:**
- executive-reporter: 롤백 이벤트 기록 및 영향 분석 요청
- cross-department-coordinator: 다중 부서에 걸친 롤백 시 영향 범위 조율

**작업 절차:**
1. 실패 유형을 분류한다: recoverable(재시도 가능) vs. unrecoverable(롤백 필요)
2. recoverable이면 동일 부서장에게 피드백과 함께 재위임한다 (최대 2회)
3. unrecoverable이면 영향 범위를 분석한다: 현재 Phase만 vs. 이전 Phase까지
4. 롤백 시 보존해야 할 아티팩트를 식별한다
5. 롤백 후 재시작 지점을 명시하고 executive-reporter에게 롤백 이벤트를 기록 요청한다

**산출물:** 롤백 결정 문서 (실패 유형, 영향 범위, 보존 아티팩트, 재시작 지점 포함)

**주의사항:**
- 보안 Critical 발견 시 즉시 파이프라인을 중단하고 사용자에게 보고한다 — 재시도 없음
- 롤백 시 `.crew/artifacts/` 하위 아티팩트는 삭제하지 말고 `.bak` 접미사로 보존한다

---

### 회고 진행 (conduct_retrospective)

**언제 참조:** 파이프라인이 완료(정상 또는 실패)될 때 — 스킵 불가

**협업 대상:**
- executive-reporter: 정량 데이터 수집 (소요 시간, 성공률, 재시도 횟수, 트렌드)
- 참여한 모든 부서장: KPT(Keep/Problem/Try) 항목 제출 요청

**작업 절차:**
1. executive-reporter에게 정량 데이터 수집을 요청한다
2. 해당 파이프라인에 참여한 부서장들에게 KPT 항목 제출을 요청한다
3. 수집된 KPT를 종합하여 Problem을 우선순위로 정렬하고 액션 아이템을 확정한다
4. 에이전트 교훈을 각 에이전트의 MEMORY.md에 저장하도록 지시한다
5. 글로벌 gotcha 승격이 필요한 항목을 `.crew/gotchas.md`에 추가한다
6. tracking 파일의 retro 섹션에 결과를 기록한다

**산출물:** 회고 결과 요약 (정량 지표, KPT 요약, 액션 아이템, 피드백 반영 목록)

**주의사항:**
- 사용자가 명시적으로 "회고 건너뛰기"를 요청한 경우에만 스킵 가능
- 파이프라인 실패 완료인 경우에도 회고를 반드시 실행한다
- Pipeline Learnings 갱신은 `.crew/references/pipeline-learnings-taxonomy.md`를 참조한다
