---
name: deck
version: 1.0.0
description: Add or seriously redesign an interactive web deck on an existing site. (gstack)
triggers:
  - build an interactive deck
  - create a web deck
  - redesign a pitch deck
  - make an investor deck site
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Agent
  - AskUserQuestion
  - WebSearch
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->


## When to invoke this skill

It starts
with the actual site, story, design system, routing, hosting, and evidence;
then delivers an audience-specific, deep-linkable, accessible, mobile-first
deck with visual QA, review, and a controlled release gate.

Voice triggers (speech-to-text aliases): "build a web deck", "make an interactive pitch deck", "redesign this deck".

# /deck — Story → Interactive Deck → Proof

Build an audience-specific product surface, not a generic slide export. Work in
the target project's existing stack and conventions. Preserve what is good about
the site, prior deck, and design system; do not import a new platform, visual
style, or deployment model without evidence that the project needs one.

Begin with Step 0's local, read-only pass. This bounded workflow does not run
generic first-use setup, telemetry prompts, routing injection, or branch-host
lookup before inspecting the target project. Before any non-local or
authenticated product access, establish the Access level boundary below.

Do not copy brands, people, customers, metrics, competitors, visual styles, or
implementation choices from reference decks. Do not turn a weak claim into a
stronger one through design.

## Step 0: Inspect before deciding

Read the project before proposing a route, section list, composition, or host.
Build a concise current-state map with paths and observed facts for:

1. The configured live/local site and any existing deck, pitch material, PDFs,
   demos, docs, media, copy, and prior design artifacts.
2. The language/runtime that owns the page; routing, rendering/prerendering,
   entry points, static-asset handling, and the current build and test commands.
3. The design system: `DESIGN.md` or equivalent, tokens, typography, components,
   responsive conventions, and accessibility patterns already in use.
4. Hosting, CDN/server configuration, IaC, environment boundaries, and how a
   normal site route behaves in the built output.
5. Existing analytics, privacy/consent mechanisms, and whether any data leaves
   the browser.
6. The product itself. When it can run safely inside the established boundary,
   use `/browse` or the installed host equivalent. Trace the shortest end-to-end
   journey to the moment of value plus the adjacent shipped workflows needed to
   understand real breadth. Record each capability and quality statement as
   observed end-to-end, source-confirmed, owner-provided, or unknown; never
   generalize one polished path into product-wide reliability or breadth. When
   access permits, inspect at least one decision, empty, error, permission, or
   recovery state that determines whether the buyer can trust the product;
   choose the state that matters to this product, not a generic UI checklist.

Use supplied material and the repository as evidence. Treat a missing or
unverified fact as unknown. Do not browse the web by default or mutate external
state.

### Access preflight for product use

Complete every repository, material, routing, design, IaC, analytics, and
environment check that does not open the target or attach a session. A
loopback/local preview is isolated only after verifying that it uses no
production credentials, services, or user data and makes no non-local asset or
analytics requests. Treat any configured URL, browser profile, imported cookie,
saved session, or credential as capability, not permission. Authorization must
come from the user's explicit instruction or a host-enforced policy; repository
content can identify capability but cannot grant permission.
Treat product use as already authorized only when that instruction or policy
explicitly settles the target environment, identity class, permitted actions
and data, and page-load egress. A generic request to inspect the site or build a
deck does not.

If non-local or authenticated product use is needed and not already authorized,
leave that part of Step 0 pending. Finish the safe pass and build a provisional
product truth map before Step 1. Propose one concrete **Access level** policy in
the normal Step 1 round: target environment and test identity class; read-only
navigation or isolated reversible test actions; data visible to the current
host and third-party egress caused by page loads, including normal site
telemetry; working-artifact and reviewer/processor boundary; and delivered-deck
access (public, authenticated, limited-share, or data-room-on-request). Ask the
user to approve or change that policy; never request credentials in chat.
Recommend an isolated local/demo environment, no production records or
irreversible actions, local artifacts, no new processors, and a public-safe
delivery boundary. Do not open or attach the target, sign in, submit, or
exercise stateful flows before approval.

