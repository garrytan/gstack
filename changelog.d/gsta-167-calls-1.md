**A driven `/ship` on Capy no longer pays one agent turn per finished reviewer, and it can count its own calls.** Replays of gstack-evals #34 and #36 (GSTA-167) made 30 to about 92 parent calls against a target of 12. In the 9-reviewer replay, 23 of 25 waits were the parent waking once per finished reviewer, because the driver told it to end its turn on `wait` while reviewers ran. What reviewers see, which reviewers run, their depth and the blocking floor are unchanged.

### Changed
- **Readers are polled inside the program** (`ship/DRIVER.md`, Capy skill). A program returns 200 s after its first line and the next call resumes the poll; the parent never ends its turn while readers run. Capy polls with one `tools.subagent.list` per tick, starts readers a create call rejected once slots free, and reports a reader stuck for 20 minutes instead of dropping it. `wait` (now 200 s) is only for tests, pregate and CI when no reader runs. Lanes, pregate and `finish` run in the background.
- **A program returns at most 32 KB**; longer reads such as `review-army.md` split at headings, each byte once, before first use. Phase 2 used to return about 98 KB of sections at once, and truncated reads cost extra calls.
- **A fix runs as one gated program**: the failing test, the fix, `--tests-only` and the next pass, each only if the last step passed. Step 7's audit, which may write tests, settles before the review pass reads the tree.
- **An unattended `push` defers the one-time pre-push guard offer** (`REDACT_PREPUSH: … deferred=unattended`) instead of stopping. It writes no marker and installs no hook, so the next interactive session still gets the offer.

### Added
- **`gstack-ship-budget calls --events <file>`** counts a run's parent calls from the host's transcript items: `CALLS: total= decision= keepalive= idle_gaps_over_300s= max_gap_s=`. A wait, or a program that only reads status (plus at most one bash for its note), counts as a keep-alive.

### Fixed
- **`gstack-ship-budget note --step 9.1`** records under step 9 with the sub-step as its label. Before, it was refused, and replays lost two notes to that error.
- **`gstack-review-scope render`** accepts `{"deferred": [...]}` as well as the bare array.
