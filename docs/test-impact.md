# Test impact: traced reuse keys for free tests

GST-167 is the plan to skip a free test on a pull request only when main already passed that exact test with the exact same inputs. PR 2 adds the pieces that decide what "the same inputs" means. Nothing here changes what CI runs yet: PR 3 records main receipts and reports in shadow, and PR 4 is the first change that would skip anything.

## Commands

`scripts/test-impact.ts` is a Bun CLI:

- `trace [--out <dir>] <test-file>...` runs each file under strace with the free runner's own `bun test` arguments and shard sandbox, and writes its read set to `<dir>` (default `.context/test-impact/traces`). It needs Linux with strace installed.
- `key --tree <ref> [--base <ref>] [--traces <dir>] [--json] <test-file>...` prints each file's key at `<ref>`, or why it has none.
- `explain [--tree <ref>] [--base <ref>] [--traces <dir>] <test-file>` prints every input of one file's key and why it is or isn't eligible.

With `--base`, the CLI loads `lib/test-impact/key.ts` from that ref and runs it over the tree, so a branch can't change the rules that decide what it skips. The CLI that does the loading comes from the checkout, so CI wiring (PR 3 and 4) has to run the base ref's copy of `scripts/test-impact.ts`, never the branch's. Without `--base`, it uses this checkout's code and says so. A base ref with no key code makes every file ineligible.

## What the trace records

The recorder runs `strace -f -y -qq -v` with `openat, open, execve, execveat, getdents64, readlink, readlinkat, stat, lstat, newfstatat, statx, access, faccessat, faccessat2, chdir, fchdir, clone, clone3, fork, vfork, connect, bind, sendto, sendmsg, sendmmsg, getsockname` (strace 6.8 on x86_64 Linux accepts the whole set) and gives the run a private TMPDIR. `lib/test-impact/trace.ts` keeps every repo path the test or any child process opened, ran, checked or probed. A failed open counts, because a file that shows up later changes what the test sees. For each repo directory it listed, the trace keeps the sorted names. Paths outside the repo, in /proc and /dev, under node_modules and in the private TMPDIR are dropped.

## What the key covers

`lib/test-impact/key.ts` reads everything at the given tree through git, never from the working tree. The graph runs over a copy of that tree written blob by blob, with no attribute processing, so the tree's own `.gitattributes` (`export-ignore`, `working-tree-encoding`, filters) can't hide an import from it. The key is a sha256 over:

- each traced path's bytes (read with `git cat-file --batch`), or that it is a directory, or that it is absent;
- the names in each traced directory listing, at the tree;
- the test's forward import-graph closure from `lib/pregate/import-graph.ts`, up to 12 hops;
- `bun.lock`, `bunfig.toml`, every `tsconfig*.json` and the `dependencies` in `.gstack/pregate.json`;
- the key code itself: the tracer, the key, the CLI, the free-test runner and planner (`scripts/test-free-shards.ts`) with every repo module it imports (shard engine, HOME guard, CI health, Windows curation, the paid/free split, the state root), the import graph, `lib/pregate/lane-selection.ts`, and the receipt reader (`scripts/lib/free-receipts.ts`) with the run verifier it trusts (`lib/run-evidence.ts`);
- the bytes of each executable outside the repo the trace ran (git, bash, tar and so on), read on the machine computing the key;
- the runtime (platform, architecture, Bun version) and the values of `CI`, `GITHUB_ACTIONS`, `TZ`, `LANG`, `LC_ALL`, `NODE_ENV`, `EVALS` and `EVALS_TIER`.

## What is never reused

A file is ineligible, so it always runs, when:

