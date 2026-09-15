# PropIQ by CiteRank AI — project instructions

India's Property Decision Intelligence Platform.
**Verified data. Explainable intelligence. Better property decisions.**

Read this file before starting any feature. Read the relevant doc in `docs/`
before touching a domain it covers. Update `docs/IMPLEMENTATION_STATUS.md`,
`docs/ROADMAP.md` and `docs/DECISIONS.md` at the end of every milestone.

## Where this lives

PropIQ is a self-contained app at `apps/propiq/` inside the `gstack` repository.
It has its own `package.json`, toolchain and test suite. Nothing outside
`apps/propiq/` belongs to PropIQ, and PropIQ does not modify gstack's root
config, docs or tests. See `docs/DECISIONS.md` (D-001) for why.

## Commands

```bash
npm run dev          # dev server
npm run build        # production build
npm run typecheck    # tsc --noEmit (strict, noUncheckedIndexedAccess)
npm run lint         # eslint flat config
npm run test         # vitest, full suite
npm run verify       # typecheck + lint + test — run before every commit
npm run format:check # prettier
```

`npm run verify` and `npm run build` must both pass before any commit.

## What this product is

Not a listings portal. The question is not "what is available" but "should I
buy this one, at this price, and what should I argue about".

Journey: Discover → Verify → Compare → Score → Analyze → Visit → Negotiate →
Buy → Monitor.

## The truthfulness rule (non-negotiable)

Never present sample data, model guesses, placeholder numbers or fabricated
records as live Indian property intelligence.

- Every material fact carries `dataStatus`: `verified` | `derived` | `estimated` | `demo`.
- A missing fact is `undefined`. Never `?? 0`, never a plausible default.
- Demo data renders only behind a visible `DemoDataBanner`.
- `getServerEnv()` throws if `PROPIQ_DATA_ADAPTER=fixture` under
  `NODE_ENV=production`. A production adapter must never emit `dataStatus: 'demo'`.
- An LLM never produces a property fact or a score. It explains what the
  deterministic engines computed.

If you cannot satisfy a request truthfully, ship the honest empty state. See
`src/components/propiq/roadmap-notice.tsx` for the pattern. The same rule
applies to degraded dependencies: with no AI provider the Copilot returns 503
rather than a canned answer, and an unvalued portfolio asset is excluded from
totals rather than assumed to be worth its cost basis.

## Architecture rules

Modular monolith. Dependencies point inward, never out.

```
src/domain/   pure TypeScript. No I/O, no React, no Next, no adapters.
src/data/     ports + adapters (fixture, supabase). Implements domain contracts.
src/server/   server-only: clients, use cases, actions.
src/ai/       provider abstraction, grounding guards, Copilot pipeline.
src/components/ presentation.
src/lib/      shared utilities, env, analytics.
```

- **The domain layer is pure.** ESLint enforces this: `src/domain/**` cannot
  import `@/data/*`, `@/server/*`, `@/components/*`, `next/*` or `react`.
  Dependencies arrive as function arguments or port interfaces.
- **No business logic in page components.** Pages call
  `buildPropertyIntelligence()` and render. If a page computes a score, that is
  a bug.
- **No clock reads in the domain.** Every engine takes `now: Instant`. That is
  what makes results reproducible and replayable.
- **One source of truth per verdict.** Search results, the Decision Room and
  the intelligence page all call the same use case. A score that differs
  between two screens is worse than no score.

## Scoring is a public API

The formula and weights are published in-product at `/methodology`, which reads
the live constants out of `src/domain/scoring/weights.ts`. Therefore:

- **Never mutate an existing scoring version.** Add a new one to
  `SCORING_VERSIONS` and leave the old one intact, so historical scores stay
  explainable.
- Every score change needs test coverage. `test/scoring.test.ts` pins weight
  sums, missing-data renormalization and the reporting floor.
- **Confidence bands are a product promise.** Any aggregation that drops the
  95% band is a regression.
- Missing signals are dropped and weights rescaled — never scored as zero.
  `coverage` reports how much weight survived.

## Deterministic vs. LLM

| Job | Where |
|---|---|
| Scoring, decisions, valuation, IRR, risk | `src/domain/**`, pure arithmetic |
| Explaining any of the above | `src/ai/**`, grounded in evidence |

Never ask a model to compute a yield, a score or an IRR.

## Coding conventions

- Strict TypeScript. `noUncheckedIndexedAccess` is on; `any` is an ESLint error.
- Branded IDs (`PropertyId`, `LocalityId`) via `asId<T>()`. Do not pass raw strings.
- `Result<T, E>` for expected failures; throw only for programmer error.
- Validate every external input with Zod at the boundary (search params, server
  actions, env). Never trust a client-supplied user id — resolve identity
  server-side.
- Comments explain *why*, not *what*. Match the density of surrounding code.
- Money is whole rupees. Format with `formatINR` (lakh/crore), never `toFixed`.

## Feature status

`IMPLEMENTED` | `FOUNDATION` | `PARTIAL` | `MOCK/DEMO` | `NOT BUILT` | `BLOCKED BY DATA/INTEGRATION`

`IMPLEMENTED` means end to end: working route, persistence, authorization,
loading/empty/error states, responsive, accessible, analytics, tests, correct
data status, no dead CTA. Anything short of that is `PARTIAL`. A homepage card
is not a feature.

## Development data policy

Fixtures live only in `src/data/fixtures/`. Every record carries
`dataStatus: 'demo'`. Developer, project and unit records are invented; locality
*names* are real Bengaluru localities but every figure attached to them is
synthetic. Unit-test factories live separately in `test/support/factories.ts` —
do not blur the two.

## Security

- RLS on every user-owned table, scoped to `auth.uid()`.
  `test/security.test.ts` fails CI if a table is added without it.
- Service-role key is server-only and bypasses RLS. Never call
  `createAdminClient()` in response to unvalidated input.
- Documents go to a private bucket under a per-user prefix, accessed via signed
  URLs.
- Untrusted text reaching an LLM is fenced with `fenceUntrusted()`.
- AI endpoints are rate limited (`checkAiRateLimit`) before any expensive work.
  The order — validate, rate limit, then work — is pinned by a test.
- The in-process limiter is not distributed. Check `RateLimiter.isDistributed`
  before assuming a hard guarantee; swap the store before running two instances.

## Market coverage

Architecture scales nationally; data deliberately does not. One market covered
densely beats a hundred covered thinly. Market config is data-driven
(`cities.coverage`).

## Before ending a session

1. `npm run verify` and `npm run build` both pass.
2. Update `docs/IMPLEMENTATION_STATUS.md`, `docs/ROADMAP.md`, `docs/DECISIONS.md`.
3. List the tests you ran and any blockers.
4. Write the exact next implementation task in `docs/ROADMAP.md`.
5. Never leave a half-migrated schema or a broken route.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
