# Test impact: traced reuse keys for free tests

GST-167 is the plan to skip a free test on a pull request only when main already passed that exact test with the exact same inputs. PR 2 adds the pieces that decide what "the same inputs" means. Nothing here changes what CI runs yet: PR 3 records main receipts and reports in shadow, and PR 4 is the first change that would skip anything.

## Commands

`scripts/test-impact.ts` is a Bun CLI:

- `trace [--out <dir>] <test-file>...` runs each file with `bun test` under strace and writes its read set to `<dir>` (default `.context/test-impact/traces`). It needs Linux with strace installed.
- `key --tree <ref> [--base <ref>] [--traces <dir>] [--json] <test-file>...` prints each file's key at `<ref>`, or why it has none.
- `explain [--tree <ref>] [--base <ref>] [--traces <dir>] <test-file>` prints every input of one file's key and why it is or isn't eligible.

With `--base`, the CLI loads `lib/test-impact/key.ts` from that ref and runs it over the tree, so a branch can't change the rules that decide what it skips. Without `--base`, it uses this checkout's code and says so. A base ref with no key code makes every file ineligible.

## What the trace records

The recorder runs `strace -f -y -qq -v` with `openat, open, execve, execveat, getdents64, readlink, readlinkat, stat, lstat, newfstatat, statx, access, faccessat, faccessat2, chdir, fchdir, clone, clone3, fork, vfork, connect, bind, sendto, getsockname` (strace 6.8 on x86_64 Linux accepts the whole set) and gives the run a private TMPDIR. `lib/test-impact/trace.ts` keeps every repo path the test or any child process opened, ran, checked or probed. A failed open counts, because a file that shows up later changes what the test sees. For each repo directory it listed, the trace keeps the sorted names. Paths outside the repo, in /proc and /dev, under node_modules and in the private TMPDIR are dropped.

## What the key covers

`lib/test-impact/key.ts` reads everything at the given tree through git, never from the working tree. The key is a sha256 over:

- each traced path's bytes (read with `git cat-file --batch`), or that it is a directory, or that it is absent;
- the names in each traced directory listing, at the tree;
- the test's forward import-graph closure from `lib/pregate/import-graph.ts`, up to 12 hops;
- `bun.lock`, every `tsconfig*.json` and the `dependencies` in `.gstack/pregate.json`;
- the key code itself: the tracer, the key, the CLI, the free-test runner and planner (`scripts/test-free-shards.ts`) with every repo module it imports (shard engine, HOME guard, CI health, Windows curation, the paid/free split, the state root), the import graph and `lib/pregate/lane-selection.ts`;
- the bytes of each executable outside the repo the trace ran (git, bash, tar and so on), read on the machine computing the key;
- the runtime (platform, architecture, Bun version) and the values of `CI`, `GITHUB_ACTIONS`, `TZ`, `LANG`, `LC_ALL`, `NODE_ENV`, `EVALS` and `EVALS_TIER`.

## What is never reused

A file is ineligible, so it always runs, when:

- it is on the always-run list in the base branch's `.gstack/always-run.json` or the tree's (the union, so a branch can add entries but never drop main's);
- it has no trace, a trace older than 7 days, or a trace whose run failed;
- its trace shows an inet connect or send to anything other than a loopback port the same run opened, any access under the real HOME other than a PATH tool lookup, shared /tmp state, or a read of the repository's own `.git`;
- its trace read a repo path the tree doesn't track, such as a build output under `dist/`. A probe of a missing path and a file the run created itself don't count;
- its import-graph walk reaches the 12-hop cap. The walk fails closed: a deeper chain makes the test ineligible instead of cutting the closure short;
- the tree changes any key-code file against the base. Then every file runs.

Limits: strace can't see which environment variables a test reads, so only the allowlist above is in the key, and a test that depends on another variable has to read it through a file the trace sees or stay off the reuse path. The recorder runs `bun test` directly, not inside the free runner's per-shard sandbox, so PR 3 should record traces through the runner. Timing assertions, flaky history and the shard's execution grouping are for PR 3 and PR 4, which have the receipts to check them against. Windows has no tracer, so the Windows lane stays full.
