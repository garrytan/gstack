# AgentForce Enterprise Process

> Every business engagement at a company using the AgentForce enterprise teams follows this
> process — the business-side twin of the development process (`docs/agentforce/PROCESS.md`
> in the agentforce repo: office-hours → plan reviews → docs PR → code). The goal is the
> same: surface bad assumptions while changing direction is free, and leave a dated audit
> trail proving the work was reviewed before it shipped.
>
> Per-team operating detail lives in [`processes/<team>.md`](processes/). This document is
> the company-level map: which order, which track, what triggers a board pass, and what
> re-runs when a plan changes.

---

## The three tracks

| Track | When | Shape |
|-------|------|-------|
| **A — Bootstrap** | New product/company, or first adoption of the enterprise teams | Foundation → teams in dependency order → board pass → review PR |
| **B — Incremental engagement** | Discuss, extend, or revise one team's plan | One team skill run → dated artifact → team consultant review → PR (board pass only if triggered) |
| **C — Change propagation** | A team's plan changed in a way other teams consume | Update the foundation if facts changed → run the propagation row → board pass if triggered |

`/enterprise-autoplan` automates Track A end-to-end (and Track C via `--refresh`) with
auto-decisions — one command, the whole bootstrap, only facts and taste decisions surfaced.

---

## Track A — Bootstrap (new product)

```
/enterprise                      Phase 0 — company foundation (facts everything reads)
      ↓
/strategy                        Phase 1 — the strategic spine, modes in order:
  --landscape → --market → --pricing → --growth
      ↓
/marketing --positioning         Phase 2 — clarity before channels
/sales --icp                       (positioning consumes the landscape; ICP is SHARED —
      ↓                             sales inherits and reconciles, never forks)
/finance --model → --runway      Phase 3 — can the plan be funded? (+ --pricing-study
      ↓                             when pricing needs quantitative validation)
/compliance --applicability      Phase 4 — before anything goes external
/legal --paper
      ↓
/marketing --plan                Phase 5 — activation (as stage demands):
/sales --playbook, --outbound      GTM plan, sales system, support ops, hiring, cadence,
/customer-success --support        deployment plan
/people --hire · /bizops --metrics, --okr
/deployment --design | --audit
      ↓
/exec-review docs/enterprise/    Phase 6 — the board pass over the assembled plan
      ↓
Review PR                        Phase 7 — "docs: enterprise bootstrap review package"
      ↓                            human approval gates all external execution
External execution               Phase 8 — humans sign/send/file/publish per the
                                   human to-do lists; teams monitor per their cadence
```

**Order matters because outputs feed forward.** Positioning without the competitive
landscape is guesswork; a GTM plan without positioning is channels-before-clarity (the
canonical failure every skill blocks); an operating model without pricing and ICP is
fiction; legal paper without the compliance applicability memo bakes in wrong assumptions.

**Don't run it in one sitting.** Each phase produces artifacts a human should glance at
before the next consumes them. `/enterprise` recommends the single next engagement;
activating one team well beats six half-configured ones. Use `/enterprise-autoplan` when
you explicitly want the whole gauntlet in one pass.

**Stage calibration — the minimum bootstrap set.** Right-sized process is the rule
(oversized process is its own failure mode):

| Stage | Minimum set | Defer until real |
|-------|-------------|------------------|
| Pre-revenue, <5 people | Foundation, `/strategy` (all modes), `/marketing --positioning`, `/finance --runway`, `/compliance --applicability`, `/deployment --design` (the moment anything ships to production) | Sales system (founder sells), legal paper beyond an NDA, CS/people/bizops programs, readiness reviews (standard-class gates suffice) |
| First customers, <$1M ARR | + `/sales --icp` + `--playbook`, `/legal --paper`, `/finance --model`, `/customer-success --support` (internal SLAs), `/deployment --audit` + `--runbook` | Comp bands, QBR program, formal OKRs |
| Growing, $1M+ ARR or 10+ people | The full Phase 1–5 set | Nothing — all ten teams have work |

---

## Track B — Incremental engagement (one team, one topic)

