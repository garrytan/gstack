# PLAN_ROLLOUT_V0 — decomposition-as-artifact

**Status:** SHIPPED (v0.1.0)
**Skill:** `/plan-rollout` (`plan-rollout/SKILL.md.tmpl`)
**Schema:** `docs/SYSTEM_MD.md`

## The problem

LLM-assisted coding compresses implementation by 10-100x. It does not
compress *review*. A reviewer still reads code at human speed. A
2,000-line diff across 15 files becomes unreviewable — scope creep
hides, reviewers skim, bugs ship.

gstack's other planning skills scope or review the *plan*. None ask of
the actual diff: "is this one PR, or several?"

## The design

`/plan-rollout` reads the working diff (committed + staged + unstaged +
untracked) plus `SYSTEM.md` if present, then writes one artifact:
`decomposition.md`. The artifact contains per-slice file lists,
reader-time estimates, dependency edges, and (when `SYSTEM.md` is
present) contract-graph reconciliation flags. It does not split
branches, does not implement, does not push.

The skill is verdict-first. If the diff is one PR's worth, the artifact
says so in one line and stops. False slicing is worse than no slicing.

`SYSTEM.md` is optional. It declares the semantic contract graph —
role-level relationships between components, including `breaks-if` and
`rollout-edge` annotations. Distinct from the package/import graph,
which is discovered at runtime. When present, it sharpens slice
ordering and surfaces coordinated-deploy edges. When absent, the skill
falls back to path heuristics plus light-touch import discovery.

## What v0 ships

| File | Purpose |
|------|---------|
| `plan-rollout/SKILL.md.tmpl` | The skill template (290 lines). |
| `plan-rollout/SKILL.md` | Generated from the template. |
| `docs/SYSTEM_MD.md` | The optional schema spec (215 lines). |
| `docs/designs/PLAN_ROLLOUT_V0.md` | This doc — design + dogfood. |
| `AGENTS.md`, `docs/skills.md` | One-line registry entries. |

Out of v0 scope (deferred):

- `rollout.md` (rollout/rollback strategy + inverse-rollback auto-gen)
- A spill-check skill for in-progress diffs against the declared slice
- Integrations into `/ship` and `/review`
- A `SYSTEM.md` scaffolder

The boundary is intentional. If the primitive doesn't fit gstack,
`git rm -r plan-rollout/ docs/SYSTEM_MD.md docs/designs/PLAN_ROLLOUT_V0.md`
is the entire revert.

## Dogfood: PR #1241

