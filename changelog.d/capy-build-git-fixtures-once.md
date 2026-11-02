**Five free-test files stop rebuilding the same git repositories for every test: they spend 17–24 s less in summed per-file runtime, with every assertion intact.** Each test still gets its own private copy of the fixture.

### Tests
- `test/helpers/git-fixture-template.ts` (new): builds a git fixture once per test file and copies it per test with `fs.cpSync`. The adopter rewrites every path-bearing file (remote URLs, alternates, state roots), and the copy is then scanned for any remaining reference to the template, so a test can never push into or read from the shared template. `test/git-fixture-template.test.ts` pins two-copy isolation and the leak scan.
- `test/release-cut.test.ts` (~10 s to ~6 s), `test/train-backstop.test.ts` (~4 s to ~1.6 s), `test/restamp-mentions.test.ts` (via `test/helpers/restamp-fixture.ts`), `test/pregate-user-policy.test.ts` (via `test/helpers/pregate-fixture.ts`) and `test/held-install-recovery.test.ts` (~33 s to ~22 s) use the template. Test and `expect()` counts are unchanged in every file.
- `test/helpers/restamp-fixture.ts` turns off auto-maintenance (`maintenance.auto=false`, `gc.auto=0`) in the bare origin the ship-queue train tests push to.
- `test/test-of-test-ratchet.test.ts`: one BASELINE row for the new helper test, which tests a test helper by design.
