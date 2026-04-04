# Design System Agent Best Practices

## Responsibility: 디자인 토큰 시스템, Figma Variables 변환, 컴포넌트 토큰, 디자인 시스템 문서화, 에셋 관리

---

### 디자인 토큰 시스템 관리 (manage_design_token_system)

**언제 참조:** 새 토큰을 추가하거나 기존 토큰을 수정할 때, 또는 토큰 시스템 초기 구축 시

**협업 대상:**
- design-director: 신규 토큰 추가 승인
- ui-designer: 컴포넌트에서 사용할 토큰 확인 및 적용 지원
- frontend-engineering: CSS Custom Properties 및 TypeScript 상수로 변환하여 제공

**작업 절차:**
1. 3계층 구조를 준수한다: 글로벌 토큰(Primitive) → 시맨틱 토큰(Semantic) → 컴포넌트 토큰(Component)
2. 토큰 이름은 `{category}-{property}-{variant}-{state}` 패턴을 따른다
   - 예: `color-background-primary`, `color-text-muted`, `spacing-component-gap-md`
3. 절대값(hex, px)은 Primitive 토큰에만 사용한다 — Semantic/Component 토큰은 참조 형식
4. 다크 모드 토큰은 별도 세트가 아닌 동일 시맨틱 토큰에 다크 모드 값을 매핑한다
5. 신규 토큰 추가 시 design-director에게 승인을 받은 후 등록한다

**산출물:** 토큰 정의 파일 (JSON, CSS Custom Properties, TypeScript 상수)

**주의사항:**
- Semantic/Component 토큰에 절대값을 직접 입력하면 테마 변경 시 전체 수동 수정이 필요하다
- 토큰 이름 변경 시 모든 사용 위치를 업데이트하고 frontend-engineering에게 통보한다

---

### Figma Variables 변환 (sync_figma_variables)

**언제 참조:** Figma에서 디자인 토큰이 변경된 후 코드에 반영할 때

**협업 대상:**
- ui-designer: Figma Variables 변경 사항 수신
- frontend-engineering: 변환된 토큰 파일을 코드베이스에 반영

**작업 절차:**
1. Figma Variables를 JSON 형식으로 추출한다 (Tokens Studio 또는 Style Dictionary 사용)
2. JSON을 CSS Custom Properties와 TypeScript 상수(타입 포함)로 변환하는 스크립트를 실행한다
3. 변환 결과를 이전 버전과 비교하여 의도하지 않은 변경이 없는지 확인한다
4. 변환된 파일을 frontend-engineering에게 전달한다

**산출물:** 변환된 토큰 파일 (CSS Variables, TypeScript 상수), 변경 사항 요약

**주의사항:**
- 변환 스크립트를 수동으로 수정하지 않는다 — 스크립트 변경은 design-director와 합의한다
- 토큰 변경이 기존 컴포넌트 스타일에 미치는 영향을 변경 전에 시각적으로 검토한다

---

### 컴포넌트 토큰 정의 (define_component_tokens)

**언제 참조:** 새 컴포넌트를 디자인 시스템에 추가하거나 기존 컴포넌트 토큰을 수정할 때

**협업 대상:**
- ui-designer: 컴포넌트 디자인 스펙 수신
- frontend-engineering: 컴포넌트 토큰을 CSS 변수로 구현

**작업 절차:**
1. 컴포넌트의 디자인 속성을 토큰으로 추상화한다
2. 컴포넌트 네임스페이스를 사용한다: `button-primary-bg`, `input-border-focus`
3. 컴포넌트 토큰은 반드시 Semantic 토큰을 참조하도록 한다 (절대값 사용 금지)
4. 테마 커스터마이징이 필요한 컴포넌트는 컴포넌트 토큰을 통해 오버라이드 가능하게 설계한다

**산출물:** 컴포넌트 토큰 정의 파일

**주의사항:**
- 컴포넌트 토큰이 Semantic 토큰을 거치지 않고 Primitive를 직접 참조하면 테마 변경이 불가능해진다
- 동일 컴포넌트의 서로 다른 variant는 동일한 컴포넌트 토큰을 공유해야 한다

---

### 디자인 시스템 문서화 (document_design_system)

**언제 참조:** 새 컴포넌트를 추가하거나 기존 컴포넌트 가이드라인을 업데이트할 때

**협업 대상:**
- ui-designer: 컴포넌트 사용 목적 및 DO/DON'T 예시 수신
- frontend-engineering: Storybook story 파일 구조 가이드 제공

**작업 절차:**
1. 각 컴포넌트의 사용 목적, variant 목록, props 인터페이스를 문서화한다
2. DO/DON'T 예시를 포함하여 잘못된 사용을 예방한다
3. 접근성 고려사항(ARIA 역할, 키보드 인터랙션)을 명시한다
4. Storybook story 파일 구조 가이드를 포함한다

**산출물:** 컴포넌트 문서 (목적, variant, props, DO/DON'T, 접근성)

**주의사항:**
- 문서에 예시 코드가 없으면 개발자가 잘못 사용하는 경우가 많다 — 올바른 사용 예시를 반드시 포함한다
- 문서는 컴포넌트 변경 시 즉시 업데이트한다 — 오래된 문서는 없는 것보다 해롭다

---

### 에셋 레지스트리 관리 (manage_asset_registry)

**언제 참조:** graphic-designer가 제작한 에셋을 디자인 시스템에 등록할 때

**협업 대상:**
- graphic-designer: 아이콘, 일러스트레이션, 이미지 에셋 수신
- frontend-engineering: 에셋 경로와 사용 방법 전달

**작업 절차:**
1. 에셋의 이름, 경로, 버전, 라이선스를 레지스트리에 기록한다
2. 에셋 카테고리(아이콘/일러스트/이미지/폰트)별로 분류한다
3. 사용 예시와 접근성 속성(alt 텍스트, aria-label)을 문서화한다
4. 에셋 업데이트 시 버전을 명시하고 변경 이력을 기록한다

**산출물:** 에셋 레지스트리 파일 (이름, 경로, 버전, 라이선스, 사용 예시)

**주의사항:**
- 라이선스가 명확하지 않은 에셋은 등록하지 않는다 — 법적 리스크를 초래할 수 있다
- 에셋 경로 변경 시 frontend-engineering에게 즉시 통보한다
