# Repository audit — pre-upgrade

Taken before the intelligence-platform upgrade. Facts, not opinions.

## Stack

| Layer | What is actually there |
|---|---|
| Framework | Next.js 16.3.5, App Router, Turbopack, `force-dynamic` homepage |
| Language | TypeScript 5.9 strict + `noUncheckedIndexedAccess`; `any` is an ESLint error |
| Styling | Tailwind CSS 4.3, CSS-first `@theme`, ~1,500-line token layer in `globals.css` |
| UI | Hand-rolled primitives (`button`, `badge`, `card`, `input`) on `cva` + `@radix-ui/react-slot`. **No shadcn/ui install** |
| Charts | Recharts 3.3 |
| 3D | **None.** No three.js, no R3F, no Framer Motion, no GSAP. All motion is CSS |
| Maps | **None.** `MapExplorer` is a hand-built equirectangular SVG projection over real fixture coordinates |
| Data | Supabase JS + SSR. Ports-and-adapters: `fixture` / `supabase` / `none` |
| Validation | Zod 4.6 at every boundary |
| Tests | Vitest 5, 28 files, 500 tests. **No Playwright, no E2E** |

## Routes — 38 pages, 0 API route handlers

Everything runs through server components and server actions. Marketing surface is
`/`; the app lives under the `(app)` group with its own chrome.

## What genuinely works

Scoring (12 pillars, versioned weights, published at `/methodology`, renormalises on
missing evidence, 95% bands), risk (9 dimensions), valuation, investment arithmetic
(IRR/EMI/yield, deterministic), negotiation, visits (22 checks), documents (19 rules),
alerts (8 kinds), portfolio, evidence + freshness, auth, watchlist, RLS-tested schema.

**This is the asset.** It is not a prototype behind the UI; it is a real engine with a
thin presentation layer over it.

## What is actually wrong

1. **The production deployment serves nothing.** `PROPIQ_DATA_ADAPTER` unset in
   production resolves to `none` → `EmptyPropertyRepository` → every data-backed
   section suppressed and replaced with a "no source connected" notice. The engine
   runs; it has nothing to run on. This is the single cause of the prototype feel.
2. **Demo mode is impossible in production by construction.** `getServerEnv()` throws
   on `fixture` under `NODE_ENV=production`. The truthfulness rule says never present
   demo data *as live* — not never show demo data. The guard is stricter than the rule.
3. **Engineering language on public surfaces.** `NOT BUILT`, `FOUNDATION`, `no route`,
   `RULES`, `SHORTLIST_LIMIT`, `adapter`, `fixture`.
4. **No 3D, no motion library.** The hero is static.
5. **Navigation is 6 flat links.** No mega menu, no search, no compare, no copilot entry.
6. **No command palette, no global compare tray, no persistent copilot.**
7. **No E2E tests and no visual regression.**

## Technical debt / risks

- `force-dynamic` on `/` — no static shell, LCP paid on every request.
- One scoring pass feeds the whole homepage (good), but it is recomputed per request.
- `MapExplorer` projection is honest but has no clustering and no layer model.
- Verdict colour + score ramp were consolidated earlier today; a tripwire test guards it.


---

## What the upgrade pass shipped

Appended after the work, so the audit above stays the entry state it was.

| # | Change | Where |
|---|---|---|
| 1 | Data mode declared, not inferred — `live \| demo \| empty` | `src/lib/data-mode.ts`, `src/lib/env.ts` |
| 2 | Dark command-centre ground, OKLCH-stepped bands, re-measured tokens | `src/app/globals.css` |
| 3 | Intelligence-node motif (SVG + CSS, no WebGL, no JS) | `intelligence-nodes.tsx` |
| 4 | Cinematic hero: real computed readouts, command-palette search | `hero-section.tsx`, `hero-search.tsx` |
| 5 | Score as a 12-node constellation with a per-pillar panel | `score-constellation.tsx` |
| 6 | Journey restored as its own section, engineering language removed | `journey-section.tsx` |
| 7 | Mega menu + command palette off one nav model | `site-nav.ts`, `mega-menu-nav.tsx`, `command-palette.tsx` |
| 8 | Premium footer with the closing statement | `site-footer.tsx` |
| 9 | Richer no-results state driven by real coverage | `(app)/search/page.tsx` |
| 10 | Playwright E2E (64 checks) and a Lighthouse runner | `e2e/`, `scripts/lighthouse.mjs` |

### Bugs found and fixed on the way

1. `.propiq-card` hardcoded `#ffffff` — every app card invisible in dark mode at 1.05:1.
2. `.propiq-stage-card` did the same to the journey section. Both now static-checked.
3. Bright `watch`/`avoid` cleared 4.5:1 on the page but not on a card or inside a badge tint.
4. Making the header a client component pulled `node:fs` into the browser and broke the build.
5. A render-prop would have passed a function across the server/client boundary.
6. Hover-then-click closed the mega menu — the most natural pointer gesture there is.
7. The palette's fallback search never navigated: `router.push` after `onClose` unmounted it.
8. Unrounded SVG trigonometry caused a hydration mismatch.
9. A raw ISO timestamp was printing onto a marketing page.
10. The header overflowed 1024px by 36px once the mega menu appeared.

### Known limitations

- **Homepage Lighthouse performance is 82**, against a floor of 90. Measured cause:
  a 445KB document of which 269KB (61%) is the RSC payload for nineteen sections,
  plus 296KB of JS. Every asset lands by 700ms observed; the 4.1s LCP is simulated
  slow-4G applied to those bytes. Reaching 90 means splitting the page, which is a
  decision about its scope. The other three audited routes score 92–97.
- **No Mapbox.** No token is configured and none was invented. `MapExplorer` draws a
  real equirectangular projection from the coordinates already in the data.
- **No PostGIS, no live Supabase data.** `live` mode is wired and untested against a
  real database, because there isn't one to point it at.
- **No PostHog.** `track()` is a no-op behind a debug flag.
- **Copilot, documents, reports, alerts, portfolio** remain early access, honestly
  labelled, and still say what they are waiting on.
