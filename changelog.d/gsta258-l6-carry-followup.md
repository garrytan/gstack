- A lane whose command runs several `bun test --shard=i/N` processes now records the sum of the shards' counts, not the last shard's (GBEV-3, gbrain-evals#317: 3336 recorded against 6,095 run across 2 shards). The sum needs one block from each of the N distinct shards at the end of the log; an incomplete or repeated set records the last summary as before, so a command that runs a suite twice still reports its last run.
- docs/pregate.md#dispatch-carry warns that a `workflow_dispatch` run reports under the same job names on the head commit, so without strict branch protection a green dispatch run can hide a red merge-commit check. It recommends strict protection or distinct job names for dispatch runs, and notes that gstack's own merge trains test the merged tree.
- docs/pregate.md#skipped-files names the order of record-ci's checks after a skipped-file remainder, including the final `tree_changed` recheck.

### Tests
- `test/evidence.test.ts`: two `--shard=i/2` processes in one log record 6095, and an incomplete or repeated shard set records the last summary. The sum case fails without the change (it recorded 3336).
