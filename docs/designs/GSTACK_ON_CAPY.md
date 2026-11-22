# gstack on Capy: what crew-only pull requests cost, and the switch for Phase 2

Status: Phase 0 of GST-1833, written 2026-11-07. Nothing here changes how gstack
behaves; it records a measurement for Garry's gate decision and the interface
Phase 2 builds. Approved shape (Garry, 2026-11-07): the crew tools stay in this
repo under `crew/` and load only on Capy machines; everyone else gets gstack
without them.

## 1. What a lighter gate for crew-only pull requests would have saved

**Answer: about $735–855 over the 14 days 2026-10-24 to 2026-11-07 on recorded
spend, or about $1,900–2,000 if every crew-only pull request had paid what
today's selector picks. On today's merge process the paid-eval part is close to
$0.** That is well under the planning estimate of $2–6k per 14 days.

The lighter gate measured: a pull request whose code changes are all crew-only
(tests and docs allowed) runs no public paid evals and gets one review pass.

| | Pull requests | Recorded paid evals | Paid evals through today's selector | Extra review rounds beyond the first |
|---|---|---|---|---|
| Merged in the window | 529 | $8,476 (plus $969 release gate, $300 unattributed) | 42,630 cases, $14,727 | 626 |
| Touching crew code | 260 | $4,467 | $8,933 | 373 |
| **Crew-only (the lighter gate's scope)** | **54** | **$711** | **5,454 cases, $1,878** | **64** |
| Crew plus unclassified repo files only | 22 | $333 | $781 | 23 |
| Mixed (crew plus product or shared code) | 184 | $3,423 | $6,275 | 286 |

- **Paid evals, recorded: $711.** $245 came from screens those pull requests
  ran and $465 from their equal share of merge-train full gates. The train
  share is an upper bound, since a train ran once for up to five pull requests.
- **Paid evals, modelled: $1,878.** Only 3 of the 54 select zero cases today,
  because some crew files (for example `scripts/pr-dependencies.ts`) are inputs
  to every paid case and some crew bins are named in skill prose.
- **Review: about $24–144 (estimate).** 64 extra rounds and about 83 extra
  reviewer dispatches, priced from 36 measured dispatches in 14 /ship cost logs.
- **Widening the scope.** Pull requests whose other files are tests or docs
  are already in the 54. Adding the 22 whose other files are unclassified
  (`TODOS.md`, `README.md`, `.gstack/`, `scripts/lib`, `scripts/resolvers`)
  raises paid evals to $1,044 recorded and $2,659 modelled, but some of those
  touch product: `scripts/resolvers` generates skill text.

### Caveats

- **The process changed mid-window.** Until 2026-11-04 every pull request rode
  a merge train that ran the full paid gate. Since direct landing (#3977) a
  pull request pays for paid evals only when it asks for a screen, and the
  release gate runs on main every 8 hours whatever each pull request changed.
  All of the recorded paid saving comes from the train period; the 16 crew-only
  pull requests merged after 2026-11-04 recorded $0.
- The modelled column uses today's selector, not the one each pull request ran
  against, and counts gate cases only (a full gate's judges cost about $0.48).
- 24% of recorded dollars are priced from run duration because those trials
  recorded no cost.
- Review dollars are an order of magnitude: the cost logs carry no pull request
  number, and 168 merged pull requests have no review line in their body.
- Only paid-eval and review spend is counted: not /ship's own work, /autoplan,
  free CI minutes or Ubicloud pre-gates.
- The 528/276/62/196 split in the planning inventory differs from the 529/260/54/184
  here mainly because `agents-digest/gstack-AGENTS.md` changes only its version
  line in about 60% of commits; this count treats that line as version metadata.

### Method

First-parent squash merges on origin/main from 2026-10-24T00:00Z to
2026-11-07T23:59Z, each diffed against its parent and classified with the
planning inventory (crew, product, shared, unclassified; tests and docs never
count against a pull request). Recorded spend sums executed trials' `cost_usd`
from every evals.yml run's `trial-outcomes`, `paid-plan`, `report-verdict` and
train-record artifacts (2,818 runs, 1,872 artifacts). The modelled column is
`scripts/gate-cost-replay.ts --since 2026-10-24 --until 2026-11-07 --json` at
5f9b7ef with the case cost table from runs 42391221370, 42349387007 and
41751174367. Review rounds come from each pull request body's `REVIEW_LOOP`
line. Free, read-only, no paid runs.

## 2. Phase 2: one switch for the crew steps in /ship, /review and /autoplan

Phase 1 moves code no public skill calls into `crew/` and makes setup register
the crew skills only on Capy. What is left is crew code that public skills call
today. Phase 2 puts each of those calls behind one switch, so a non-Capy run
skips the crew step and gets a defined result instead.

### The switch

- **One signal.** "Crew loaded" means a Capy machine (`CAPY_MACHINE_CONFIG` set
  or any `~/.capy` entry, which paired devices have too: `gstack_on_capy` in
  `bin/gstack-install-registry.sh`, `onCapyMachine` in
  `scripts/discover-skills.ts`, both added by #4143) and a `crew/` folder in
  the checkout. Nothing
  else turns crew steps on: not `GSTACK_CAPY`, not `.gstack/ship-policy.json`.
  Tests force either answer with a temporary HOME, as
  `test/crew-skills-on-capy.test.ts` (also from #4143) does.
- **Prose calls go through one wrapper.** A new `bin/gstack-crew-step <step> --
  <command…>` runs the command when crew is loaded. Otherwise it runs nothing,
  prints `CREW_STEP: <step> skipped (not a Capy machine)` and exits 0. Skill
  templates name crew commands only through it, so the generated SKILL.md is
  the same for every host and a guard test can list every crew call.
- **Code calls go through one module.** `lib/crew-hooks.ts` exports the crew
  steps shared /ship code needs, each with a typed "absent" result. When crew
  is loaded it imports `crew/lib/hooks.ts` dynamically; otherwise it returns the
  absent result without loading any crew module. `lib/ship-policy.ts`,
  `lib/ship-preflight.ts`, `lib/ship-bin-common.ts`, `lib/ship-patch.ts` and
  `lib/gstack-post.ts` import that module instead of crew modules. A guard
  test fails when anything outside `crew/` imports `crew/` directly.

### What each skill does without crew

| Skill and step | Crew command or module today | Without crew |
|---|---|---|
| /ship Step 1 and every boundary check | `gstack-ship-budget` start, note and handoff; `lib/spend-ledger` | No meter; an explicit `--token-cap` is still honoured by the public core |
| /ship Step 5 and finish | `gstack-pregate` (remote carry), `gstack-ci-carry` | Local checks only (generated-file freshness, secrets, strays), under a public name |
| /ship push and PR body | `gstack-ship-receipt`, `SHIP_RECEIPT` line, the Approvals and Ruled-notes lines | No receipt and no crew lines; the body keeps What changed, Why and Blast radius |
| /ship version | `gstack-ship-release`, restamp | The existing VERSION and CHANGELOG path; restamp's rewrite stays public for /land-and-deploy |
| /ship queue ready, red-base pause | `gstack-ship-queue ready`, `lib/base-red` | Skipped |
| /review rulings | `gstack-approval-classes` | No approval-class check |
| /autoplan budget and gate | `lib/spend-ledger`, `lib/gate-list` (nine modules import them) | Split: a public budget and gate core stays in `lib/`; crew keeps the ledger mirror |
| /autoplan owner brief and trail | `gstack-owner-brief`, `lib/captain-brief`, `gstack-decision-trail`, `gstack-lane-check` | Skipped; the plan and the gate render as today |

### How Phase 2 proves it

- **A no-crew install check in CI**: a clean HOME without the Capy signal runs
  /ship's deterministic steps with stub crew commands that record any call,
  and fails on one. The same job runs with the signal and expects today's calls.
- **Byte-identical Capy behaviour**: the generated SKILL.md and the PR body a
  Capy run produces are compared with main's on a recorded fixture.
- **Focused evals**: /ship and /autoplan, a crew arm and a no-crew arm, under
  the $10-per-PR cap, with a no-loss bar registered before the run (review
  changes merge only after their no-loss replay passes).
- **Rollout**: one pull request per row group (ship budget and receipts;
  pregate split; autoplan split; review), each landing alone. Rollback is a
  revert of that pull request; the switch itself keeps today's behaviour on
  Capy, so a crew run never depends on the new path being right.
