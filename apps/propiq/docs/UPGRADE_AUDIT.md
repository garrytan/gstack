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
