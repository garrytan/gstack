**A capped `/ship` on Capy now spends fewer agent turns and counts only its own tokens, while every reviewer still gets exactly the brief 1.91.331.0 gives it.** Two new commands do `/ship`'s fixed shell work, a short driver file replaces reading the whole skill when a parent agent runs `/ship`, and the budget measures each reviewer batch on its own instead of across the parent's work. Replays of gstack-evals #34 and #36 (GSTA-167) spent 12.19M tokens on Steps 12-17 and 0.25-0.4M on each parent turn; these changes cut turns, not reviewer context.

### Added
- **`gstack-ship-preflight`** runs Steps 1-3 (branch guard, status, fetch, diff stat, PR and receipt carry, scope, base merge, distribution, policy, runtime lines) and Step 5 (pregate, then the test lanes in parallel) in one call. **`gstack-ship-release`** runs Step 12's version, Steps 15-16's release commit and verification, and Step 17's push. Each prints at most 30 lines; `STOP:` names the decision left to the agent and `NEXT:` the step to run. Under `queue_mode stamp-at-merge` the version step prints `VERSION: skipped (policy: ...)` and writes nothing.
- **`ship/DRIVER.md`**, a compact host-neutral driver for a parent agent running `/ship` unattended: one or two calls per phase, and the section each STOP needs. Its audit, review, adversarial and documentation phases run their sections as written, so it never restates or shortens a reviewer's brief.
- **`gstack-review-dispatch`** gates every `/ship` reviewer brief and finding. `render` builds a reader's brief from its section with only declared slots filled, `sent` checks the prompt a dispatch passed against that brief by sha256 (`BRIEF_MISMATCH` voids the review), `collect` is the only way findings reach `merged.jsonl` (each with its label as written), and `judge` refuses a judged set that drops or downgrades a collected finding. `verify --ledger` replays all of it per pass from the run's ledger and prints `VERIFY: clean` only when nothing was lost; a mismatched send that was re-sent exact before anything was collected shows as `voided=N`.
- **Small runs keep their segment.** `check --runtime-lines <n>` continues at the Step 9 and Step 12 boundaries with a `SMALL_RUN:` line when the diff has at most 50 runtime lines and the segment would cost less than a child's fixed startup.

### Changed
- **The Capy meter reads the agent's own thread**, its subagents included, inside the same program as the budget command, never in a call of its own. A handoff child counts from its own `verify-handoff` reading, and `reconcile` charges the `used=` its return prints.
- **Steps are priced at the run's own per-call charge** once three calls are measured; a prior reading older than the run's last reading is ignored (`CALL_UNKNOWN:`).
- **A reviewer batch is measured only by its own program's reading pair** (`settle --dispatched-at <before> --reading <after> --readers <n>`); anything else prints `UNMEASURED:` and leaves the factor alone. `check` prints the reservation id alone on a `RESERVATION_ID:` line, a multi-role reservation admits one review start per role, and `--finish` settles a later Red Team batch of the same pass.
- **A handoff brief lists the child's `READ:` line ranges**: its own steps of `ship/SKILL.md` and each of its sections whole, and names the last step it returns at.
- **The Capy launch file appends the checkout's `bin/` to PATH**, so a bare `gstack-ship-budget` resolves.

### Fixed
- **A failed child stops its parent** until a regenerated child reconciles complete or the owner resumes, and `reconcile --record` finds the parent run after a `--continue` child.
- **`close` counts review starts reserved in handoff children**, so a dispatch reserved inside a child is no longer flagged as unreserved at the root.
- **A dependency or script change after review is re-reviewed.** `gstack-ship-release finish` counts package.json and package-lock.json as release metadata only when the version alone changed, never counts bun.lock, and decides after any `--build` runs. TODOS.md edits rerun the test lanes.
- **`push` stops when the sealed-output guard could not run**, not only when it refuses.

### Tests
- `test/review-packets-removed.test.ts` now also pins the reviewer briefs, checklists, fix-check prompt and depth rules by content, so a change to what a reviewer sees fails until its no-loss replay is recorded.
