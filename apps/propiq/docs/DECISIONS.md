# Decisions

Architecture decision record. Newest first. Each entry states what was decided,
why, and what it costs.

---

## D-001 — Build PropIQ at `apps/propiq/`, not at the repository root

**Date:** 2026-09-15 · **Status:** Accepted

**Context.** The target repository is `gstack` — Garry Tan's Claude Code skills
toolkit: a Bun CLI, a Playwright harness, ~40 skill templates, a 59KB root
`CLAUDE.md` and a `docs/` directory its own tests read. It contains no PropIQ
code, and its stack is not a foundation for a property SaaS.

**Decision.** Build PropIQ self-contained under `apps/propiq/`, with its own
`package.json`, toolchain, docs and tests. Leave gstack's root files untouched.

**Why.** Writing PropIQ's `CLAUDE.md` and `docs/*` at the root would have
overwritten gstack's own and broken its test suite — violating the standing
requirement to keep the repository buildable and tested. The brief's file
layout is satisfied relative to the app root, which is what a monorepo package
does anyway.

**Cost.** Doc paths are `apps/propiq/docs/*` rather than `docs/*`. Noted here so
nobody goes looking in the wrong place.

---

## D-002 — Modular monolith, boundaries enforced by the linter

**Date:** 2026-09-15 · **Status:** Accepted

**Decision.** One deployable. `src/domain` is pure and may not import
`@/data/*`, `@/server/*`, `@/components/*`, `next/*` or `react`, enforced by a
scoped `no-restricted-imports` rule.

**Why.** Microservices would add network boundaries with no demonstrated need.
But module boundaries stated in a README erode in a month. A lint rule does
not. The purity buys reproducibility (scores replay identically), test speed
(200 tests in 1.6s with no database), and auditability.

**Cost.** Occasional ceremony passing `now` and repository results into domain
functions instead of reaching for them.

---

## D-003 — Bisection for IRR, not Newton-Raphson

**Date:** 2026-09-15 · **Status:** Accepted

**Decision.** Solve IRR by bisection over `[-0.99, 10]`, 300 iterations, and
return `undefined` when no sign change brackets a root.

**Why.** Property cash-flow series routinely have a badly-conditioned
derivative near the root — long runs of near-zero cash flow followed by one
large terminal value — where Newton oscillates or diverges. Bisection is slower
and always converges when a root is bracketed. For a product whose credibility
rests on its numbers, "slower and correct" is not a trade-off.

Returning `undefined` for a deal that never returns capital is the honest
answer; a fabricated negative rate is not.

**Cost.** ~300 iterations instead of ~5. Immaterial at this volume.

---

## D-004 — Missing signals are dropped and weights rescaled, never scored zero

**Date:** 2026-09-15 · **Status:** Accepted

**Decision.** A signal with no data is excluded, the remaining weights in its
pillar are rescaled, and the surviving share is reported as `coverage`. Below
45% coverage or 35% confidence, no score is published at all.

**Why.** This is the single most important scoring decision. "We measured it and
it is bad" and "we did not measure it" are different claims. Scoring a missing
field as zero makes thin records look dangerous; scoring it as average makes
them look safe. Both are lies, in opposite directions.

**Cost.** Sparse records produce no score, which looks like a gap in the
product. It is not — it is the product working.

---

## D-005 — Publish the methodology by reading live constants

**Date:** 2026-09-15 · **Status:** Accepted

**Decision.** `/methodology` imports `SCORING_VERSIONS`, `DECISION_THRESHOLDS`,
`SOURCE_HALF_LIFE_DAYS` and the risk dimensions directly, and renders them.

**Why.** A published methodology restated in prose drifts from the code within
two releases, and then the published version is a lie. Rendering from the
source makes drift impossible.

**Cost.** The page is less editorial than a hand-written one. Worth it.

---

## D-006 — Three independent layers of demo-data containment

**Date:** 2026-09-15 · **Status:** Accepted

**Decision.** (1) `getServerEnv()` throws on `fixture` under production. (2) The
production adapter filters `data_status <> 'demo'` in the query and declares
`servesDemoData: false`. (3) Every public RLS read policy excludes demo rows.
Plus: a visible banner on any demo-backed surface, and exclusion from the
sitemap.

**Why.** Demo data reaching a production response is the failure that would end
the product's credibility permanently. One guard is a single point of failure.
Three independent guards at config, application and database level mean any one
can be forgotten without the failure occurring.

