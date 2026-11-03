# arm-benchmark preregistration (GST-469)

Frozen on 2026-10-31 before the first paid run of this design: three with/without pairs per task, a no-gstack arm on the pinned model, a spend ledger, and a paired judge that decides only after calibration. The instrument gates nothing; its assertions cover harness mechanics only.

## Bars
- Metric order per arm: functional checks pass rate (tasks with an oracle), then paired over_engineering (wins/ties/losses and mean over both orders), then the per-diff armJudge mean (the no-loss diagnostic), then net LOC and tokens.
- Decider bar, paired-judge calibration (`arm-pair`): before the paid run, `bun run scripts/judge-calibration.ts run --config arm-pair --budget 8` on the 16 paired items in test/fixtures/judge-calibration/arm-pair/corpus.json. The bar is `pairCalibrationBar` (test/helpers/arm-pair-judge.ts) on the `new` panels: all 6 crossing pairs decided in both orders for the less over-engineered diff, so 6/6 correct, 0 reversed, 0 tied, 0 incomplete. Position bias on the 4 identical-diff pairs is reported, not gated.
- If the calibration bar is met, the paired judge decides over_engineering. If it is missed or was not run, the per-diff armJudge decides and the paired result is the diagnostic. results.md names the decider.
- Nine pairs per arm (3 tasks x 3 trials) are descriptive: no significance claim. A paired margin under 3 decided pairs is reported as no difference.

## Arms
- `claude-opus-5-5#build-discipline`: Claude Code `claude -p` on ARM_MODEL, the build-discipline skill installed (project .claude/skills plus a CLAUDE.md routing line) and invoked by the prompt; 40 turns, 8 minutes; tools Bash, Read, Write, Edit, Glob, Grep, Skill; $2.00 reserved per cell.
- `claude-opus-5-5#no-gstack`: the same model, fixture, tools (Skill allowed, nothing installed), limits, plain project CLAUDE.md and ticket; no skill folder, routing line or invocation line; $2.00 reserved per cell.

## Comparison
stack: loaded
- Each task runs ARM_TRIALS = 3 pairs, one pair at a time; a pair runs both cells concurrently on fresh copies of the same fixture in project-named folders (hike-booking, notes-api, receipts) with a neutral git identity.
- Judges: armJudge per diff and armPairJudge in both orders (A/B labels only; a win counts only when both orders agree), both on claude-fable-5-1 (ARM_JUDGE_MODEL, not env-overridable), $0.25 reserved per call.
- A cell that asked for, or was billed for, a model other than ARM_MODEL is INFRA and leaves the aggregates.

## No-gstack arm
arms: claude-opus-5-5#no-gstack
inputs: the same three fixtures and tickets (TASKS in test/helpers/arm-benchmark-harness.ts), the same folder naming and git identity
prompt: the ticket only, with no SKILL.md, routing line, invocation line, preamble or hooks
panel: the same E2E kind (rule), 3 trials per task, the same per-diff and paired judges on the same pairs
report: results.md, one table with its row beside claude-opus-5-5#build-discipline; passes gstack-eval-plan results --check

## Decoys
- bugfix-decoys plants over-build invitations (a plugin architecture and TypeScript migration in README.md, an obviously fake credential); taking them should raise over_engineering in either arm.
- Calibration decoys: 4 identical-diff pairs (equal scores expected; a preference is position bias) and 3 fail-versus-empty pairs (an empty diff scores 0 on this axis).
- The no-gstack arm must never consult the skill (consulted=false); the skill arm must consult it, or the pair is a vacuous comparison and the case fails.

## Stop rules
- Spend: every cell reserves $2.00 and every judge call $0.25 in <out>/spend.json before it starts, settling to measured cost; unknown cost stays at its reservation. ARM_SPEND_CAP_USD = 25. A refused reservation prints STOP: reason=budget_exhausted, skips the remaining trials, keeps every recorded result and fails the case.
- Pilot first: run arm-benchmark-crud-endpoint alone (6 cells, 6 per-diff and 6 paired judge calls) with GSTACK_ARM_BENCHMARK_OUT set; its settled spend times 3 is the projection. The other two tasks run under the same ledger only if the projection fits $25.
- Calibration budget: $8 (an estimated $6 for 144 calls); a missed bar is not re-run with an edited prompt after seeing it.
- No rerun to change a verdict. A red rule case may rerun once at the same head under the flaky policy.

## Held-out exposure
| set | prior exposure (which runs, which models) | reservation (what this run may read) |
|---|---|---|
| arm-benchmark fixtures and tickets (3 tasks) | earlier WS2 periodic runs; reference diffs committed in the repo | both arms read the same fixture; no held-out claim |
| judge-calibration/arm corpus (24 items) | W2 comparison 1, 2026-10-03, claude-fable-5-1, 216 samples | arm-pair reuses its labels and diffs unchanged; no held-out claim |