Discussing a new campaign, a contract, a hire, a vendor, a churn spike — anything scoped
to one team:

1. Run the team skill in the matching mode (e.g. `/marketing --launch`,
   `/legal --review`, `/people --hire`). The skill reads the current foundation and the
   team's prior artifacts — it builds on the plan of record, never from scratch.
2. The team's consultant adversarial review (Phase 4 of every skill) is the quality gate.
   **No board pass needed** unless a trigger below fires.
3. The dated artifact lands in `docs/enterprise/<team>/`, INDEX updated.
4. Open the review PR (`docs: <team> <mode> review package`). Internal-only drafts can
   iterate on the branch; anything customer- or authority-facing waits for approval.

**Revising an existing artifact** is a new dated artifact, not an edit to the old one —
the old file stays as the audit trail. The INDEX shows the succession.

Scheduled re-checks run as Track B engagements too: `/strategy --refresh` and
`/strategy --teardown <competitor>` replace the retired standalone competition-watch
skill. `--refresh` is the strategy team's full scheduled sweep — the AgentForce
planner runs it on cadence, and it executes both the watch-list sweep and every dated
revisit trigger across the team's artifacts (pricing revisits, measurement windows,
publish-gate follow-ups). The `## Revisit triggers` convention is defined once, in
the `/strategy` skill's `--refresh` contract — every team's artifacts should carry
the section so the planner can schedule the follow-through instead of relying on a
human calendar. Scope honestly: today only the STRATEGY team has a scheduled sweep
that executes triggers. Other teams' `## Revisit triggers` sections are recorded but
NOT yet machine-executed — until a team gains its own `--refresh` equivalent, its
dated commitments still need a human (or a planner follow-up issue) to fire them.

---

## Track C — Change propagation

When a team's plan changes in a way other teams consume, two rules come first:

