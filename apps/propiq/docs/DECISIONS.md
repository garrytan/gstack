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

---

## D-019 — Document checks are deterministic and ship without OCR

**Date:** 2026-09-15 · **Status:** Accepted

**Decision.** The rule engine runs over a structured `ExtractedDocument`.
Extraction is a separate, swappable step. The UI offers manual entry, so the
checks work today with no provider.

**Why.** The valuable half of document analysis is not reading the page, it is
knowing that a B-khata is not loan-eligible, that a five-year encumbrance
certificate proves nothing about a six-year-old charge, and that an agreement
which forfeits your deposit but carries no delay penalty is not symmetric.
That half is deterministic. Coupling it to OCR would have delayed all of it
for none of it.

Field presence is presence, not truthiness: an empty string means the
extractor looked and found nothing (a finding), `undefined` means it never
looked (a skip). Conflating them would downgrade "this deed has no
registration number" into "we did not check whether it was registered".

**Cost.** Manual entry is slower than an upload. It is also private, free and
available now.

---

## D-020 — A site visit produces first-party evidence, not a notes field

**Date:** 2026-09-15 · **Status:** Accepted

**Decision.** Checklist items may declare an `evidenceField`. Answers on those
items become `Evidence` records with source type `survey` at trust 0.9, merged
into the property's evidence before scoring.

**Why.** A buyer standing in a flat who sees a silt line on the compound wall
knows something the model does not. That observation should move the score,
not sit in free text nobody reads again. It is the only first-party evidence
in the product and is weighted accordingly — above a listing, below an
instrumented survey.

A reported concern is trusted more than a reported all-clear (0.9 against
0.7): "it looked fine" is easy to say without checking. `Didn't check` is
excluded entirely, exactly as a missing signal is excluded from a pillar.

**Cost.** Visit evidence is per user, so two buyers can hold different scores
for the same property. That is correct — it is their observation, not a market
fact — but it means a score is no longer globally cacheable.

---

## D-021 — Negotiation records the sequence, and the walk-away price up front

**Date:** 2026-09-15 · **Status:** Accepted

**Decision.** Store the offer sequence and derive state from it. `walk_away_price`
is NOT NULL and must be at or above the target, enforced by a check constraint.
Status transitions go through `canTransition`.

**Why.** A number set while calm is worth more than one set across a table, and
the failure mode is revising the walk-away upward because you are already in
the room. Storing it before the first offer is the entire point of the model,
so the schema refuses a negotiation without one.

Deriving state from the offers means the summary can never disagree with the
history it summarises. The guidance is deliberately blunt: a buyer
mid-negotiation needs to be told the number on the table is past their own
walk-away, not given a balanced summary of considerations.

**Cost.** None worth naming.

---

## D-022 — Negotiation guidance is capped at the asking price

**Date:** 2026-09-15 · **Status:** Accepted

**Context.** Found by running the app, not by a test. For a property priced
*below* fair value, the raw valuation band sits above the asking price, so the
guidance suggested a target of ₹1.67 Cr against an asking price of ₹1.59 Cr —
advising the buyer to offer more than the seller was asking.

**Decision.** Cap the walk-away at the asking price and the target at 97% of
it, then derive the opening offer under that.

**Why.** An uncapped target is not negotiation advice, it is a bug with a rupee
sign on it. The 3% margin matters too: a below-fair-value asking price is a
reason to move quickly, not a reason to stop negotiating.

**Cost.** None. Six regression tests pin the ordering invariant in both the
overpriced and underpriced cases.

## D-023 — An unconfigured delivery channel says so, rather than stubbing

**Context.** Alerts evaluated correctly but went nowhere. Three delivery
channels were candidates: an in-app inbox, a webhook, and email. Only the
first two can be built without a third-party account.

**Decision.** Every channel implements the same `AlertNotifier` port and
reports one of four outcomes: `delivered`, `skipped`, `failed`,
`notConfigured`. Email is implemented as a notifier that always returns
`notConfigured`, carrying the integration requirement as its detail string.
It does not log to the console and return success.

