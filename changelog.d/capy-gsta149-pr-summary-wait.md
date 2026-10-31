**A PR push in a repository with a merge train no longer waits ten minutes for a check that does no work.** Under a train policy every PR push runs E2E Evals in `pr-summary` mode, which plans no paid slices, yet its `readiness` job still waited out the 600-second quiet window and green Free Tests before the run could finish. Now `readiness` waits for `route` and skips in `pr-summary` mode, so E2E Evals on a PR push finishes in about a minute (58 s on #3609) instead of after the 10-minute wait.

### Changed
- **`.github/workflows/evals.yml`**: `readiness` needs `route` and runs only when the mode is not `pr-summary`. In `pr` mode (a repository without a train) it still gates recovery and planning as before. In `pr-summary` mode a red Free Tests now shows on Free Tests alone, which stays the required free check; the train gate and the dispatched screen still carry the paid work.
- **`bun run test:health`**: the "PR lane push-to-verdict" rule text says `pr-summary` runs skip the wait since GSTA-149, so its p50 drops by about 10 minutes from this change on.
- **docs/TESTING_INTERNALS.md** describes the skip.

### Tests
- `test/evals-pr-lane-workflow.test.ts` pins `readiness.needs` and the full `if`. `test/evals-train-workflow.test.ts` checks that a `pr-summary` push runs only `build-image`, `route` and `screen-summary`, and that `pr` mode still runs `readiness`.
