# R51 final full review after a granted fix-check: no-loss replay (preregistration)

Frozen 2026-11-22 (GST-3260 PR 3), before the planner change and before the
replay test existed. Deterministic and free: no model calls, no paid runs.
CREW rule 15 requires this replay for any change to review depth, reviewer
packets or reviewer prompts in `/ship`.

## Question

Does the PR 3 change lose any review step the planner ran before? It changes
two things:

1. **Review depth (Part C).** After a clean granted fix-check whose fix range
   changed runtime lines, `lib/review-depth.ts` `nextStep` plans one read-only
   full review of the final head (R51: a re-check that reads only what changed
   never stands in for the final full review). After that review, no blocker is
   `done` with notes and a blocker is `stop` with `PR_ROUND_CAP`. A fix range
   with 0 runtime lines stays `done` after the fix-check.
2. **Review packet (Part B).** Decision 3.5's touched hunks run `git add -N` on
   each file the fix created before `git diff $PASS_HEAD`, so a new, uncommitted
   file reaches the fix-check reader.

## Corpus

- **Old planner:** main's `lib/review-depth.ts` at git blob
  `47ac26b58e397466121a70cefd28dda4251615ce` (main `0b4f0ce`; byte-identical on
  the PR 2 base `ac9163d`), stored as a fixture copy whose blob hash the test
  checks.
- **Recorded histories:** every `History` (with its depth) that the existing
  planner tests pass to `nextStep` or `planReview`: `test/review-depth.test.ts`,
  `test/review-depth-lean.test.ts`, `test/review-plan-pr-rounds.test.ts`,
  `test/review-risk-routing.test.ts`, `test/review-round2-plan.test.ts` and
  `test/round-cap-granted-stop.test.ts`, captured once into a fixture.
- **Grid:** every combination of a fixed value set for each History field the planner reads
  (last, passes, fix-checks, each fix flag, range runtime lines, both grant
  kinds, lean, gate and voices, post-review, chained, prior rounds, round grant,
  pass-1 depth) and every depth, so the replay does not depend on which cases
  the tests happened to write.
- **Real shapes** (step sequences, from the test fixtures and the PR records):
  gstack #4537 (a new run spends the grant on a read-only run's stop),
  harness-evals#508 (the stopped run spends the grant on its own stop), #4612
  (same route, counted by finish), #4597 (trailer plus a later clean full
  round, no grant), harness-evals#504 (a fix-check grant answering a stop after
  a gate-class fix-check edit), #4664 (granted fix-check at b2d3ab4 after a
  round-2 stop), #4663 (a Captain-ruled read-only final review after a grant),
  gbrain#10036 (an in-run grant whose fix-check read the fixed blockers clean),
  and a negative control: a granted fix-check whose range is docs and tests
  only (0 runtime lines).
- **Packets:** git fixtures for Part B: a fix that edits tracked files only, a
  fix that deletes a file, a fix with ignored files present, and a fix that
  creates a new file.

## Metric and pass rule

1. **Plan replay.** For every recorded and grid history without the new History
   field, the new planner's step equals the old planner's step. For every real
   shape, the sequence of review steps the new planner runs contains every step
   the old planner ran, in order; the only added step is at most one read-only
   `full` after a granted fix-check that changed runtime lines, and it is
   followed only by `done` or `stop`. No `fix-check` and no `scoped` or
   repeated fix round is ever added. With the new field set, the planner never
   plans a `fix-check` or `scoped` step. The 0-runtime-line control adds nothing.
2. **Packet replay.** On every packet fixture with no untracked file, the
   documented hunks command's output is byte-identical to plain
   `git diff $PASS_HEAD`. On the fixture whose fix created a file, the output
   contains that file's diff.

Pass means both hold on every case. There is no threshold and no sampling: a
single counterexample fails it.

## Decision each outcome changes

- **Pass:** repin `lib/review-depth.ts` and `ship/sections/review-army.md` in
  `test/fixtures/review-pins/` naming this replay, and the PR merges on green.
- **Plan replay fails:** the planner change does not merge. Narrow it until the
  only added step is the one read-only final review, or report the case to the
  Captain if R51 itself needs the extra step.
- **Packet replay fails:** drop or reword the Part B hunks command until it is
  byte-identical without untracked files; Part C can still merge alone.

## Results

Filled in after the run, below this line.