**Cost.** Some redundancy. That is the point.

---

## D-007 — Real locality names with synthetic figures in fixtures

**Date:** 2026-09-15 · **Status:** Accepted

**Context.** The demo dataset needs to be navigable. Invented locality names
make it useless for development; real names attached to invented figures risk
being read as real market data.

**Decision.** Use real Bengaluru locality names. Invent every developer, project
and unit. Mark every figure `dataStatus: 'demo'`, state the policy in the
fixture source, show the banner on every surface, exclude these pages from the
sitemap, and say so explicitly on `/data-sources`.

**Why.** The containment is strong enough (D-006) that the usability gain is
worth it, and the alternative — a demo of "Locality A" through "Locality F" —
would not exercise the commute, infrastructure or environment logic
realistically.

**Cost.** Requires the labelling to stay loud. If the banner is ever weakened,
this decision must be revisited.

---

## D-008 — Commercial fields are structurally separated from scoring

**Date:** 2026-09-15 · **Status:** Accepted

**Decision.** `CommercialRelationship` is disclosed on every property page. A
test asserts that no commercial field name appears anywhere in
`scoring/engine.ts`, `scoring/signals.ts` or `decision/engine.ts`.

**Why.** "We would never let a paid placement affect a score" is a promise. A
failing CI check is a guarantee. For a measurement company, the difference is
the whole business.

**Cost.** None.

---

## D-009 — Scoring versions are immutable

**Date:** 2026-09-15 · **Status:** Accepted

**Decision.** Weights and thresholds are versioned. A change adds a new version;
existing versions are never edited. Stored `scores` rows reference the version
they were computed under.

**Why.** The formula is published, which makes it a public API. Editing v0.1.0's
weights would silently change the meaning of every historical score and break
the promise that any score can be re-explained.

**Cost.** Version proliferation over time. Acceptable — a version is a few
hundred bytes.

---

## D-010 — The null AI provider throws rather than stubbing

**Date:** 2026-09-15 · **Status:** Accepted

**Decision.** With no provider configured, `NullProvider.complete()` throws
`AiNotConfiguredError`.

**Why.** A stubbed AI answer is indistinguishable from a real one to a user.
Returning a plausible placeholder would be the exact fabrication the product
forbids, shipped by the module whose job is to prevent it.

**Cost.** Any future Copilot surface must handle the error explicitly. That is
the correct amount of friction.

---

## D-011 — Comparison declares a winner only above a minimum meaningful spread

**Date:** 2026-09-15 · **Status:** Accepted

**Decision.** Each comparison dimension carries its own minimum spread (5 score
points, 3 percentage points on fair-value deviation, 0.4pp of yield, 0.08 risk
severity). Below it, the Decision Room reports "too close to call".

**Why.** Declaring a winner on a 0.4-point difference is noise dressed as
insight, and it trains users to distrust the ones that are real.

**Cost.** Some comparisons return few decisive winners. That is an honest result.

---

## D-012 — Every page that reads the repository is `force-dynamic`

**Date:** 2026-09-15 · **Status:** Accepted

**Decision.** No caching on scored pages.

**Why.** Scores depend on evidence freshness measured against the current clock.
A cached score carries a confidence band that was true when it was computed and
is quietly wrong afterwards. Stale confidence is worse than a slower page.

**Cost.** Higher server cost per view. Revisit with an explicit
revalidate-on-evidence-change strategy when volume justifies it — not with a
blanket TTL.

---

## D-013 — Loading skeletons are per-segment, never at the app root

**Date:** 2026-09-15 · **Status:** Accepted

**Context.** A root `src/app/loading.tsx` was in place initially. Smoke testing
found that `/property/does-not-exist` and `/locality/nowhere` returned **HTTP
200** while rendering the not-found page — a soft 404.

**Cause.** A root `loading.tsx` wraps every route in a Suspense boundary. Next
flushes the shell, committing a 200, before the page body runs. `notFound()`
raised after that point can only render the not-found UI; it cannot change a
status that has already been streamed. Moving the check into
`generateMetadata` did not help — the root boundary still opened the stream
first.

**Decision.** Remove the root `loading.tsx`. Place skeletons in the segments
that benefit from them and have no not-found path: `/search`, `/localities`,
`/compare`, `/dashboard`. The two dynamic detail routes get no skeleton.

