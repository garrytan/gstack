**`test:health` and the factory scorecard leave reused main pushes out of their free-suite flake counts (#3725).** Since #3709, a main push whose merged pull request already passed on the same tree reuses that run. It finishes green, runs no shards and uploads nothing, so both readers counted it as a run with zero flakes. As reuse grows, that pulls real flake rates under the 5% bar, and `bun run test:health --enforce` stops flagging files without any error.

### Fixed
- **One rule for both readers** (`reuseChecker` in `scripts/lib/ci-history.ts`). A run with no artifacts and a green `reuse` job is a reused main push. `readCiFlakeLedgers` leaves it out of the window and its denominator and fills the window with older runs, so it still holds 20 runs that ran their shards. `readFreeRetries` in `lib/factory-scorecard.ts` leaves it out of the free-retry count. Both reports name how many runs they left out.
- **Bounded and visible.** A run with any artifact costs no extra call. A run with none costs one job listing, at most 40 per read. Past that cap, or when a listing fails, the run counts as it did before and the report says so.

### Tests
- `test/test-health-report.test.ts`: reused runs among real flaky runs (2 flaky of 20 real runs, with 30 reused) failed on the old code with 2/45 = 4.4%, which passed the 5% bar; now 2/20 = 10% fails it. The lookup cap and a failed lookup both count the run as before, and the report says so.
- `test/factory-scorecard.test.ts`: two reused runs in the window failed on the old code ("in 1 of 5 runs"); now the free-retry line matches the real runs only ("in 1 of 3 runs") and names the 2 runs it left out.