1. **Facts change → foundation first.** If the change alters product, stage, business
   model, pricing, customers, or geography, update `docs/enterprise/foundation.md` (and
   the owning team's foundation) *before* running anything else — every team reads it.
2. **Then run the matrix row.** Required re-runs unblock correctness; recommended
   refreshes keep artifacts honest but can ride the next cadence cycle.

| Change | Required re-runs | Recommended refresh | Board pass? |
|--------|-----------------|---------------------|-------------|
| **Pricing or packaging change** (`/strategy --pricing`) | `/finance --pricing-study` + `--model`; `/legal --review` on order form/ToS pricing terms; `/sales` playbook pricing section + battle cards | `/marketing --positioning` value themes + pricing page copy; `/customer-success` renewal plays (grandfathering) | **Yes** — pricing is cross-domain by definition |
| **Category / positioning change** (`/strategy --market`, `/marketing --positioning`) | `/marketing` messaging + site copy; `/sales` pitch + battle cards | `/marketing --plan` channels; win-loss guide | **Yes** if the category changed; no for message-level tuning |
| **ICP change** (`/sales --icp`) | `/marketing --plan` (channels follow the customer); `/sales --outbound` lists + sequences | `/customer-success` segmentation + health model per segment; `/strategy --landscape` if the segment implies new competitors | Only if it changes the market thesis |
| **New geography / jurisdiction** | `/compliance --applicability`; `/legal --paper` deltas (governing law, DPA modules); `/people` state addenda if hiring there | `/finance` — flag tax nexus for the CPA | **Yes** |
| **New data collection, AI feature, or subprocessor** | `/compliance --privacy` (data map/RoPA/policy delta) and `--ai` for AI features; `/legal` ToS/DPA delta | `/marketing` claims check ("we never train on your data" must stay true) | Only if customer-facing claims or contracts change |
| **Tier 1 launch** | `/marketing --launch` (owns it); `/deployment --readiness` (the launch ships through the release gate); `/sales` enablement delta; `/customer-success` readiness (macros, KB, staffing for the spike); `/legal` claims review | `/compliance` if the feature touches new data | **Yes** for Tier 1; Tier 2/3 need only the marketing consultant gate |
| **Deployment stack / platform change** (`/deployment --design` revision) | `/deployment --runbook` re-issue; `/setup-deploy` re-run (deploy config of record) | `/finance --finops` (cost posture); `/compliance --applicability` if data residency moves | Only if customer-facing SLAs, pricing posture, or data location change |
| **Deploy-caused Sev 1 incident, or promised SLA at risk** | `/deployment --audit` (post-mortem feeds it); `/customer-success` comms | `/legal` if SLA credits are owed | No — unless the fix requires an SLA or architecture change |
| **Headcount plan change / first hire in a new state** | `/people` (scorecard or state compliance); `/finance --runway` | `/bizops --okr` if goals shift | No — unless runway impact is material or it's a RIF (RIF → attorney + board pass) |
| **Fundraise** | `/finance --raise`; `/legal --corporate` (data room, consents) | `/strategy` narrative refresh | **Yes**, before anything is sent to an investor |
| **Non-standard enterprise deal** (terms outside the playbook) | `/legal --review`; `/finance` (discount/rev-rec impact); `/customer-success` SLA feasibility check | — | No — deal-desk pattern; escalate to a board pass only for precedent-setting terms (MFN, unlimited liability asks) |
| **Churn spike / NRR miss** | `/customer-success --health` + churn post-mortems | `/strategy --landscape` (competitive driver?); `/marketing` win-loss; `/finance` forecast | Rides the quarterly pass unless existential |
| **Quarter roll** | `/bizops --okr` scoring + new quarter | Each active team refreshes its plan of record | **Yes** — the quarterly board pass (below) |

---

## The board pass — `/exec-review`

`/exec-review` convenes the ten consultants over a target (a doc, a directory, or the
whole `docs/enterprise/` plan of record) and hunts cross-domain contradictions: pricing
that breaks the compliance posture, hiring the runway can't fund, launch claims legal
can't defend.

**A board pass is required — bright lines:**

1. Completing a Track A bootstrap (always, before the review PR).
2. Pricing or packaging changes.
3. Category repositioning or new-market/new-geography entry.
4. Tier 1 launches.
5. Fundraise materials, before anything external sees them.
6. Any change whose propagation row touches **three or more teams'** artifacts.
7. **Quarterly**, over the full plan of record — the standing cadence pass, aligned with
   the OKR roll and the foundation's 90-day review.

**A board pass is NOT required for:** single-team artifacts (the team's own consultant
review is the gate), Tier 2/3 launches, individual deals within playbook norms, routine
content/KB/macros, internal process docs. Over-reviewing is process theater; the
consultant already reviewed it once.

---

## Review PRs and the audit trail

Same law as the development process:

- Every artifact carries its date in the filename and header
  (`docs/enterprise/<team>/<slug>-<YYYY-MM-DD>.md`). **Dates are the audit trail — never
  removed, never backdated.** Revisions are new dated files, not edits.
- Every artifact carries a review gate on its face: `AI-final`,
  `Human review recommended`, or `Licensed professional required (attorney / CPA /
  broker / auditor)`.
- PR titles: `docs: <team> <mode> review package`; bootstrap: `docs: enterprise
  bootstrap review package`; board passes attach the `/exec-review` verdict to the PR.
- **Nothing externally binding ships before the PR is approved** — sending, signing,
  filing, publishing, or spending waits for a human. Internal drafts iterate freely.

## Human action checklists (always a file, never buried)

Every team engagement ends by handing the human a list of things only they can do (engage
counsel, sign, file, spend, configure an external account, hold a conversation). **That list
lives in ONE standing checklist per team that grows over time — never a fresh dated file per
engagement, never buried in an artifact footer, never left only in chat.** One shared shape
across all teams so the user and the planner always know where it is and how to read it.

**Where:** exactly one file per team, `docs/enterprise/<team>/CHECKLIST.md` — the single
living checklist. Every engagement APPENDS its human items here. Link it from the team's
`INDEX.md` once, marked `standing` (not re-added per engagement).

**When:** always — any engagement that produces human action items appends them. One or two
trivial items may also be echoed inline in the handoff, but they still land in the checklist.

**Shape (the standing `CHECKLIST.md` has all of these):**

1. **Header block** — `# <Team> — Standing Human Action Checklist`, a `Maintained by` line,
   and a `Last updated: <YYYY-MM-DD>` line.
2. **"What this is / How to use it"** — one short paragraph: the doc is living and
   append-only, categories are ordered by execution/importance, plus a legend for any
   priority markers.
3. **Categorized `- [ ]` steps, ordered by execution/importance** (what gates what, what is
   time-critical, what is deferred). Each step carries a short rationale and, where relevant,
   a blocking-path marker and a link back to the dated artifact it came from. Steps a skill
   will do (not the human) say so. Check items off IN PLACE as they complete — closed items
   stay as audit trail.
4. **A `## Changelog`** at the bottom — one dated entry per engagement listing the items that
   engagement INTRODUCED. This is what lets the planner detect new items without re-reading
   every checkbox.
5. **The team's review-gate footer.**

**Adding items (every engagement does all three):**

1. Append the new items into the right categories, in execution order.
2. Add a `## Changelog` entry — `### <YYYY-MM-DD> — <engagement/slug>` followed by a bullet
   list of the new items, and the `af-manual-action` delta marker below.
3. Bump `Last updated`.

**The planner and the delta issue.** Each changelog entry carries an `af-manual-action` marker
so the planner opens ONE issue per delta — outlining just the newly introduced items and
linking the checklist — instead of one all-time issue per file:
```
<!-- af-manual-action
title: "Manual actions: <team> — new items from <engagement> (<YYYY-MM-DD>)"
labels: af-manual-action, af-manager-review
checklist: docs/enterprise/<team>/CHECKLIST.md
changelog: <YYYY-MM-DD>
owner: founder
-->
```
The planner dedupes on the `changelog` date so an already-opened delta is not reopened; the
issue body lists the new items and points at the checklist, where the live checkboxes stay.

**The printed handoff** is a SHORT pointer ("Human to-dos are in
`docs/enterprise/<team>/CHECKLIST.md` — <N> new this run; category X gates Y"), not a reprint.

Reference model: `docs/enterprise/legal/CHECKLIST.md`.

## Operating cadence

| Rhythm | What runs | Owner skill |
|--------|-----------|-------------|
| Weekly | WBR (metrics vs plan, exceptions only); pipeline review; support queue health | `/bizops`, `/sales`, `/customer-success` |
| Monthly | Close + BvA + investor update; VoC synthesis; content/SEO refresh check | `/finance`, `/customer-success --voc`, `/marketing` |
| Quarterly | OKR score + reset; **board pass over the plan of record**; win-loss report; comp/benchmark sanity check; vendor renewal sweep; pipeline audit refresh (DORA re-score, break-glass log, cost re-check) | `/bizops --okr`, `/exec-review`, `/marketing`, `/people`, `/bizops --vendor`, `/deployment --audit` |
| 90 days | Foundation docs `Last reviewed` refresh (every skill nags when stale) | `/enterprise` |

## FAQ

**Where do I start?** `/enterprise`. It builds the foundation and recommends exactly one
next team. If you want the whole bootstrap in one command, `/enterprise-autoplan`.

**Do I really need the review PR for a blog post?** For the *program* (content strategy,
calendar, positioning) yes — once. Individual posts executing an approved program are
Track B artifacts gated by the marketing consultant review only.

**A team's artifact contradicts another team's.** That's exactly what `/exec-review`
exists to catch — run it over both teams' directories and let the board adjudicate.
Whichever resolution wins becomes a new dated artifact in each team's directory.

**When is a human professional mandatory, not just recommended?** The moment output
leaves drafting: attorney before any contract/policy/handbook is executed or published,
CPA for filings and formal statements, licensed broker for benefits/insurance, accredited
auditor for SOC 2/ISO. Each team's process doc names its boundary; each artifact's review
gate says which applies.

**Can I skip a required board pass to move fast?** The propagation matrix exists because
these are the changes that historically break companies sideways. If you skip it,
record that decision in a `/bizops --decide` memo — the one-way-door discipline applies
to skipping the review too.
