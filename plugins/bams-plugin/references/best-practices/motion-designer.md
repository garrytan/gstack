# Motion Designer Best Practices

## Responsibility: Rive 기반 애니메이션, 마이크로인터랙션, 스크롤 스토리텔링, 트랜지션 설계, 모션 언어 수립

---

### Rive 기반 애니메이션 (create_rive_animation)

**언제 참조:** 상태 머신 기반 인터랙티브 애니메이션이 필요할 때 (버튼 전환, 로딩 인디케이터 등)

**협업 대상:**
- design-director: 모션 언어 및 브랜드 가이드라인 확인
- frontend-engineering: `.riv` 파일 전달 및 Rive 런타임 연동 협의
- ui-designer: 애니메이션 대상 컴포넌트 스펙 확인

**작업 절차:**
1. 애니메이션의 목적을 먼저 정의한다 (피드백, 방향 제시, 상태 변화 알림 등)
2. Rive State Machine으로 상태 전이를 설계한다 (Idle → Hover → Active → Success 등)
3. 12 Principles of Animation에서 Ease In/Out, Anticipation을 기본 원칙으로 적용한다
4. 과도한 애니메이션을 경계한다 — 동시에 움직이는 요소는 최대 3개로 제한한다
5. `.riv` 파일을 frontend-engineering에게 전달하고 Rive 런타임 API 연동을 협의한다

**산출물:** `.riv` 파일, 상태 머신 설계 문서, Rive API 연동 스펙

**주의사항:**
- 모든 애니메이션의 목적을 명세에 기록한다 — "예쁘게 보이려고" 는 목적이 아니다
- `prefers-reduced-motion` 미디어 쿼리 대응 버전(정지 상태)을 반드시 포함한다

---

### 마이크로인터랙션 설계 (design_microinteraction)

**언제 참조:** 버튼, 폼, 알림 등 사용자 행동에 반응하는 세밀한 애니메이션을 설계할 때

**협업 대상:**
- ux-designer: 인터랙션 트리거 조건 및 사용자 플로우 확인
- frontend-engineering: CSS/JavaScript로 구현 가능한 수준의 스펙으로 전달

**작업 절차:**
1. 트리거(클릭, 호버, 포커스, 스크롤)에 따른 반응을 정의한다
2. 모션 타이밍 스케일을 적용한다: Instant(0ms), Fast(150ms), Normal(300ms), Slow(500ms)
3. 애니메이션이 사용자의 이해를 돕는지 확인한다 — 순수 장식 목적의 애니메이션은 제거한다
4. Figma 프로토타입으로 구현 전 시뮬레이션을 제공한다

**산출물:** 마이크로인터랙션 스펙 (트리거, easing, duration, keyframe 정의), Figma 프로토타입

**주의사항:**
- 애니메이션이 메인 콘텐츠보다 오래 재생되면 사용자 이탈이 발생한다 — duration을 최소화한다
- 성능 영향을 고려한다 — `transform`과 `opacity`만 변경하는 애니메이션을 우선 사용한다 (Compositor Layer)

---

### 스크롤 스토리텔링 (design_scroll_storytelling)

**언제 참조:** 랜딩 페이지, 온보딩 플로우의 몰입감을 높이는 스크롤 기반 시각 내러티브를 설계할 때

**협업 대상:**
- ux-designer: 랜딩 페이지 플로우 및 핵심 메시지 전달 순서 확인
- frontend-engineering: Scroll-linked animation 구현 방식 (IntersectionObserver, ScrollTimeline API) 합의

**작업 절차:**
1. 스크롤 위치에 따른 콘텐츠 노출 순서를 스토리보드로 작성한다
2. Parallax, Reveal on scroll, Scroll-linked animation 패턴 중 적합한 것을 선택한다
3. 각 구간의 진입/이탈 트리거 스크롤 위치(%)를 명세한다
4. 모바일에서의 스크롤 성능을 고려하여 GPU 가속 속성만 사용한다

**산출물:** 스크롤 스토리텔링 스토리보드, 구간별 애니메이션 스펙

**주의사항:**
- `prefers-reduced-motion`이 활성화된 경우 스크롤 애니메이션을 즉시 표시로 대체한다
- 모바일에서 Parallax는 성능 문제를 유발할 수 있다 — 모바일에서는 간소화된 버전을 제공한다

---

### 모션 언어 수립 (establish_motion_language)

**언제 참조:** 새 제품 또는 새 브랜드 아이덴티티를 위한 모션 시스템을 처음 구축할 때

**협업 대상:**
- design-director: 브랜드 가이드라인과 모션 언어 정렬
- design-system-agent: 모션 토큰(easing, duration) 토큰 시스템에 등록
- frontend-engineering: 모션 토큰을 CSS 변수로 구현

**작업 절차:**
1. easing curve를 브랜드 성격에 맞게 정의한다 (친근함 → ease-in-out, 전문성 → linear 등)
2. duration scale을 정의한다: Instant(0ms), Fast(150ms), Normal(300ms), Slow(500ms), Deliberate(800ms)
3. 각 duration을 맥락에 매핑한다 (마이크로인터랙션 → Fast, 화면 전환 → Normal)
4. design-system-agent에게 모션 토큰 등록을 요청한다

**산출물:** 모션 언어 가이드 (easing curve, duration scale, 맥락별 매핑)

**주의사항:**
- 800ms 이상의 Deliberate 애니메이션은 사용자가 "느리다"고 느끼는 구간이다 — 적재적소에만 사용한다
- 모션 언어는 design-director의 승인 후 design-system-agent에 등록한다