- it is on the always-run list in the base branch's `.gstack/always-run.json` or the tree's (the union, so a branch can add entries but never drop main's);
- it has no trace, a trace older than 7 days or dated more than 5 minutes in the future, a trace whose run failed, or a trace made under other values of the allowlisted variables or on another runtime;
- its trace shows an inet connect or send to anything other than a loopback endpoint a socket in the same run bound, a unix socket outside the repo and the private TMPDIR (or an abstract one), any access under the real HOME other than a PATH tool lookup or the tool itself, a listing of HOME, shared /tmp state, or a read of the repository's own `.git`;
- its trace read a repo path the tree doesn't track, such as a build output under `dist/`. A probe of a missing path and a file the run created or truncated itself don't count;
- its import-graph walk reaches the 12-hop cap. The walk fails closed: a deeper chain makes the test ineligible instead of cutting the closure short;
- the tree changes any key-code file against the base. Then every file runs.

Limits: strace can't see which environment variables a test reads, so only the allowlist above is in the key, and a test that depends on another variable has to read it through a file the trace sees or stay off the reuse path. The recorder reuses the runner's arguments and sandbox but not its home-write guard, which only watches and changes nothing a test reads. Timing assertions, flaky history across the last main runs and the shard's execution grouping are for PR 4, which reads them from the receipts PR 3 writes. Windows has no tracer, so the Windows lane stays full.

## Receipts and shadow mode

PR 3 records what main passed and reports, on every pull request, what the free lane could have reused. It still runs every file. `scripts/lib/free-receipts.ts` holds the logic; `scripts/test-free-shards.ts` has two thin hooks.

**Writing receipts.** `--ci-run <plan> --shard <n> --result <file> --receipts <dir> [--traces <dir>]` writes `<dir>/free-receipts-shard-<n>.json` after the shard runs. Each passing file whose key exists gets one record: `file`, `key` (the full sha256), `run_id`, `run_attempt`, `head_sha`, `tree`, `shard` and `written_at`. The key is computed at the run's own commit with that commit's key code (through the CLI's `key --base`), from the traces in `--traces` (default `.context/test-impact/traces`). A shard writes nothing at all when:

- it didn't pass, its flaky retry re-ran anything, a worker crashed (even if bun's own retry then passed), it recorded an unattributed failure, or its summary doesn't count every planned file;
- the run isn't a `push` run, isn't on its first attempt, or the checkout isn't the run's commit.

A failure while writing prints `none written (<cause>)` and never changes the shard's verdict. The Windows lane has no tracer, so `--receipts` refuses `--windows-only`.

**Reading receipts.** `--shadow-select --receipts <dir> --base <ref> [--traces <dir>]` reads every receipt file under `<dir>` and checks each source run once through `verifyRun` (see [run evidence](pregate.md#run-evidence)). It uses the base branch's `run_profiles["free-receipts"]` from `.gstack/pregate.json`, so a pull request can't relax it, and it accepts `push` runs only, whatever the profile's events say. The profile names the `free-tests` job, which passes only when every shard did, and the `free-tests-tree` artifact, which holds the run's `tree.json`; receipts and the run may be at most 72 hours old. A receipt is refused, with its reason on the file's line, when:

- `other_workflow`: its run executed another workflow file;
- `not_push`: its run was a `pull_request`, a dispatch or any other event;
- `retried`: the receipt or the API names a run attempt above 1, or the run moved to a new attempt while it was being checked;
- `stale`: the run finished, or the receipt was written, more than the profile's `max_age_hours` ago;
- `forged_run`: the receipt's sha or tree disagrees with what the API and git say the run tested, `tree.json` disagrees with git, or `tree.json` doesn't list the file;
- `off_base`: the run's head isn't an ancestor of `--base` (so the PR job needs main's history);
- `run_refused`: any other `verifyRun` refusal, such as a failed run or a newer red run on the same head.

The PR's keys are computed at `HEAD` by the base's key code: the reader runs `scripts/test-impact.ts key --tree HEAD --base <ref> --json`, the trusted route above, and a failure there makes every line `execute (keys unavailable: <cause>)`. The writer runs the same command with the run's commit as both tree and base.

**The report.** One line per free file, then a summary:

```
test/a.test.ts would-reuse 19283746501 key=1f2e3d4c5b6a
test/b.test.ts execute (key mismatch: receipt 9a8b7c6d5e4f, tree 0a1b2c3d4e5f)
test/c.test.ts execute (ineligible: no trace)
test/d.test.ts execute (no receipt)
shadow: would reuse 1 of 4 free files (25.0%) and 3.0 s of 10.0 s seed time (30.0%); 0 files have no seed duration. Nothing was skipped: every file ran.
```

The seed time comes from `scripts/free-test-durations.json`. The report throws unless its lines cover every free file exactly once. It never fails open: if the receipts can't be read or verified (a missing directory, a malformed file, no profile on the base, an API or artifact outage), every line reads `execute (receipts unavailable: <cause>)`. It exits 0 and runs nothing, so CI wiring keeps it non-blocking. The reader runs from the PR's checkout for now; that's fine while it only reports, and PR 4 moves the decision to the base's code before anything is skipped.