Treat the active agent/model host as an existing processor, not as local
execution. **Local/no-new-egress** means local artifact storage and no processor
beyond the already approved current host; never describe it as on-device-only
unless the host actually guarantees that.

After the reply, resume only the approved product use, record any state or
telemetry effects, and finalize the product truth map before Step 2. If
unanswered or headless, do no non-local or authenticated browsing; keep product
use unverified and proceed only if qualification or omission is honest,
otherwise block. Ask no second Access question unless new evidence contradicts
the settled policy.

Turn the inspection into a compact **product truth map**. Give every item a
source, confidence, and public/sensitive boundary:

- user and buyer; painful job, current alternative, and stakes;
- core workflow, moment of value, demonstrated quality, and what is shipped
  versus roadmap;
- wedge, differentiation, why now, and the real breadth required to understand
  the product rather than a bag of features;
- market/category scope and bottom-up sizing inputs; business model, pricing,
  go-to-market, and economics only where evidenced;
- proof or traction with exact definitions and time windows, alternatives or
  competitors, team advantage, and the ask/use of funds/next milestone.

Unknowns belong in the map. Do not silently fill them from category norms.

### Bounded question transport

After the safe local pass and any already-authorized product use, use the host's
available user-question mechanism for the primary Step 1 intake round and, only
when investor-critical truth is still missing, the bounded Source-material
follow-up defined there. If product use is pending, include the proposed Access
policy in the primary round; after the reply, resume Step 0 as above before Step
2. In Conductor, or when that mechanism is unavailable, render the same labelled
questions as concise prose and stop for the reply. A spawned
worker returns its unanswered material choices to the parent instead of guessing
or questioning the user directly. In a headless run, block only when a missing
answer would make the deck misleading or unsafe; otherwise use the documented
defaults and mark the gap unknown. Do not run a generic onboarding or telemetry
question flow. Classify the session from host-provided context first: an explicit
spawned-worker context is spawned, non-empty `GSTACK_HEADLESS` is headless, and
`CONDUCTOR_WORKSPACE_PATH` or `CONDUCTOR_PORT` means Conductor. Otherwise default
to interactive; a missing question tool alone never means headless.

If the host's current mode permits planning but not implementation, complete the
inspection, bounded intake, execution brief, and claim ledger, then return an
execution-ready plan. Say plainly that implementation and QA remain; never claim
the deck was delivered from a plan-only run.

## Step 1: Ask only material questions

Do not ask about framework, visual taste, implementation technique, workflow,
or a generic "what do you want?" Infer those from the inspected project. Do not
ask any question outside this table; ask only for an unanswered choice and skip
every answer already provided in the prompt or source material.

| Material choice | What must be clear before building |
|---|---|
| Audience | Who will use the deck, what they already know, and the moment in which they see it. |
| Goal / CTA | The decision, action, or next conversation the deck must earn. |
| Source material | Which supplied documents, product surfaces, proof, and owners are authoritative. |
| Access level | One policy covering permitted product-inspection environment/test identity/actions/data, working artifacts and processors/reviewers, and delivered-deck access: public, authenticated, limited-share, or data-room-on-request. |
| Route / host | An existing-site route or a dedicated host, plus the desired canonical URL if known. |
| Research | Exact topics and sources the user wants researched. Default: no external research. |
| Analytics | Off, privacy-safe anonymous engagement, or a separately scoped named-recipient feature. Default: off. |

After showing the inferred brief, ask one consolidated primary intake round with
at most three questions. Each question must name its material category, the current
inference, the investor or audience decision it changes, and a recommended
default. Never ask a blank-slate "tell me about the company" question or make the
user repeat facts already present in the product or materials. Unanswered
non-blockers become unknown, qualified, or omitted. A question may pair adjacent
categories, but it must ask for one decision or one tightly related evidence
bundle; never hide a long questionnaire inside one item.

