# Implementation status

Last updated: 2026-09-15 · Milestones A and B complete; P1 delivered bar its providers; the buyer journey now runs end to end.

Status vocabulary: `IMPLEMENTED` · `FOUNDATION` · `PARTIAL` · `MOCK/DEMO` ·
`NOT BUILT` · `BLOCKED BY DATA/INTEGRATION`.

`IMPLEMENTED` means end to end: working route, functional UI, persistence,
authorization, loading/empty/error states, responsive layout, accessibility
basics, analytics, tests, correct data status, provenance preserved, no dead
CTA. Anything short of that is `PARTIAL`.

## Repository audit (entry state)

The `gstack` repository is Garry Tan's Claude Code skills toolkit: a Bun CLI, a
Playwright browser harness and ~40 skill templates. It contained **no PropIQ
code**, and its stack is not a foundation for a property SaaS.

Findings:

| Area | Finding |
|---|---|
| Reusable code | None for this domain |
| Existing routes | None — gstack is a CLI, not a web app |
| Fake data | None to remove |
| Auth | None |
| Database | Four telemetry migrations for gstack's own usage tracking, unrelated |
| Tests | gstack's own suite, unrelated |
| Broken routes / dead CTAs | Not applicable |

Decision: build PropIQ self-contained at `apps/propiq/` rather than overwrite
gstack's root `CLAUDE.md`, `docs/`, `package.json` and test suite, which would
have broken the host repository. See `DECISIONS.md` D-001.

## Domain engines

| Feature | Status | Notes |
|---|---|---|
| Evidence model + provenance | `IMPLEMENTED` | 4 statuses, 11 source types, review states |
| Confidence decay / staleness | `IMPLEMENTED` | Per-source half-life; 13 tests |
| PropIQ Score v0.1.0 | `IMPLEMENTED` | 12 pillars, 3 personas, versioned, 15 tests |
| Missing-data renormalization | `IMPLEMENTED` | Absent ≠ zero; coverage reported |
| Reporting floor | `IMPLEMENTED` | <45% coverage or <35% confidence → no score |
| 95% confidence bands | `IMPLEMENTED` | Widen as evidence thins |
| Decision engine v0.1.0 | `IMPLEMENTED` | 5 verdicts, named rules, 12 tests |
| Fair value v0.1.0 | `IMPLEMENTED` | Comparable adjustment + weighting, 19 tests |
| Negotiation guidance | `IMPLEMENTED` | Open / target / walk-away with levers |
| Investment analysis | `IMPLEMENTED` | EMI, amortisation, IRR by bisection, 24 tests |
| Risk engine v0.1.0 | `IMPLEMENTED` | 9 dimensions with drivers, 10 tests |
| Comparison analysis | `IMPLEMENTED` | Winners, differences, trade-offs, 13 tests |
| Locality intelligence | `IMPLEMENTED` | CAGR, overhang, commute, environment |
| Buyer profile / personas | `IMPLEMENTED` | Editor at `/preferences`; drives weighting and buyer-fit signals |
| Portfolio arithmetic | `IMPLEMENTED` | Equity, gain, CAGR, yields; unvalued assets excluded, 17 tests |
| Alert evaluation | `IMPLEMENTED` | 8 rule families with published thresholds, 17 tests |
| Document checks | `IMPLEMENTED` | 22 deterministic rules over 6 document types, 46 tests |
| Site visit checklist | `IMPLEMENTED` | 22 items; answers become first-party evidence, 21 tests |
| Visit → score loop | `IMPLEMENTED` | Visit evidence merges into scoring and moves confidence |
| Negotiation state | `IMPLEMENTED` | Offer sequence, guarded transitions, blunt guidance, 18 tests |

## Data layer

| Feature | Status | Notes |
|---|---|---|
| Repository ports | `IMPLEMENTED` | Property, watchlist, portfolio |
| Fixture adapter | `IMPLEMENTED` | 12 properties, 8 projects, 6 developers, 6 localities |
| Supabase adapter contract | `FOUNDATION` | Written, typed, demo-filtered. No live data to run against |
| Row mappers | `IMPLEMENTED` | No defaults for missing columns |
| Canonical schema | `IMPLEMENTED` | 25 tables, FKs, check constraints, indexes |
| RLS policies | `IMPLEMENTED` | Every user-owned table, every verb; 28 invariant tests |
| Env validation | `IMPLEMENTED` | Zod, client/server split, production fixture guard |

## Application

