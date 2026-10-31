**A subagent's /ship cost now says it is an upper bound.** A Capy subagent cannot read its own jam counter, so its /ship read `"this"`, the root thread, whose counter also holds every sibling lane. BUDGET_FINAL and the notes printed that total as if it were the run's own cost.

### Added
- **`gstack-ship-budget start --meter-scope self|tree`.** A run started with `tree`, or with `--subagent` (or `GSTACK_SHIP_SUBAGENT=1`) and `--reading-from this`, is tree-scoped: every BUDGET, NOTE, BUDGET_FINAL and BUDGET_TIMELINE line it prints is followed by `METER: tree (root counter, upper bound)`.
- **`METER_SCOPE_PARENT`.** A subagent reading `"this"` that asks for `--meter-scope self` is refused with exit 2 and the fix `--meter-scope tree` (docs/troubleshooting.md#meter-scope-parent).

### Changed
- The Capy skill and docs/ship-budget.md tell a subagent to start with `--subagent --reading-from this --meter-scope tree`, and say exact per-run cost comes from a root replay thread. The driver's Step 22 carries the `METER: tree` line into the report.

### Tests
- `test/ship-budget-meter-scope.test.ts`: tree runs label every cost line, self runs print none, the refusal and its troubleshooting anchor, and the docs pointers.