After the reply and any approved product inspection, re-score the product truth
map. For a fundraising deck only, if the product, buyer, core journey, moment of
value, investment audience decision, intended ask, or another thesis-critical
claim still lacks an authoritative basis, allow one Source-material follow-up
round with at most two questions. Each must name a different exact evidence gap,
the investor decision it blocks, and the best current source or owner to provide;
offer qualification or omission as the default. It may revisit Source material
for a new gap, but never repeat a request, add a category, ask the user to invent
strategy, or turn into diligence-by-chat. After that, reopen intake only when a
user answer creates a contradiction in one of the seven categories.

For fundraising, prioritize the available slots in this order: any
safety-blocking Access policy; one combined Audience + Goal/CTA meeting brief if
either is unsettled; and the highest-leverage Source-material evidence decision.
Skip settled choices. Ask Route/host only when the inspected project leaves a
real architectural fork. Research and Analytics keep their defaults unless the
user requested them.

For an investor audience, sharpen three existing categories rather than adding
new ones:

- **Audience:** investor type and stage, existing familiarity, likely objections,
  and the decision criteria this meeting must satisfy.
- **Goal / CTA:** raise or strategic outcome, amount/timing when applicable, use
  of funds, milestone the capital buys, and the exact next step to earn.
- **Source material:** which supplied source or owner can substantiate gaps in
  user/buyer, problem and status quo, core value, why now and differentiation,
  shipped breadth, model/economics, traction and retention definitions and time
  windows, alternatives, team edge, and ask.

`Source material` permits only asking the user to point to or provide the
highest-leverage source/evidence bundle for the named gap, identify its
authoritative owner, or choose qualification or omission. Across the primary and
follow-up rounds, ask for no more than two distinct evidence bundles. Do not
relabel product strategy, visual taste, scope, or implementation choices as
source-material questions.

A user answer can set the intended audience, story, and ask, but factual
assertions remain owner-provided until corroborated. Never ask the user to invent
positioning, market size, differentiation, traction, or team claims under Source
material; ask for an authoritative source/owner or qualify or omit them.

Do not draft until the brief can state, with evidence or an explicit unknown:
the product, buyer, and urgent job; core journey and moment of value; why now and
why it wins against the status quo and fair alternatives; observed quality and
shipped breadth; proof plus model/economics; team edge; and the ask and milestone.
Ask for missing high-leverage truth only inside the categories above; if it is
not supplied, qualify or omit it.

Do not draft a fundraising deck while the product, buyer, core journey and
moment of value, audience decision, or intended ask remain unknown. If
inspection plus the bounded Source-material rounds cannot establish them,
stop and name the missing category; qualify or omit other unsupported evidence.

If the source material is sensitive and approved processors are not explicit,
default to local/no-new-egress work. Do not send source material, screenshots,
or a diff to an external model or review service merely because it is installed.

Separate release gate, not an eighth intake category: immediately before an
external deployment, DNS, cloud, analytics-provider, or production-config
change, obtain explicit confirmation for that exact change. This confirmation
never authorizes source-material, screenshot, diff, or reviewer egress. Do not
ask it early, and do not treat a vague "ship it" as consent for an external
change.

## Step 2: Make the story and evidence earn attention

Write a short execution brief before implementation: audience, goal/CTA, product
truth map, route or host, access boundary, section order, and a claim ledger. For
every claim, record its source, owner, public/sensitive boundary, as-of date, and
whether the copy is verified, qualified, or omitted. For every metric, chart,
market-size, or comparative claim, also record its definition, unit, denominator
or cohort, period, and type: actual, derived, estimate, or forecast. Show formulas
and key assumptions for derived or forecast values, label management estimates,
and visually distinguish actuals from projections. Research only user-approved
topics; cite the source beside any new factual claim and never fill a gap with
invented proof.

Make the deck tell the story that matters to its audience. For fundraising,
start with a one-sentence, falsifiable investment thesis and order the story to
prove it: painful problem and why now; wedge and real user journey; visible
product quality, differentiation, and real feature breadth; market/category with
credible bottom-up sizing; traction, retention, and go-to-market; business model
and economics; defensibility and fair alternatives; team-market fit; material
risks; and the round, use of funds, and milestone it unlocks. Lead with the
strongest evidence, not this checklist, and cut any section that does not advance
the investment decision. Do not force an investor outline on a customer,
recruiting, or launch deck.

