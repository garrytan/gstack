# Architecture

## Shape

A modular monolith. No microservices, because there is no demonstrated reason
for any — one deployable, one database, clear internal boundaries enforced by
the linter rather than by network hops.

```
                      ┌──────────────────────────────┐
  Browser  ──────────▶│  Next.js App Router (RSC)    │
                      │  src/app, src/components     │
                      └──────────────┬───────────────┘
                                     │ calls use cases
                      ┌──────────────▼───────────────┐
                      │  src/server (use cases,      │
                      │  actions, Supabase clients)  │
                      └───────┬──────────────┬───────┘
                              │              │
              implements ports│              │injects data
                      ┌───────▼──────┐  ┌────▼─────────────────┐
                      │  src/data    │  │  src/domain          │
                      │  ports +     │  │  pure engines        │
                      │  adapters    │  │  (no I/O, no clock)  │
                      └───────┬──────┘  └──────────────────────┘
                              │
                 ┌────────────┴────────────┐
                 │                         │
         ┌───────▼────────┐      ┌─────────▼────────┐
         │ fixture adapter │      │ supabase adapter │
         │ (demo, dev only)│      │ (production)     │
         └─────────────────┘      └──────────────────┘
```

Dependencies point inward. The domain layer knows nothing about Supabase,
React, Next or the fixture dataset.

## Layers

### `src/domain` — pure

Every engine here is a function of its arguments. No I/O, no `Date.now()`, no
framework imports. ESLint enforces the boundary (`no-restricted-imports` scoped
to `src/domain/**`).

| Module | Responsibility |
|---|---|
| `shared/types` | Branded IDs, money, `Result`, clamp/round primitives |
| `evidence/` | Evidence records, data status, confidence decay, staleness |
| `property/` | City → MicroMarket → Locality → Project → Phase → Unit |
| `locality/` | Market indicators, CAGR, supply overhang, commute |
| `buyer/` | Buyer profile, persona, priorities |
| `scoring/` | Normalization, signals, pillars, versioned weights, composite |
| `decision/` | Verdict rules; comparison analysis for the Decision Room |
| `valuation/` | Comparable adjustment, weighting, fair-value band, negotiation |
| `investment/` | EMI, amortisation, yields, cash flow, IRR, scenarios |
| `risk/` | Nine named risk dimensions with drivers |

Purity buys three things that matter for this product specifically:
reproducibility (a score can be replayed), testability (186 tests run in ~1.5s
with no database), and auditability (the methodology page reads the same
constants the engine uses, so published and actual can never drift).

### `src/data` — ports and adapters

`ports.ts` declares `PropertyRepository`, `WatchlistRepository` and
`PortfolioRepository`. Two adapters implement the property port:

- **`fixtures/adapter.ts`** — the labelled demo dataset. `servesDemoData: true`.
- **`supabase/property-repository.ts`** — the production contract. Excludes
  `data_status = 'demo'` at the query level, not after the fact.

`index.ts` selects between them from `PROPIQ_DATA_ADAPTER`. `getServerEnv()`
refuses `fixture` under `NODE_ENV=production`, so demo data has no path into a
live deployment.

Row mapping lives in `supabase/mappers.ts`, separate from query logic, so the
database shape can change without the queries changing with it. Mappers never
default a missing column — `?? 0` on a price would turn "unknown" into "free".

### `src/server` — use cases

`intelligence.ts` holds the one use case that matters:
`buildPropertyIntelligence(id, options)`. It orders the chain deliberately —
valuation feeds risk (valuation risk), both feed scoring, scoring feeds the
decision — and every screen that shows a verdict calls it. That is what
guarantees search, the Decision Room and the property page agree.

Server actions (`actions.ts`) validate with Zod and resolve the acting user
server-side. A client-supplied user id is never trusted.

### `src/ai` — explanation only

`provider.ts` is a provider abstraction (Anthropic, OpenAI, or a null provider
that throws rather than returning a plausible stub). Model IDs come from
environment configuration and never appear in domain code.

`grounding.ts` builds the grounded context and guards the output. See
[AI_ARCHITECTURE.md](AI_ARCHITECTURE.md).

### `src/components` — presentation

Server components by default. Client components are leaves: the search bar, the
filter form, the watchlist button, expandable panels, charts. The property page
is a server component that renders client leaves, so the intelligence payload is
computed once on the server and never shipped as a client-side computation.

## Rendering

- Pages that read the repository are `force-dynamic`. Scores depend on evidence
  freshness measured against the current clock, so caching a score would mean
  serving a stale confidence band.
- Static: `/methodology`, `/about`, `/pricing`, `/copilot`, the dashboard
  placeholder routes, `/robots.txt`.
- `optimizePackageImports` keeps the `lucide-react` and `recharts` barrels out
  of the client entry graph.

## Security boundaries

| Boundary | Enforcement |
|---|---|
| User data isolation | Postgres RLS on `auth.uid()` — the real boundary |
| Application authorization | Server-side identity resolution; defence in depth |
| Demo data containment | Env guard + adapter filter + RLS policy, three layers |
| Secrets | Server-only modules marked `server-only`; anon key is the only client key |
| Input validation | Zod at every boundary: search params, actions, env |
| Prompt injection | `fenceUntrusted()` + grounding guard on model output |
| Transport | HSTS, `X-Frame-Options: DENY`, `nosniff`, restrictive Permissions-Policy |

## Testing strategy

| Tier | What | Speed |
|---|---|---|
| Unit | Scoring, decisions, valuation, investment math, normalization, freshness, comparison, grounding | ~1s, no I/O |
| Integration | Fixture adapter + full intelligence chain | ~1s |
| Static invariant | RLS coverage, demo containment, schema shape, scoring/commercial separation | ~1s |
| Manual | `supabase/verify-rls.sql` against a live database | on deploy |

The static invariant tests exist because the two failures that would be most
damaging — a user-owned table shipped without RLS, and demo data reaching a
production response — are both easy to introduce and expensive to discover.

## What is deliberately absent

- **No caching layer.** Premature at this data volume, and a cached score with a
  stale confidence band is worse than a slow honest one.
- **No queue.** Nothing is asynchronous yet. Alerts and scheduled re-scoring
  will need one; it will be added when they are built, not before.
- **No ORM.** The Supabase client plus explicit mappers keeps the mapping rules
  readable and testable on plain objects.
