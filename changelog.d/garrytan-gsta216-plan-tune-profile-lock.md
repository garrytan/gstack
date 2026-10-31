**Background `--derive` runs no longer drop /office-hours sessions or fail with ENOENT when they overlap (#3437).** `gstack-question-log` starts a background `gstack-developer-profile --derive` after every append, and a multi-question AskUserQuestion logs several rows at once. Every derive wrote the same `developer-profile.json.tmp` and rewrote the whole profile without a lock. On main at 3bfe566, 30 rounds of 8 overlapping derives plus one `--log-session` saw 9 of 270 runs fail with `ENOENT` on rename, and 2 of the 30 sessions disappeared. With this change the same run has 0 failures and keeps 30 of 30 sessions.

### Fixed
- **`bin/gstack-developer-profile`**: `--derive`, `--log-session`, `--reconcile` and `--migrate` hold `developer-profile.json.lock` from before they read the profile until after they rename it, and each writes its own `mktemp` file. The owner file names the holder's process ID, and the lock is ownership-checked on release. A lock is taken over when its holder process is gone, or once it is 5 minutes old even if a process with that ID is running, since no writer takes that long and the ID may have been reused. Takeovers go one at a time under `developer-profile.json.lock.takeover`, so two waiters can't both take over. A writer that can't get the lock within 10 seconds writes nothing and exits 5. An unwritable state directory is reported right away instead of after the wait. A relative state root is anchored once, so the lock is released under the same path it was taken. Windows drive-letter roots stay as they are.
### Removed
- **`scripts/psychographic-signals.ts`**: `applySignal` and `newDimensionTotals`, which lost their last production caller when `--derive` moved onto `accumulateSignals` (#3435), and their three unit tests.

### Not covered yet
- `gstack-distill-apply` and /plan-tune's declared edits still write the profile without the lock.

### Tests
- `test/gstack-developer-profile.test.ts`: a directory at the old fixed temp path; a held lock blocking `--derive` and `--log-session`; takeover of an ownerless stale lock, of a dead holder's lock, and of a 5-minute-old lock whose process ID is alive; a takeover already in progress; a takeover that can't remove the lock still giving up; a relative state root; and 6 rounds of 6 derives plus a `--log-session` keeping every session. Each test failed on the code before its fix.