| Route | Status | Notes |
|---|---|---|
| `/` | `IMPLEMENTED` | 19 sections, every figure projected from one scoring pass; shortlist tray, 3D hero, WebGL fallback |
| `/search` | `IMPLEMENTED` | Filters, personas, sort, pagination, empty state |
| `/property/[id]` | `IMPLEMENTED` | The flagship screen, all 13 sections |
| `/compare` | `IMPLEMENTED` | Decision Room with winners and trade-offs |
| `/localities` | `IMPLEMENTED` | Indicator table |
| `/locality/[slug]` | `IMPLEMENTED` | Trend chart, environment, pipeline, evidence |
| `/valuation` | `IMPLEMENTED` | Method + worked example with adjustments shown |
| `/investment` | `IMPLEMENTED` | Method + worked example with assumptions shown |
| `/methodology` | `IMPLEMENTED` | Reads live constants — cannot drift |
| `/data-sources` | `IMPLEMENTED` | Per-source integration status, live adapter state |
| `/about` | `IMPLEMENTED` | |
| `/privacy` | `PARTIAL` | Technical data handling documented accurately; operator policy (fiduciary, retention, DPDP grievance officer) not published |
| `/developers` | `IMPLEMENTED` | Delivery record, handover delay, complaints on file |
| `/research` | `IMPLEMENTED` | Index of the written method pieces; every card links to a page that exists |
| `/dashboard` | `IMPLEMENTED` | |
| `/dashboard/watchlist` | `IMPLEMENTED` | Persisted, re-scored on load, empty + signed-out states |
| `/login`, `/signup` | `PARTIAL` | Full flow built; needs a Supabase project to function |
| `/pricing` | `NOT BUILT` | Honest placeholder. Pricing undecided |
| `/preferences` | `IMPLEMENTED` | Buyer profile editor; changes every score on the site |
| `/copilot` | `PARTIAL` | Full pipeline live; synthesis `BLOCKED BY DATA/INTEGRATION` on a provider |
| `/api/copilot` | `IMPLEMENTED` | Validated, rate limited, refuses rather than stubs |
| `/api/cron/evaluate-alerts` | `IMPLEMENTED` | Bearer-secret auth, evaluates then delivers, per-channel receipts |
| `/dashboard/portfolio` | `IMPLEMENTED` | Add, list, remove; provenance labelled per figure |
| `/dashboard/alerts` | `IMPLEMENTED` | Live evaluation on load, written to the inbox, scheduler endpoint delivers |
| `/dashboard/notifications` | `IMPLEMENTED` | Inbox, mark-all-read, per-channel delivery status shown honestly |
| `/decision-room` | `IMPLEMENTED` | Permanent redirect to `/compare`, the canonical surface |
| `/reports` | `IMPLEMENTED` | Permanent redirect to `/dashboard/reports` |
| `/dashboard/reports` | `IMPLEMENTED` | Frozen, versioned, printable report per property |
| `/property/[id]/report` | `IMPLEMENTED` | Print-to-PDF via the browser; noindex |
| `/property/[id]/visit` | `IMPLEMENTED` | Checklist; captured answers feed the score |
| `/property/[id]/negotiate` | `IMPLEMENTED` | Offer tracking against a walk-away set up front |
| `/document-ai` | `IMPLEMENTED` | Checks run in-browser on typed input; no upload needed |
| `/tools` | `IMPLEMENTED` | Hub for the free tools |
| `/tools/carpet-area` | `IMPLEMENTED` | Loading, carpet efficiency, multi-quote carpet-basis comparison |
| `/tools/emi` | `IMPLEMENTED` | Instalment, total interest, year-by-year amortisation |
| `/tools/rental-yield` | `IMPLEMENTED` | Gross vs net yield on all capital deployed |
| `/checks/[kind]` | `IMPLEMENTED` | Six document types, each publishing the rules we run |
| `/site-visit-checklist` | `IMPLEMENTED` | All 22 items, free, printable, no account |
| `/methodology/[version]` | `IMPLEMENTED` | Frozen permalink per scoring version (`/methodology/v0.1.0`), for citation |
| `/llms.txt` | `IMPLEMENTED` | Generated from live constants; declares this deployment's data status |
| `/sitemap.xml`, `/robots.txt` | `IMPLEMENTED` | Demo-backed pages excluded; AI crawlers named explicitly |
| `/opengraph-image`, `/icon` | `IMPLEMENTED` | Generated share card and tab icon; no figures on the card |

Every route in the navigation resolves. No dead CTAs.

## Cross-cutting

