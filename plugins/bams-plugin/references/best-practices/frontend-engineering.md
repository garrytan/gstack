# Frontend Engineering Best Practices

## Responsibility: UI 컴포넌트 구현, 클라이언트 플로우 제어, 프론트엔드 품질 최적화

---

### UI 컴포넌트 구현 (implement_ui_components)

**언제 참조:** pipeline-orchestrator 또는 design-director로부터 UI 구현 작업을 위임받았을 때

**협업 대상:**
- ui-designer: 컴포넌트 스펙 및 디자인 토큰 수신 — 구현 전 반드시 Figma 스펙을 확인
- design-system-agent: 디자인 토큰(색상, 타이포그래피, 스페이싱) 적용 기준 확인
- ux-designer: 인터랙션 플로우 및 상태 정의(Normal, Hover, Active, Disabled, Focus) 확인
- backend-engineering: API 인터페이스 합의 — 요청/응답 스키마, 에러 코드 체계

**작업 절차:**
1. 기존 컴포넌트 구조를 Glob, Read로 파악하여 프로젝트 컨벤션을 따른다
2. ui-designer의 Figma 스펙에서 컴포넌트 변형(variant), 상태(state), 크기(size)를 확인한다
3. 단일 책임 원칙에 따라 컴포넌트를 설계하고 props 인터페이스를 명확히 정의한다
4. 시각적 상태(로딩, 에러, 빈 상태, 성공)를 빠짐없이 처리한다
5. WAI-ARIA 표준을 준수하여 접근성을 확보한다
6. 작업 완료 시 viz `agent_end` 이벤트를 emit한다

**산출물:** 구현된 컴포넌트 파일, 타입 정의, 접근성 속성 포함

**주의사항:**
- 디자인 스펙 없이 컴포넌트를 먼저 구현하지 않는다 — ui-designer의 스펙을 반드시 입력으로 받는다
- 하드코딩된 스타일 값(색상 hex, px 수치)은 디자인 토큰으로 대체한다
- 모든 컴포넌트에 5가지 상태(Normal/Hover/Active/Disabled/Focus)를 반드시 구현한다

---

### 클라이언트 플로우 제어 (orchestrate_client_flow)

**언제 참조:** 가입, 결제, 조회 등 다단계 사용자 플로우를 구현할 때

**협업 대상:**
- ux-designer: 플로우 다이어그램과 엣지 케이스(빈 상태, 에러, 권한 없음) 수신
- backend-engineering: API 에러 코드와 재시도 정책 합의
- data-integration: 이벤트 트래킹 삽입 위치 및 페이로드 합의

**작업 절차:**
1. ux-designer의 플로우 다이어그램에서 모든 분기와 엣지 케이스를 확인한다
2. 각 단계 간 전환 조건을 명확히 구현한다
3. 에러 복구 경로(재시도, 이전 단계 복귀)를 포함한다
4. 이탈 방지 로직(미저장 데이터 경고, 진행 상태 유지)을 구현한다
5. 상태 유실 없이 플로우가 완결되도록 보장한다

**산출물:** 플로우 구현 코드, 에러 처리 로직, 상태 관리 코드

**주의사항:**
- 플로우 중간 이탈 시 사용자 입력 데이터를 유실하지 않도록 임시 저장 로직을 포함한다
- 네트워크 에러 발생 시 사용자에게 명확한 피드백을 제공한다

---

### 프론트엔드 품질 최적화 (optimize_frontend_quality)

**언제 참조:** 빌드 후 성능 측정 결과가 기준치 미달일 때, 또는 정기적인 품질 점검 시

**협업 대상:**
- performance-evaluation: LCP, FID, CLS 등 Core Web Vitals 기준치 확인
- platform-devops: 빌드/배포 파이프라인에서 성능 메트릭 수집
- automation-qa: 성능 회귀 테스트 연동

**작업 절차:**
1. 불필요한 리렌더링을 제거한다 (React.memo, useMemo, useCallback 적절 사용)
2. 코드 스플리팅을 적용하여 초기 번들 크기를 최소화한다
3. 이미지 최적화(WebP 변환, lazy loading, srcset)를 적용한다
4. WAI-ARIA 표준 준수 여부를 점검한다
5. Core Web Vitals(LCP < 2.5s, FID < 100ms, CLS < 0.1) 달성 여부를 측정한다

**산출물:** 최적화 적용 코드, 전후 성능 측정 수치

**주의사항:**
- 최적화 전 수치와 후 수치를 반드시 비교하여 효과를 정량화한다
- 과도한 최적화(premature optimization)를 피한다 — 측정 먼저, 최적화는 그 다음이다