**Target:** [garrytan/gstack#1241](https://github.com/garrytan/gstack/pull/1241)
— `fix(ask-user): keep question payloads compact`. 41 files, +661 / -282.
**Operator:** manual walkthrough against the documented Step-by-Step flow.

41 files in one PR is the canonical "one PR or three?" surface — the
most informative test of the verdict logic, even though (spoiler) the
right answer turns out to be one PR.

### File breakdown (skill Step 2)

Bucketed by top-level dir (path-heuristic fallback, no `SYSTEM.md`):

| Bucket | Files | Lines |
|--------|------:|------:|
| `*/SKILL.md` (36 skill regenerations) | 36 | +576 / -252 |
| `scripts/resolvers/preamble/` (the actual fix) | 1 | +16 / -7 |
| `test/fixtures/golden/` (3 golden regenerations) | 3 | +54 / -27 |
| `test/` (2 test files) | 2 | +31 / -3 |

### Reader-time estimate (skill Step 4)

`ceil(943 / 80) + ceil(41 / 5) = 12 + 9 = 21 min`. Under the 30-min cap.

Honest only if you treat the 36 SKILL.md regenerations as skim-time, not
read-time. A reviewer who actually reads each one would burn far longer.
The skill's heuristic does not currently model "mechanical regeneration"
— see Finding 1.

### Verdict the skill should emit

> **This is one PR. No decomposition needed.**
>
> 39 of 41 files are deterministic regenerations of one source change
> (`scripts/resolvers/preamble/generate-ask-user-format.ts`). They are
> not independently shippable — splitting them off would leave Slice 2
> with no standalone value and Slice 1 with broken downstream goldens
> until Slice 2 lands. Boil it.
>
> **Reader guide for the single PR:**
> 1. Read `scripts/resolvers/preamble/generate-ask-user-format.ts`
>    (+16 / -7). This is the entire substantive change.
> 2. Spot-check 2-3 of the regenerated `*/SKILL.md` files to verify
>    the new format is applied as intended.
> 3. Read `test/resolver-ask-user-format.test.ts` (+22 / -3) and
>    `test/gen-skill-docs.test.ts` (+9 / -0). These pin the new
>    behavior.
> 4. Goldens (`test/fixtures/golden/*-ship-SKILL.md`) are diff-only;
>    skim if curious.

### Findings (v1.1 todos)

**Finding 1 — Path heuristics can't detect "regenerated output."**

Without `SYSTEM.md`, the skill buckets by top-level directory. With this
PR it would produce roughly:

- Slice 0: `scripts/resolvers/preamble/...` (the fix)
- Slice 1: `*/SKILL.md` (the regenerations)
- Slice 2: `test/fixtures/golden/*` (also regenerations)
- Slice 3: `test/*.test.ts` (the tests)

The verdict logic *should* catch this because Slice 1 and Slice 2 have
no import edges back to anything except the build script — they can't
ship before Slice 0. The topological-order check would collapse them.
But the file count is high enough that a naive operator might still
ship "Source fix" + "Regenerated outputs" as two PRs. The skill needs
a deterministic-regeneration detector: if a slice's only diff is
mechanical output of another slice's source change, merge them. v1
doesn't have this.

**Finding 2 — Reader-time is wrong for regeneration-heavy diffs.**

21 minutes is the right number for "skim 36 generated files + read the
source." It would be the wrong number if a reviewer read each
`SKILL.md`. The heuristic treats lines uniformly. A `regen-multiplier`
flag on slices that match build-output patterns
(`*/SKILL.md` adjacent to a build script, `test/fixtures/golden/*`)
would adjust this — v1.1.

**Finding 3 — `SYSTEM.md` wouldn't have helped here.**

A gstack-shaped `SYSTEM.md` with `scripts/resolvers/` marked as a
component and `*/SKILL.md` files marked as `leaf-util` wouldn't have
changed the verdict. The actual signal needed is "this file is a build
output of that file," closer to a Makefile-style dependency than a
contract graph. `SYSTEM.md` is not the right primitive for catching
this. Don't promise it is.

**Finding 4 — The skill needs an `--explain` mode.**

A reviewer looking at the verdict "this is one PR" deserves to see why:
how many files were classified as regeneration, which source change
they depend on, what would happen if you tried to slice anyway. v1's
verdict is a one-liner. v1.1 should print the rejected slicing
alternatives and why they were rejected.

### What v0 got right

- **Verdict-first design.** The skill is structured to ALWAYS output a
  verdict line. Even when the right answer is "one PR," the artifact
  produces value: a written record of "we looked, and slicing was
  considered and rejected because of these signals."
- **Honest about reader-time.** 21 min is the right number under
  reasonable skim assumptions. Calibrated for typical PR reading, not
  pathological "read every regenerated file."
- **No silent slicing.** The Step 7 self-check ("If the entire diff
  fits comfortably in one slice ... say so plainly") catches the case
  where naive bucket-counting would propose 3 slices but the verdict
  logic should collapse them.

## v1.1 roadmap

1. **Deterministic-regeneration detector.** Heuristic match on filename
   patterns (`SKILL.md` adjacent to `SKILL.md.tmpl`,
   `test/fixtures/golden/*`) plus an optional `regeneration-of:` field
   in `SYSTEM.md`.
2. **Regen-multiplier on reader-time.** Scale regenerated-output line
   counts by ~0.1 (skim-reading speed).
3. **`--explain` mode.** When the verdict is "one PR," print the
   rejected slicing alternatives and the signals that rejected them.
4. **Calibration loop.** Log predicted vs actual reader-time on the
   first ~10 real invocations to ground v2 heuristics in data.

## What v0 proves

The skill is honest about the cases where it can produce useful output
(real multi-component diffs with clear seams) and the cases where it
can't (regeneration-heavy diffs, single-source-fan-out patterns). One
PR's worth of analysis on a real diff caught four real limits worth
fixing in v1.1. That's the bar a skill should clear before shipping.
