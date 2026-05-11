# /plan-rollout dogfood: PR #1241

**Date:** 2026-05-11
**Skill version:** 0.1.0
**Target:** [garrytan/gstack#1241](https://github.com/garrytan/gstack/pull/1241) —
`fix(ask-user): keep question payloads compact`
**Operator:** manual walkthrough (no live skill invocation; the MVP doesn't
auto-run yet).

## Why this PR

41 files in one PR is the canonical "is this one PR or three?" surface.
That makes it the most informative test of the skill's verdict logic, even
though — spoiler — the right answer turns out to be "one PR." A skill
that proposes slicing here would be wrong.

## Input

- **Base:** `main`
- **Head:** `oss/fix-1208-ask-user-layout`
- **Diff:** 41 files, +661 / -282 lines
- **SYSTEM.md present:** no (gstack does not have one)
- **Plan source:** PR body only (no `~/.gstack/projects/` artifact for this branch)

## File breakdown (skill Step 2)

Bucketed by top-level dir (path-heuristic fallback, no SYSTEM.md):

| Bucket | Files | Lines |
|--------|------:|------:|
| `*/SKILL.md` (36 skill regenerations) | 36 | +576 / -252 |
| `scripts/resolvers/preamble/` (the actual fix) | 1 | +16 / -7 |
| `test/fixtures/golden/` (3 golden regenerations) | 3 | +54 / -27 |
| `test/` (2 test files) | 2 | +31 / -3 |

## Reader-time estimate (skill Step 4)

`ceil(943 / 80) + ceil(41 / 5) = 12 + 9 = 21 min`. Under the 30-min cap.

The estimate is honest only if you treat the 36 SKILL.md regenerations
as skim-time, not read-time. A reviewer who actually reads each one
would burn far longer. The skill's heuristic does not currently model
"mechanical regeneration" — see Finding 1 below.

## Verdict the skill should emit

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

## What the skill would have gotten wrong (Findings)

### Finding 1 — Path heuristics can't detect "regenerated output"

Without SYSTEM.md, the skill buckets by top-level directory. With this
PR it would produce roughly:

- Slice 0: `scripts/resolvers/preamble/...` (the fix)
- Slice 1: `*/SKILL.md` (the regenerations)
- Slice 2: `test/fixtures/golden/*` (also regenerations)
- Slice 3: `test/*.test.ts` (the tests)

The verdict logic *should* catch this because Slice 1 and Slice 2 have
no import edges back to anything except the build script — they
can't ship before Slice 0. The skill's topological-order check would
collapse them into one slice. But the file-count is high enough that a
naive operator might still ship "Source fix" + "Regenerated outputs"
as two PRs. **The skill needs a "deterministic regeneration" detector:**
if a slice's only diff is mechanical output of another slice's source
change, merge them. v1 doesn't have this — track as a v1.1 todo.

### Finding 2 — Reader-time is wrong for regeneration-heavy diffs

21 minutes is the right number for "skim 36 generated files + read the
source." It would be the wrong number if a reviewer read each SKILL.md.
The skill's heuristic treats lines uniformly. A `regen-multiplier` flag
on slices that match build-output patterns (`*/SKILL.md` adjacent to a
build script, `test/fixtures/golden/*`, etc.) would adjust this — v1.1.

### Finding 3 — SYSTEM.md wouldn't have helped here

A gstack-shaped SYSTEM.md with `scripts/resolvers/` marked as a
component and `*/SKILL.md` files marked as `leaf-util` wouldn't have
changed the verdict. The actual signal needed is "this file is a
build output of that file," which is closer to a `Makefile`-style
dependency than a contract graph. SYSTEM.md is not the right primitive
for catching this. Don't promise it is.

### Finding 4 — The skill needs an `--explain` mode

A reviewer looking at the verdict "this is one PR" deserves to see WHY:
how many files were classified as regeneration, which source change
they depend on, what would happen if you tried to slice anyway.
v1's verdict is a one-liner. v1.1 should print the rejected slicing
alternatives and why they were rejected.

## What the skill got right

- **Verdict-first design.** The skill is structured to ALWAYS output a
  verdict line. Even when the right answer is "one PR," the artifact
  produces value — a written record of "we looked, and slicing was
  considered and rejected because of these signals."
- **Honest about reader-time.** 21 min is the right number under
  reasonable skim assumptions. The skill's estimate is calibrated for
  typical PR reading, not pathological "read every regenerated file."
- **No silent slicing.** The Step 7 self-check ("If the entire diff
  fits comfortably in one slice ... say so plainly") catches the case
  where naive bucket-counting would propose 3 slices but the verdict
  logic should collapse them.

## What this dogfood proves

The skill is honest about the cases where it can produce useful output
(real multi-component diffs with clear seams) and the cases where it
can't (regeneration-heavy diffs, single-source-fan-out patterns). One
PR's worth of analysis on a real diff caught three real limits worth
fixing in v1.1. That's the bar a skill should clear before shipping.

## v1.1 todos surfaced by this dogfood

1. **Deterministic-regeneration detector.** If a file's content is
   reproducible from another file in the diff (build-script output,
   generated SKILL.md, golden fixtures), mark it and merge it into the
   source slice. Implementation: heuristic match on filename patterns
   (`SKILL.md` adjacent to `SKILL.md.tmpl`, `test/fixtures/golden/*`)
   plus an optional `regeneration-of:` field in SYSTEM.md.
2. **Regen-multiplier on reader-time.** When a slice contains regenerated
   outputs, scale their line count by ~0.1 (skim-reading speed).
3. **`--explain` mode.** When the verdict is "one PR," print the
   rejected slicing alternatives and the signals that rejected them.
4. **Calibration loop.** Predicted vs actual reader-time on the first
   ~10 real invocations to ground v2's heuristic in data instead of
   guesses.
