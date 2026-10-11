# Multi-agent wave: incident-to-test map

Each incident from the gbrain feedback (docs/designs/MULTI_AGENT_WAVE_2026_10_10.md,
Validation 1) becomes a fixture or scripted scenario here, named by plan section
and incident, and a test shows the tool catching it or producing the artifact.
Later PRs of the wave append their rows; a row is never removed.

| Incident | Plan item | Fixture / scenario | Test |
|---|---|---|---|
| p0-2-hand-written-artifacts: the plan's own run wrote its artifacts by hand because no validator existed | B0 | `reference-run/` (the plan branch's artifacts, run-dir-relative paths, `status: complete`) | `test/headless-artifacts.test.ts` "reference run validates" |
| p0-2-interrupted-run: a parent consumed a run whose reviewer never returned | B0 | `reference-run/` with `status: running` / a voice `pending` | `test/headless-artifacts.test.ts` "interrupted run" |
| p0-2-omitted-finding: a count that matched hid an omitted finding | B0 | `reference-run/` with a dropped row and an unchanged count, then a changed hash | `test/headless-artifacts.test.ts` "count mismatch", "stale artifact" |
| p0-2-missing-reviewer: a phase reported CONFIRMED with one voice absent | B0 | `reference-run/` with `phases.eng.outside` removed | `test/headless-artifacts.test.ts` "missing reviewer" |
| p0-2-path-escape: an artifact list naming a file outside the run directory | B0 | symlink out of a temp run dir | `test/headless-artifacts.test.ts` "path escape" |
| p0-2-claimed-clean: `status: clean` hand-written beside 176 open findings | B7 | findings.jsonl with open rows and a claimed-clean row | `test/review-log-findings.test.ts` |
| p0-2-headless-collision: `headless` redefinition would change eval semantics | B1 | `GSTACK_HEADLESS=1` beside `GSTACK_SESSION_KIND=unattended` | `test/gstack-session-kind.test.ts` "unattended" |
| p0-2-unattended-egress: an unattended run synced data nobody approved | B1 | stubbed egress bins on PATH | `test/gstack-skill-start.test.ts` "unattended … egress" |
| p0-2-gate-grammar: `d10 yes`, `1a 2a`, a 33-decision approve-all | B9 | reply strings | `test/gate-list.test.ts` |
| p0-2-timing: no wall-time record per phase, no pre-run estimate | B10 | analytics history | `test/autoplan-timing.test.ts` |
| p0-2-urgent-block: a security finding buried in a 400-line record | B12 | findings with `urgent: true` | `test/headless-artifacts.test.ts` "URGENT block" |
| p1-5-unverified-premise: the wave's load-bearing premise ("13 of 28 threads ran nothing") had no receipt | D1 | `reality-rows.json` `premise-table` (positive from `ceo-native.md:11-37`, receipt-less decoy) | `test/plan-reality.test.ts` "positive fixture", "decoy" |
| p1-5-already-done-rebuilt: a fix re-planned after main had merged it | D1 | `reality-rows.json` `already-done` (positive from `eng-native.md:9`, tier 1 `n/a` decoy) | `test/plan-reality.test.ts` "decoy", "tier 1 n/a is missing" |
| p1-5-surface-miss: `bun upgrade --version` assumed; `--help` lists only `--canary` | D1 | `reality-rows.json` `surface-check` (positive from `eng-native.md:191`, prose-only decoy) | `test/plan-reality.test.ts` "prose has every row missing" |
| p1-5-overruled-binding-decision: an owner decision undone by a project default two phases later | D1 | `reality-rows.json` `binding-decisions` (lookalike row id decoy) | `test/plan-reality.test.ts` "unknown row ids are reported, not counted" |
| p1-5-uncredible-numbers: an effort table with no basis credited until re-counted | D1 | `reality-rows.json` `numbers` (positive from the plan's Effort table, receipt-less decoy) | `test/plan-reality.test.ts` "decoy" |
| p1-5-deferred-asks-unlisted: two of six issue asks found only after merge | D1 | `reality-rows.json` `deferred-asks` (positive from "Not in this wave") | `test/plan-reality.test.ts` "positive fixture" |
| p1-5-pr-count-unstated: five PRs became seven with no queue cost stated | D1 | `reality-rows.json` `pr-count` (positive from `eng-native.md:23`) | `test/plan-reality.test.ts` "positive fixture" |
| p1-5-row-missing-is-a-warning: an unattended phase closed with a required row missing | D1 | six of seven rows under `GSTACK_SESSION_KIND=unattended` | `test/plan-reality.test.ts` "verdict=incomplete", bin "check" |
| p1-6-cache-skips-guard: a new cache in front of a guarded call skipped the policy check on a hit | D2 | `review/checklist.md` Sideways sweep (cache bullet) | `test/sideways-review.test.ts` "every shape the plan names" |
| p1-6-sibling-ingress-downgraded: a defect fixed at one ingress and rated low while its sibling stayed | D2 | review Step 4 sideways sweep, forced-CRITICAL list; cso Phase 12 sibling sweep | `test/sideways-review.test.ts` "Step 4", "cso" |
| p1-6-undeclared-behavior-change: a diff changed a default the PR body never mentioned and the audit said CLEAN | D2 | review-mode Scope Check `Diff read` / `Undeclared behavior changes` lines | `test/sideways-review.test.ts` "Scope Check" |
| p1-7-flake-loosened: a flaky test was "fixed" with a wider timeout and no probe | D3 | `investigate/sections/flake.md` (never loosen, `P(fail \| regression)`, `## Flake evidence`) | `test/investigate-recipes.test.ts` "flake" |
| p1-7-polluter: a test green alone, red in its shard, rerun until green | D3 | `investigate/sections/polluter.md` (`ship-measure free --files` bisect) | `test/investigate-recipes.test.ts` "polluter" |
| p1-7-backlog-closed-unreproduced: an issue closed from a triage that never ran the repro | D3 | `investigate/sections/backlog.md` (repro required for `still_open`, read-only, no closing) | `test/investigate-recipes.test.ts` "backlog" |
| p1-7-stale-index-timing: a benchmark in a fresh worktree charged git's index refresh to the first measurement | D3 | `benchmark/SKILL.md.tmpl` and investigate Phase 1 `git update-index --refresh` | `test/investigate-recipes.test.ts` "Phase 1 additions" |
| p0-4-stale-goldens: a generated file (ship goldens, agents digest) hand-merged or left stale, caught only by CI | C4, C8 `regen` | `test/helpers/pregate-fixture.ts` repo: `src/version.js` bumped, `generated/digest.md` unchanged; registry on `origin/main` | `test/gstack-regen.test.ts` "stale"; `test/pregate-selection.test.ts` "p0-4-stale-goldens" |
| p0-4-scratch-script: `zz-probe.sh` committed at the repository root | C8 `strays` | fixture repo with `zz-probe.sh`, `notes.txt`, a new top-level directory and a conventional `CONTRIBUTING.md` | `test/pregate-selection.test.ts` "p0-4-scratch-script" |
| p0-4-heavy-old-constant: a nightly-only test kept asserting the old timeout literal | C8 `literals` | `test/nightly/retry-heavy.test.js` asserting `TIMEOUT_MS` 5000 after `lib/retry.js` moves to 9000 | `test/pregate-selection.test.ts` "p0-4-heavy-old-constant" |
| p0-4-windows-lane-unrun: a Windows-only test changed on a Linux box merged with that lane unrun | C8 `lanes` | `test/windows-paths.test.js` touched; `windows.yml/windows-shard` is a planner-computed matrix with a selection manifest | `test/pregate-selection.test.ts` "p0-4-windows-lane-unrun"; `test/pregate-invalidation.test.ts` "uncleared requires-remote" |
| p0-4-pipe-hidden-failure: a failing runner behind `\| tail` reported green; a zero-run lane reported green | C8 `lanes` (pipefail) | runner `node --test {files} 2>&1 \| tail -n 1` with a broken `lib/util.js`; runner that prints `# tests 0` | `test/pregate-selection.test.ts` "p0-4-pipe-hidden-failure" |
| p0-4-stale-pregate: a pre-gate record reused after the final stamp moved the tree | C8 publication | pregate.json recorded, then `README.md` edited | `test/pregate-invalidation.test.ts` "PREGATE_STALE for both" |
| p0-4-dropped-vendored-hunk: a `patchedDependencies` hunk silently dropped on regeneration | C8 `patches` (tier 2, deferred) | — | — (follow-up pre-gate PR) |
