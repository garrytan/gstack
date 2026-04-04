# Automation QA Best Practices

## Responsibility: UI E2E 자동화, API 통합 자동화, 자동화 안정화, 비주얼 회귀 테스트

---

### UI E2E 자동화 (automate_ui_e2e)

**언제 참조:** qa-strategy로부터 핵심 사용자 시나리오의 자동화 테스트 작성 위임을 받았을 때

**협업 대상:**
- qa-strategy: 자동화할 테스트 케이스 목록 수신
- frontend-engineering: UI 변경 시 테스트 업데이트 협업
- platform-devops: CI 파이프라인에 테스트 스위트 연동

**작업 절차:**
1. 기존 테스트 코드 구조를 Glob, Read로 파악하여 프로젝트 컨벤션을 따른다
2. 페이지 객체 패턴(POM)을 적용하여 UI 변경 시 테스트 수정 범위를 최소화한다
3. 하드코딩된 대기(sleep)를 지양하고 명시적 대기(waitFor, locator.waitFor)를 사용한다
4. 테스트 데이터를 독립적이고 재현 가능하게 관리한다 (Fixture, Factory 패턴)
5. 테스트 실행 결과를 구조화된 리포트로 생성한다

**산출물:** E2E 테스트 코드 (POM 구조), 테스트 데이터 Fixture, 실행 결과 리포트

**주의사항:**
- 테스트 간 공유 상태(shared state)를 만들지 않는다 — 각 테스트는 독립적으로 실행 가능해야 한다
- `sleep(3000)` 같은 하드코딩된 대기는 Flaky 테스트의 주요 원인이다 — 즉시 제거한다

---

### API 통합 자동화 (automate_api_integration)

**언제 참조:** REST/GraphQL API 엔드포인트의 자동화 검증이 필요할 때

**협업 대상:**
- backend-engineering: API 스키마 및 에러 코드 확인
- data-integration: 외부 서비스 Mocking 전략 협의

**작업 절차:**
1. backend-engineering의 API 계약 문서를 기반으로 테스트를 작성한다
2. 정상 응답(Happy Path)과 에러 응답(4xx, 5xx)을 모두 테스트한다
3. 외부 서비스 의존성은 Mock/Stub으로 대체하여 독립적인 테스트 환경을 구성한다
4. 경계값(빈 배열, 최대 페이지 크기, 특수 문자 입력)을 포함한다

**산출물:** API 테스트 스크립트, Mock 서버 설정

**주의사항:**
- Mock이 실제 외부 API와 다르게 동작하면 테스트가 통과해도 프로덕션에서 실패한다 — Mock 계약을 주기적으로 실제 API와 비교 검증한다
- 인증/인가 테스트를 별도 케이스로 포함한다

---

### 자동화 안정화 (stabilize_automation)

**언제 참조:** Flaky 테스트(간헐적 실패)가 발생하거나 CI 파이프라인의 신뢰도가 낮을 때

**협업 대상:**
- platform-devops: CI 환경 이슈(리소스 부족, 네트워크 불안정) 확인

**작업 절차:**
1. Flaky 테스트를 식별하고 실패율을 측정한다 (최근 10회 실행 중 실패 횟수)
2. 원인을 분류한다: 타이밍 이슈, 테스트 데이터 의존성, 환경 이슈, 실제 버그
3. 타이밍 이슈: 명시적 대기 조건으로 교체한다
4. 테스트 데이터 의존성: 테스트 데이터를 격리하고 독립적으로 생성한다
5. 환경 이슈: platform-devops와 함께 CI 환경을 개선한다

**산출물:** Flaky 테스트 목록, 원인 분석, 안정화 조치 보고서

**주의사항:**
- Flaky 테스트를 "가끔 실패하는 것"으로 방치하면 CI 신뢰도가 전체적으로 무너진다
- 실패율 5% 이상인 테스트는 우선 격리하고 즉시 수정에 착수한다

---

### 비주얼 회귀 테스트 (automate_visual_regression)

**언제 참조:** UI 변경이 디자인 시스템을 깨뜨리지 않는지 자동으로 검증할 때

**협업 대상:**
- ui-designer, design-system-agent: 허용 오차 기준 합의 및 기준 스크린샷 승인
- qa-strategy: 비주얼 회귀 테스트 전략 수신

**작업 절차:**
1. Percy, Chromatic, 또는 Playwright screenshot 중 프로젝트에 맞는 도구를 선택한다
2. 디자인 시스템 컴포넌트별 기준 스크린샷을 ui-designer 승인 후 등록한다
3. 허용 오차 기준을 ui-designer, design-system-agent와 합의하여 오탐(false positive)을 최소화한다
4. PR마다 시각적 차이를 감지하여 리포트를 생성한다
5. 변경이 의도적인 경우 기준 스크린샷을 업데이트한다 (ui-designer 승인 필수)

**산출물:** 비주얼 회귀 테스트 설정, 기준 스크린샷 세트, PR별 시각적 차이 리포트

**주의사항:**
- 기준 스크린샷 업데이트는 ui-designer의 승인 없이 임의로 하지 않는다
- 허용 오차를 너무 높게 설정하면 실제 회귀를 놓치고, 너무 낮으면 오탐이 많아진다 — 적절한 균형을 찾는다