**Why.** PropIQ's distribution depends on search and AI citation. Soft 404s get
unknown property URLs indexed, which is a slow-acting but real correctness
problem for a product whose whole claim is that it does not assert things it
cannot support. A skeleton on a detail page is worth less than a correct status
code.

**Also.** `generateMetadata` and the page body both need the intelligence
payload, so both dynamic routes now share a `cache()`-wrapped loader. The
scoring chain runs once per request rather than twice.

**Cost.** Property and locality pages show no skeleton while loading. Acceptable
— they are server-rendered and the payload is a single in-process computation.

**Verified:** `/property/does-not-exist` → 404, `/locality/nowhere` → 404,
valid routes → 200.

---

## D-014 — Rate limiting is in-process, and says so

**Date:** 2026-09-15 · **Status:** Accepted

**Decision.** A fixed-window counter behind a `RateLimiter` interface, with
`isDistributed: false` exposed on the implementation.

**Why.** The AI endpoint needed a limit before it could be exposed at all, and
a shared store is not yet justified by the deployment. What would be wrong is
pretending the guarantee is stronger than it is: on N instances an in-process
limiter permits N times the configured rate. Exposing `isDistributed` means a
caller that needs a hard guarantee can check for one rather than assume it.

An anonymous caller gets half the per-user budget, because an IP is far easier
to rotate than an account.

**Cost.** Must be swapped before a second instance runs. Named in
`IMPLEMENTATION_STATUS.md` under known limitations.

---

## D-015 — An unvalued portfolio asset is excluded, not assumed flat

**Date:** 2026-09-15 · **Status:** Accepted

**Decision.** An asset with no current value is left out of portfolio totals
and counted separately, rather than being treated as still worth its cost
basis.

**Why.** Assuming flat value would understate a gain and overstate a loss, and
would present an assumption as a measurement — the same error as scoring a
missing signal as zero (D-004). The UI states the exclusion and the count
rather than hiding it.

Relatedly: a value the user typed is stored as `userProvided` even if the form
offered `verified`. The label on a number has to match where it actually came
from, and the server action enforces that rather than trusting the form.

**Cost.** Totals can look lower than a user expects until they value everything.
That is the honest reading.

---

## D-016 — The Copilot refuses rather than degrading

**Date:** 2026-09-15 · **Status:** Accepted

**Decision.** With no provider configured, `/api/copilot` returns **503** with
`code: AI_NOT_CONFIGURED`, and the UI shows what is missing. The retrieval,
grounding, fencing and guard steps still run.

**Why.** 503 rather than 500 because nothing is broken: the service is
correctly configured to refuse. And a refusal rather than a canned answer
because a stubbed AI response is indistinguishable from a real one to a user —
shipping one from the module whose job is preventing fabrication would be the
sharpest possible version of the failure.

The pipeline runs regardless so the parts that keep the promise are exercised
and tested without a provider present.

**Cost.** The Copilot is visibly unfinished in an unconfigured environment.
Preferable to being invisibly wrong.

---

## D-017 — Alerts evaluate on page load, against published thresholds

**Date:** 2026-09-15 · **Status:** Accepted

**Decision.** Each watched property is re-scored when the alerts page opens,
diffed against its last snapshot, and the new snapshot stored. Every rule
carries an explicit threshold, published on the page itself.

**Why.** The evaluation rules are the hard part and they are pure, so they can
be built and tested before a scheduler exists. Doing it on load makes the
feature real today and leaves the scheduler as a delivery concern rather than a
prerequisite.

The thresholds are the substance: an alert that fires on a one-point score
wobble trains people to ignore alerts, which is worse than having none. A score
move under 4 points is inside the confidence band anyway, so reporting it would
be reporting noise.

**Cost.** The snapshot store is in-process, so a restart loses the baseline and
the next visit re-baselines rather than reporting a change. Stated on the page
("we just took a first reading") rather than papered over.

---

## D-018 — Reports print through the browser

**Date:** 2026-09-15 · **Status:** Accepted

**Decision.** `/property/[id]/report` is a print-styled page. `window.print()`
produces the PDF. No server-side renderer.

**Why.** It yields a real PDF with selectable text, adds no dependency, works
offline, and is available now. A headless-browser renderer earns its place when
reports must be emailed or stored server-side — not before.

The report carries the scoring, decision and valuation versions it was produced
under, so a conclusion can be re-derived rather than taken on trust, and is
`noindex` because it is an artefact for one buyer.

**Cost.** No server-side generation, so reports cannot yet be emailed or
attached. That is the trigger for revisiting this.