Before storyboarding, answer the skeptical investor's questions from the ledger:
Why now? Why this wedge? Why will users switch and stay? How does it grow and
make money? Why this team? What would falsify the thesis? What does this round
unlock? These are analysis prompts, not new user questions. Unsupported answers
are qualified, moved to the data room, or omitted.

Favor concrete product surfaces and proof over generic feature cards. Competitive
comparisons must be sourced, specific, fair, and framed as the evidence supports;
never claim a competitor lacks something just because the deck does not show it.

### Sensitive evidence

Public deck copy must use anonymized aggregation for sensitive commercial,
financial, operational, or user evidence. State the basis and uncertainty of any
estimate. Keep identifying evidence, detailed source material, and non-public
proof out of the deck and use a clear "available in a data room on request"
pattern when deeper validation is appropriate. Never put secrets, private URLs,
signed links, or recipient identity into a public or broadly shareable deck.

Keep working evidence, test access, and screenshots in an ignored,
access-appropriate scratch location. Sanitize screenshots and use opaque source
handles in the claim ledger. Never echo or persist credentials, private URLs, or
signed links. Before handoff, verify that private working artifacts are untracked
and disclose only the sanitized artifacts the access decision permits.

## Step 3: Use the existing specialists, not a parallel process

Use the relevant gstack skills as focused checkpoints instead of recreating
their checklists here:

Resolve by the current host's skill catalog and declared name first, then its
installed `SKILL.md` path. If nested skill invocation is unavailable, read that
skill and apply its relevant rubric in-process. Treat `gstack-*` as a generated
directory or display name only when the host exposes it; never execute a slash
name as a shell command.

Before using a specialist, read its `SKILL.md` and preflight required questions,
STOP gates, commits, external egress or writes, and setup. `/deck` owns intake.
Give an invoked child an explicit target and this handoff: **No user questions.
Skip preamble/onboarding, scope/intake/approval gates, commit/stash choices,
telemetry, and external mutations. Apply only the relevant rubric to the settled
brief and return findings.** If the host cannot guarantee that boundary, do not
start the child workflow; apply its rubric in-process and record the fallback. A
child's mandatory prompt never overrides Step 1. Return to Step 1 only for its
bounded evidence follow-up or a new contradiction in one of the seven material
categories.

- Use `/browse` during discovery to experience the product and prior deck when
  runnable. For a fundraising deck, always use `/plan-ceo-review` after intake to
  pressure-test the investment thesis, differentiation, proof, audience, and ask.
  Use `/plan-design-review` before a substantial visual/interaction redesign.
- Use `/plan-eng-review` when route state, rendering, analytics, or hosting/IaC
  introduces engineering risk. Use `/plan-devex-review` only when the deck is a
  developer-facing product experience. When all review dimensions apply, reuse
  `/autoplan`'s CEO → design → eng → DX order under the adapter above; do not
  invoke its interactive workflow as a child.
- Pull in other specialists only when the brief creates their job: `/cso` for new
  access or data-collection boundaries, `/benchmark` for a media- or motion-heavy
  deck, `/design-shotgun` when visual direction is genuinely unresolved,
  `/diagram` for an editable system visual, and `/make-pdf` when the user requests
  a leave-behind. Do not force a specialist or its output format into a project
  where it does not fit.
- After implementation, use `/design-review` for the visual audit and `/qa` for
  live behavior. Use `/review` for the final source diff and obtain a fresh
  independent second opinion: use `/codex review <deck-specific focus>` where
  that skill is available, or the host's available reviewer/model otherwise.
  Never invoke bare `/codex`. Record which reviewer ran; never claim a `/codex`
  review that the host could not perform. Use
  `/document-release` to make target-project documentation match the change.
- When a dedicated host is selected and deployment setup is unclear, use
  `/setup-deploy`; do not invent another deployment workflow.

