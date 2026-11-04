**Five routine /ship and /autoplan stops no longer wait for a Captain: each is checked, recorded in the receipt's `no_stop` field, and the run keeps going (GSTA-258 L5, plan K1).** GBrain-Evals pre-granted these after GBEV-30 stopped about seven times in one day on them. A case that doesn't qualify, and every other stop, still goes to the owner.

### Added
- **`gstack-no-stop record --class <class> --reason <text> --evidence <ref>`** (`lib/no-stop.ts`) checks a stop and appends `{class, reason, evidence}` to the branch's ledger, or prints `NO_STOP: refused` and exits 3. The five classes:
  - `scoped-fix-check`: one scoped fix-check past R51's two-round cap, when the round-2 fix is docs class only or only raises timeouts. The range must start at the commit the last review pass read. It records the standing grant in the approval record and prints `GRANT:` for `gstack-review-plan --grant`. One per branch.
  - `test-timeout-fix`: a fix whose every changed line is in a test file and only raises a timeout value. A line with an assertion or a comparison never qualifies. Its gate finding takes a printed `kept` reason instead of `open`.
  - `pregate-flake-rerun`: one rerun of a failed pregate case at the same tree (rule 16). One per branch.
  - `stamp-only-carry`: a refused carry where HEAD differs from the receipt head merged into the base only in a version stamp. /ship then takes the carry's `RECHECK:` route instead of running Steps 2–16 again.
  - `autoplan-regate`: see below.
- **`gstack-no-stop import` and `list`** add an autoplan run's records to the branch and print the ledger. /ship's receipt write passes it as `--no-stop @<file>`.

### Changed
- **An autoplan plan edit made after the owner's answer carries their words when it only adds ELI5 lines.** Every added line must sit in the plan's `## ELI5` section and name no number, spend, budget, cap, limit, arm, model, judge or verdict. Such an edit carries as `reason=no-stop autoplan-regate: …` and is written to `<run>/no-stop.json`, and the run still exports the reviewed plan. A removed or reworded line, a line added anywhere else, or an edit to the reviewed plan itself still goes to the owner. The run keeps a copy of each plan file it hashes, so the edit is diffed against what the owner answered.
- docs/review-policy.md#no-stop has the table. docs/ship-policy.md lists the receipt's `no_stop` field, and docs/unattended.md describes the carry-forward change.

### Tests
- `test/no-stop.test.ts`: each class's qualifying and refused cases, the ledger, the grant row, the receipt's `no_stop` validation, stamp-only after a base merge, import, and the template wording.
- `test/autoplan-carry.test.ts`: an ELI5-only addition after the revise now carries and is recorded. A cap move still refuses.
