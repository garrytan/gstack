# Flaky tests: rerun once and record it (`gstack-flaky`)

`gstack-flaky run` runs your test command, reads the JUnit report it writes,
and when tests failed, runs the command once more. A test that passes on its
rerun is a **flaky pass**: the job stays green and the flake is recorded on a ledger, so
the daily flaky pass can fix it at the source. A test that fails twice is red.
This is CREW rule 16 ("run the failed test again and note that it is flaky")
for any runner that writes JUnit: Playwright, `bun test`, jest, vitest and
pytest. A test that keeps flaking while it is fixed can be
[quarantined](#quarantine): it still runs, with up to 3 attempts, and never counts
as a pass. gstack's own free suite keeps its file-level retry
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

## Quarantine

A test that keeps flaking while someone fixes it can be **quarantined** in
`.gstack/quarantine.json` at the repository root. Quarantine is a larger
attempt budget, never a skip: the test still runs on every run, is listed as
quarantined in the output, and never counts as a pass.

**How a quarantined test is judged.** The verdict rule from
[Rerun scope](#rerun-scope) does not change: an attempt counts only when the
runner itself reports a full green run. When every test an attempt failed is a
live quarantined test, and nothing else is wrong with that attempt (no kill, no
failure outside the report, no first-run test missing), the whole command may
run again, up to 3 attempts in total. The run is green only when one of those
attempts is fully green. A quarantined test that fails all 3 is a **hard
break**, and the run is red. A test that is not quarantined keeps its one
rerun. A red attempt never turns green because its only reported failure is a
quarantined test, because the runner's exit status can come from things the
report does not show (a coverage threshold, a fail-on-flaky policy, a global
setup). With `--rerun-scope test` the quarantined test gets the same 3
attempts on the targeted path, with the same fallback to the whole command.
When the runner retries on its own (Playwright `retries`), its attempts are
the budget and nothing is rerun again.

**Missing results.** A quarantined id missing from a run that included its
file (and, for Playwright, its project) is red. A run that did not include the
file, such as a shard or a diff selection, is not.

**Read from the base branch.** `run --base <ref>` reads the registry from
that commit instead of the working tree. Pull-request CI passes its target
branch, so a change cannot quarantine the test it breaks. `check --base`
compares against the merge base, so check out full history for it:

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- name: Quarantine registry
  run: '"$RUNNER_TEMP/gstack/bin/gstack-flaky" quarantine check --base "origin/${{ github.base_ref }}"'
- name: E2E
  run: |
    "$RUNNER_TEMP/gstack/bin/gstack-flaky" run --base "origin/${{ github.base_ref }}" --junit results/junit.xml -- npx playwright test --reporter=line,junit
```

### Commands

| Command | What it does |
|---|---|
| `gstack-flaky quarantine add <id> --owner <who> --ledger <url> --class <class> --reason <text> --evidence <url>… --junit <file> [--days <n>]` | Adds an entry that expires in `--days` (default 7, at most 14). `--junit` counts the suite for the cap and confirms the id exists; `gstack-flaky ids` prints the ids. |
| `gstack-flaky quarantine renew <id> --owner <who> --evidence <url> [--days <n>]` | One renewal of up to 7 days from the later of now and the current expiry, with evidence not already on the entry and the owner named again. A second renewal is refused. |
| `gstack-flaky quarantine release <id> --reason <text> --pr <url>` | Moves the entry to `released` with the date, the reason and the PR. |
| `gstack-flaky quarantine check [--base <ref>] [--junit <file>]` | Validates every entry and the cap; with `--base`, also what this change did since the merge base. Exits 1 with one `QUARANTINE_REFUSED:` line per problem. |
| `gstack-flaky quarantine report [--ledger <file\|dir>…] [--base <ref>]` | Lists expired entries, then live entries soonest-expiring first with days left. With downloaded ledgers it adds recent outcomes and marks entries with 10 consecutive clean passes `READY_TO_RELEASE`; without `--ledger` it says the exit rule was not checked. |

### Rules

- **Every entry is owned and expires.** An entry holds `owner`, `ledger`
  (the ledger line or issue tracking the fix), `failureClass`, `reason`,
  `evidence`, `enteredAt`, `expiresAt`, `renewals` and `suiteTests` (the
  suite size `add` counted). It lasts 7 days by default and at most 14 from
  entry, plus one renewal of at most 7 days.
- **Expired means not quarantined.** An expired entry stops applying without
  an edit: `run` treats the test as an ordinary test and prints
  `FLAKY_QUARANTINE_EXPIRED` with the renew and release commands. An entry
  that breaks a rule (for example one that lasts 30 days) is ignored the same
  way, with `FLAKY_QUARANTINE_IGNORED`.
- **Cap.** Live entries are capped at 10% of the suite's tests, at least 1,
  and 5 for a suite under 50 tests. `add` refuses past the cap; `check`
  enforces it against `--junit` when given, else against the smallest
  `suiteTests` on a live entry.
- **Classes.** `detector`, `harness`, `timing` and `model-latency`.
  `product` is refused (a product defect is fixed, not quarantined), and so is
  `infra` (an infrastructure red is rerun or fixed as infrastructure).
- **`check --base` refuses** an entry added in the same change that edits its
  test's file, an entry that disappears without a release record, a release
  record that was removed, and a changed `enteredAt` or rewritten renewal
  history.
- **Exit rule.** 10 consecutive clean passes (`quarantined-pass` with no
  failed attempt) on the ledgers since the entry was added. Release the entry
  with the fix PR.
- **Separate from `CASE_QUARANTINE`.** gstack's own paid-eval quarantine
  (`CASE_QUARANTINE` and `EVAL_POLICY`,
  [TESTING_INTERNALS.md](TESTING_INTERNALS.md)) is a different registry with
  its own rules for eval cases. The two share no schema, and `gstack-flaky`
  neither reads nor writes it.

### The daily flaky pass

Download the ledger artifacts of the last week's runs and read them with
`report`; fix expired and `EXPIRING` entries first (fix the test, or renew
once with new evidence), release `READY_TO_RELEASE` entries, then fix the
worst repeat on the ledger:

```bash
for id in $(gh run list --workflow e2e.yml --limit 50 --json databaseId -q '.[].databaseId'); do
  gh run download "$id" --pattern 'flaky-junit-ledger-*' --dir "ledgers/$id" || true
done
gstack-flaky quarantine report --ledger ledgers
```

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
- **Ledger.** One JSON line per flaky pass (`kind: flaky-pass`), per test
  that failed its rerun (`rerun-fail`) and per quarantined test on every run
  (`quarantined-pass`, `quarantined-fail`, `hard-break`), with the tree, commit, branch, run URL,
  attempts, the rerun's scope (`test` or `command`) and the first lines of
  the error. Ids, paths and failure text go through gstack's redaction engine
  first; when the scan cannot run, they are withheld. The path is `--ledger`,
  else `GSTACK_FLAKE_LEDGER_JUNIT`, else
  `<state root>/flake-ledger-junit.jsonl`, and `FLAKY_RESULT` names it. It is
  kept apart from the free suite's file-level ledger (`GSTACK_FLAKE_LEDGER`).
  A ledger write error is a warning and never changes the verdict.

## Output and exit codes

One `FLAKY: <flaky-pass|fail|rerun-fail|quarantined-pass|quarantined-fail|hard-break> <id> attempts=<…> (<reason>)`
line per test that failed at least once and per quarantined test,
`FLAKY_RERUN: scope=command (<why>)` when the rerun repeated the whole command, then
`FLAKY_RESULT: tests=<n> failed=<n> flaky=<n> quarantined=<n> reruns=<n> command_exit=<n> verdict=pass|fail ledger=<file|none>`.
`failed` counts every outcome but `flaky-pass` and `quarantined-pass`; `quarantined`
counts the quarantined tests' outcomes, which are never counted as passes.

| Exit | Meaning |
|---|---|
| 0 | Every test passed, flaky passes included |
| 1 | A test failed (after its rerun, or with no rerun), including `FLAKY_UNREPORTED_FAILURES`, a quarantined test's hard break or missing result, and a refused `quarantine` command |
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
| `FLAKY_QUARANTINE_INVALID` | 3 | `.gstack/quarantine.json` is not valid JSON or not a schema 1 registry | Fix the file; `quarantine check` names the problem |
| `FLAKY_QUARANTINE_BASE` | 3 | `--base` does not resolve to a commit (exit 2 for a value starting with `-`), or `check` finds no merge base | Fetch the base branch; `check --base` needs `fetch-depth: 0` |
| `FLAKY_QUARANTINE_REFUSED` | 1 | `add`, `renew` or `release` broke a rule | Read the reason; [Quarantine](#quarantine) lists the rules |
| `FLAKY_QUARANTINE_USAGE` | 2 | An unknown `quarantine` command or option, or a missing value | `gstack-flaky quarantine --help` |
| `FLAKY_QUARANTINE_EXPIRED` | — | Notice: an expired entry no longer applies | Fix the test, renew once, or release; the line prints both commands |
| `FLAKY_QUARANTINE_IGNORED` | — | Notice: an entry breaks a rule and does not apply | Fix the entry; `quarantine check` names the rule |