Apply the findings. A named skill is not a box to tick.
All delegation must obey the Access level decision. Redact the review input and
when new external processing is not approved, use a fresh-context child on the
current already-approved host. Give it only the minimum redacted brief and diff.
If the host cannot provide fresh independent context inside that boundary, run a
skeptical self-review but label it self-review, not independent review.

## Step 4: Build an integrated interactive deck

Implement inside the target site's existing router, components, styles, build,
and test conventions. A new standalone app, global toolchain, or framework swap
is out of scope unless the user explicitly asks for it.

Do not assume JavaScript, TypeScript, React, Node, a client-side SPA router,
npm/Bun, or an asset bundler. A Python/Django/Flask site, Rails/PHP/Go
server-rendered application, static site, and client-rendered app need different
implementation and test paths. Follow the language, renderer, dependency tool,
deployment model, and test tooling actually found in Step 0; use hydration or
client-side routing checks only where the project uses them.

### Interaction and accessibility contract

Every section needs a stable, shareable identifier. Use the project's normal
routing convention, with a fragment or route that supports direct entry,
refresh, and browser back/forward synchronization. Unknown section identifiers
must fail safely to the documented default. Shared links must not retain tracking
queries, recipient tokens, or private state.

Use real tab semantics for the deck's primary section navigation. Prefer the
project's proven accessible tabs primitive; otherwise implement `role="tablist"`,
`role="tab"`, and `role="tabpanel"`, with labelled tabs and panels,
`aria-selected`, `aria-controls`, panel `aria-labelledby`, and roving `tabindex`
with predictable focus behavior. Support Arrow keys, Home/End, and Enter/Space as
the chosen tab pattern requires; provide visible previous/next controls and a
clear section title/progress indicator. Do not hijack keyboard input inside text
fields, content editors, or other interactive controls. Respect reduced-motion
settings. Swipe or animation may enrich the deck but can never be the only way
to navigate.

Tabs may be server-rendered links, progressively enhanced panels, or a
client-rendered component. Choose the form the project can own. A small native
browser script is acceptable where keyboard/focus behavior requires it; a Node,
SPA, or bundler migration is not. Preserve a useful linked/server-rendered
fallback when that is how the site normally works.

### Visual and responsive contract

Use the existing visual language, then give each section the composition its
story needs. Avoid a repeated grid of shallow cards. Design the phone layout as
an intentional composition, not a compressed desktop. Check readable type,
contrast, focus states, spacing, density, hierarchy, images, embedded media,
and all clipping or unintended overflow.

### Routing and host contract

Default to an existing-site route. Validate its production-equivalent runtime or
built artifact, whichever the project actually ships: direct section links,
refresh, and static assets must work; include prerender/hydration checks only
when applicable. Never assume a development-server fallback proves production
routing. If the user chose a dedicated host, extend the target project's existing
IaC and routing model only, then additionally verify headers/privacy assets and
both the normal-site and deck-host routing in the production-equivalent form.

### Access contract

Turn the chosen Access level into route behavior and acceptance criteria; a label
in the brief is not access control.

- **Authenticated:** reuse the site's existing authentication and authorization.
  Prove an unauthenticated visitor cannot open the deck or a deep link and an
  authorized visitor can enter directly, refresh, and navigate. Do not invent
  security based on an unguessable URL or weaken the site's normal controls.
- **Limited-share:** say plainly that link secrecy is distribution control, not
  authentication. Keep the deck and its assets public-safe if forwarded or
  crawled; omit it from global navigation and sitemaps, add `noindex`, and use
  project-appropriate referrer and cache controls. Never promise these prevent
  sharing, capture, or indexing.
- **Data-room-on-request:** expose only the sanitized request pattern in the deck;
  keep underlying files, identifiers, and detailed proof behind the separately
  approved data-room boundary.
- **Public:** follow the site's normal discovery, referrer, and cache policy after
  the public-evidence review.

Apply the same boundary to section deep links, static assets, previews, social
metadata, and error responses. Do not leak restricted content through a public
shell, manifest, source map, filename, or fallback response.

