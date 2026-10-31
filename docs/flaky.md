# Flaky tests: rerun once and record it (`gstack-flaky`)

`gstack-flaky run` runs your test command, reads the JUnit report it writes,
and when tests failed, runs the command once more. A test that passes on its
rerun is a **flaky pass**: the job stays green and the flake is recorded on a ledger, so
the daily flaky pass can fix it at the source. A test that fails twice is red.
This is CREW rule 16 ("run the failed test again and note that it is flaky")
for any runner that writes JUnit: Playwright, `bun test`, jest, vitest and
pytest. gstack's own free suite keeps its file-level retry
(`GSTACK_FREE_RETRY_FLAKY`, [Flake ledger](TESTING_INTERNALS.md#flake-ledger)).

## Get started in GitHub Actions

```yaml
- uses: oven-sh/setup-bun@v2
  with: { bun-version: 1.4.4 }
- name: Install gstack-flaky (pinned)
  env: { GSTACK_REF: <a gstack commit sha you have tested> }
  run: |
    git clone --quiet --filter=blob:none https://github.com/garrytan/gstack.git "$RUNNER_TEMP/gstack"
    git -C "$RUNNER_TEMP/gstack" checkout --quiet "$GSTACK_REF"
- name: E2E
  env:
    PLAYWRIGHT_JUNIT_OUTPUT_NAME: results/junit.xml
    GSTACK_FLAKE_LEDGER_JUNIT: ${{ runner.temp }}/flaky-junit-ledger.jsonl
  run: |
    "$RUNNER_TEMP/gstack/bin/gstack-flaky" run --junit results/junit.xml -- npx playwright test --reporter=line,junit
- if: always()
  uses: actions/upload-artifact@v4
  with: { name: flaky-junit-ledger-e2e, path: "${{ runner.temp }}/flaky-junit-ledger.jsonl", if-no-files-found: ignore, retention-days: 90 }
```

Replace `GSTACK_REF` with a gstack commit you have tested; the bin needs only
Bun and git. In Actions it also writes a step-summary table of the flaky
passes and one `::warning` annotation per flaky test, so they are visible on
the run before anyone reads the ledger.

## Runners

| Runner | Command after `--` | Notes |
|---|---|---|
| Playwright | `npx playwright test --reporter=line,junit` with `PLAYWRIGHT_JUNIT_OUTPUT_NAME=<file>` | `gstack-flaky` sets `PLAYWRIGHT_JUNIT_INCLUDE_RETRIES=1` so Playwright's own `retries` are reported; with retries configured, those attempts stand and nothing is rerun again. |
| bun | `bun test --reporter=junit --reporter-outfile=<file>` | |
| jest, vitest, pytest (`--runner generic`) | your command, writing JUnit | Always reruns the whole command, even with `--rerun-scope test`. |

The command after `--` runs without a shell. When it needs one, wrap it as
`bash -c '<script> "$@"' _` so a targeted rerun's selection arguments reach
the runner.

## Rerun scope

**Default: the whole command.** The rerun repeats your command exactly, and
counts only on the runner's own full green verdict: it exits 0, no test fails,
every test of the first run is in its report, and the runner counts no failure
outside the report. That verdict covers every reason a run can fail, including
the ones a narrowed rerun cannot see: a test the first run never reached
(`--bail`, `--max-failures`, `-x`), a coverage threshold (however coverage is
configured, `bunfig.toml` and lcov included), a fail-on-flaky policy, a
global setup error. A test that failed in the first run and passes once in this
rerun is a flaky pass. It costs one more run of the suite, which is still far
cheaper than rerunning the CI job by hand.

**Opt-in: `--rerun-scope test`.** Reruns the failed test alone (Playwright:
`<file> --grep <title> --project <project>`; bun: `<file> --test-name-pattern <title>`)
and clears it when that rerun exits 0. Use it only when the first run's exit
status can come from failed tests alone: no coverage threshold in any form, no
`--fail-on-flaky-tests`, no other step inside the command that can fail. As a
safety net, `gstack-flaky` still reruns the whole command
(`FLAKY_RERUN: scope=command (<why>)`) when the runner exited anything but
1, its summary is missing, it stopped early (bun `Bailed out`, Playwright
`did not run`, `interrupted`, `Testing stopped early`, a global timeout), it
printed a coverage table or got `--coverage`, or it retried flaky tests itself.
It cannot see a coverage threshold configured without console output (for
example `coverageReporter = ["lcov"]` in `bunfig.toml`), which is why this
scope is opt-in.

## Rules

- **One rerun, small failures only.** A failed test gets one rerun when the
  runner made no retries and at most `--max-reruns` (3) tests failed. More
  failures than that is a real red, and nothing is rerun. When the run is
  already red for a test that cannot be rerun, a whole-command rerun is
  skipped.
- **A rerun clears a test only cleanly.** The rerun's command must exit 0 and
  the test must run once and pass on its first attempt; a rerun the runner
  retried again does not count.
- **Never green by accident.** The report is deleted before every attempt, and
  a report that attempt did not write counts as missing. A missing, empty,
  zero-test or malformed report fails, as does a non-zero exit with no failed
  test (a crash or a non-test step) and a runner killed by a signal. Cancelling
  `gstack-flaky` (SIGINT, SIGTERM) is passed to the runner and latched: nothing
  is rerun after it, whatever exit the runner chooses. When the runner's
  summary counts failures its JUnit omits (a bun file that fails to load, a
  Playwright error outside any test), the run is red and nothing is rerun.
- **Reports.** After the run, `--junit` holds the first run's report, so a
  later upload or test reporter sees what failed. Each rerun's report is kept
  beside it as `<name>.rerun-<n>.xml`. Other reporters' outputs (Playwright's
  `test-results/` and HTML report) are rewritten by a rerun; upload the JUnit
  report as the record. An existing `--junit` file that is not a JUnit report,
  or cannot be read, is refused (usage, exit 2), never deleted.
- **Ids.** A test is `<file>::<project>::<describe > title>`, with the project
  empty outside Playwright, so a test in two browser projects is two tests.
  `gstack-flaky ids --junit <file>` prints them.
- **Ledger.** One JSON line per flaky pass (`kind: flaky-pass`) and per test
  that failed its rerun (`rerun-fail`), with the tree, commit, branch, run URL,
  attempts, the rerun's scope (`test` or `command`) and the first lines of
  the error. Ids, paths and failure text go through gstack's redaction engine
  first; when the scan cannot run, they are withheld. The path is `--ledger`,
  else `GSTACK_FLAKE_LEDGER_JUNIT`, else
  `<state root>/flake-ledger-junit.jsonl`, and `FLAKY_RESULT` names it. It is
  kept apart from the free suite's file-level ledger (`GSTACK_FLAKE_LEDGER`).
  A ledger write error is a warning and never changes the verdict.

## Output and exit codes

One `FLAKY: <flaky-pass|fail|rerun-fail> <id> attempts=<…> (<reason>)` line per
test that failed at least once, `FLAKY_RERUN: scope=command (<why>)` when the
rerun repeated the whole command, then
`FLAKY_RESULT: tests=<n> failed=<n> flaky=<n> reruns=<n> command_exit=<n> verdict=pass|fail ledger=<file|none>`.

| Exit | Meaning |
|---|---|
| 0 | Every test passed, flaky passes included |
| 1 | A test failed (after its rerun, or with no rerun), including `FLAKY_UNREPORTED_FAILURES` |
| 2 | Usage error, including a `--junit` path that is not a `.xml` file, or an existing file there that is not a readable JUnit report |
| 3 | No usable report, a crash, or a killed runner (a code below on stderr) |

| Code | Exit | Cause | Fix |
|---|---|---|---|
| `FLAKY_NO_RESULTS` | 3 | No report at `--junit`, an empty one, or one with no testcase | Make the command write JUnit to that path |
| `FLAKY_JUNIT_INVALID` | 3 | The report is not well-formed XML | Make sure one process writes it and nothing appends to it |
| `FLAKY_RETRIES_HIDDEN` | 3 | Playwright retried but its report omits the retries | Set `PLAYWRIGHT_JUNIT_INCLUDE_RETRIES=1` where the report is written |
| `FLAKY_COMMAND_FAILED` | 3 | Non-zero exit with no failed test | Read the command output: a real red |
| `FLAKY_COMMAND_KILLED` | 3 | The runner was killed by a signal (a cancelled job, an OOM kill) | Nothing was rerun; rerun the job |
| `FLAKY_COMMAND_NOT_STARTED` | 3 | The command could not be started | Check the argv after `--` |
| `FLAKY_UNREPORTED_FAILURES` | 1 | The runner counted failures or errors its JUnit omits | Fix the load error or the error outside any test: a real red |
| `FLAKY_LEDGER_WRITE_FAILED` | — | The ledger could not be appended (warning) | Check the path; the verdict stands |
