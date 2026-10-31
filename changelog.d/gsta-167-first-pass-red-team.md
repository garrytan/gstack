**`/ship` no longer runs the standalone Red Team on a change's first full review pass at gate class or past 200 runtime lines.** The preregistered no-loss replay (GSTA-167 Round 7, handoffs/GSTA-167/noloss7-results.md) removed those Red Team lines from the recorded reviewer outputs. The rest of the stack still found 32 of the 41 panel blockers against 33 with them, a one-sided non-inferiority p of 0.00074 at a margin of 4. The Red Team still runs on a first pass with a CRITICAL, on a small diff raised to standard, on every post-fix full pass and on the scoped pass.

### Changed
- **`lib/review-depth.ts`**: on a first full pass (`fullPasses` 0), the gate-class term (a depth error included, since it runs as gate class) and the more-than-`RED_TEAM_LINES` term no longer add the Red Team. The plan prints `SKIP: red-team (first full pass; Round 7 no-loss)`. The CRITICAL and raised small-diff terms are unchanged, and post-fix full passes keep every term. The scoped pass, the fix-check and light depth's batched red-team checklist are unchanged.
- **`RED_TEAM_FIRST_PASS`** (false) joins the `DEPTH_RULES` hash, so the hash moves.

### Docs
- `docs/review-policy.md`: the first-pass rule and its evidence, the depth table, the light-versus-standard inversion this leaves (light keeps the red-team checklist in its batched reader; a first standard or gate pass has no Red Team) and the follow-up arm light needs.

### Tests
- `test/review-depth.test.ts`: separate histories for a first gate pass, a first pass reached through a depth error and a first pass past 200 lines (no Red Team), a first pass with a CRITICAL and a raised small diff (Red Team), post-fix full passes, the scoped pass and the fix-check, light's checklist, and the `DEPTH_RULES` move.
- `test/review-pass.test.ts`: the pass program creates no Red Team on a first full pass, and a failed Red Team on a post-fix pass stops it. `test/review-dispatch.test.ts`: a trimmed Red Team brief is `BRIEF_MISMATCH` and the exact re-send voids it.

### Gate integrity
- Behavior change: the `DEPTH_RULES` hash moves. `test/review-packets-removed.test.ts` repins `lib/review-depth.ts` under the new `V7` replay.
- Changed assertions that expected a first-pass Red Team now assert none there and assert it after a fix: `test/review-depth.test.ts` (gate class and hit-rate gating, efforts, `--all-specialists`, GSTA-131 coverage, the six fail-closed matrix cases, the captured gate fixture, the standard plan); `test/review-pass.test.ts` (four pass-program tests move to a post-fix pass); `test/review-targeted.test.ts` (the dispatch-superset check allows exactly the first-pass Red Team to drop on its four first-pass full-depth fixtures).