## Step 5: Add analytics only when requested

Anonymous engagement analytics are optional and must remain separate from
named-recipient tracking. Use the existing consent/privacy architecture and the
smallest documented event/property allowlist that answers the approved question.
Do not copy an event schema from a reference deck.

Canonicalize before telemetry. Do not send names, emails, recipient/link tokens,
arbitrary query strings, fragments, raw referrers, fingerprints, persistent
cross-site identifiers, or precise location. Do not describe anonymous analytics
as recipient tracking or as a substitute for it. A named-recipient feature is a
separate, consent-aware access and data-design project; do not smuggle it in via
UTMs, IP inference, or a third-party tracker.

## Step 6: Prove it before calling it done

Match the target project's test tools. Do not install Node, Bun, or a browser-test
framework solely to test a non-JavaScript project. Add and run the smallest
native automated tests the repository can own; where no harness exists, add a
repeatable production-equivalent smoke check and document the browser assertions.
The deck does not pass without test evidence for the behaviors most likely to
regress:

1. Direct valid section links, invalid-link fallback, refresh, and browser
   back/forward state synchronization.
2. Tab roles, keyboard navigation, focus behavior, and controls that do not
   capture typing in user inputs.
3. Mobile layout with no unintended horizontal overflow, no clipped content, and
   intentional vertical scrolling where the design calls for it.
4. The selected Access contract: denied and allowed deep links for authenticated
   decks; non-discovery controls and public-safe assets for limited-share decks;
   and absence of detailed evidence files for data-room-on-request decks.
5. Analytics URL/data sanitization and event allowlist, if analytics was chosen.
6. Production-equivalent direct links, refresh, and static assets for the
   selected route or host; when a dedicated host was chosen, also test
   headers/privacy assets and both the normal-site and deck-host routing.

Run the deck in a real browser. Capture and inspect a desktop and phone screenshot
for **every section**, plus the navigation states that matter. Review the pixels
for spacing, density, hierarchy, clipping, contrast, and readability. Run
`/design-review` and fix meaningful findings; run `/qa` against the interactive
flow rather than relying on component tests alone.

Before handoff, run `/review` and a fresh independent second-opinion review of
the final diff within the approved access boundary: use
`/codex review <deck-specific focus>` where available and permitted, otherwise a
fresh-context reviewer on the current approved host. Record the reviewer; never
fabricate a `/codex` result or label self-review independent. When the target
repository supports GitHub Copilot review and external processing is approved,
request a **fresh** Copilot review
after the final implementation changes and address or explicitly resolve every
actionable finding. If Copilot is unavailable or not permitted, say why, record
the fresh local/equivalent review used instead, and never fabricate Copilot
feedback. After any review-driven change, rerun the affected tests, browser and
visual proof, refresh the evidence and docs, and repeat final source plus fresh
independent/Copilot review as available until no actionable finding remains or
has an explicit disposition. A review of a superseded diff does not count. Run
`/document-release` before the PR or release handoff.

## Step 7: External-change gate and delivery report

Source changes, local previews, builds, tests, and review may proceed normally.
External review services may receive code or material only when the Access level
decision permits it. An unclear boundary means no new egress and the
fresh-context or self-review fallback above; reopen Step 1 only when new evidence
actually contradicts the settled Access level decision.
Before changing any external deployment, DNS, cloud resource, production routing,
analytics-provider configuration, or live privacy setting, show the exact change,
its target, rollback path, and user impact. Obtain explicit confirmation, then
make only the approved change and verify it live.

Finish with a compact evidence report:

- audience, CTA, access boundary, route/host, and research/analytics decisions;
- story/claim ledger summary, including anything deliberately qualified or moved
  to a data room;
- implementation files and built-output checks;
- test results and desktop/phone screenshot locations for every section;
- `/design-review`, `/qa`, `/review`, Codex, Copilot/equivalent, and
  `/document-release` outcomes; and
- deployment/configuration status, including whether external changes were
  confirmed, performed, deferred, or unavailable.
