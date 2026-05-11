# PLAN_ROLLOUT_V0 — decomposition-as-artifact

**Status:** SHIPPED (v0.1.0)
**Skill:** `plan-rollout/SKILL.md.tmpl`
**Schema:** `docs/SYSTEM_MD.md`

## Problem

LLMs compress implementation 10-100x. They do not compress *review*. A
2,000-line diff is unreviewable — scope creeps, reviewers skim, bugs
ship. No existing skill asks of an actual diff: "one PR, or several?"

## Design

`/plan-rollout` reads the working diff + optional `SYSTEM.md`, writes
one artifact: `decomposition.md` (per-slice file lists, reader-time
estimates, dependency edges, reconciliation flags). Never splits
branches, never implements, never ships.

Verdict-first: if the diff is one PR, the artifact says so in one line
and stops. False slicing is worse than no slicing.

`SYSTEM.md` is optional input. Path heuristics + import discovery
when absent.

## What v0 ships

| File | Lines | Purpose |
|------|------:|---------|
| `plan-rollout/SKILL.md.tmpl` | 296 | Skill template |
| `plan-rollout/SKILL.md` | 1011 | Generated from template |
| `docs/SYSTEM_MD.md` | 129 | Schema spec (optional input) |
| `docs/designs/PLAN_ROLLOUT_V0.md` | (this file) | Design + dogfood |
| `AGENTS.md`, `docs/skills.md` | +2 | Registry |

Out of v0 (deferred): `rollout.md`, spill-check skill, `/ship` and
`/review` integrations, `SYSTEM.md` scaffolder. Reverting v0 is
`git rm -r plan-rollout/ docs/SYSTEM_MD.md docs/designs/PLAN_ROLLOUT_V0.md`.

## Dogfood: PR #1241

Target: [garrytan/gstack#1241](https://github.com/garrytan/gstack/pull/1241)
— 41 files, +661/-282. Manual walkthrough.

Bucketing (no SYSTEM.md):

| Bucket | Files | Lines |
|--------|------:|------:|
| `*/SKILL.md` regenerations | 36 | +576/-252 |
| `scripts/resolvers/preamble/` (the fix) | 1 | +16/-7 |
| `test/fixtures/golden/` regenerations | 3 | +54/-27 |
| `test/` | 2 | +31/-3 |

Reader time: `ceil(943/80) + ceil(41/5) = 21 min`. Under 30-min cap.

### Verdict

**One PR.** 39 of 41 files are deterministic regenerations of one
source change in `scripts/resolvers/preamble/generate-ask-user-format.ts`.
Not independently shippable — splitting them would leave dependent
fragments.

### Findings (v1.1 backlog)

1. **Regeneration detector.** Path heuristics don't know `*/SKILL.md`
   is mechanical output of `*/SKILL.md.tmpl`. Without it, a naive
   operator might still ship "source + regenerations" as two PRs. Fix:
   filename-pattern match + optional `regeneration-of:` in SYSTEM.md.
2. **Regen-multiplier on reader-time.** Lines in regenerated files
   should count ~0.1x (skim speed). Today they count 1x.
3. **`--explain` mode.** When the verdict is "one PR," print the
   rejected slicing alternatives and why each was rejected.
4. **Calibration loop.** Log predicted vs actual reader-time on the
   first ~10 real invocations. Ground v2 heuristics in data.

### Limit surfaced

`SYSTEM.md` is **not** the right primitive for build-output coupling.
The signal needed is "file X is generated from file Y" — closer to a
Makefile dependency than a contract graph. Don't promise SYSTEM.md
solves regeneration cases.
