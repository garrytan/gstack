**Four skill-eval check commands that gstack-evals' Lane A vendors as graders no longer pass runs that break their rule.** gstack-evals' grader audit (GST-374) showed that one agent-written `.gitignore` could hide new code from the /office-hours no-code check, and that three smaller gaps let other checks pass on the wrong files.

### Fixed
- **office-hours/no-code-session** lists untracked files with `--exclude-from=.git/info/exclude` instead of `--exclude-standard`, so a `.gitignore` the agent writes no longer hides anything. Only the seed's own exclude entry (`.gstack-home/`) still applies.
- **learn/no-code-change** also fails on a new untracked file under `app/`. Before, `git diff --quiet HEAD -- app` saw only tracked files.
- **learn/add, prune-stale and prune-conflict** read the seeded project's `learnings.jsonl` (the slug `seed.sh` derives from the work dir) instead of `projects/*`, so an extra project folder can no longer satisfy them.
- **The eight office-hours design-doc checks and backend-skips-visual** first require `.gstack-home` to be a real directory and not a symlink. `find` does not descend into a symlinked start point, so a swapped state root used to hide every design doc and mockup.

### Gate integrity
- These are grader edits that only tighten. Each check now fails runs it passed before, and no threshold, trial count or task was removed. The new `test/skill-eval-checks.test.ts` seeds each task with its own `seed.sh`, then runs the committed check after an honest action (it must pass) and after each hole (it must fail). On the old checks, all 15 hole cases passed the check and all 15 honest cases passed too. gstack-evals relocks its vendored copies from this commit.
- `test/skill-eval-checks.test.ts` joins the `BASELINE` in `test/test-of-test-ratchet.test.ts`. It imports no product module because no gstack module runs these check commands; the commands themselves are what it tests.
