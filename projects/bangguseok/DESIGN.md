# 방구석 사진관 — Design System

> **Aesthetic: Morning Studio (아침 사진관)**
> 따뜻한 자연광이 들어오는 사진관.
> 깨끗하지만 차갑지 않고, 세련되지만 기계적이지 않음.

---

## Color

### Background
| Token | Hex | Usage |
|-------|-----|-------|
| `--bg-warm` | `#FEFCF9` | 메인 배경 (크리미 화이트) |
| `--bg-cream` | `#F5F0EB` | 카드/섹션 배경 |
| `--bg-section` | `#FAF7F4` | 보조 섹션 배경 |
| `--bg-glow` | `rgba(212,165,116,0.08)` | 은은한 햇살 글로우 |

### Text
| Token | Hex | Usage |
|-------|-----|-------|
| `--text-dark` | `#3D2B1F` | 제목 (다크 브라운) |
| `--text-body` | `#6B5B4F` | 본문 |
| `--text-muted` | `#A39585` | 보조/캡션 |
| `--text-white` | `#FEFCF9` | 버튼 위 텍스트 |

### Accent
| Token | Hex | Usage |
|-------|-----|-------|
| `--accent` | `#D4A574` | CTA, 강조 (앰버) |
| `--accent-hover` | `#C4905E` | 호버 상태 |
| `--accent-soft` | `rgba(212,165,116,0.12)` | 배지/아이콘 배경 |

### Status
| Token | Hex | Usage |
|-------|-----|-------|
| `--success` | `#59A96A` | PASS |
| `--danger` | `#D45A5A` | FAIL |
| `--warning` | `#D4A04A` | 경고 |

---

## Typography

| Role | Font | Weight | Size |
|------|------|--------|------|
| 로고/타이틀 | Noto Serif KR | 700 | 36px (desktop) / 28px (mobile) |
| 본문 | Pretendard | 400-500 | 16px / line-height 1.6 |
| 라벨 | Pretendard | 600 | 14px |
| 캡션 | Pretendard | 400 | 12-13px |
| CTA 버튼 | Pretendard | 600 | 16px |

### Scale
`12 → 13 → 14 → 16 → 18 → 24 → 28 → 36`

---

## Spacing

4px 기본 단위.

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | 4px | 미세 간격 |
| `--space-sm` | 8px | 아이콘-텍스트 간격 |
| `--space-md` | 16px | 요소 간 기본 간격 |
| `--space-lg` | 24px | 카드 내부 패딩 |
| `--space-xl` | 32px | 섹션 간 간격 |
| `--space-2xl` | 48px | 대영역 간 간격 |

---

## Shape

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | 8px | 버튼, 입력, 체크리스트 |
| `--radius-md` | 12px | 카드, 다운로드 버튼 |
| `--radius-lg` | 20px | 업로드 영역, 결과 배너 |
| `--radius-full` | 9999px | 배지, 필 셀렉터 |

---

## Shadow

| Token | Value | Usage |
|-------|-------|-------|
| `--shadow-soft` | `0 2px 16px rgba(61,43,31,0.06)` | 기본 그림자 |
| `--shadow-card` | `0 4px 24px rgba(61,43,31,0.08)` | 카드 그림자 |
| `--shadow-cta` | `0 4px 20px rgba(212,165,116,0.3)` | CTA 버튼 그림자 |

---

## Motion

| 대상 | Value | 설명 |
|------|-------|------|
| 기본 전환 | `0.2s ease` | 호버, 색상 변경 |
| 호버 리프트 | `translateY(-1px) + shadow 강화` | 버튼, 카드 |
| 로딩 시머 | `1.5s ease-in-out infinite` | 진행 바 밝기 변화 |
| 햇살 글로우 | `fixed, always visible` | 우상단 radial-gradient |

### Reduced Motion
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## Layout

### Breakpoints
| Name | Breakpoint | Layout |
|------|-----------|--------|
| Desktop | ≥960px | 2컬럼 (좌: 액션 / 우: 신뢰) |
| Tablet | 640-959px | 1컬럼, max-width 560px |
| Mobile | <640px | 풀폭, 터치 최적화 |

### Desktop Grid
```
┌──── 좌 컬럼 (1fr) ────┬──── 우 컬럼 (1fr) ────┐
│  필 셀렉터             │  예시 결과물            │
│  업로드 영역           │  신뢰 배지 3개          │
│  CTA 버튼             │                        │
└────────────────────────┴────────────────────────┘
max-width: 960px, gap: 32px
```

---

## Component Inventory

| Component | 설명 |
|-----------|------|
| `header` | 세리프 로고 + 서브타이틀 + 베타 배지 |
| `doc-selector` | 필 버튼 3개 (여권/주민/이력서) |
| `upload-zone` | 점선 영역 + 카메라 아이콘 + 안내 텍스트 |
| `btn-cta` | 앰버 풀폭 CTA 버튼 |
| `sample-result` | 전후 비교 미니 카드 |
| `trust-badge` | 아이콘 + 라벨 + 설명 |
| `progress-bar` | 5단계 로딩 바 + 텍스트 |
| `result-banner` | 성공/실패 배너 |
| `comparison` | 전후 나란히 비교 |
| `btn-download` | 녹색 다운로드 CTA |
| `check-list` | 검증 항목 리스트 |
| `footer` | 면책, 개인정보 링크 |

---

## Accessibility

- **명암비:** `#3D2B1F` on `#FEFCF9` = 12.4:1 (AAA 통과)
- **focus-visible:** 모든 인터랙티브 요소에 2px accent 링
- **터치 영역:** 최소 44×44px (모바일)
- **키보드:** Tab 순서 = 용도 → 업로드 → CTA → 결과 → 다운로드
- **ARIA:** 업로드 영역에 `role="button"` + `aria-label`
- **prefers-reduced-motion:** 전체 애니메이션 해제

---

## Don'ts

- ❌ 이모지를 UI에 사용하지 않음
- ❌ 보라색 그라디언트 사용하지 않음
- ❌ 다크 모드 사용하지 않음
- ❌ backdrop-filter: blur 사용하지 않음
- ❌ 480px 고정 레이아웃 사용하지 않음
- ❌ 기능 나열형 카피 사용하지 않음 ("AI가 자동으로...")
