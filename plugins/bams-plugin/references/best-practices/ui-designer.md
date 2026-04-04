# UI Designer Best Practices

## Responsibility: 레이아웃 설계, 반응형 디자인, 컴포넌트 라이브러리, 디자인 토큰 준수

---

### 레이아웃 설계 (layout_design)

**언제 참조:** ux-designer의 와이어프레임을 받아 고충실도 레이아웃을 설계할 때

**협업 대상:**
- ux-designer: 와이어프레임 및 정보 구조 수신 — 반드시 와이어프레임을 입력으로 받은 후 시작
- design-system-agent: 그리드 시스템, 스페이싱 토큰 기준 확인
- design-director: 크리에이티브 방향(무드보드, 스타일 가이드) 확인

**작업 절차:**
1. ux-designer의 와이어프레임을 반드시 먼저 확인한다 — 와이어프레임 없이 고충실도 UI를 먼저 설계하지 않는다
2. design-director의 스타일 가이드와 2026 트렌드(Bento Grid, Glassmorphism 등)를 참조하여 레이아웃 방향을 결정한다
3. 그리드 시스템을 기반으로 정보 위계와 시각적 흐름을 최적화한다
4. Figma Auto Layout으로 컴포넌트를 구조화한다

**산출물:** 고충실도 레이아웃 파일 (Figma)

**주의사항:**
- 트렌드 적용 시 접근성(명도 대비 WCAG 2.2 AA 4.5:1) 기준을 먼저 검토한다
- 레이아웃 설계 후 design-director의 품질 게이트 검토를 받는다

---

### 반응형 디자인 (responsive_design)

**언제 참조:** 모바일/태블릿/데스크톱에서 동작하는 UI를 설계할 때

**협업 대상:**
- frontend-engineering: 브레이크포인트별 구현 방식 합의
- design-system-agent: 반응형 토큰(스페이싱 스케일) 확인

**작업 절차:**
1. 4가지 브레이크포인트를 커버한다: 모바일(360px), 태블릿(768px), 데스크톱(1280px), 와이드(1920px)
2. 각 브레이크포인트에서 레이아웃 변환 방식을 명세한다 (컬럼 수, 컴포넌트 크기 변화, 숨김/표시)
3. 모바일 퍼스트로 설계한다 — 모바일에서 시작하여 점진적으로 확장한다
4. 터치 인터랙션을 고려한다 (터치 타겟 최소 44×44px)

**산출물:** 브레이크포인트별 레이아웃 스펙 (Figma 각 프레임)

**주의사항:**
- 각 브레이크포인트에서 모든 컴포넌트의 상태(Normal/Hover/Disabled 등)가 정의되어 있는지 확인한다
- "데스크톱 축소판"이 아닌 각 화면 크기에 최적화된 레이아웃을 설계한다

---

### 컴포넌트 라이브러리 (build_component_library)

**언제 참조:** 새 컴포넌트를 디자인 시스템에 추가하거나 기존 컴포넌트를 업데이트할 때

**협업 대상:**
- design-system-agent: 디자인 토큰 적용 및 컴포넌트 등록
- frontend-engineering: 컴포넌트 구현 스펙 전달 — props 인터페이스, 상태 목록
- ux-designer: 컴포넌트 인터랙션 상태 정의 수신

**작업 절차:**
1. Atomic Design 원칙에 따라 Atom → Molecule → Organism 계층을 정의한다
2. 각 컴포넌트의 변형(variant), 상태(state), 크기(size)를 Figma Auto Layout으로 정의한다
3. 모든 컴포넌트에 Normal, Hover, Active, Disabled, Focus 상태를 빠짐없이 정의한다
4. 다크 모드와 라이트 모드를 설계 초기부터 함께 고려한다
5. design-system-agent에게 컴포넌트를 등록하고 토큰 매핑을 확인한다

**산출물:** 컴포넌트 라이브러리 Figma 파일, 각 컴포넌트의 변형/상태 명세

**주의사항:**
- 5가지 상태(Normal/Hover/Active/Disabled/Focus) 중 하나라도 누락되면 frontend 구현에서 빠진다
- 컴포넌트 이름을 design-system-agent 및 frontend-engineering과 동일하게 맞춰야 한다

---

### AI 도구 활용 (use_ai_tools)

**언제 참조:** UI 초안을 빠르게 생성하거나 반복 작업을 자동화할 때

**협업 대상:**
- design-director: AI 생성 결과가 브랜드 가이드라인에 부합하는지 검토 요청

**작업 절차:**
1. Galileo AI로 UI 초안을 생성한다 (화면 설명을 구체적으로 입력할수록 품질이 높다)
2. Figma AI로 반복 작업(레이아웃 제안, 컴포넌트 자동 완성)을 자동화한다
3. AI 생성 결과를 디자인 원칙과 브랜드 가이드라인에 맞게 큐레이션하고 정제한다
4. AI 생성 결과임을 명시하고 design-director의 검토를 받는다

**산출물:** 큐레이션된 AI 생성 UI 초안

**주의사항:**
- AI 생성 결과를 검토 없이 그대로 사용하지 않는다 — 반드시 브랜드 가이드라인에 맞게 편집한다
- 라이선스가 불명확한 AI 도구로 생성한 에셋은 사용하지 않는다
