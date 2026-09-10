# Design System — gstack

## Product Context
- **What this is:** Community website for gstack — a CLI tool that turns Claude Code into a virtual engineering team
- **Who it's for:** Developers discovering gstack, existing community members
- **Space/industry:** Developer tools (peers: Linear, Raycast, Warp, Zed)
- **Project type:** Community dashboard + marketing site

## Aesthetic Direction
- **Direction:** Industrial/Utilitarian — function-first, data-dense, monospace as personality font
- **Decoration level:** Intentional — subtle noise/grain texture on surfaces for materiality
- **Mood:** Serious tool built by someone who cares about craft. Warm, not cold. The CLI heritage IS the brand.
- **Reference sites:** formulae.brew.sh (competitor, but ours is live and interactive), Linear (dark + restrained), Warp (warm accents)

## Typography
- **Display/Hero:** Satoshi (Black 900 / Bold 700) — geometric with warmth, distinctive letterforms (the lowercase 'a' and 'g'). Not Inter, not Geist. Loaded from Fontshare CDN.
- **Body:** DM Sans (Regular 400 / Medium 500 / Semibold 600) — clean, readable, slightly friendlier than geometric display. Loaded from Google Fonts.
- **UI/Labels:** DM Sans (same as body)
- **Data/Tables:** JetBrains Mono (Regular 400 / Medium 500) — the personality font. Supports tabular-nums. Monospace should be prominent, not hidden in code blocks. Loaded from Google Fonts.
- **Code:** JetBrains Mono
- **Loading:** Google Fonts for DM Sans + JetBrains Mono, Fontshare for Satoshi. Use `display=swap`.
- **Scale:**
  - Hero: 72px / clamp(40px, 6vw, 72px)
  - H1: 48px
  - H2: 32px
  - H3: 24px
  - H4: 18px
  - Body: 16px
  - Small: 14px
  - Caption: 13px
  - Micro: 12px
  - Nano: 11px (JetBrains Mono labels)

## Color
- **Approach:** Restrained — amber accent is rare and meaningful. Dashboard data gets the color; chrome stays neutral.
- **Primary (dark mode):** amber-500 #F59E0B — warm, energetic, reads as "terminal cursor"
- **Primary (light mode):** amber-600 #D97706 — darker for contrast against white backgrounds
- **Primary text accent (dark mode):** amber-400 #FBBF24
- **Primary text accent (light mode):** amber-700 #B45309
- **Neutrals:** Cool zinc grays
  - zinc-50: #FAFAFA (lightest)
  - zinc-400: #A1A1AA
  - zinc-600: #52525B
  - zinc-800: #27272A
  - Surface (dark): #141414
  - Base (dark): #0C0C0C
  - Surface (light): #FFFFFF
  - Base (light): #FAFAF9
- **Semantic:** success #22C55E, warning #F59E0B, error #EF4444, info #3B82F6
- **Dark mode:** Default. Near-black base (#0C0C0C), surface cards at #141414, borders at #262626.
- **Light mode:** Warm stone base (#FAFAF9), white surface cards, stone borders (#E7E5E4). Amber accent shifts to amber-600 for contrast.

## Spacing
- **Base unit:** 4px
- **Density:** Comfortable — not cramped (not Bloomberg Terminal), not spacious (not a marketing site)
- **Scale:** 2xs(2px) xs(4px) sm(8px) md(16px) lg(24px) xl(32px) 2xl(48px) 3xl(64px)

## Layout
- **Approach:** Grid-disciplined for dashboard, editorial hero for landing page
- **Grid:** 12 columns at lg+, 1 column at mobile
- **Max content width:** 1200px (6xl)
- **Border radius:** sm:4px, md:8px, lg:12px, full:9999px
  - Cards/panels: lg (12px)
  - Buttons/inputs: md (8px)
  - Badges/pills: full (9999px)
  - Skill bars: sm (4px)

## Motion
- **Approach:** Minimal-functional — only transitions that aid comprehension. The dashboard's live feed IS the motion.
- **Easing:** enter(ease-out / cubic-bezier(0.16,1,0.3,1)) exit(ease-in) move(ease-in-out)
- **Duration:** micro(50-100ms) short(150ms) medium(250ms) long(400ms)
- **Animated elements:** live feed dot pulse (2s infinite), skill bar fill (600ms ease-out), hover states (150ms)

## Grain Texture
Apply a subtle noise overlay to the entire page for materiality:
- Dark mode: opacity 0.03
- Light mode: opacity 0.02
- Use SVG feTurbulence filter as a CSS background-image on body::after
- pointer-events: none, position: fixed, z-index: 9999

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-21 | Initial design system | Created by /design-consultation. Industrial aesthetic, warm amber accent, Satoshi + DM Sans + JetBrains Mono. |
| 2026-03-21 | Light mode amber-600 | amber-500 too bright/washed against white; amber-700 too brown/umber. amber-600 is the sweet spot. |
| 2026-03-21 | Grain texture | Adds materiality to flat dark surfaces. Prevents the "generic SaaS template" sameness. |