**Why.** A stub that reports a send it did not make is the alerting version
of a fabricated data point, and this product's central promise is that it
does not do that. `test/alert-delivery.test.ts` asserts that the email
notifier's source contains no `'delivered'` branch, so the stub cannot be
reintroduced quietly.

**Consequence.** The notifications page renders per-channel configuration
state, so a deployment's real capability is visible rather than implied.
Wiring an email provider means adding a notifier, not editing a page.

## D-024 — The page view writes to the inbox, and the write is idempotent

**Context.** Alerts are evaluated when `/dashboard/alerts` loads, because
that is the only evaluation that happens without a scheduler. Without a
write, a change detected on a page view was forgotten as soon as the user
navigated away.

**Decision.** The alerts page writes what fired to the notification inbox.
The store's uniqueness key is `(user, property, kind, rule, day)`, so a
refresh, a double-fired scheduler and a page view that races the cron all
collapse to one row.

**Why.** A side effect on a GET is normally a smell. Here the effect is
idempotent by construction and the alternative is a product that detects a
price cut and then loses it. The dedupe key is what makes it safe, so it is
enforced by a unique index in the schema rather than by application code.

**Consequence.** Three evaluations of the same unchanged alert produce one
inbox row — verified in the browser, not only in unit tests.

## D-025 — Spec-named URLs redirect; they do not become second pages

**Context.** The product calls the comparison surface the "Decision Room"
and the surface lives at `/compare`. People type and link the name.

**Decision.** `/decision-room` and `/reports` are permanent redirects to
`/compare` and `/dashboard/reports`. They are not copies.

**Why.** Two pages rendering the same thing drift, and a score that differs
between two screens is worse than no score. One canonical route keeps that
impossible.

**Consequence.** `test/navigation.test.ts` walks the App Router tree and
fails when any internal link in the header, footer, homepage or dashboard
has no route behind it — which is the spec rule "do not show nonexistent
routes in navigation", enforced rather than remembered.

## D-026 — The free tools are the part of the product that can launch today

**Context.** The engine is real and the dataset is not. Anything that
showcases property intelligence is blocked until a real source lands, which
left the product with nothing it could honestly put in front of anyone.

**Decision.** Split the product by data dependency rather than by feature.
Carpet-area arithmetic, EMI and amortisation, rental yield, the 22 document
rules and the 22-item site-visit checklist depend on figures the user supplies
and on published law, not on our dataset. They ship open — no account, no
email, nothing stored — and they are indexable whichever adapter is running.

**Why.** They are correct for any property in any Indian market today. Waiting
for a data source before publishing arithmetic that is already right would be
withholding a working product for no reason, and these are the highest-intent
questions in the category.

**Consequence.** `test/tools-independence.test.ts` fails CI if a tool page
imports the property repository, calls a server action, posts anywhere, or
grows a `DemoDataBanner`. The moment a tool reads the dataset it becomes
demo-backed and needs a banner it does not have, so the guard is a static
invariant rather than a convention.

## D-027 — Built to be cited, not just ranked

**Context.** A growing share of the questions this product answers are put to
an answer engine rather than typed into a search box. An engine cites what it
can parse, date and attribute.

**Decision.** Expose the shape the product already produces. `llms.txt` is
generated from the live constants — scoring version, pillar weights, decision
thresholds, alert thresholds, document rules version — for the same reason
`/methodology` is: a published formula that has drifted from the running one
is worse than no published formula. Each scoring version also gets a frozen
permalink at `/methodology/v<version>`, since a citation needs a URL whose
content does not change and a scoring version is never mutated once released.
AI crawlers are named explicitly in `robots.txt` rather than left to the
wildcard, with the same disallow list as every other agent.

**Why.** Every fact in this product already carries a data status, a source, an
observation date and a decaying confidence. That is precisely what makes a
claim citable, and it was built for honesty rather than for distribution — the
distribution is a consequence worth collecting.

**Consequence.** `llms.txt` states this deployment's data status in the file a
model reads first, and says plainly not to cite a fixture figure as an Indian
market fact. `test/tools-independence.test.ts` pins that disclosure, so a
future edit cannot quietly drop it.

