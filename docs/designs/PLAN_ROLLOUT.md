# Design: `/plan-rollout` + `/spill-check` — PR-stack-aware planning

**Status:** PROPOSAL — seeking directional feedback from maintainer before implementation.
**Author:** @mastermanas805
**Tracking issue:** (will be added after filing)
**Supporting materials:** [`docs/designs/plan-rollout/`](./plan-rollout/)

---

## The problem

LLM-assisted coding compresses implementation by 10-100x. It does not compress
**review**. A reviewer still reads code at human speed. This asymmetry shows up
as a specific, common failure mode:

- AI produces a 2,000-line diff that touches 15 files across 4 components
- The reviewer can't meaningfully hold the change in their head
- Scope creep ("spills" — unrelated changes sneaking in) compound the load
- LGTM happens under cognitive pressure; real bugs ship
- Rollback is improvised when something breaks in production

None of gstack's existing skills address this. `/plan-eng-review` and
`/plan-ceo-review` scope the plan. `/ship` creates one PR. `/review` reviews
one diff. Nothing asks **"is this one PR or three?"** or **"in what order
should these units ship to production?"**

## The proposal

Two new skills plus a declarative schema:

### `SYSTEM.md` — the semantic contract graph

A repo-root declarative file that declares each component's role, what it
owns, and the role-level contracts between components. It is the **human**
half of architectural truth — things only a human knows.

The **package/import graph** is the machine half — discovered by the LLM at
runtime via AST, grep, and package manifests. Never declared, never cached.

The two graphs are reconciled jointly: declared contracts give the *why*,
discovered imports give the *what*. Disagreements (import without contract,
contract without imports, rollout-order inversion) surface for human
resolution.

Schema: see [`plan-rollout/system-md.schema.md`](./plan-rollout/system-md.schema.md).

### `/plan-rollout` — decomposition + rollout planning

Runs after plan approval (`/plan-eng-review` or equivalent). Produces two
artifacts:

- `decomposition.md` — the PR stack: units with declared files, dependencies,
  reviewer reading-order, time-budget estimates, ASCII stack-map
- `rollout.md` — rollout strategy (flag / canary / migration-first / big-bang),
  step sequence with inverse rollback auto-generated, verify metrics per step

Reads SYSTEM.md + the discovered package graph + the plan. Applies
decomposition heuristics (component boundary, interface-first, migration-first,
reviewer-budget cap, etc.). Ends with a confirmed decomposition written to
`~/.gstack/projects/$SLUG/`.

Draft: see [`plan-rollout/plan-rollout.skill-draft.md`](./plan-rollout/plan-rollout.skill-draft.md).

### `/spill-check` — mid-implementation scope enforcement

Compares the current diff against the declared PR unit in decomposition.md.
Flags undeclared files as spills. Adaptive: strict for code, soft for
infra/meta files (CLAUDE.md, package.json, bun.lock, CI config). Can carve
spills into a separate branch on demand.

Draft: see [`plan-rollout/spill-check.skill-draft.md`](./plan-rollout/spill-check.skill-draft.md).

## Integration with existing gstack skills

Zero regression gated on `decomposition.md` existence — every modification
below is a no-op when no decomposition artifact is present:

- `/ship` gains **stack mode**: reads decomposition.md, runs /spill-check as
  pre-gate, auto-titles the PR, auto-generates the PR body with reader-guide
  block + reviewer time budget + dependency narration
- `/review` gains **scope verification**: flags diff files that aren't in the
  declared PR unit
- `/plan-ceo-review` and `/plan-eng-review` gain `/plan-rollout` in their
  Next Steps review chain

Details: see [`plan-rollout/integration-notes.md`](./plan-rollout/integration-notes.md).

## Dogfood evidence

The design was stress-tested end-to-end by simulating the workflow against
[honojs/hono issue #4633](https://github.com/honojs/hono/issues/4633) (405
Method Not Allowed). Results:

- SYSTEM.md authored for Hono's 8 real components + 12 role-level contracts
- `/plan-rollout` decomposed the issue into a 3-PR stack with graceful
  dependency relaxation (PR-3 can merge without PR-2 via feature detection)
- PR-1 implemented: 171 LOC, 3 files, 86/86 tests passing, zero regressions
  across the 4 router implementations not modified by PR-1

The dogfood surfaced 8 concrete design gaps, all folded into the v1 scope.
Highlights:

- **`kind: component | leaf-util | types-only`** field needed — shared utility
  dirs don't fit the schema cleanly
- **`package-type: library | service | cli`** field needed — rollout.md
  template is service-shaped and doesn't fit library changes
- **Reviewer-time formula** needs recalibration; ship v1 with conservative
  defaults and log predicted-vs-actual from day one
- **Shared-test-fixture heuristic** missing from the decomposition step — PR
  units extending shared interfaces need explicit fixture ownership

Full findings in the [CEO plan](./plan-rollout/ceo-plan.md) under "Dogfood
findings".

## Proposed contribution path

The contribution is a **4-PR stack** — deliberately chosen so the skill
decomposes its own shipping:

| # | Title | Reviewer est. | Scope |
|---|-------|---------------|-------|
| 1 | Foundation: SYSTEM.md parser + schema docs | ~15 min | `lib/plan-rollout/system-map-*.ts`, `test/plan-rollout/`, `docs/SYSTEM-MD.md` — standalone, no skills modified |
| 2 | `/plan-rollout` skill | ~25 min | `plan-rollout/SKILL.md` + remaining lib helpers (decomposition writer, rollout writer, reviewer-time estimator, inverse-rollback generator) |
| 3 | `/spill-check` skill | ~15 min | `spill-check/SKILL.md` + spill classifier. Independent of PR #2 |
| 4 | Integration | ~20 min | Modify `ship/SKILL.md`, `review/SKILL.md`, `plan-ceo-review/SKILL.md`, `plan-eng-review/SKILL.md`. Hot-path risk; covered by existing golden-fixture tests |

Total: ~75 min of cumulative review time. PR #1 is low-risk standalone and
should be landed first to establish the schema before the rest.

## What I'd like from you

1. **Directional signal.** Is this the right shape of skill for gstack? Should
   it land in-tree, or is this better as a separate plugin?
2. **Scope pushback.** Which of the 7 accepted expansions (see ceo-plan.md)
   should move to v2? Which v2 candidates should be v1?
3. **Naming.** `/plan-rollout` pairs nicely with `/plan-*` series. `/spill-check`
   is more utilitarian. Open to alternatives.
4. **Convention checks.** Especially the location of artifacts
   (`~/.gstack/projects/$SLUG/` vs `.gstack/` in repo) and the SYSTEM.md
   schema format.

If directionally approved, I'll open the 4 PRs in the order above. If
rejected or redirected, that saves us both implementation time.

## Why file an issue instead of opening the full PR stack?

Two reasons: (1) 278 open PRs upstream suggests the review queue is deep; a
design-first check prevents sinking 4 PRs into that queue that might not fit;
(2) the gstack CONTRIBUTING guide's contributor workflow explicitly
recommends "fix gstack while doing your real work" — this is a larger
in-flight design that benefits from maintainer signal before the code lands.

## References

- [CEO plan (full spec)](./plan-rollout/ceo-plan.md)
- [SYSTEM.md schema](./plan-rollout/system-md.schema.md)
- [Usage documentation](./plan-rollout/usage.md)
- [/plan-rollout SKILL.md draft](./plan-rollout/plan-rollout.skill-draft.md)
- [/spill-check SKILL.md draft](./plan-rollout/spill-check.skill-draft.md)
- [Integration notes](./plan-rollout/integration-notes.md)
- [system-map-parser.ts (foundation code)](./plan-rollout/system-map-parser.ts)
- [Dogfood run: honojs/hono #4633](https://github.com/honojs/hono/issues/4633)
