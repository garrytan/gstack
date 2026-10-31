**gstack's own tests no longer write into a developer's real gbrain.** A developer who exports `GBRAIN_DATABASE_URL` for their working brain and runs `bun run test` or a single test file used to hand that URL to every gstack bin the tests spawn. `test/brain-sync.test.ts` and `test/gstack-memory-ingest.test.ts` then called the real `gbrain` on PATH, which added `brain-sync-remote-*` and `gstack-transcripts-*` sources and test pages to the live brain. Now no test run passes on the four variables that pick a brain: `GBRAIN_DATABASE_URL`, `GBRAIN_DIRECT_DATABASE_URL`, `DATABASE_URL` and `GBRAIN_HOME`. From #3466 by @AndreIntelas.

### Fixed
- **The test preload strips them before any test module loads**, and says so on stderr, so a focused `bun test` run is safe. `test/bunfig.toml` loads the same preload, so a run from `test/` (`cd test && bun test brain-sync.test.ts`) is covered too; before, Bun read no preload there.
- **`createShardSandbox` drops them from every shard's environment.** In Bun a child spawned without `env:` still gets the startup environment after the preload deletes a variable, so `bun run test` needs the sandbox as well.
- **The key list lives in one dependency-free file, `lib/live-brain-env.ts`.** It is a global touchfile pinned by the harness manifest, so an edit to it selects the paid cases whose environment it changes. `test/bunfig.toml` is a free-lane only PR file, because paid shards run from the repo root and never read it.

### Tests
- `test/shard-engine.test.ts`: a shard never inherits the variables that point gbrain at a live brain.
- `test/state-root-config-merge.test.ts`: the preload strips them for a run from the repo root and from `test/`, with no `--preload` flag.
- `test/pr-dependencies.test.ts`: a change to `test/bunfig.toml` alone stays in the PR profile with no paid cases selected.
