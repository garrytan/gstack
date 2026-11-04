- gstack's own CI carry now runs the test files CI skipped entirely. Free Tests records `skipped_files` (the planned files whose every test skipped on the runner) in its `tested-tree` record, and gstack's `bun run test` lane declares `per_file`, so a /ship carry runs those files locally instead of counting them as run (GST-1190).

### Tests
- `test/ci-tree-reuse.test.ts`: only a file whose every test skipped is listed, a partly skipped file stays covered, and a run without complete per-file counts records no list.
