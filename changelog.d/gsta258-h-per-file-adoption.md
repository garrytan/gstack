- gstack's own CI carry now runs the test files CI skipped entirely. Free Tests records `skipped_files` (the planned files whose every test skipped on the runner) in its `tested-tree` record, so a /ship carry runs those files here through the `bun run test` lane's `per_file` runner instead of counting them as run (GST-1190). A file that skips here too is not owed (GST-1314), so the carry no longer falls back to the full lane.

### Tests
- `test/ci-tree-reuse.test.ts`: only a file whose every test skipped is listed, a partly skipped file stays covered, and a run without complete per-file counts records no list.
