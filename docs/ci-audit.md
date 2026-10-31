# /ci-audit and gstack-ci-audit

`/ci-audit` measures a repo's GitHub Actions CI and checks it against nine CI-speed
lessons (from Owen Gretzinger's write-up of taking a CI from 40 minutes to 2). It ranks
fixes by minutes saved per PR and dollars per month, and changes nothing unless you
approve a fix. The numbers come from one program, `bin/gstack-ci-audit`, so they repeat.
GitHub Actions only.

## What it measures

- **Push to all checks green.** For each PR head: from its first workflow run created to
  its last run finished, counting only heads whose every run went green on the first
  attempt. Cancelled or superseded heads, reruns, unfinished heads and heads at the edge
  of the window are left out and counted. Failed heads get a separate time to first
  failure.
- **Per job: waiting, setup and running.** Waiting is job created to job started (the
  queue for a machine). Setup is the steps named like checkout, toolchain setup, cache,
  install, container start or artifact download. Running is the rest.
- **Cost.** Billed minutes (each job rounded up to a whole minute) scaled from the
  sampled runs to every run of each workflow in the window, priced from dated rows in
  `lib/ci-audit/prices.ts`. GitHub's standard runners are free on public repos.
  Ubicloud bills by VM family, read from a job log's `VM Family:` line with `--logs`;
  without it Ubicloud jobs are priced as standard and marked assumed.
- **Cache hit rate** only from evidence: restore lines in sampled logs (`--logs N`, at
  most 20). Without logs it says unknown.

GitHub's runs list returns at most 1,000 runs per query. On a busy repo the push-to-green
and job numbers then cover a shorter span than the window, and the report says from when;
cost still uses per-workflow run counts over the whole window.

## The nine lessons

| # | Lesson | Finding when |
|---|---|---|
| 1 | Fast runners for every job | jobs wait a minute or more for a machine often enough to matter; bursts of the repo's own jobs are named as a concurrency problem instead |
| 2 | Fast, strict lint | ESLint takes over 30 s per run; no recognized linter is unknown, never a finding |
| 3 | The fastest typechecker | the typecheck step is slow |
| 4 | Bigger machines, not more shards | shards spend most of their time on setup |
| 5 | Stop reloading the app per test file | Vitest runs without \`isolate: false\`; Jest is unknown |
| 6 | Fix setup: caches, checkout, parallelism | setup takes a quarter of a job, caches miss, full-history checkouts, more parallel tasks than cores |
| 7 | Run every job in parallel; split the slowest | one workflow finishes last on most heads |
| 8 | Only run what a PR touches, and test that skip logic | a path filter or selector has no full run behind it or no test |
| 9 | Checks in a pre-push hook | no pre-push hook runs lint or typecheck |

Each lesson is pass, finding (with minutes and dollars where measured), unknown (with the
evidence that would decide it) or not applicable.

## Commands

```
gstack-ci-audit run [--repo owner/name] [--since-days 7] [--since <iso>] [--until <iso>]
                    [--runs-per-workflow 30] [--workflows a.yml,b.yml] [--logs N]
                    [--max-calls 800] [--timeout 300] [--ubicloud-family premium|standard]
                    [--prices file.json] [--root dir] [--json] [--out file]
gstack-ci-audit compare --before <report.json> [--since <iso>] [run options]
gstack-ci-audit ship-check --base <branch> [--pr <n>]
gstack-ci-audit publish --exit <code> [--report report.json] [--error-file f] [--run-url u] [--dry-run]
```

Exit codes: 0 complete, 1 usage, 3 unavailable, 4 partial (labeled in the report),
5 internal error. Every error is one `CI_AUDIT: unavailable <detail> (<code>)` line with a
fix; the codes are in [troubleshooting](troubleshooting.md#gstack-ci-audit).

`--root` (default: the current directory) is read for workflow files, package scripts and
hooks only when its `origin` is the audited repo on github.com; otherwise those lessons
are unknown. `--record <dir>` saves the GitHub responses (allowlisted fields only) and
`--fixture <dir>` (or `GSTACK_CI_AUDIT_FIXTURE=<dir>`) replays them offline, using the clock the recording saved in `clock.json`, so a window measured from now asks for the same responses.

## The /ship check

`ship-check` runs on every `/ship`. It takes a few seconds, costs no model calls or
dollars, and never blocks a ship. With CI-shaping files in the diff (workflows,
`package.json`, hook and linter configs) it checks them against the lessons. With a PR
number it compares the PR's previous settled push with up to 40 comparable all-green PR
heads (same base, same workflow set): "slower" means slower than 19 of 20 of them and at
least `ci_audit_slower_min_s` (default 120) seconds over their median. Fewer than 8
comparable heads prints `unknown thin baseline`. About 6 GitHub calls, 10 second deadline.
Turn it off with `gstack-config set ci_audit_ship off`.

## The Saturday audit

`lib/ci-audit/templates/ci-audit-weekly.yml` runs the full report every Saturday at 15:00 UTC
and keeps one open "Weekly CI audit" issue current. A complete audit creates or replaces
the issue, or closes it when nothing is left to fix. A partial or failed audit comments
on the issue and keeps the last complete findings. The issue is matched by its title and
a marker line, so an issue a person opened with the same title is left alone. It reads
with the workflow's `GITHUB_TOKEN` (1,000 calls an hour), so it runs with
`--max-calls 400`.
