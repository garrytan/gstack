**gstack's own tests no longer write into a developer's real gbrain.** If you export `GBRAIN_DATABASE_URL` for your working brain and run gstack's test suite, tests that spawn bins with a temp `HOME` used to pass that URL straight through. With no gbrain config under the temp `HOME`, the real `gbrain` on your PATH then added `brain-sync-remote-*` sources and test pages to your live brain. From #3466 by @AndreIntelas.

### Fixed
- **The test preload (`test-setup.ts`) strips the variables gbrain uses to pick a brain** before any test module loads: `GBRAIN_DATABASE_URL`, `GBRAIN_DIRECT_DATABASE_URL`, `DATABASE_URL` and `GBRAIN_HOME`. It prints one line on stderr for each variable it strips. This covers `bun test <file>` and every shard of `bun run test`.

### Tests
- `test/state-root-config-merge.test.ts`: a `bun test` run with all four variables exported spawns a child under a temp `HOME` that calls `buildGbrainEnv`, and the child sees none of them. It fails on main.
