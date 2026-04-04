# HR Agent Best Practices

## Responsibility: 에이전트 생명주기 관리(정의/등록/평가/비활성화), 조직도 유지보수, 퍼포먼스 리포트

---

### 에이전트 설계 (design_agent)

**언제 참조:** pipeline-orchestrator가 새 에이전트가 필요하다고 판단하고 HR Agent에게 설계를 위임할 때

**협업 대상:**
- pipeline-orchestrator: 새 에이전트 필요성 판단 및 역할 요구사항 전달
- performance-evaluation: 기존 에이전트 성능 데이터 참조

**작업 절차:**
1. `jojikdo.json`을 Read하여 기존 조직도와 중복 역할이 없는지 확인한다
2. 요청된 역할을 분석하여 agent_id, responsibility, inputs, outputs, skills, agent_calls를 설계한다
3. `agents/*.md` 표준 형식으로 에이전트 정의서를 작성한다
4. `plugin.json` agents 배열에 새 에이전트를 추가한다
5. `jojikdo.json` 조직도에 부서 배치를 반영한다
6. `agents-config.ts` viz 설정에 에이전트를 등록한다

**산출물:** 에이전트 정의 파일 (`agents/{agent_id}.md`), 업데이트된 `plugin.json`, `jojikdo.json`, `agents-config.ts`

**주의사항:**
- 기존 에이전트와 역할이 중복되면 새 에이전트 생성 대신 기존 에이전트의 역할 확장을 검토한다
- 에이전트 이름은 `{역할}-{유형}` 패턴을 따른다 (예: `backend-engineering`, `qa-strategy`)
- disallowedTools는 반드시 명시한다 — 코드 수정이 불필요한 에이전트는 `Write, Edit`을 금지한다

---

### 조직도 관리 (manage_org_chart)

**언제 참조:** 에이전트 추가/이동/비활성화 시, 또는 조직 개편 시

**협업 대상:**
- pipeline-orchestrator: 조직 변경 사항을 파이프라인 라우팅에 반영
- cross-department-coordinator: 부서 간 협업 플로우 업데이트

**작업 절차:**
1. `jojikdo.json`의 현재 구조를 확인한다
2. 변경 사항(추가/이동/비활성화)을 적용한다
3. `org-gen.ts`의 `generateOrgChart()`를 실행하여 에러 없이 동작하는지 검증한다
4. 변경 전후 차이를 요약하고 pipeline-orchestrator에게 보고한다

**산출물:** 업데이트된 `jojikdo.json`, 변경 요약 보고

**주의사항:**
- 수정 전 반드시 `jojikdo.json`을 백업한다
- 비활성화 에이전트는 삭제하지 말고 `status: inactive`로 표시하여 이력을 보존한다
- 조직도 변경 후 `generateOrgChart()` 검증은 절대 생략하지 않는다

---

### 퍼포먼스 체크 (check_performance)

**언제 참조:** 주간 퍼포먼스 체크 스케줄, 또는 특정 에이전트의 성능 이슈 보고 시

**협업 대상:**
- performance-evaluation: 에이전트 성능 데이터 수집 협업
- executive-reporter: 퍼포먼스 리포트를 경영진 보고서에 포함
- pipeline-orchestrator: 저성능 에이전트 재설계 또는 교체 논의

**작업 절차:**
1. 이벤트 로그에서 에이전트별 호출 횟수, 성공률, 평균 소요 시간을 집계한다
2. 재시도 횟수가 높거나 실패율이 높은 에이전트를 식별한다
3. 저성능 원인을 분석한다: 역할 정의 불명확, 모델 부적합, 입력 품질 문제 등
4. 개선 방안(역할 재정의, 모델 변경, 위임 프로토콜 보완)을 제안한다
5. 퍼포먼스 리포트를 작성하고 pipeline-orchestrator에게 보고한다

**산출물:** 에이전트 퍼포먼스 리포트 (호출 통계, 저성능 에이전트 목록, 개선 방안)

**주의사항:**
- 단순 이벤트 로그 수치만으로 성능을 판단하지 말고 작업 복잡도를 함께 고려한다
- 에이전트 교체 결정은 pipeline-orchestrator와 합의 후에만 실행한다

---

### 회고 산출물 HR 변환 (retro_to_hr_conversion)

**언제 참조:** 파이프라인 회고 완료 후 에이전트 개선 사항을 HR 시스템에 반영할 때

**협업 대상:**
- pipeline-orchestrator: 회고 액션 아이템 수신
- 해당 에이전트: MEMORY.md 업데이트 지시

**작업 절차:**
1. `.crew/artifacts/retro/{slug}/` 에서 회고 산출물을 Read한다
2. 에이전트 개선 관련 액션 아이템을 추출한다
3. 각 에이전트의 `.crew/memory/{agent-id}/MEMORY.md`에 교훈을 기록하도록 지시한다
4. 글로벌 gotcha로 승격이 필요한 항목을 `.crew/gotchas.md`에 추가한다
5. 에이전트 정의 파일(`agents/*.md`) 수정이 필요한 항목을 식별하고 업데이트한다

**산출물:** HR 변환 완료 보고 (업데이트된 MEMORY.md 목록, gotchas 추가 건수, 에이전트 정의 변경 건수)

**주의사항:**
- MEMORY.md 기록 시 날짜와 파이프라인 slug를 반드시 포함한다
- 에이전트 정의 파일 변경은 조직도 변경과 동일한 검증 절차를 따른다
