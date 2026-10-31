**A test that fails once in CI and passes when run again no longer turns the job red, and every such flake is recorded for the daily flaky-fix pass.** `gstack-flaky run` wraps any test command that writes a JUnit report (Playwright, `bun test`, jest, vitest, pytest). When a few tests fail, it runs the command once more. A test that failed and then passes is a flaky pass, so the job stays green, an Actions `::warning` and a step-summary row name it, and one line goes on a ledger. A rerun counts only when the runner itself reports a full green run, so a real failure, a coverage threshold, a test the first run never reached, a crash or a cancelled job stays red. Before this, each one-off flake meant rerunning the whole CI job by hand (five times in Truther's last evidence window, three of them for one test).

### Added
- **`bin/gstack-flaky run --junit <file.xml> -- <command>`**: reruns the whole command once when at most `--max-reruns` (3) tests failed and the runner made no retries of its own. `--rerun-scope test` opts in to rerunning only the failed tests (Playwright `--grep`/`--project`, bun `--test-name-pattern`), for suites with no coverage gate and no fail-on-flaky policy; it still falls back to the whole command when it sees an early stop, a coverage table or the runner's own retries.
- **Ledger** at `GSTACK_FLAKE_LEDGER_JUNIT` (default `<state root>/flake-ledger-junit.jsonl`), kept apart from the free suite's file-level ledger: one redacted line per flaky pass and per test that failed its rerun, with tree, commit, branch, run URL, attempts, scope and the first lines of the error.
- **`gstack-flaky ids --junit <file>`** prints the test ids a report holds (`<file>::<project>::<describe > title>`).
- Exit codes: 0 pass (flaky passes included), 1 a test failed, 2 usage, 3 no usable report, a crash or a killed runner, each with a `FLAKY_<CODE>` and a `fix:` line. A missing, stale, empty or malformed report never passes, and an existing `--junit` file that is not a JUnit report is refused rather than deleted.

### Docs
- `docs/flaky.md`: the GitHub Actions setup, runners, rerun scope and its preconditions, rules, output and exit codes. `docs/TESTING_INTERNALS.md#flake-ledger` points other repositories to it.

### Tests
- `test/flaky-run.test.ts` with captured Playwright 1.64 and bun 1.4 JUnit reports under `test/fixtures/junit/`: flaky pass, real red, rerun scopes, coverage-threshold and early-stop runs, unreported failures, cancelled runs, report deletion and ledger redaction.

### Gate integrity
- `test/helpers/free-fixtures-data.ts`: registers `test/fixtures/junit/**` to `test/flaky-run.test.ts`. No assertion, threshold or skip changed.