## D-028 — JSON-LD is assembled from literals, never from a record

**Context.** Structured data is a machine-readable restatement of a page, and
the temptation is to emit property figures into it.

**Decision.** `src/lib/structured-data.tsx` only describes pages: what a tool
computes, what a term means, who published it. No helper accepts a property,
a locality or an evidence record.

**Why.** Two reasons, and the second is the stronger one. A JSON-LD block
built from a record would put demo figures into a machine-readable claim that
no banner covers. And a payload assembled from literals has no untrusted
string reaching a script tag, which removes the injection question entirely
rather than answering it.

## D-029 — The marketing surface projects the engine; it stores no numbers

**Context.** A homepage needs headline figures, and the fastest way to get them
is to write them down. The build brief for the page even supplied illustrative
ones.

**Decision.** `src/site/data/page-data.ts` runs one `buildPropertyIntelligence`
pass and every section reads from it. `src/site/types` describes only what that
projection produces. Three shapes are authored, because the engine has no
concept of them — research entries, the developer profile wrapper and the
command-centre framing — and each carries its own `dataStatus`.

**Why.** Hand-written numbers on a page whose entire argument is that it does
not invent numbers would be self-defeating. And one pass means the hero, the
map, the cards, the comparison table and the command centre cannot disagree
about the same property, which a second copy would eventually guarantee.

**Consequence.** Changing a weight in `src/domain/scoring/weights.ts` moves the
homepage. That is the intended coupling.

## D-030 — Two verdict palettes, picked by the ground the subtree sits on

**Context.** The site is light-first with dark sections inside it. A single
`--color-buy` cannot clear 4.5:1 on both #ffffff and #070b16, and an axe sweep
found 188 contrast failures across the page when it tried.

**Decision.** `globals.css` defines each decision colour twice: the original,
tuned for dark grounds, and an `-ink` variant for paper. `.propiq-site` points
the five semantic tokens at the ink set; `.propiq-dark` points them back. The
same trick already used for surfaces and text now covers verdicts, plus a
`--text-accent` token for brand blue used as text rather than as a background.

**Why.** No component should have to know which ground it landed on. The
alternative — conditional classes at every call site — is the version that
silently rots the first time a section changes tone.

**Consequence.** A verdict is legible on both halves of the page, and the
homepage reports zero serious or critical axe violations at 1440px and 390px.
Adding a third ground means extending the token block, not the components.

## D-031 — The comparison tray is browser-local and never calls itself a watchlist

**Context.** A visitor weighing three properties needs somewhere to put them
before they have an account.

**Decision.** `src/components/site/shortlist.tsx` holds the tray in a module
store read through `useSyncExternalStore`, persisted to `localStorage` and
capped at four — what the Decision Room can render side by side. It hands off
to `/compare?ids=`. Saving is a separate action that goes to the real watchlist
repository and reports what actually happened, including "Sign in to save
properties to your watchlist."

**Why.** Comparing is a reading task; gating it behind a signup would be
theatre. But a local list presented as a stored one is the same class of
untruth as a demo figure presented as a market fact, so the two are never
conflated in the copy or in the storage.

**Consequence.** The tray survives a reload and reaches no server. A save that
cannot happen says so rather than flipping the button optimistically.

## D-032 — Distances are drawn on an axis, because the record has no coordinates

**Context.** The locality section needed a spatial view. The first attempt was
a radar: employment hubs and transit anchors placed around a circle at their
true radius.

**Decision.** Replaced with `LocalityAccess` — one shared horizontal scale, one
bar per anchor, the kilometres and the peak commute printed next to each.

**Why.** `Locality` stores `distanceKm`, not a position. The radar therefore
had to invent a bearing for every anchor and then spend a paragraph explaining
that the bearings meant nothing. A chart that needs a disclaimer to stop it
lying is the wrong chart; the honest version of that data is one axis.

**Consequence.** Nothing on the page implies a direction we do not hold. When a
geocoded anchor set exists, a real map can replace this — and it will be a map,
not a diagram shaped like one.