| Feature | Status | Notes |
|---|---|---|
| Auth (Supabase) | `PARTIAL` | Sign in / up / reset + middleware refresh. `BLOCKED BY DATA/INTEGRATION` on a project |
| Watchlist | `IMPLEMENTED` | Supabase-backed; in-memory dev store in fixture mode |
| Analytics | `FOUNDATION` | 13 typed events, 8 funnel stages, buffered transport. No vendor wired |
| Evidence panel | `IMPLEMENTED` | Reusable, with commercial disclosure |
| Demo data banner | `IMPLEMENTED` | On every fixture-backed surface |
| AI provider abstraction | `FOUNDATION` | Anthropic + OpenAI + null; env-configured |
| AI grounding + guards | `FOUNDATION` | System prompt, injection fence, output guard, 14 tests |
| Loading / empty / error states | `IMPLEMENTED` | Per-segment skeletons (see D-013), empty states, error boundary with digest |
| HTTP status correctness | `IMPLEMENTED` | Unknown property/locality return real 404s, verified by smoke test |
| Accessibility | `PARTIAL` | Semantic tables, labelled controls, skip link, chart text summaries, reduced-motion, focus-visible. Not yet screen-reader tested |
| SEO | `IMPLEMENTED` | Metadata, canonicals, sitemap, robots, breadcrumbs |
| Security headers | `IMPLEMENTED` | HSTS, nosniff, DENY, referrer, permissions |
| Rate limiting | `IMPLEMENTED` | Fixed-window, applied to the AI endpoint, standard headers, 8 tests |
| AI Copilot pipeline | `IMPLEMENTED` | Intent, retrieval, grounding, fencing, output guard, 21 tests |
| AI synthesis | `BLOCKED BY DATA/INTEGRATION` | Needs `AI_PROVIDER` / `AI_API_KEY`. Refuses with 503 until then |
| Document extraction (OCR) | `BLOCKED BY DATA/INTEGRATION` | Upload path and validation built; no provider. Checks work on typed input |
| Alert scheduling | `IMPLEMENTED` | Endpoint ready for any cron; evaluates then delivers, per-channel receipts |
| Alert delivery — in-app | `IMPLEMENTED` | Inbox with dedupe key, read state, rule shown per row |
| Alert delivery — webhook | `IMPLEMENTED` | HMAC-SHA256 signed, 5s timeout, reports non-2xx as failed |
| Alert delivery — email | `BLOCKED BY DATA/INTEGRATION` | No transactional provider. Reports `notConfigured`; never claims a send |
| Navigation integrity | `IMPLEMENTED` | `test/navigation.test.ts` fails CI on a link with no route behind it |
| Free tools | `IMPLEMENTED` | No data dependency, so correct and indexable whichever adapter runs |
| Tool independence guard | `IMPLEMENTED` | `test/tools-independence.test.ts` fails CI if a tool reads the repository, posts data, or grows a demo banner |
| Structured data (JSON-LD) | `IMPLEMENTED` | WebApplication, FAQPage, HowTo, Article, DefinedTerm — assembled from literals only |
| Answer-engine surface | `IMPLEMENTED` | `llms.txt`, versioned methodology permalinks, explicit AI-crawler allow |

## Not built

Floor-plan intelligence · Maps · Advisor workspace · CRM · Transaction state ·
Billing · NRI workflows · Admin · Blog.

Advisor, CRM, admin and NRI are deliberately not started rather than
half-built. NRI in particular turns on statutory TDS, FEMA and DTAA
positions: shipping those from memory would put asserted tax law on screen
under a product promise of verified, sourced facts, which is the one thing
this product must not do. It needs a citable, dated rate table and
professional review before any of it renders.

### Known limitations in what did ship

- **Rate limiting is in-process.** On N instances it permits N times the
  configured rate. `RateLimiter.isDistributed` exposes this rather than hiding
  it; swap in a shared store before running more than one instance.
- **Alert snapshots live in an in-process store in fixture mode.** A restart
  loses the baseline and the next visit re-baselines instead of reporting a
  change. Supabase mode persists; the in-memory store is development only.
- **Email delivery has no provider.** The channel reports itself
  `notConfigured` with the integration requirement rather than shipping a
  console-logging stand-in that returns success.
- **Reports print through the browser.** Real PDF with selectable text, no
  extra dependency. A server renderer is only needed once reports must be
  emailed or stored.

## Quality gates

```
npm run typecheck   ✓ strict, noUncheckedIndexedAccess, zero errors
npm run lint        ✓ zero errors, zero warnings
npm run test        ✓ 386 tests across 19 files, ~2s
npm run build       ✓ 30 routes, production build clean
```

Nothing is suppressed. No `any`, no `@ts-ignore`, no disabled lint rules.

## Test coverage by area

| Area | Tests |
|---|---|
| Security / provenance invariants | 47 |
| Document checks | 46 |
| Integration (fixture + full chain + profile + visits) | 34 |
| Investment math | 24 |
| AI Copilot pipeline | 21 |
| Valuation | 25 |
| Site visits | 21 |
| Negotiation | 18 |
| Portfolio arithmetic | 17 |
| Alert rules | 17 |
| Scoring | 15 |
| AI grounding | 14 |
| Analytics & formatting | 14 |
| Comparison | 14 |
| Decision rules | 14 |
| Evidence & freshness | 13 |
| Normalization | 12 |
| Risk | 10 |
| Rate limiting | 8 |
