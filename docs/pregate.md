# The pre-gate: generated files, cheap checks, issue links

`/ship` Step 5 opens with `gstack-pregate`: the free checks that catch what the
multi-agent wave kept paying remote gates to find (stale generated files, a
scratch script at the repo root, a nightly-only test still asserting an old
constant, a Windows-only change merged with its lane unrun, a `| tail`-hidden
failure). Plan: `docs/designs/MULTI_AGENT_WAVE_2026_10_10.md` C4, C6, C8.
Result codes: [docs/troubleshooting.md](troubleshooting.md#pre-gate-generated-file-registry-gstack-pregate-issue-links).

Three bins, all over `lib/`:

| Bin | Pin file (read from `origin/<base>`) | Does |
|---|---|---|
| `gstack-regen` | `.gstack/generated.json` | generated files regenerate, never hand-merge |
| `gstack-pregate` | `.gstack/pregate.json` | two-stage cheap gate, `pregate.json` record, publication check |
| `gstack-issue-links` | — | `Fixes #N` only on explicit closure intent; Related PRs and validated flake issues |

## Trust boundary

A pin file names commands. Its presence never authorizes execution: both tools
read the committed copy on `origin/<base>` (a PR cannot smuggle a command into
its own gate; `gstack-pregate run` alone also reads a user-owned file outside
the repository when the base has none, see [pregate v1](#pregate-v1)) and run commands only with `--allow-repo-commands`, which `/ship`
passes. Standalone, `gstack-regen check` lists the commands and exits 3
(`REPO_COMMANDS_NOT_ALLOWED`); `gstack-pregate` marks `regen` and `lanes`
`incomplete`, never `pass`. `--policy-from head` (a PR that introduces or
changes a pin file) is accepted only with `--allow-repo-commands` and the record
says `policy head (unreviewed)`. Under it the branch's `pregate.json` may only
add test lanes over the trusted policy (the base copy, or the user-owned file
when the base has none): a new `dependencies` glob with at least one test, or
more tests on a glob the trusted policy already maps. A removed or shrunk glob,
a new `[]` declaration, or any other key that differs (runner, guards, warn,
allowlist, timeouts, the remote gate, ...) refuses the run with
[`PREGATE_HEAD_POLICY_LOOSENS`](troubleshooting.md#pregate-head-policy-loosens).
A branch behind its base is measured from the copy at its merge base and runs
the base tip's policy plus its additions. With no trusted policy at all, the
head file is a bootstrap and runs as written. `.gstack/generated.json` is still
read from the branch under `--policy-from head`. So an allowlist entry or a
`[]` declaration a branch adds counts only once it is on the base, and a lane it
adds counts on the base policy only once it lands; `PREGATE_NO_LANE`'s fix line
says so when the branch edits the file
([troubleshooting](troubleshooting.md#pregate-no-lane-own-policy)).
<a id="accept-head-policy"></a>/ship's reruns on the final tree (`gstack-ship-release accept`, and `finish`
when it reruns the whole pregate on the stamped tree) choose the policy themselves
(GST-1595). When the branch's `pregate.json` differs from the copy it forked from
(the base tip's when the fork has none) in nothing but added test lanes, and
`.gstack/generated.json` matches the base tip's copy (a head-policy run loads the
regen registry from the branch, so a copy that main changed after the fork keeps
the base policy), they pass `--policy-from head` and print
`POLICY: head (unreviewed) .gstack/pregate.json: adds <n> test lane(s) over
origin/<base> and changes nothing else, so the gate is only stricter`. So a PR
that adds a runtime file and its own lane line passes `accept` without a
lanes-only PR first (gstack-evals #240). Any other difference (a removed or
shrunk lane, a `[]` declaration, `warn`, `timeout_s`, `ship_lanes_from`, any
other key, a changed `generated.json`, a file that does not parse) keeps the
base policy as before, with `POLICY: base origin/<base>:.gstack/pregate.json (the
branch's copy <what differs>, so it does not count here; land it on <base>
first)`. A branch that leaves the file alone prints no `POLICY:` line.
An unresolvable base exits 3 with
`POLICY_SOURCE_UNAVAILABLE`. Globs are repo-relative (no `..`, no absolute
paths, at most 64 per list); commands are one line under 512 bytes.

<a id="generated"></a>
## `.gstack/generated.json` (generated-v1)

```json
{ "$schema": "https://github.com/garrytan/gstack/docs/pregate.md#generated-v1",
  "entries": [ { "id": "skill-docs", "command": "bun run gen:skill-docs --host all",
                 "outputs": ["*/SKILL.md", "*/sections/*.md"], "inputs": ["*/SKILL.md.tmpl", "hosts/**"] } ] }
```

- `gstack-regen check` regenerates every entry (or `--only <id>`, or `--touched
  <paths>` for entries whose inputs or outputs intersect) in a scratch
  `git worktree` seeded from the working tree, with `node_modules` linked rather
  than copied, and reports stale outputs (`REGEN_STALE`, exit 1) without touching
  the tree. When outputs differ but `package.json` declares dependencies and
  `node_modules` is missing, the entry is `REGEN_DEPS_MISSING` (install, then
  rerun) instead of stale. An entry with no `command` is tracked only (goldens regenerated by
  another entry).
- `gstack-regen write` regenerates in place: what `gstack-restamp` and the
  Step 3 conflict rule use. On a conflict in a registered output, take either
  side, then `gstack-regen write`; the agent never hand-merges a generated file.
- `list`, `validate`, `init [--explain] [--force]`.

gstack's entries: `skill-docs` (every host render, the agents digest, llms.txt,
the doctor component table) and `ship-goldens` (`bun scripts/gen-ship-goldens.ts`,
the byte-pinned `/ship` renders in `test/fixtures/golden/`).

<a id="pregate-v1"></a>
## `.gstack/pregate.json` (pregate-v1)

| Key | Meaning |
|---|---|
| `runner` | the local test command with `{files}` (gstack: `bun test --timeout=30000 {files}`, the 30 s per-test timeout CI uses); set, the local lane gives it only the selected files its tool runs, judged by extension (JS/TS files for `bun test`, `node --test`, `deno test`, vitest, jest, mocha, ava or playwright; `.py` files for pytest; each matched as a whole word, so `npx vitest run` counts and `tests/node/run.sh` does not; every file for any other command, such as a `node scripts/run-tests.js` dispatcher, or one naming both), and the lanes detail names each file it cannot run as not run and not counted as covered, so a `*_test.py` never reaches a local `bun test` (no Python lane runs beside a declared runner; the remote gate and `test_backend` commands still receive the whole selection); unset, it is detected (bun, vitest or jest for JS/TS files, pytest when python3 can import it (else `pytest` or `python3` is named missing), `node --test`, and `flutter test`/`dart test` per Dart package root, through fvm when that package or an ancestor pins it with `.fvmrc` or `.fvm/fvm_config.json` and fvm is on PATH; `cargo test -p <name>` per Rust crate, run from the root of the workspace the crate is a member of (Cargo's `members` globs, `exclude` and `package.workspace`), else the crate directory; a JS/TS test whose nearest package.json is a nested package declaring vitest or jest (a dependency or its `test` script) runs from that package, with package-relative paths, through the package manager its `packageManager` field or the nearest lockfile up to the repo root names: `pnpm exec`, `yarn`, `bun x`, else `npx`; a JS/TS test file that imports `@playwright/test` at the start of a line runs as `playwright test --reporter=list` from its nearest package through that same package manager, whatever the unit runner is, a type-only import (`import type …`, or one whose every specifier is `type X`) does not count, file arguments are passed as escaped regexes anchored to the path (Playwright reads them as regexes), and a run where every test fails and Playwright says its browser is not installed is `PREGATE_ENVIRONMENT` (a partial install, where some tests pass, stays the diff's failure); every other test keeps the root detection, split by language when no one runner fits them all, so `.mjs` and `.py` root tests each get their own runner); nothing detected, a Dart SDK, cargo or package manager missing from PATH, a `.dart` file with no `pubspec.yaml` above it, a `.rs` file outside any crate, or one in a crate whose name Cargo would reject (anything but letters, digits, `_` and `-`), is `incomplete` (the runnable groups still run, so a real failure still fails) |
| `dependencies` | glob → test files for subprocess targets, runtime reads and generated inputs the import graph cannot see; `[]` declares "no lane needed" (docs, licences). A `[]` that matches a deleted test does not skip it: the deleted test still runs its owning suite, and a file naming it that `[]` covers (a durations list) counts as covered. With this key present, even empty, the policy [declares lanes](#lane-requirements) |
| `empty_lanes` | extra globs for the docs/no-tests empty lane. Any Markdown file already qualifies with no pin file when no test depends on it (the same import graph as other files: a quoted path, a `join()` of path segments, an import, or a `dependencies` entry). reStructuredText and AsciiDoc count as Markdown here. README, CHANGELOG, CONTRIBUTING, LICENSE, AGENTS and CLAUDE qualify even without `.md`, and so does licence text under any vendored name (`roboto-LICENSE.txt`, `LICENSE-MIT`, `licenses/*.txt`). Source code and files under a test directory never qualify. A test that reads the file still selects that test |
| `selection` | `workflow.yml/job` → a command printing the lane's file list, for matrices a planner computes (gstack: `scripts/test-free-shards.ts --list`) |
| `warn` | check ids downgraded to warn; `secrets` and required lanes never. `"lanes"` downgrades only a touched file with no lane: the selected tests still run, a red lane stays `fail` (`PREGATE_LANE_FAILED`) and an unfinished one `incomplete`; a green run is `warn` `PREGATE_NO_LANE` naming the unmapped files |
| `strays.allow` | intentional root files or new top-level directories |
| `local` | `workflow.yml/job` lanes a local run satisfies: a platform-agnostic toolchain (an `ubuntu-latest` suite that runs the same on a Mac), or a repo whose CI is off. Their tests run here instead of becoming `requires-remote`, except that on a machine under 8 cores with a `remote_gate` or a remote `test_backend` the small-machine rule still records the test tier as a `requires-remote` obligation. `--explain` notes an id that matches no workflow lane |
| `guards` | `[{ id, when: [globs], command, fix?, timeout_s? }]`: repo commands a lane must pass when a touched file matches `when` (manifest checks, subprocess goldens the import graph cannot see); see [guards](#guards) |
| `serial_patterns` | test-file globs the `lanes` check runs one process per file, apart from the unit files (default `**/*.serial.test.*`) |
| `sealed` | sealed or eval output that must never reach a public destination; read by the pre-push hook and `gstack-pregate sealed` (see [sealed output](#sealed)) |
| `price_file` | repo-relative path of the paid gate's call-plan data file (`GSTACK_EVAL_CALLS v1`); `gstack-eval-plan price-gate` prices from it and never executes anything ([docs/eval-calls.md](eval-calls.md)) |
| `stall_timeout_s` | seconds a test command may print nothing while using under a tenth of one CPU before its process group is killed and the check is `incomplete` (`PREGATE_STALLED`); default 300, `0` disables; `--stall-timeout` overrides; the `--remote` gate is exempt (see [supervision](#supervision)) |
| `timeout_s` | seconds each runner process may take (the unit-file group, each serial file, each guard without its own `timeout_s`, and the remote gate's deadline) when `--timeout` is not passed; 1 to 3600, default 600. `gstack-ship-preflight` forwards its own `--timeout`; without it, and in the `finish` fallback, this is how a repo with long lanes sets theirs |
| `remote_gate` | the repo's remote test gate command; under 8 cores the local test tier becomes a `requires-remote` obligation naming it, and `--remote` runs it (see [remote gate](#remote-gate)) |
| `run_profiles` | a map from each profile name to `{ workflow, events, jobs, artifact, max_age_hours?, os?, skippable? }`: the GitHub Actions runs `clear --run` verifies as evidence on the identical tree; a profile named after a lane (`free-tests.yml/macos-named-regressions`) clears that lane (see [run evidence](#run-evidence)). `--from-run` and the reuse job verify runs against them too ([from-run](#from-run), [CI reuse](#ci-reuse)) |
| `remote_gate_runs` | `{ profiles, inventory, skipped? }`: the run profiles that together clear `pregate.json/remote_gate`, the command that prints the remote gate's test files, one per line, which their runs must cover, and an optional command that prints which selected files the gate itself never runs (see [run evidence](#run-evidence)) |
| `ship_lanes_from` | maps each exact /ship lane command to `{ profiles, inventory }` or `{ profiles, jobs }`, with optional `aliases` (and, on an inventory entry, an optional `per_file` runner for files CI skipped entirely, see [skipped files](#skipped-files)): the run profiles whose verified runs at HEAD's clean tree carry that lane instead of running it, and either the command listing its test files, which their runs must cover, or the CI jobs that must have succeeded (see [CI carry](#ci-carry)); read from the base branch only |
| `allowlist` | `[{ finding, paths?, pattern?, reason }]`: benign findings the `secrets` check accepts and names as allowlisted, by gstack-redact finding id or non-secret category, path globs and a pattern anchored at the finding; never `env.value` (see [allowlist](#allowlist)) |

Only the `origin/<base>` copy or the user-owned file below is honoured, so a
downgrade is reviewed (or is the user's own) before it takes effect. A repo that
keeps `.gstack/` out of git (a shared repo where gstack is one contributor's
tool) can hold the same file at `<state root>/projects/<slug>/pregate.json`. The
state root is `GSTACK_STATE_ROOT`, else `GSTACK_HOME`, else `GSTACK_STATE_DIR`,
else a gstack plugin's data directory, else `~/.gstack` ([docs/state-root.md](state-root.md)); `<slug>` is what
`~/.claude/skills/gstack/bin/gstack-slug --get REPO_SLUG` prints in the repository
(`GSTACK_PROJECT_SLUG` overrides it; a `.gstack-project` marker does not). It is read only when the base carries none
(under `--policy-from head` it is the trusted policy the head file is compared with), it lives outside the repository so a PR still
cannot reach it, and the record names it (`policy user <path>`) and fingerprints
its bytes (`policy_digest`, and each check's `inputs.policy`); `verify` and the
ship receipt treat an edited or deleted user file, or one that appears (or a
link on its path that starts pointing nowhere) after a run under the defaults,
as `PREGATE_STALE`. A path that is relative, resolves inside the repository, or
reaches it through any symlink on the way (a state root linked into the
checkout, or a link hop inside it, even when the last hop points back outside)
is ignored, since a PR could commit it or choose the file; `--explain` says
so, or says `(absent)` when no file is there. The slug and state root come from
the caller's environment, never the checkout's `.env`: the bin's shebang passes
`--no-env-file`, and a bare `bun gstack-pregate` launched beside any `.env` file
refuses (`POLICY_SOURCE_UNAVAILABLE`). `verify` reads both paths from the
record, not from its own environment.
It covers `gstack-pregate run` only: `sealed`, `price_file`, `run_profiles` and
`remote_gate_runs` are read from the base branch's copy, so the user file refuses
them (`PREGATE_CONFIG_INVALID`; an empty `run_profiles` is accepted) rather than
holding a policy nothing reads. A user file that exists but cannot
be read, or a symlink on its path that points nowhere, refuses the same way
instead of falling back to defaults. A base copy git cannot read (and
`git ls-tree` cannot confirm is absent) refuses with `POLICY_SOURCE_UNAVAILABLE`
instead of handing the run to the user file.
`gstack-pregate validate` / `init` cover the working-tree file.

<a id="no-policy"></a>
**No policy yet.** A repository with no `.gstack/pregate.json` on the base
branch and no user-owned file runs under the defaults, and a touched file that
maps to no test is then a **warning**, not the hard `PREGATE_NO_LANE`: the
`lanes` row is `warn` with `PREGATE_NO_POLICY`, the selected tests still run
(a red lane is still `fail`, an unknown platform matrix is still a
`requires-remote` obligation), and the table prints a starter policy drafted
from the repository (`PREGATE_STARTER:` lines: the detected runner, the test
directories, the CI lanes, then the JSON between `begin` and `end`, with a
`dependencies` entry per unmapped touched file mapped to the tests nearest it
or sharing its stem, never `[]`, and a `TODO` line for each file nothing
covers). `run` writes nothing; `gstack-pregate init` is the explicit write.
Once any policy exists (committed on the base, or the user-owned file), an
unmapped file is `PREGATE_NO_LANE` again: the warning is for the first /ship
in a new repository (three Captains lost their first pass to it), never a way
to hide missing coverage. `--policy-from head` with a head policy is strict too.

<a id="lane-requirements"></a>
**Lane requirements.** "Any policy" above means a policy that declares lanes:
one with a `dependencies`, `empty_lanes`, `selection` or `local` key, even an
empty one (`gstack-pregate init` writes the first three). A policy with none of
them, such as
`{"timeout_s": 1800}` to give long tests more time, keeps the no-policy lane
verdicts: an unmapped file is the `warn` `PREGATE_NO_POLICY`, the selected
tests run, a red lane is `fail`, and the starter says the active policy
declares no lanes instead of claiming there is none. So raising
`timeout_s` never needs a `"**": []` catch-all. Add `dependencies` when you
want unmapped files to fail. The same rule applies to the user-owned file and to
a `--policy-from head` bootstrap (gbrain-evals #272, GST-775).

`gstack-pregate init` writes a draft built from the repo, not a fixed example.
It prints the languages it found and the runner each language's tests would
get, then maps every file the import graph cannot place to the tests of the
nearest directory above it that holds at most 25 of them, up to the
256-entry schema limit. The draft never
writes `[]`, which would clear a file without a test. A file with no nearby
test, and a lane whose matrix a planner computes, is printed as a `TODO`.
Review each entry before committing the file on the base branch.

## `.gstack/always-run.json`

`{ "tests": [globs] }` names whole-tree tests that scan every file of a kind (tripwires, ratchets, conformance and fixture inventories). A diff-selected run never maps a touched file to them, so they used to pass the selected gate and then fail CI (GST-98). When a branch selects any test, owes a lane, or edits this file, the `lanes` selection adds every tracked test file a glob matches. `--explain` prints each one as `<test> (always_run, .gstack/always-run.json)`, and a glob that matches no test as `<glob> matches no test file`. A docs-only branch adds nothing.

The globs are the union of the working tree's list and the merge base's list (GST-233), so a branch can add entries but never drop one main already has. A test only the merge base's list names prints as `<test> (always_run, merge base .gstack/always-run.json)`. `scripts/test-impact.ts` takes the same union with its `--base` ref and never reuses a result for those tests ([test-impact.md](test-impact.md)).

The list lives in its own file, not in `pregate.json`, because older pregate readers reject unknown keys there. A repository that ignores `.gstack/` (gstack does) tracks the file with `git add -f`, as it does `pregate.json`. A missing file means an empty list. A file that is not JSON, or whose `tests` is not a list of non-empty strings, stops the check with that message. gstack's own list matches 16 test files; the 13 with a seed in `scripts/free-test-durations.json` (recorded 2026-10-19) total about 13 s there, and `bun-entry-isolation`, `launch-env-echo-ratchet` and `review-packets-removed` have no seed yet.

## `gstack-pregate`

```
gstack-pregate [--stage preflight|tests|guards|all] [--only <check,..>] [--allow-repo-commands] [--policy-from base|head]
               [--timeout <s>] [--stall-timeout <s>] [--remote --spend-cap <usd>] [--run <id>] [--from-run <id|url>] [--no-ci-carry] [--explain] [--json]
gstack-pregate verify | clear --remote <workflow.yml/job> --run-url <url> | lanes | validate | init
```

Two stages with separate clocks, both printed:

**Stage 1, mechanical preflight** (the two-minute promise; gstack measured
~2.5 s for `regen` and under 200 ms for each of the others):

- `regen`: every registry entry whose inputs or outputs are touched is fresh
  (`gstack-regen check` in a scratch worktree). A fresh entry with touched
  outputs then runs once more with those outputs deleted; the ones the command
  recreates byte-identically are the check's `proven` paths, which
  `gstack-ship-receipt carry` reads. The verdict comes from the first run: an
  output the second run does not recreate, or a second run that fails, is
  simply not proven.
- `secrets`: `gstack-redact` over the branch's added lines (merge-base to the
  working tree, untracked files included). HIGH, or MEDIUM in the `secret`
  category, fails; other MEDIUM findings warn. Cannot be downgraded. A
  changed Python (`.py`, `.pyi`) or Dart file is scanned whole and only
  findings on its added lines count, so a line added inside an existing
  `"""` or `'''` string is still read as a literal; its rows give the file's
  line number (`app.py, line 10`). A tracked file's whole text is the version
  git diffed (a full-context `git diff`), never the working copy; an untracked
  file is read whole from disk. A file over the size limit, or whose full diff
  does not parse, is scanned on its added lines alone, without that context.
- `strays`: a new file at the repository root, a new top-level directory, or a
  scratch name (`zz-*`, `tmp*`, `scratch*`) or editor leftover (`*.orig`,
  `*.rej`, `*.swp`, `*.swo`, `*.bak`, `*.tmp`, `*~`, `.DS_Store`, `Thumbs.db`)
  anywhere.
- `literals`: for every changed exported constant or named timeout/retry
  literal (a named literal the branch only adds, such as `limit: 300` in a new
  object, is not a change), the whole test tree (nightly- and Heavy-only files included) is
  searched for the old value in files that name the constant or, when the old
  value is longer than one character, its module (the module's file name not
  followed by another extension, or a path ending
  in its stem followed by its own extension, for a JS/TS module also any JS/TS
  extension or `.d.ts`, a sentence-ending `.`, or anything but a word
  character, `.` or `-`; so a sibling `<stem>.txt`, `<stem>-v2.ts` or
  `<file>.snap`, or `<stem>.ts` beside a shell module, is not the module); a
  consumer the branch did not update fails with
  `file:line`. A version-history row, a line that starts a bracketed row with
  the old value (`[45, "<digest>"]`), is skipped when the same table (a run of
  consecutive lines starting with `[`) also holds a row for the new value that
  the branch added (the file at the merge base, read through a rename git
  detects, has no new-value row). A table the branch did not extend, a file that already held a
  new-value row at the merge base, a merge base that cannot be read, and every
  other line holding the old value still fail. Only the row itself is exempt:
  the old value after its closing bracket on the same line still fails. Rows in object form (`{ v: 45 }`) or spread over several
  lines are not recognized as history rows.
  A one-character old value (`2`) counts only in a statement that names the
  constant: on the name's line, or on up to three lines that continue it (the
  line before ends with `(`, `[`, `{`, `,`, `.`, `=` or another operator, or the
  line starts with `.`, `)`, `]`, `}` or an operator), never on a comment line, plus the history rows
  above. A `$2` in a shell stub, a comment, or `export default 2` in a fixture
  elsewhere in the file is not a consumer. A call-site name such as `attempts`
  or `limit` is an ordinary word, so for it the file must also name the changed
  module.
  A test that keeps the old value on purpose, such as the refused input after a
  minimum version goes up, marks that one line with a comment on it or on the
  comment line directly above it:
  `// pregate-literal: MIN_RUNTIME='1.4.0' refused input below the minimum`
  (`#` and `/*` comments work too). The marker waives only that line, and only
  when it names the changed constant and its old value and gives a reason (a
  reason cannot start with `*`, so a bare `*/`, `**/` or `* */` closer is not
  one); text inside a string is not a marker. Every other line in the file is still
  checked. The check lists each waived line as
  `waived: <file>:<line>: <NAME> <old> (<reason>)`, adding `marker added on
  this branch` when the merge-base file lacks the marker. The policy has no
  waiver key, so neither a base nor a pushed `pregate.json` can widen it.

- `policy-floor`: on a branch that changes `.gstack/ship-policy.json`, a
  `min_gstack_version` above the newest stable gstack release fails
  (`POLICY_FLOOR_ABOVE_STABLE`, naming the floor and the release), since every
  stable-channel lane would refuse that policy; when the release cannot be
  resolved (no release tag on gstack's origin, no local stable ref or tag) it
  warns (`STABLE_RELEASE_UNKNOWN`). The same rule as `gstack-ship-policy
  validate` ([ship-policy.md](ship-policy.md)).
- `timing`: added or changed test lines that compare an elapsed wall-clock or
  CPU time against a bound, or sleep and then assert, print
  `TIMING_ASSERTION: <file>:<line> <pattern>` and a
  `TIMING_ASSERTIONS: found=<n> escaped=<n> files=<n>` summary. It warns
  (`PREGATE_TIMING_ASSERTION`); it does not block. See [timing](#timing).

- `guards`: each guard in the active policy (`.gstack/pregate.json`, or the
  user-owned file) whose `when` globs match a
  touched file (renames included) runs its `command` in its own process, under
  the verified launch Bun, with its own `timeout_s` (default `--timeout`). A
  non-zero exit fails pregate naming the guard and its `fix`
  (`PREGATE_GUARD_FAILED`); a guard that could not start, or whose own binary
  is off PATH (exit 127), is the machine's, `PREGATE_ENVIRONMENT`
  (`incomplete`), not a guard failure; a timeout is `incomplete`; without
  `--allow-repo-commands` the selected guards are listed and the check is
  `incomplete`. Guards are read from the base branch's copy (or the
  user-owned file when the base carries none) and cannot be
  downgraded to warn. A guard whose exact command already passed at this tree
  is not run again ([guard carry](#guard-carry)). See [guards](#guards).

**Stage 2, test execution:**

- `lanes`: touched files map to tests through `lib/pregate/import-graph.ts`
  (static imports ∪ repo-path string literals ∪ the `bin/<name>` →
  `test/<name>*.test.ts` convention ∪ `dependencies`; Dart `import`/`export`/`part`
  directives resolve `package:<name>/x` through every tracked `pubspec.yaml`, and
  `*_test.dart` files under a `test/` directory are tests, except under `integration_test/` and
  `test_driver/`: they need a device, so pregate never runs them, and a touched
  one has no lane until you declare `"**/integration_test/**": []` (and
  `"**/test_driver/**": []`) under `dependencies` on the base branch and let CI run them
  (a `[]` only on the branch is refused under `--policy-from head`); Dart files, device tests
  included, are source code, so a `dependencies` `[]` declaration clears them and `empty_lanes`
  does not); in a Rust crate (the nearest Cargo.toml with a `[package]` name) a `.rs` file is a
  test when it sits under `<crate>/tests/`, holds a `#[cfg(test)]` (any cfg predicate naming
  `test`) or a test attribute (`#[test]`, `#[tokio::test]`), and every `.rs` file of the crate and its Cargo.toml select the crate's tests and
  those of every crate whose manifest depends on it, directly or through other crates (cargo
  runs a crate's tests, not a file, so the lane is the crate; a crate with no tests still has
  no lane, and a workspace-only Cargo.toml or Cargo.lock needs a `dependencies` entry),
  transitively through
  non-test files; deleted and renamed files select the tests that named them.
  A removed test (a deleted one, or a rename's old name) that no remaining
  test selects owes no lane, and prints `removed (no lane owed): <path> —
  <why>` (the `lanes` detail adds `N removed path(s)`), when it is a JS, TS,
  Python, Dart or bats test and no remaining file imports it (directly or
  through a directory it reads; otherwise `still imported by …`). It runs
  the tests of each remaining non-Markdown file that mentions its name
  without the final extension anywhere (`alpha.test`, `test_alpha`:
  a path with or without the extension, or a dotted module), such as a curation list (`files naming it run: …`), and fails closed when
  such a file has no test (`still named by …, which no test covers`). A test
  renamed to another test path then defers to its new name (`old name of
  <new>`). A deleted test, or one renamed to a non-test path, also runs its
  owning suite, the remaining tests that directly exercise the files its
  merge-base text exercised (`owning suite runs: …`; test helpers and
  fixtures are not subjects), and names each file left with no test at all
  (`coverage removed: <file> has no remaining test`, and `M subject(s) lost
  their last test` in the detail). Every other removal owes what an edit
  owes, as before: a deleted or renamed Go or Ruby test (it may define
  helpers its package still uses), a deleted test whose merge-base text
  cannot be read (a symlink, invalid UTF-8, over 1 MiB), and any removed
  non-test path, a renamed source file's old name included, are still
  `PREGATE_NO_LANE` until a test or a `dependencies` entry covers them. A
  modified file whose only test the branch deleted still has no lane, and a
  remaining test that reads a deleted file or directory is selected. /review
  lists a deleted test as a gate edit (RH-1) either way.
  An extensionless JS/TS import (relative, a tsconfig/jsconfig `paths` alias or
  `baseUrl`) tries the exact path, then `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`,
  `.cjs`, `.mts`, `.cts`, then `index.ts`, `index.tsx`, `index.js`, `index.jsx`
  and `index.mjs` inside the directory; the first file that exists wins.
  A touched source file with no lane is `FAIL lanes — <file> has no test lane`
  once a policy that [declares lanes](#lane-requirements) exists (the base copy,
  the user-owned file or `--policy-from head`); with no policy anywhere, or one
  that declares no lanes, it is the `warn` `PREGATE_NO_POLICY` with a starter
  printed ([no policy](#no-policy)); never a pass. Markdown that no
  test depends on is a docs/no-tests empty lane
  instead (`docs/no-tests: N documentation file(s)`), including when the base
  branch has no `.gstack/pregate.json`. The dependency is the same import graph
  as every other file, so a test that reads the Markdown (a fixture or a doc)
  still selects that test. `empty_lanes` adds globs for other documentation;
  it cannot clear a source file or a file under a test directory.
  Files no test runner loads take a second empty lane by the same rule
  (`no-tests (assets and tool config): …`): images, fonts, media and PDFs
  outside snapshot, golden and fixture directories, plus an allowlist of tool
  configuration (`.editorconfig`, `.gitignore`, `.pre-commit-config.yaml`,
  lint and format config, `.vscode/`, `.idea/`, `.impeccable/`, and GitHub
  issue templates, CODEOWNERS and dependabot config). Stylesheets (they import
  each other), any other dotfile (`.rspec`, `.husky/` hooks, `.env*`, version
  pins), CI workflows and actions, and `.gstack/` still need a lane.
  A release manifest the branch only re-stamped is waived as
  version-stamp-only (`version-stamp-only (no lane needed): …`): the file's
  diff against the merge base changes nothing but its version values. Three
  file kinds qualify, each by its own exact rule (lib/pregate/stamp-only.ts).
  A JSON file (`*.json`) whose two sides parse to objects of the same shape
  (the same own keys in the same order in every object, the same length in
  every array, the same type at every leaf), whose only differing leaf is the
  document's top-level `version` with a bare version on both sides (`1.2.3`,
  `v1.2.3.4`, `1.2.3-rc.1`; never a range), and whose text is line-for-line
  identical once that line has its old quoted version replaced by the new
  one. A plist whose differing lines are all `<string>` versions under
  `<key>CFBundleShortVersionString</key>` or `<key>CFBundleVersion</key>`. A
  `VERSION` or `VERSION.txt` file (any case) holding one bare version, with at
  most a trailing LF, on both sides. Texts are compared byte for byte outside
  the stamped value, so a line-ending change or a BOM is content. Nothing
  nested in JSON qualifies, so a dependency pin or range, a lockfile entry, a
  catalog or a package named `version` is never a stamp; nor is a changed
  description, a new, removed or reordered key, a floor such as
  `minHostVersion`, `schemaVersion` or `MinimumOSVersion`, a reflow, a change
  the parser would erase (a big integer, a duplicate key), a file that is not
  valid UTF-8 or is over 1 MiB, a mode change or a symlink on either side, an
  added, deleted or renamed manifest, or any other file kind: each keeps its
  `PREGATE_NO_LANE`. The rule runs only after the import graph, the
  declarations, the regen registry and both empty lanes found nothing, so a
  manifest a test reads still selects that test, and never under a test,
  fixture, golden, snapshot, `.gstack/` or CI-workflow tree, whose JSON a test
  may compare against by a path the graph cannot see.
  `--explain` prints the verdict per file (`version-stamp-only against
  <merge-base> (version 1.0.0 → 1.0.1)` or `not version-stamp-only
  (<reason>)`).
  In a Django project (a manage.py or code importing django, plus Python
  code, not a string or comment, that assigns `INSTALLED_APPS` or
  `ROOT_URLCONF`, or a config file names `DJANGO_SETTINGS_MODULE`), the files
  Django loads by name get `framework` edges: every Python test depends on
  each settings module; a dotted string in a settings module and an
  `include("app.urls")` argument count as imports; an app's migrations,
  `admin.py`, `templates/`, `static/`, `templatetags/`, `management/`,
  `fixtures/` and `locale/` files select that app's tests and the tests that
  reach its `models.py` (the settings module, so the suite, when the app has
  no tests of its own); a template under a project-level `templates/`
  directory selects the suite through the settings module.
  Lanes and platform tiers come from `.github/workflows/*.yml`
  (`gstack-pregate lanes` prints them; a test path a step names resolves against
  that step's `working-directory`, else the job's or workflow's
  `defaults.run.working-directory`): local ones run through the runner under
  `set -o pipefail`, judged on the runner's summary line (zero tests ran is a
  failure, a `| tail`-hidden exit is still an exit; cargo's `test result:` lines, one per
  test binary and doc-tests included, are summed); a platform lane this
  machine cannot run becomes a `requires-remote` obligation naming
  `workflow.yml/job`, unless `local` names that lane. `--explain` prints each test's provenance and every
  uncertain mapping (a planner-computed matrix without a `selection` manifest
  selects conservatively). Test files matching `serial_patterns` (default
  `**/*.serial.test.*`) run one process per file after the unit files. The
  runner and every guard run with the verified launch Bun first on PATH: the
  first of `$BUN_INSTALL/bin` and `~/.bun/bin` whose Bun satisfies gstack's and
  the project's `engines.bun` (the row prints `runtime: bun <v> from <dir>`),
  so a Capy host's older image Bun cannot flip the verdict.
- Every test-tier command (the lanes runner, each guard, the `--remote` gate)
  runs supervised: see [supervision](#supervision). `--timeout` (else the
  policy's `timeout_s`, else 600 s) bounds each runner process (the unit-file
  group, each serial file, each guard without its own `timeout_s`), not their total; the stall timeout catches a hung or
  silent one sooner.
- Under 8 cores, a `remote_gate` in the active policy or a remote `test_backend`
  (`gstack-config set test_backend ubicloud`) records the local test tier as a
  `requires-remote` obligation instead of running it: see [remote gate](#remote-gate).

Every check records the input identity it ran against (the working-tree
fingerprint before and after, the selection, the command hash); a tree that
moved during a check, a timeout or a missing tool is `incomplete`, never `pass`.
The record is `.gstack/tmp/pregate.json` (`gstack-artifact validate --as pregate`).

**Publication.** `gstack-ship-receipt write --pregate .gstack/tmp/pregate.json`
(Step 18) refuses unless the record is current for the tree being published
(`PREGATE_STALE`: rerun after the final stamp), green (`PREGATE_LANE_FAILED`,
`PREGATE_INCOMPLETE`, or `PREGATE_ENVIRONMENT` when every incomplete check is
the machine's) and every `requires-remote` obligation carries a receipt
(`PREGATE_REMOTE_UNCLEARED`: dispatch the job, wait for it to finish green, then
`gstack-pregate clear --remote <workflow.yml/job> --run-url <url>`). The ship
receipt then carries `pregate` and `requires_remote`. `gstack-pregate verify`
runs the same check standalone.

**By tree.** Every record `gstack-pregate` writes is also mirrored, byte for
byte, to `<state root>/pregate/by-tree/<tree>.json` (the state root from
docs/state-root.md). `gstack-ship-queue ready` reads the checkout's
`.gstack/tmp/pregate.json` first; when that file is missing or was recorded
for another tree, or is current but still waits on a remote receipt, it looks
the current tree up in the mirror and uses that record when it verifies,
printing `PREGATE: … (from the state root's pregate/by-tree/<tree12>.json,
recorded by another checkout)`. This is for the lane whose `gstack-pregate
--remote` had to run from a separate clone (a worktree cannot host it): the
clone's record clears the lane's own checkout as long as both hold the same
tree. Only a run that holds the tests stage stands in (what `--stage tests
--remote` writes, `checks=[lanes]`; a `--only timing` or preflight-only run
is "a run without the tests stage"), and it must be recorded against
`origin/<base>` and not under `--policy-from head`;
otherwise the `PREGATE:` line says why the mirror cannot stand in. A record
whose own checks failed or stayed incomplete is final and no mirror overrides
it. An explicit `--pregate <file>` that verifies is used as before; a mirror
for a different tree changes nothing. Writing the mirror is best effort (a
temp file renamed into place) and never fails the record itself.

Unknown flags exit 2 with usage on every verb (an agent told to run a flag this
gstack lacks never gets a green it did not ask for). Tier 2 checks still to come
(`ratchets`, `lint`, `links`, `hermetic`, `patches`, `integrator`) are named in
`--only`'s help.

<a id="supervision"></a>
## Supervision: progress, stalls, deadlines

GBRA-95 (gbrain, 4 cores): a core edit selected 3,683 local files, 358 of them
serial; the test stage printed nothing for 90 minutes: each runner process
ran up to its own `--timeout` (one per serial file) with its output buffered
until it returned, and nothing noticed a process that had gone quiet. Now each
test-tier command:

- runs in its own process group (`setsid`), with stdout and stderr appended to
  a log file, never a pipe, so a backgrounded grandchild that keeps the output
  open cannot hold the check; after the command exits, the group's leftover
  members are killed;
- reports live on stderr (stdout stays the table, or one JSON document with
  `--json`):
  ```
  PREGATE_TEST: <n>/<total> <file> start
  PREGATE_TEST: <n>/<total> <file> pass|fail <seconds>
  PREGATE_HEARTBEAT: <label> running <s>s; last file <file>; log <bytes> bytes, last growth <s>s ago (<log>)
  PREGATE: tests <verdict> in <s>s — lanes: <detail>
  ```
  Per-file lines come from a progress adapter where the runner's reporter
  provides them: `bun test` (its `<file>:` headers) is the only adapter today;
  a one-file run (each serial file) reports its file from the launch for any
  runner. Other runners (node --test, vitest, jest, pytest, playwright test, flutter test, dart test, cargo test) get heartbeats
  only. A heartbeat follows each 60 s with no progress line;
- is killed as **stalled** when its log does not grow and its process group
  stays under a tenth of one CPU for the stall timeout (`--stall-timeout <s>`, else
  `stall_timeout_s`, else 300; `0` disables): the check is `incomplete` with
  `PREGATE_STALLED` and names the last file started; the next serial file
  still runs. The group counts as busy when its CPU time, sampled each second,
  grew by at least a tenth of the wall time, so a quiet suite that is working
  (FOUN-63: a parallel `check.sh` silent for 9 minutes) is not killed, while
  a hang that waits on nothing is. A hang that keeps burning CPU is left to
  the timeout. Linux reads `/proc` (exited children's time included once
  reaped); macOS and other BSDs read `ps -S`; a failed read skips that
  sample. Windows reads no CPU time here and uses log growth alone. The `--remote` gate is exempt: a
  gate that waits on CI is quiet by design, so only its timeout bounds it, and
  its heartbeats add `; last output: <the gate's last line>`;
- is killed as **timed out** when that runner process reaches its timeout
  (`--timeout <s>`, else `timeout_s`, else 600; per runner process, so many
  serial files that each fit still pass): the check is `incomplete`, its detail
  names which of the three set the timeout, and the next serial file still runs.

A kill is SIGTERM to the group, then SIGKILL after 5 s (a group that ignores
SIGTERM still dies). SIGINT or SIGTERM to `gstack-pregate` itself SIGKILLs every
running group, writes no `pregate.json` and exits 130 or 143. Windows has no
process groups here: the kill is `taskkill /T /F` on the shell's tree, which
misses a descendant that was reparented or started detached.

<a id="remote-gate"></a>
## Small machines and the remote gate

Under 8 cores (`os.availableParallelism()`), when the active policy (the
base branch's `.gstack/pregate.json`, or the user-owned file) declares `remote_gate` or `gstack-config get
test_backend` is not `local`, the lanes check runs nothing locally: it records
the selected local files as a `requires-remote` obligation with the command to
run, `pregate.json/remote_gate` (the declared command) or
`test_backend/<backend>` (gstack's `scripts/ubicloud/ubi-runner.sh run --src
<repo> -- '<runner> <files>'`). Without either, the tier runs locally under
the supervision above. Close the obligation one of four ways:

- by default, when the base declares `remote_gate_runs`, let CI clear it: the
  tests stage clears it on its own from a verified run at this exact tree
  ([CI carry](#ci-carry)), and the uncleared obligation's detail names that
  route first (`push, then gstack-ci-carry wait --base <base> and rerun
  gstack-pregate --allow-repo-commands`, the whole pregate, so the record keeps
  its preflight checks) and the VM only as the opt-in (under `--no-ci-carry` it
  names the VM route); or
- after running it, `gstack-pregate clear --remote pregate.json/remote_gate
  --receipt <file>` with the gate's output, validated as `--remote` validates it
  (a run URL is refused, `PREGATE_RECEIPT_INVALID` for a bad receipt; a receipt
  for a tree that differs from this one only by the repo's stamp rule is
  accepted and recorded, see [below](#remote-gate-stamp-only)), or
  `gstack-pregate clear --remote test_backend/<backend> --run-url <url>`, which
  has no machine-checkable receipt and is recorded as `attested:<url>`; or
- when CI already ran the full suite on this tree, `gstack-pregate clear --remote
  pregate.json/remote_gate --run <id|url> [--run …] --allow-repo-commands`, one
  verified GitHub Actions run per `remote_gate_runs` profile (see
  [run evidence](#run-evidence)); or
- `gstack-pregate --stage tests --remote --spend-cap <usd> --allow-repo-commands`,
  which runs the declared `remote_gate` now (under `--policy-from head`, still the trusted copy's gate;
  a `test_backend` without `remote_gate` cannot be run this way). The gate runs
  in the repository root with `PREGATE_TREE` (the working-tree fingerprint
  being tested), `PREGATE_FILES_FILE` (the selected files, one per line),
  `PREGATE_SPEND_CAP_USD` and `PREGATE_TIMEOUT_S` (this run's per-process
  timeout in whole seconds), and must print
  `PREGATE_REMOTE: tree=<tree> tests=<n> failed=<n> [spent=<usd>]`, reporting the
  tree it actually tested. The obligation clears only when that tree is
  `PREGATE_TREE`, `tests` > 0, `failed` = 0 and the gate exits 0; anything else
  leaves it uncleared and the check `incomplete`. The gate runs until it exits
  or reaches the timeout (`--timeout`, else `timeout_s`, else 600 s); the stall
  timer does not apply, and each 60 s heartbeat names the gate's last output
  line, so a gate that prints what it is waiting on (a CI run id and its
  status) shows it. The cap defaults to
  `$GSTACK_SPEND_CAP_USD`; there is no default spend. Spend prints as
  `spent, reserved, unknown`: a gate that prints no `spent=` is `unknown`,
  counted at the cap.

<a id="remote-gate-stamp-only"></a>
### A receipt from a stamp-only predecessor tree (gate ahead of the stamp)

The receipt `clear --receipt` validates names the tree the gate tested, and
pregate.json names the tree being published. A repo whose full gate runs before
its turn in the queue ("gate ahead": the gate tests commit G, then /ship's
restamp moves the version files, so the head H it publishes is G plus the
stamp) could never clear the obligation with that run, and paid a second full
gate on H for a diff that was nothing but stamps. `clear` now accepts that
receipt for H when the two trees differ only as a stamp does:

- gstack diffs the gated tree against pregate.json's tree
  (`git diff --unified=0 <gated> <head>`, both trees as objects in this
  repository: the gated commit's tree once it is fetched, and the head tree
  `bin/gstack-wtree` wrote) and classifies every differing file with the tree
  receipt's own rule, `lib/tree-receipt.ts` under `.gstack/ship-policy.json` on
  `origin/<base>` ([ship-policy](ship-policy.md#tree-receipt)). That is the rule
  `gstack-tree-receipt`, `gstack-pregate regate` and the train's
  `verify --train` apply: with `stamp_files` set only those files can be
  stamps, each hunk in them must be the exact old → new rewrite under
  `stamp_patterns` (literal `{version}` templates) or the built-in forms
  (`(was X)`, `since: X`, `vX`), and the version file, `package.json`'s
  `version`, a lockfile's root version keys and a CHANGELOG re-heading (under
  `changelog_fragments`, also the fold of the fragments the head deletes) have
  their own built-in rules. There is no second list and no looser rule here:
  the file verdicts `clear` reaches on a pair are the verdicts
  `gstack-tree-receipt --gated G --current H` reaches, and its gate rule holds
  too: a policy whose `stamp_sensitive_gates` names the test lane (`tests`, as
  gstack's own does because its tests read VERSION and the agents digest) is
  refused outright, since the tree receipt never marks such a lane reusable.
  The policy is the one on this repository's base branch (`origin/HEAD`, as
  `regate` reads it) at its current tip, never a branch pregate.json names: a
  pregate.json recorded against another base is refused. What the receipt does
  not compare, exactly as a same-tree receipt does not, is the gate's execution
  identity (Bun, OS, lockfiles); that stays the evidence bundle's job.
- Accepted, the obligation's receipt reads `remote-gate tree=<gated>
  tests=<n> accepted-for=<head> stamp-only=<file count> receipt=<file>
  sha256=<digest>`, and pregate.json records the substitution beside it:
  `substitution: { gated_tree, accepted_for, policy, files: [{ path, rule }] }`,
  the policy label (`origin/<base>@<sha>:.gstack/ship-policy.json`) and every
  differing path with the rule that classed it (`version-file`,
  `version-manifest`, `manifest-version`, `lockfile-root-version`,
  `changelog-heading`, `changelog-fragments` for the CHANGELOG under the fold,
  `changelog_fragments` for a folded fragment's deletion, `stamp_files`,
  `stamp_paths`, `release_outputs`). `clear` prints the same
  as `PREGATE_RECEIPT_SUBSTITUTED: …`, `verify` repeats it on its ok line, and
  the ship receipt carries the receipt string. The receipt's own tests and
  failed checks apply as before (its exit status is checked only when
  `--remote` runs the gate itself), and `verify` refuses a recorded
  substitution whose `gated_tree` is not the receipt string's `tree=`.
- Refused, with `PREGATE_RECEIPT_INVALID` and a fix naming the offending
  path: any differing path outside the rule (`lib/x.ts (stamp_files: not in the
  repo's stamp_files allowlist, line 1)`), a stamp path whose hunk is not the
  stamp rewrite (`plugin.json (stamp_files: "…description…" -> "…", line 4)`),
  a gated tree that is not a 40- or 64-hex object id or not an object here
  (fetch the gated commit first), a base branch whose policy cannot be read
  or is invalid, a pregate.json recorded with `--base` against another branch
  than this repository's base (`origin/HEAD`), a policy whose
  `stamp_sensitive_gates` names the test lane (`tests` or `remote_gate`;
  gstack's own policy does, so gstack itself never substitutes), or a patch
  that does not account for every path `git diff-tree` lists between the two
  trees. The version rule is the tree
  receipt's: a `stamp_files`, `stamp_paths` or `release_outputs` hunk is a stamp
  only as the rewrite to the head's version from the gated tree's version, or
  from a newer tentative version of the repo's width that the stamp moved (a
  `*_KEY_VERSION` written as the next minor, #3512) (so two trees
  at the same version refuse such a hunk as `other`), while the built-in
  version-file, manifest, lockfile and CHANGELOG rules compare content and do
  not check the direction of the version move. The obligation stays uncleared; rerun
  the gate on the head, or make the extra change a stamp under the repo's
  rule.

A consuming repo declares its stamp paths once, in `.gstack/ship-policy.json`
on its base branch (`stamp_files`, `stamp_patterns`, `changelog`), the same
file the tree receipt and restamp already read; nothing is declared in
`.gstack/pregate.json` for this. gbrain's is in
[gbrain worked configs](#gbrain-worked-configs).

The gate must have run on a clean, committed checkout: `PREGATE_TREE` is the
`bin/gstack-wtree` fingerprint, which equals the commit's tree only when nothing
was uncommitted or untracked there, and `clear` can compare only trees that are
objects in this repository. A receipt whose tree is not here is refused, never
guessed. The sequence that reuses a gate-ahead run, on a machine under 8 cores:

```bash
git fetch origin <gated sha>                      # the gated commit's tree must be here
gstack-pregate --allow-repo-commands              # on the stamped head: records pregate.json/remote_gate uncleared
gstack-pregate clear --remote pregate.json/remote_gate --receipt <the gate's output for the gated tree>
gstack-pregate verify                             # PREGATE_VERIFY: ok …; pregate.json/remote_gate: gated tree … accepted for tree …
```

gstack's own example: `.gstack/pregate.json` declares
`"remote_gate": "bash scripts/ubicloud/pregate-remote.sh"`. With
`UBICLOUD_API_KEY` and `UBI_OWNER` set the script runs the selected files on one Ubicloud VM
with `bun run test:ubicloud`'s environment, refuses before creating the VM when
the cap cannot buy a 20-minute run at the size's list price (`UBI_SIZE`,
default `standard-16`), checks the tree and the planned file set on the VM
before any test runs, and reports `spent=` from billed minutes. Without a key
it runs the same files locally in parallel shards
(`test-free-shards.ts --files-from`) and reports `spent=0`, after a
`backend=local (N cores; not the CI environment)` line. Paid test files in the
selection (skill-e2e and the other paid globs in `test/helpers/paid-test-set.ts`)
are named and left to the paid PR gate; a selection of only paid files reports
`tests=0`, which never clears the obligation. The command is the same either way
(`--remote` always needs a cap; the keyless path spends nothing).

pregate kills the gate at its `--timeout` (default the policy's `timeout_s`, else
600 s) with a 5 s grace, so the script finishes before that deadline: it reads the
deadline from `PREGATE_TIMEOUT_S`, which pregate sets to that same timeout, else from
the `gstack-pregate` command it runs under (its `--timeout`, else 600), reserves 120 s for teardown plus 15 s margin, and tells
the VM to stop at whichever comes first, that point or the cap's wall (at most
45 minutes, minus 3 for teardown). A deadline that leaves the VM under 300 s
refuses before any VM (`PREGATE_REMOTE_TIMEOUT_TOO_SHORT`). At create time it
prints the VM's name and the exact
`bash scripts/ubicloud/ubi-runner.sh down <name>` line to destroy it.

A run killed before its teardown line leaves its VM running. A machine restart
kills a background pregate this way. Don't destroy the VM first: rerun the same
`gstack-pregate` command before anything it depends on changes. The run key
covers the tree, the planned file set, the commit `origin/HEAD` points at (a
`git fetch` that moves it counts), `UBI_LOCATION`, the size, the environment,
and the runner script and setup it uploads. When the rerun prints `reattaching to VM <name>` with
the name from the create line, it finishes the run on that VM and bills from
the VM's original create. When it creates a new VM instead (the key changed,
or the restart came before the runner recorded the VM), destroy the old one
with the `down` line from its create line. Use the same line when you give up
on the run. A reattach whose billed minutes leave the cap no room
refuses (`PREGATE_REMOTE_CAP_SPENT`) and prints both choices: destroy the VM,
or rerun with a higher `--spend-cap`. The whole script is parsed before it
runs, so editing it during a run changes nothing. `--timeout 2700` gives a
whole-tier run room inside the 45-minute wall:

```bash
gstack-pregate --stage tests --remote --spend-cap 2 --timeout 2700 --allow-repo-commands
```

Measured (October 2026): keyed, all 1,280 free files on standard-16 took 404 s
from start to teardown (create 24 s, setup 72 s, tests 250 s) for $0.06.
Keyless on 4 cores, 98 files took 103 s, and GSTA-35's 798-file selection took
3,550 s, so keyless is practical for small selections only. A large selection
on a small machine needs a key, or a `--timeout` longer than the run. Keyless also runs in
your environment, not CI's: a file that needs what setup-free-suite.sh installs
(Playwright's Chromium, Xvfb) fails locally until you install it.

Every refusal line starts with a reason code:

| code | exit | meaning |
|---|---|---|
| `PREGATE_REMOTE_USAGE` | 2 | an input is missing or malformed; run it through `gstack-pregate --stage tests --remote` |
| `PREGATE_REMOTE_TREE_MISMATCH` | 3 | the working tree is not `PREGATE_TREE`; nothing uploaded, nothing spent |
| `PREGATE_REMOTE_TREE_MOVED` | 3 | the tree changed during the run (the moved paths are listed); no result reported |
| `PREGATE_REMOTE_VM_TREE` | 3 | the VM's unpacked tree or planned file set differs from what was checked locally |
| `PREGATE_REMOTE_NO_RESULT` | 1 | test-free-shards printed no result (a rejected file list) |
| `PREGATE_REMOTE_PAID_ONLY` | 0 | every selected file is a paid test file; `tests=0` cannot clear |
| `PREGATE_REMOTE_CAP_TOO_LOW` | 5 | the cap cannot buy a 20-minute run at the size's price; nothing created |
| `PREGATE_REMOTE_NO_PRICE` | 5 | `UBI_SIZE` has no list price in the script |
| `PREGATE_REMOTE_TIMEOUT_TOO_SHORT` | 5 | pregate's deadline leaves the VM under 300 s after the 135 s teardown reserve; nothing created |
| `PREGATE_REMOTE_OWNER_REQUIRED` | 2 | `UBI_OWNER` is unset; nothing created (every VM must name its owner) |
| `PREGATE_REMOTE_INFRA` | 4 | create, setup, SSH or the stop deadline failed, or the runner's `UBICLOUD: left=` line is not `0`; the VM, its teardown line and `spent=` follow |
| `PREGATE_REMOTE_INTERRUPTED` | 130 | TERM or INT; ubi-runner tears the VM down on its own |

<a id="run-evidence"></a>
## Run evidence: one full suite per tree (`clear --run`)

A repository that runs its full suite in CI and again as its remote gate on the
same tree paid twice for one result (gbrain: a 30–45 min Ubicloud gate, then an
18–20 min full-ci dispatch, every serial slot). `clear --run` lets a passed
GitHub Actions run stand in for the gate, on the runner's own record and never
on prose: a pasted URL is only a pointer the verifier resolves.

**Declare it on the base branch.** In `.gstack/pregate.json`:

```json
{
  "run_profiles": {
    "test": { "workflow": "test.yml", "events": ["workflow_dispatch", "push"], "jobs": ["full-suite"], "artifact": "full-suite-tree" },
    "e2e":  { "workflow": "e2e.yml",  "events": ["workflow_dispatch", "push"], "jobs": ["e2e-full-suite"], "artifact": "e2e-full-suite-tree" }
  },
  "remote_gate_runs": { "profiles": ["test", "e2e"], "inventory": "bash scripts/pregate-remote-gate.sh --list" }
}
```

Profiles are read only from `origin/<base>`, so a pull request can tighten
them but never relax them. That covers the profile, not the suite it names: the
workflow file a run executed and the inventory command are the branch's own, as
the remote gate's script already is, so a diff to either is reviewed like any
other gate change. Each profile names the workflow file, the events it
accepts, every job that must have passed (each exactly once), and the artifact
holding the run's `tree.json`. `max_age_hours` (1–168, default 24) bounds how
old the run may be, and `os` (`Linux`, `macOS`, `Windows`) requires
`tree.json` to record that runner OS. <a id="skippable"></a>`skippable`
(`{ jobs, gate, scripts }`, GST-1190) lets named jobs be skipped by a path
filter: a skipped job counts only in a `pull_request` run (whose gate diffs
against the pull request's base; a push or dispatch gate diffs against the last
push, which the branch's push history controls), when the `gate` job (the one
whose output decides the skip) succeeded in the same attempt, and the workflow
file plus the gate's inputs are byte-identical to `origin/<base>`. Those inputs
are the declared `scripts`, which must list every repo file the gate reads,
plus every path the gate job's steps name in the base copy of the workflow
(also read under the job's `working-directory` and after a `${{ … }}`
prefix), plus `package.json` when the gate runs a package script. gstack
cannot see what a gate script imports or what a package script runs, so list
those files in `scripts`. Otherwise the pull request controlled the skip
decision, so the job refuses as `job_skipped` and the lane runs here. A lane
whose every named job was skipped this way prints `LANE: <label> not owed: CI
skipped at this tree (gate job <name>, workflow unchanged) run=…`. Each workflow uploads `tree.json` from
its own job: `run_id`, `run_attempt`, `event`, `sha` (or `head_sha`),
`tree` (`git rev-parse HEAD^{tree}` as tested), `files` (every test file the
run executed), `tests` (the count) and, with `os`, the runner OS or a list of
every OS the run's test jobs ran on (the profile's `os` must be one of them).

**What `clear --run` checks** (`lib/run-evidence.ts`), for every run, online,
once:

- The run belongs to this repository and ran for a same-repository head. Its
  workflow file is the profile's, its event is one the profile lists (`push`,
  `workflow_dispatch` or `pull_request`), and it completed with success. A
  `pull_request` run tested GitHub's merge commit, not its head, so its
  `tree.json` must name the head (`head_sha`) and the merge commit (`sha`), and
  the tree git computes for that merge commit must equal the head's tree: the
  head already contained its base, so the merge tested exactly the head tree
  (`tree_mismatch` otherwise). The API answers with
  the newest attempt, so an earlier green attempt under a newer red one is
  refused, and the run is read again after the evidence is collected: a new
  attempt meanwhile is `run_changed`.
- Every job the profile names appears exactly once in that attempt and
  succeeded. Jobs and runs are read across every page.
- `tree.json` (an artifact of at most 8 MiB) names this run, attempt, event and
  head (`sha` and `head_sha`, each checked when present). It is not a reuse
  record (a reuse is never evidence). Its tree equals the tree git computes for
  the run's head commit. `files` is a list of paths and `tests` a
  non-negative integer when present; without `tests` the file count stands in.
  <a id="skipped-files"></a>`skipped_files`, when present, lists the files whose every test skipped on
  the runner (a Docker image, a drive path or an installed gstack it lacks;
  GST-1190). A carry treats them as uncovered: the pregate tests stage runs
  them here. A /ship lane or guard whose inventory names one carries the
  covered files and runs only the skipped ones here, through the runner its
  `ship_lanes_from` entry declares as `per_file` (a command with `{files}`,
  such as `"per_file": "bun --no-env-file test --timeout=30000 {files}"`, the
  same form as the tests stage's `runner`). It runs one file at a time, each path
  anchored with `./` because Bun reads a bare relative path as a substring
  filter. Those runs are recorded under `<label>.skipped`, the `LANE:` line adds
  `skipped_here=<n> file(s) tests_ran_here=<n>`, and the CI row is written only
  after four checks pass. In order, they are each file's exit
  (`skipped_failed`), each file's test count above zero (`skipped_zero_run`),
  every carried run again (`run_changed`), and the working tree once more
  (`tree_changed`, for an edit made during those checks). An edit made while the
  remainder itself runs leaves its ledger row without a tree, so it shows as
  `skipped_zero_run`. One exception to the count check (GST-1314): a file whose
  Bun summary registered tests and skipped every one of them here too, the way
  an env-gated or tool-gated file skips by design, is not owed. The CI row lists
  it under `skipped_here.not_owed` and the `LANE:` line adds
  `not_owed_here=<n>`. A file that registers no test here still refuses, and so
  does a file whose log hit the 2 MB cap, since a cut log's last summary may not
  be the run's. Any of these refusals runs the whole lane here. An entry with no `per_file` refuses as
  `inventory_skipped`, naming the files, and the lane runs here whole. A partly
  skipped file ran tests and stays covered. gstack's own Free Tests writer
  (`scripts/ci-tree-reuse.ts record`) emits the list from complete per-file
  counts, and gstack's `bun run test` lane declares `per_file`. A `tree.json`
  without the key (older writers, other repos) is read as before, with every
  listed file counted as run; add the list to your writer to close that gap.
  The remote gate's clearance does not use it: that gate runs on a Linux runner
  like CI, where the same files skip.
- No run of the same workflow on that head, or on pregate.json's own head,
  whose newest attempt started at or after the second this run was created
  failed, was cancelled or is still running (`run_started_at`, so a red re-run
  of an older run counts, a run started in the same second counts, and
  re-running this run does not hide a failure in between).
- The run finished within `max_age_hours` (its jobs' latest `completed_at`,
  else the run's `updated_at`), and on the profile's OS when it names one.
  Re-running only the failed jobs refuses (`artifact_mismatch`) unless the job
  that uploads `tree.json` re-runs too, because that file must name the
  newest attempt. The 8 MiB cap is read from the artifact's zipped size before
  download, so a workflow on the branch itself can still unpack a larger file
  into the temporary directory.

Then, for the lane:

- pregate.json was recorded against this repository's base, whose profiles
  apply (`base_mismatch` otherwise).
- Each profile gets its own run (a run id given twice is a usage error), and
  every run verifies under its profile. The assignment is searched, so a run
  valid for two profiles cannot starve the other. A lane with a profile needs
  one run; `pregate.json/remote_gate` needs one per `remote_gate_runs`
  profile.
- All runs tested one tree: pregate.json's tree, or a stamp-only predecessor of
  it under exactly the rule [above](#remote-gate-stamp-only) (a policy whose
  `stamp_sensitive_gates` names `tests` refuses that substitution).
- Every run executed something (`no_tests` names one that did not), and the
  runs' `files` together cover the obligation's selected test files, plus, for
  the remote gate, every file the `inventory` command prints. The inventory is
  a pin-file command, so it runs only with `--allow-repo-commands`, and only
  while the working tree is pregate.json's tree (checked before and after it
  runs); an empty or failing inventory refuses, and it runs under `pipefail`,
  so a pipeline whose first command fails refuses too.
- When `remote_gate_runs` declares `skipped`, that command runs the same way,
  with `PREGATE_FILES_FILE` naming a file of the obligation's selected test
  files, one per line, and prints the ones the remote gate itself never runs
  (gstack's gate leaves paid test files to the paid PR gate). Those files need
  no run, and the receipt counts them as `skipped=<n>`. A file the inventory
  prints stays required even when `skipped` names it, and a failing `skipped`
  command refuses (`skipped_failed`). When `skipped` names every selected file,
  no selected test ran, so the clear refuses (`paid_only`), just as the gate's
  own `tests=0` report never clears. Without `skipped`, every selected file
  must appear in a run's `files`.
- Every run is read once more after the inventory: a run that moved to a new
  attempt or stopped being a success meanwhile refuses (`run_changed`).

Any API or git error refuses. Each refusal prints `REUSE: refused
reason=<code> — …` as `PREGATE_RECEIPT_INVALID`, and a run that fails
verification is named with its own reason (`fork_run`, `event_mismatch`,
`run_not_success`, `job_missing`, `job_skipped`, `artifact_mismatch`, `artifact_reused`,
`tree_mismatch`, `newer_run_vetoes`, `run_changed`, `run_stale`,
`os_mismatch`, `api_error`, …); the clear-level codes are `base_mismatch`,
`no_verified_run`, `tree_mismatch` (runs on different trees),
`tree_not_stamp_only`, `no_tests`, `inventory_failed`, `inventory_empty`,
`skipped_failed`, `paid_only`, `inventory_uncovered` (the remote gate) and `tests_uncovered` (a lane's own
selected tests). A wrong run count, a repeated run or a lane with no
profile is a usage error (exit 2), not a REUSE refusal.

Accepted, `clear` prints `REUSE: accepted <lane> <receipt>`, and the receipt
reads `remote-gate tree=<t12> tests=<n> runs=<id>/<attempt>,… profiles=<p>,…
heads=<h12> verified=<time>` (with `skipped=<n>` after `tests=` when the
`skipped` command excused selected files, and `accepted-for=` and the substitution for a
stamp-only predecessor). A lane with its own profile gets `run tree=… runs=…`
the same way; for such a lane `--run-url` is verified as `--run` is, and
`--bundle-lane` is refused. A lane with no profile still clears by
`--run-url`, with run checks (GSTA-203): when the base config and the GitHub
origin can be read, `clear` reads the run once and refuses
`PREGATE_RECEIPT_INVALID` unless it is a run of this repository whose
workflow file is the lane's own `<workflow.yml>`. A run of another workflow
refuses with `REUSE: refused reason=workflow_mismatch — run <id> attempt <n>
ran .github/workflows/<other>.yml, not .github/workflows/<lane's>.yml`; a
run gh cannot read refuses with `api_error`, and a URL that is not an Actions
run URL or id on this repository with `run_ref_invalid`. A reusable-workflow
lane (one whose file another workflow calls through `workflow_call`) also clears from a run
of a caller: a workflow in the branch's own `.github/workflows/` with a job
that says `uses: ./.github/workflows/<lane's>.yml` (GST-971), read at
pregate.json's recorded tree, as long as the lane's own job succeeded in the
run under that calling job (`<calling job> / <lane job>`); else it refuses
with `caller_job_skipped`. Fix lines only suggest `gh workflow run` for
a file with a `workflow_dispatch` trigger.
The run must also
have finished green (GSTA-203 PR 8): a run that is still queued or running
refuses with `run_in_progress`, and one that concluded anything but `success`
(`failure`, `cancelled`, `timed_out`, …) with `run_not_success`; each fix line
says to rerun the workflow and clear with the green run. The check reads the
run's newest attempt, so a `/job/<id>` or `/attempts/<n>` link is judged by
the whole run, not that job or attempt, and the lane records
`https://github.com/<repo>/actions/runs/<id>/attempts/<n>` for the attempt it
judged rather than the link you passed. The job (apart from a caller run's
`<calling job> / <lane job>` above), tree and age are not
checked there; that is what a run profile adds. `test_backend/<backend>` lanes and `--bundle-lane` are
unchanged. When the base config or the GitHub origin cannot be read, `--run`
fails, and so do `--run-url` and `--bundle-lane` unless the base was read and
shows the lane has no profile; then the lane is recorded as before, with a
warning naming the cause. `gstack-ship-queue ready --dispatch-ci` still
records its dispatched runs by URL; routing it through the verifier is a
follow-up (GST-555), so a repository that declares lane profiles clears those
lanes with `gstack-pregate clear --run`.

**gstack's own profiles.** gstack's `.gstack/pregate.json` declares two, and
names neither after a lane: `ci-reuse/free-tests` (the complete Free Tests run:
every non-matrix job and the `free-tests` aggregate, `os` Linux) and
`ci-reuse/windows-free-tests` (`windows-plan` and the `windows-free-tests`
aggregate, `os` Windows). Each accepts `pull_request` and `workflow_dispatch`
runs and reads the `tested-tree` artifact, which both aggregates upload only
after their strict verification passes. The main-push reuse job and
`--from-run` read them, and `remote_gate_runs` names `ci-reuse/free-tests`,
so a green Free Tests run at pregate.json's tree clears
`pregate.json/remote_gate` without a Ubicloud VM:

```bash
gstack-pregate clear --remote pregate.json/remote_gate --run <free-tests run id or url> --allow-repo-commands
```

Its `inventory` is `scripts/test-free-shards.ts --list` (the complete free
suite, the same set the Free Tests plan shards), and its `skipped` command
prints the selected files `test/helpers/paid-test-set.ts` marks paid, the
same split `scripts/ubicloud/pregate-remote.sh` makes before it runs. A
`pull_request` run counts only when the branch already contains its base
(the merge commit's tree is the head's), so a branch behind main still needs
the gate or a fresh run. No lane has a profile, so every macOS and Windows lane
still clears by `--run-url`, checked for its workflow file and a green
conclusion. On main the free tier's Windows smoke lane is
`windows-smoke.yml/windows-smoke`, and a `windows-smoke.yml` run clears it.
Two narrower Windows lanes are owed only when a branch selects their own test
files: `free-tests.yml/cso-windows-launcher` (cleared by a `free-tests.yml`
run) and `windows-setup-e2e.yml/windows-setup` (cleared by a
`windows-setup-e2e.yml` run). The six-shard
`windows-free-tests.yml/windows-free-shard` job is `manual`, so it is never an
obligation. A branch cut before
`windows-smoke.yml` landed still owes `windows-free-tests.yml/windows-free-shard`
from its own workflows, and only a `windows-free-tests.yml` run clears that. A
pull request cut before these
workflows uploaded `tested-tree` has no record a lane profile could verify, so
lane profiles wait until open pull requests carry the producer (GST-555).

**`verify` stays offline.** The check ran at `clear`. `gstack-pregate verify`,
and `gstack-ship-queue ready` through it, refuse a run receipt whose `tree=`
is not pregate.json's tree unless a substitution for it is recorded. They make
no network call, so GitHub's availability and the run's age never sit on the
merge path.

**What is never reusable.** Security and advisory scans (osv, audit,
gitleaks) depend on the day, not on the tree, so they are not run profiles:
they run on every head as before, and `--from-run` never skips them.
Dispatched runs always run fresh. A push to main reuses
([below](#ci-reuse)), and a Free Tests pull request run reuses only a run it
can't control ([below](#ci-reuse-pr)).

<a id="from-run"></a>
### The tests stage from a Free Tests run (`--from-run`)

`gstack-pregate --stage tests --from-run <run id|url>` takes a Free Tests run
that already passed on this exact tree, for example the one CI ran on the
pushed head, instead of running its files again here. The run is verified
online, once, against the base branch's run profiles for this machine's OS
whose workflow holds a lane this machine runs (gstack's `ci-reuse/free-tests`
on Linux), with pregate.json's own head as a further veto head. Its tree must be this tree exactly (no
stamp-only substitution). Then:

- The selected local test files the run's `tree.json` lists count as passed,
  except those in its `skipped_files` ([above](#skipped-files)), which run here.
  The lanes check records them under `from_run` with the run receipt
  (`run tree=… tests=… runs=<id>/<attempt> profiles=… heads=… verified=…`) and
  prints `REUSE: accepted <n> of <m> selected local test file(s) from <receipt>;
  <k> still run`.
- The rest run as they would have: locally, or recorded as the remote gate
  obligation on a small machine, or through `--remote`.
- A run that does not verify prints `REUSE: refused reason=<code> — …; every
  selected test runs here` and changes nothing else. The codes are
  verifyRun's, plus `tree_mismatch` (another tree), `no_tests`, `no_profile`
  (no profile for this OS covers a local lane's workflow), `no_verified_run`
  (more than one profile applied and each refused; the detail lists every
  refusal) and `profiles_unavailable` (the base config or the GitHub origin
  could not be read).

`--from-run` applies to the tests stage only, so `--stage preflight` refuses it
as a usage error. It changes nothing in the preflight stage: with `--stage all`
the preflight checks, the secrets scan included, run as before, and
`--stage tests` runs no preflight check in that invocation, with or without it.

<a id="ci-carry"></a>
### CI carry: pregate and /ship use CI's run instead of running again (GSTA-258)

CI is the one full test run. When a verified run already passed at the exact
tree being tested, pregate's tests stage and /ship's test lanes use it instead
of running the suite a second time. `lib/ci-carry.ts` `findCarry` decides, and
it accepts a run only when all of these hold:

- The working tree is HEAD's committed tree (the `gstack-wtree` fingerprint
  equals `HEAD^{tree}`), read before the lookup and again after it. A dirty
  tree, an untracked file or an edit made during the lookup never carries.
- The newest of HEAD's runs (up to 10) under each named profile passes
  `verifyRun` above: same-repository head (a fork run never counts), the
  profile's workflow, event and jobs, the newest attempt, no newer red or
  running run on HEAD, within `max_age_hours`, and a `tree.json` naming HEAD's
  tree. A `pull_request` run counts only when the pull request already
  contained its base.
- Every run executed tests, and with an inventory command, the runs'
  `tree.json` files cover every file it prints, none of them a file whose every
  test skipped there (`skipped_files`). A lane mapped by `jobs`
  instead needs no test count: each named job succeeded in the run's newest
  attempt. Each run is read once more afterward (`run_changed`).

Security and advisory scans, the sealed guard and every other preflight-stage
check always run; only test lanes carry, plus guards whose exact command
already passed at this tree ([guard carry](#guard-carry)).

**The tests stage.** Without `--from-run`, when the base branch declares
`run_profiles`, `gstack-pregate` looks up the newest verified run at HEAD under
the profiles `--from-run` would use and applies it as `--from-run` does: the
selected local files its `tree.json` lists count as passed, and only the rest
run. On a small machine a selection the run covers records no remote gate
obligation. It prints `CI_CARRY: accepted <receipt>` or `CI_CARRY: none
(<reason>)` on stderr; `--no-ci-carry` skips the lookup.

When files are left over, the remote gate obligation still clears from the
same run when the base declares `remote_gate_runs` naming that run's profile:
the run must pass every `clear --run` check, with the carried files counted
as selected files. So a remainder of only files the gate's `skipped` command
names (gstack's paid evals, which the gate itself reports as
`PREGATE_REMOTE_PAID_ONLY` with `tests=0`) clears with `skipped=<n>` in the
receipt instead of becoming an obligation nothing can clear. The line is
`CI_CARRY: cleared pregate.json/remote_gate <receipt>`, or `CI_CARRY:
pregate.json/remote_gate stays uncleared (<reason>)` when a check refuses, for
example a gate inventory file missing from the run's `tree.json`.

**gstack's own gate.** gstack's `.gstack/pregate.json` declares
`remote_gate_runs` with the `ci-reuse/free-tests` profile, so on gstack a green
Free Tests run at the same tree is how the remote gate obligation clears, and
the Ubicloud VM (`gstack-pregate --stage tests --remote`) is an opt-in for when
no such run exists. The order after a push: wait for Free Tests
(`gstack-ci-carry wait --base main`), then `gstack-pregate
--allow-repo-commands`. A `pull_request` run tests GitHub's merge commit, so on
a branch that does not contain the base tip it tested another tree and
`CI_CARRY` says `none (no_verified_run: … tree_mismatch)`: dispatch Free Tests
on the branch
(`gh workflow run free-tests.yml --ref <branch>`), which tests HEAD's own tree,
and wait again. When the pull_request run tested that merge commit, the
refusal names the command for the run's branch (`fix: gh workflow run
free-tests.yml --ref <branch>, then gstack-ci-carry wait`). The preflight stage (generated-file freshness, secrets, strays
and the other mechanical checks) and the sealed guard are unchanged and always
run here. The macOS and Windows lane
obligations still clear with `gstack-pregate clear --remote <lane> --run-url
<url>` from their CI runs.

<a id="dispatch-carry"></a>**A dispatched run can hide a red merge commit.** A
`workflow_dispatch` run reports its checks on the head commit under the same
job names as the `pull_request` run. So a green dispatch run of HEAD's own tree
can stand in for a required check whose `pull_request` run failed on the merge
commit, and without strict branch
protection ("Require branches to be up to date before merging") the pull
request can merge with that failure hidden (GBEV-3). Turn on strict protection
for the base branch, or give dispatch runs distinct job names (for example a
job `name:` that includes `github.event_name`), so a dispatch run never stands
in for the required `pull_request` check. gstack's own merge trains test the
merged tree before they merge, so gstack is covered; a repo that merges
without a train is not.

**/ship lanes: `ship_lanes_from`.** A lane carries only when the base branch's
`.gstack/pregate.json` maps its exact command (the evidence ledger binds the
command's sha256; a label alone never carries) to the profiles whose runs carry
it and the command that lists its test files:

```json
"ship_lanes_from": {
  "bun run test": { "profiles": ["ci-reuse/free-tests"], "inventory": "bun --no-env-file --config=/dev/null run scripts/test-free-shards.ts --list | sed -n 's/^  //p'" }
}
```

<a id="ship-lanes-jobs"></a>A lane with no test files to list, such as a typecheck or a verify script,
names the CI jobs that run it instead (GST-1189). Declare exactly one of
`inventory` or `jobs`:

```json
"ship_lanes_from": {
  "bun run verify": { "profiles": ["ci/test"], "jobs": ["verify", "typecheck"] }
}
```

It carries only when every named job concluded `success` in the newest attempt
of the verified run at HEAD's tree, read by the same `verifyRun` job check the
profile's own `jobs` use. A job that is missing refuses as `job_missing`, a
skipped one as `job_skipped`, any other conclusion as `job_not_success`, and a
run of another tree as `tree_mismatch`. The receipt reads `ci-carry tree=…
jobs=verify,typecheck runs=…`, and the ledger row records the jobs. gbrain run
41564913688 (tree `13570abc`) is the case: its verify and typecheck jobs passed
at the tree, but no inventory could name their files, so they ran again. The
same form replaces fake `check:<command>` entries some repos wrote into
`tree.json` to give a typecheck, a doc-freshness check or a lint an inventory
(gstack-evals #180): name the job instead. A gstack older than the version that
adds `jobs` rejects the key as invalid config, so a repo declaring it should
first raise its `min_gstack_version` to that version.

<a id="ship-lanes-aliases"></a>**Aliases.** A lane is keyed on its exact command, so
`env -u ANTHROPIC_API_KEY bun test tests/` never matches a `bun test tests/` key.
Declare the other spellings on the entry, read from the base like the rest of
the map (GST-1190):

```json
"bun test tests/": { "profiles": ["ci/test"], "inventory": "…", "aliases": ["env -u ANTHROPIC_API_KEY bun test tests/"] }
```

An alias is a second exact command, never a pattern: gstack does not strip env
prefixes on its own, because `env -i HOME=… PATH=… bun test tests/` runs in a
different environment than the key. An alias that repeats a key or another
entry's alias is invalid config. The ledger row binds the command the lane
actually ran.

**What `tests_ran` means on a carried lane.** No carried lane reports the whole
run's count. A lane mapped by `inventory` reports how many of its inventory
files the runs' `tree.json` covers, labeled as a file count (`tests_ran=14
unit=files` on the ledger line, `tests_ran=14 (files)` on the `LANE:` line);
alphaclaw's 14-file, 46-test guards lane used to record the run's 9677.
`tree.json` has no per-file test counts yet, so the lane's own test count is
not available. A lane mapped by `jobs` reports `tests_ran=n/a`. Only the
pregate tests stage and `gstack-ci-carry find` without `--command`, which carry
the whole run, report its test count.

**`tree.json` counts from Bun's JUnit.** A writer that builds `tree.json` from
Bun's JUnit report must take the root `testsuite` count. Nested `describe`
suites repeat the file attribute, so summing every `testsuite` counts tests
twice. harness-evals #240's `scripts/ci-tree-json.ts` does it right.

<a id="prove-a-mapping"></a>**Proving a new mapping.** `ship_lanes_from` is read from `origin/<base>`
only, so a branch that adds a mapping cannot carry from it, and running
against `--base <PR branch>` fails (`BASE_CONTAINS_HEAD`). Prove it with the dry
run instead, once per lane command:

```bash
gstack-ci-carry find --base main --policy-from head --simulate --command 'bun run verify' --allow-repo-commands
```

It reads the branch's own `ship_lanes_from` and `run_profiles`, checks the lane
against the verified CI run at this tree exactly as a carry would, and prints
`SIMULATION:` at the start of every line (`SIMULATION: CI_CARRY: accepted …` or
`SIMULATION: CI_CARRY: none (<reason>)`). It writes no evidence or ledger row
and clears no obligation. To check every /ship lane at once, the same dry run
takes lane flags: `gstack-ship-preflight --tests-only --base main --policy-from
head --simulate --allow-repo-commands --lane 'verify=bun run verify' …` prints `SIMULATION: LANE:
<label> would carry run=…`, `SIMULATION: CI_CARRY: none label=<label> (<reason>)`
or `not mapped` per lane, runs no lane and no pregate, and exits 0 when every
mapped lane would carry. Both dry runs run the branch's inventory commands to
check coverage, which is running the branch's code, so both need
`--allow-repo-commands`; without it `gstack-ci-carry find --command` stops
with a usage error (exit 2), and the preflight dry run prints
`inventory_not_allowed` for an inventory-mapped lane. truther's adoption proved its map this way by hand
before the dry run existed: run 41585332512 accepted 7 of 7 lanes. A branch's own map never carries,
even when the base has no policy at all, because the pull request controls both
the map and the CI that would satisfy it. So the first pull request that adopts
a mapping pays its full lanes; the carry starts on the pull requests after it
merges. `ship_lanes_from` itself needs `min_gstack_version` 1.94.0.0 or later in
`.gstack/ship-policy.json`, and `jobs` and `aliases` need the release that ships
them. With that floor set, a gstack that has this check but not the key prints
`needs gstack >= <version>; upgrade` (`PREGATE_GSTACK_TOO_OLD`) instead of a
generic invalid-config error. A gstack released before the check (1.94.0.0
included) still reports the unknown key as `PREGATE_CONFIG_INVALID`.

As a second guard, every `record-ci` row names the policy that mapped it
(`origin/<base>@<sha>:.gstack/pregate.json`), and `gstack-evidence carried`, which
the ship receipt reads, lists only rows whose policy is `origin/<the receipt's
base>`. A row written by a run against another base never lands in a receipt.
`carried` also lists a row only when `check`'s own grading, at the 24-hour age
limit /ship uses, calls it FRESH, so a carry that never reached FRESH (a failed
or zero-run row, or one older than 24 hours) leaves no `ci_carried` entry.

A carried lane prints `LANE: <label> carried run=<id>/<attempt> tests_ran=<n>`
(see above for what `<n>` counts) and writes an explicit CI-sourced ledger row (`gstack-evidence record-ci
--label <label> --base <base> -- <command>`, which finds and verifies the run
itself, so no caller hands it run ids or a test count: `source: "ci"`, its runs
and profiles, the run's finish time as `ts`, bound to the clean tree), never a
fictitious local run. `gstack-evidence check` grades it
like any row and names `source=ci runs=…`, so `finish`'s FRESH check and the
24-hour age limit apply to the CI run's own time. The ledger stores a label
with every character outside `A-Za-z0-9._-` turned into `_` (`pnpm lint` is
`pnpm_lint`, `db:test` is `db_test`), and `run`, `record-ci` and `check` all
use that one spelling, so `check --label 'pnpm lint'` finds the row; `ci_carried`
and `CI_CARRIED:` name the stored spelling. A mapped lane that cannot
carry prints `CI_CARRY: none label=<label> (<reason>)` and runs here. Every
other lane runs through `gstack-evidence run --reuse`: the newest row for its
label, command and working tree is reused when it passed with a counted run
under the same runtime (bun and node versions, OS, architecture, runner image)
within 24 hours; a newer failure on that tree vetoes an older pass, and the
reused copy keeps the original timestamp. The cache is this machine's ledger
only; across machines, CI is the trust boundary.

**Finish, push and accept.** `gstack-ship-release finish` commits the release
metadata, so the stamped tree has no CI run yet. A mapped lane that is not
already FRESH is deferred (`EVIDENCE: DEFERRED`), and the pregate runs only its
preflight stage on the stamped tree, written to its own file so the full
`.gstack/tmp/pregate.json` stays in place until `accept` replaces it. `gstack-ship-release push --early` (the
Phase 2 push that lets CI run beside the review) runs the secrets scan and the
sealed guard before it pushes. After the final push,
`gstack-ship-release accept --base <base> --lane …` waits (bounded by `--wait`)
for the run at the pushed HEAD, stops on a red or still-running run, carries
each mapped lane from the green run at that exact tree, reuses or runs the rest,
checks every lane FRESH and reruns the pregate there, whose tests stage carries
the same run. `gstack-ship-receipt write` records the carried runs as
`ci_carried: [{ lane, run, attempt, tree }]`, and the `SHIP_RECEIPT:` line names
them (`ci_carried=<lane>:<run>/<attempt>`). Each `record-ci` gets the base
policy's [`ci_record_timeout_s`](ship-policy.md#ci-record-timeout) (600 s by
default, 3600 s at most), and accept prints it as `CI_RECORD_TIMEOUT:`.

<a id="accept-local-tests"></a>**When accept's final pregate runs the tests here (GST-1606).** The final
pregate's tests stage carries only under a base run profile whose `os` matches
this machine and whose workflow holds a lane this machine runs. A lane carried
through `ship_lanes_from` needs neither, so a profile without `os` carries
every lane and still leaves the tests stage to run its whole selection here
(harness-evals #271 ran 3,666 tests that way). accept then prints one line:
`CI_CARRY: none (<reason>); the final pregate's tests stage ran here instead:
tests <verdict> in <n>s`. The run is correct, only slower. Adding `"os":
"Linux"` (or this machine's OS) to the profile on the base branch lets the
next accept carry the tests stage too, when the run's `tree.json` covers the
selection.

<a id="same-tree-clears"></a>**A rerun at the same tree keeps its clears (GST-1627).** accept's final
pregate reran `gstack-pregate` on the tree the lane had already cleared
`macos-named-regressions` and `windows-smoke` on from CI runs, and the fresh
record dropped both receipts, so accept stopped on `requires-remote (2
uncleared)` and never exited 0 (#4063, GST-1595). Now, when `gstack-pregate`
writes over a record for the same head, tree, policy and base branch, each uncleared
obligation takes the earlier receipt for the same lane, platform, workflow and
job, with its `cleared_by`, stamp-only substitution and flaky exception, as long
as the earlier obligation listed every test the new one needs. Each kept
receipt prints `PREGATE_CLEAR_KEPT: <lane> receipt=<receipt> (recorded at this
tree <tree12>; …)` (on stderr under `--json`), and accept relays the lines
before its `PREGATE:` line. A record for another head or tree keeps nothing,
so any commit after the clear, even an amend that keeps the tree, needs a new
clear at the new head: a receipt and its flaky exception were vetted against
the head they name. A rerun with a
failed, incomplete or not-installed check also keeps nothing, so a remote gate
that ran again and timed out stays uncleared. `gstack-pregate verify` checks a
kept receipt as it checks any other one.

<a id="carry-imported-tests"></a>**An inventory file CI's JUnit tree never lists (GST-1595).** bun registers
the tests of a test file another test file imports under the importer, so the
imported file's own JUnit suite never appears in `tree.json` and the carry
refuses with `inventory_uncovered`. For each such file another inventory file
imports by a relative path (`import`, `import()`, `require`), the refusal adds
`CARRY_DIAGNOSIS: bun registers <imported> under <importer>; its JUnit suite
won't appear` (`lib/ci-carry.ts` `importedTestLines`), printed by `gstack-evidence
record-ci`, `gstack-ship-preflight` and `accept`; the remote gate's
`inventory_uncovered` reason carries the same words. The fix is usually to move
the shared code out of the `.test.` file. When that can't happen in this PR,
the owner can grant a [test-lane exception](ship-policy.md#test-lane-exceptions)
for exactly those files at the pushed head: `record-ci` then runs each of them
here, one file at a time, with the entry's `per_file` runner (label
`<lane>.excepted`) and carries the lane only when every file's run passes with a
counted test; the lane's `tests_ran` counts those files beside the ones CI
covered. A failed or zero-test run of any file refuses with
`exception_preflight_failed`, and a grant at another head or for another file
set binds nothing. The CI row and the receipt's `ci_carried` entry
keep the grant and the preflight (`exception`), and `accept` prints
`TEST_LANE_EXCEPTION: <files> at <head12>: preflight <label> ran <n> test(s)
here; granted by <who> at <time>: <reason> (approval <id>)`.

**`gstack-ci-carry`.** `find [--profile <name>]… [--command <exact lane command>
--allow-repo-commands]` prints the verdict for HEAD; `wait [--timeout <s>]`
polls the newest run at HEAD until it completes (run it in the background) and
prints `CI_WAIT: green|red|running|none`, then `find`'s verdict on green.
`find --policy-from head --simulate` is the dry run in
[proving a new mapping](#prove-a-mapping).

<a id="ci-reuse"></a>
### Main pushes reuse the merged pull request's run

A squash merge whose pull request head already held main produces a push with
the identical tree, and Free Tests and Windows Free Tests used to run on it a
second time. Now each workflow starts with a `reuse` job that runs on a push
to `main` (and, for Free Tests, on pull requests: [below](#ci-reuse-pr)), with job-level `contents: read` and `actions: read` (every other
job keeps the workflow's `contents: read`). It runs
`scripts/ci-tree-reuse.ts find`, which:

1. finds the pull request whose merge commit is the pushed commit
   (`repos/{repo}/commits/{sha}/pulls`, one page of at most 10), merged into
   main from a same-repository head (`no_pr`, `ambiguous_pr`, `fork_head`);
2. requires that head's tree to equal the pushed tree (`tree_mismatch`);
3. lists that head's `pull_request` and `workflow_dispatch` runs of the same
   workflow, newest first, at most 10 (`no_candidate`); and
4. accepts the first one `verifyRun` accepts under the profile in the pushed
   tree's `.gstack/pregate.json` (`no_verified_run` lists each refusal; a newer
   red run on the head vetoes an older green one).

It writes `reused=true` with the run's id and link, or `reused=false` and the
reason, and prints one `REUSE:` line in the step summary. Every suite job
needs `reuse` and runs unless it succeeded with `reused=true`; their
conditions start with `!cancelled()` because GitHub otherwise skips a job whose
needed job was skipped, and `reuse` is skipped on every dispatch run (and on
every Windows Free Tests run). The required aggregates (`free-tests`, `windows-free-tests`)
choose a path in their first step, before any download. A verified reuse writes
the reused run's link to the summary and passes; anything else, a failed or
skipped `reuse` job included, takes the strict path unchanged. Only the strict
path records and uploads `tested-tree`, after its verification passes, so a
red, partial or reused run never leaves a record and a reuse is never reused.
The pull request lookup needs no `pull-requests` permission on a public
repository; a private fork of this setup would need `pull-requests: read`,
and without it every push falls back to the full run. Windows Free Tests now
runs nightly and by hand only (docs/support-tiers.md), never on a push, so its
`reuse` job is always skipped and every nightly run takes the strict path.

<a id="ci-reuse-pr"></a>
#### Pull requests reuse only a run they can't control

Free Tests' `reuse` job also runs on `pull_request`, as
`find … --pull-request` (`findPrReuse`). On a pull request it checks out the
base commit, never the merge commit, and runs bun with `--no-env-file
--config=/dev/null`, so the reuse script, everything it imports and the run
profile are main's code. Main pushes stay the only consumers
of anything a pull request could certify for itself, so a `pull_request` run
is never a source. A pull request run reuses a green run only when all of these
hold:

1. the pull request's head is on this repository (`fork_head`), it targets
   main (`not_main_pr`), and this is the run's first attempt (`rerun`: a re-run
   never reuses, so a red earlier attempt stays visible);
2. GitHub's merge commit has exactly two parents, main and the pull request's
   head (`merge_mismatch`);
3. the merge commit leaves `.github/workflows/free-tests.yml`
   (`workflow_changed`), `scripts/ci-tree-reuse.ts` and `lib/run-evidence.ts`
   (`script_changed`) byte-identical to its main parent, so the rules that
   decide the reuse are main's;
4. the source is a `push` or `workflow_dispatch` run on main, or a
   `workflow_dispatch` run on the pull request's own branch, newest first and
   at most 10 (`no_candidate`), whose head commit has the merge commit's tree
   (`tree_mismatch`); and
5. `verifyRun` accepts it under `ci-reuse/free-tests` with `push` and
   `workflow_dispatch` as the accepted events, its `tested-tree` record names
   the merge commit's tree, and no newer red run on its head vetoes it (the
   pull request's own run in progress is not a veto). A dispatch that
   overrode the runner, shards or sub-shards records `sizing_experiment` in
   its `tested-tree`, and `verifyRun` never accepts it (`sizing_experiment`),
   for any consumer.

The aggregate's route step accepts a reuse on a `pull_request` run of
`refs/pull/<n>/merge` as it does on a push to main. A reused pull request run
uploads no `tested-tree`, so the main push after the merge finds the source run
on the head (a branch dispatch) or runs every job. The usual case is a branch
that already holds main's tip. Dispatch Free Tests on the branch, and the
pull request run that follows reuses it instead of running the suite again.

<a id="flaky-exception"></a>
## Owner-granted flaky exception

A timing flake in a test file the pull request never touched can keep a remote
gate obligation red: the rerun hits the same 5 s timeout on a loaded runner,
and nothing in the diff can fix it. `clear --flaky-exception` lets the owner
accept named cases for one head, on the run's own records:

```bash
gstack-pregate clear --remote pregate.json/remote_gate --run <id|url> \
  --flaky-exception "test/docsync-fault-interface-legacy.test.ts::rejects legacy-third" \
  --pr <n> --allow-repo-commands
```

The first call checks everything below and then refuses with
`reason=grant_needed`, printing the exact `gstack-approvals add` command to run
once the owner says yes: its `--scope` is `flaky-exception:<sha256>`, a digest of
the repository, PR, head, tree, lane, every run with its attempt, and the sorted
cases. Record the owner's exact words in that row, then rerun the same clear with
`--grant <the row id>`. The obligation clears only when all of this holds:

- **Every failure is named from the run's own records.** A red run uploads no
  `tree.json`, so the clear reads the strict shard runner's artifacts instead
  (`free-plan`, `free-result-<n>` and `free-test-shard-logs-<n>` in
  `free-tests.yml`; the `windows-` names in `windows-free-tests.yml`; any other
  workflow refuses with `no_shard_results`). Every job of the attempt is
  reconciled: only the shard jobs (`free-suite (<n>)`) and the aggregate that
  needs them may fail, every job the profile requires must pass, and any other
  failed or cancelled job refuses (`unnamed_failure`). Every planned shard needs
  its result; a missing result, a timed-out shard or a missing summary is
  `shard_incomplete`. A failure the runner could not attribute to a test file,
  an unhandled error between tests, or a `(fail)` line in a failed shard's log
  that its result does not record refuses. A retry that passed is a recovered
  flake; a retry that failed again keeps its own failures.
- **The cases are exactly the failures.** At most three, written as
  `<test file>::<test name>` the way the run printed them. A failure no
  `--flaky-exception` names refuses (`unnamed_failure`), and so does a named
  case that did not fail (`case_not_failed`). The refusal lists the run's
  failures in that form.
- **The files are not the PR's business.** A named file in the PR's diff
  (`case_in_diff`), or one the import graph reaches from any changed path
  (`case_in_closure`, lib/pregate/import-graph.ts with the base branch's
  `dependencies`), refuses. The closure follows imports only: a test that reads a
  changed doc, template or workflow through the file system is not reached, so
  required CI stays the check on it. A paid test file (`case_paid`) and a
  security test (`case_security`: a file name with cso, secrets, gitleaks, sealed,
  redact or redaction, osv, security, sanitize or inject) are never excepted. Security scans themselves are pregate checks and CI jobs,
  not test cases, so no exception can reach them.
- **One head, one grant.** The runs must have tested pregate.json's own head and
  tree, with no stamp-only substitution (`head_mismatch`); the PR must be open with
  that head (`pr_mismatch`); no newer run of the workflow may exist on the head
  (`newer_run`), and the run may not move to another attempt during the check
  (`run_changed`). The grant row must carry this exception's scope
  (`grant_mismatch` otherwise), record `approved` (`grant_not_approved`) and be
  the owner's words, not an agent's (`grant_not_owner`). That last check reads
  the row's `by` field, which `gstack-approvals add --by` takes as written, so it
  only catches a row honestly labeled `agent:`. The record is as trustworthy as
  whoever writes it, the same as every gstack approval. A new head needs a new
  run and a new grant; a grant is never rebound: `ready` and the ship receipt
  refuse an exception granted for another PR or head, even when the tree matches.

pregate.json records the grant under `exceptions` (lane, repository, PR, head,
tree, runs, cases, grant id, who said it, their words and the binding), and the
obligation's receipt adds `exception=<grant> cases=<n>` to the usual run fields.
The verdict becomes `pass-with-exception`. `verify` re-checks offline that each
exception receipt has its entry, bound to this head and tree, with a binding that
still matches its fields, and prints
`PREGATE: pass-with-exception (<cases>; grant <id>)`. `gstack-ship-queue ready`
accepts it and prints one `FLAKY_EXCEPTION:` line per exception in the READY
block, and `gstack-ship-receipt write` records `flaky_exception` (lane, runs,
cases, grant, who).

**Pregate only.** The exception clears the pregate obligation and nothing else.
It never waives a red required CI check: `ready` still needs every required check
green at the exact head, so a red Free Tests check on the pull request needs its
own rerun to pass. Changing that contract is a separate decision for the owner.

**Why not `base_red`.** `base_red` (docs/ship-policy.md#base-red) proves a
failure belongs to the base by reproducing it there, at the base head and at the
PR head. A timing flake usually passes on the base (the 2026-11-02 docsync case
passed in 3.5 s on main and failed at 5 s on the PR's tree), so `base_red`
returns `IN_BRANCH` and refuses. The exception path asks a different question:
not "is the base broken?" but "is every failure named, outside this PR, and
accepted by the owner?"

<a id="guards"></a>
## Guards and the lane-done rule

A lane runs `gstack-pregate run --allow-repo-commands` on its branch before it
reports done, and its handoff carries the `PREGATE:` line (the coordinator
contract says so word for word). The unit tier covers the changed files'
tests; guards cover the repo's mechanical gates the import graph cannot see:

```json
{ "guards": [
    { "id": "serial-manifest", "when": ["test/**/*.serial.test.ts", "scripts/serial-files.tsv"],
      "command": "bun test test/scripts/serial-files.test.ts",
      "fix": "add the file's row to scripts/serial-files.tsv" } ] }
```

`dependencies` still maps globs to extra *tests* the lanes check selects; a
guard is a *command* with its own fix line. Older gstack refuses unknown keys
(`PREGATE_CONFIG_INVALID`), so a repo commits `guards` only after the gstack
that reads them ships. The worked gbrain configuration is in
[gbrain worked configs](#gbrain-worked-configs).

<a id="prepush"></a>
### Before every push: `--stage guards`

Housekeeping checks cause a large share of red CI runs: a stale render or
golden, a size ratchet, a token budget, a type error. gbrain had 64 of 93 red
heads from these (FOUN-64), and gstack's #3908 went red on the context-budget
ratchet. Each one is quick to run locally, so run them before the push instead
of waiting a CI round to find out:

```
gstack-pregate --stage guards --allow-repo-commands
```

`--stage guards` runs only two checks: `regen` (generated-file freshness) and
`guards`. Each runs only for the files the branch touched, so a docs-only
change runs nothing. It writes `.gstack/tmp/pregate-guards.json`, so it never
replaces the full run's `.gstack/tmp/pregate.json`. It refuses `--only`,
`--remote` and `--from-run`.

`gstack-ship-release push` runs it before every push, early or final, and
prints `GUARDS: <verdict> (<detail>)`. A failing or unfinished guard stops the
push with the guard's fix, and nothing is pushed. A pass already recorded at
HEAD's exact tree is reused instead of rerun: either push's own record or
`finish`'s preflight record. Both live under `.git`, where no commit can
place one. The guards must have checked the tree being pushed, so uncommitted
or untracked files that change what they saw stop the push until you commit or
stash them. A refused run (an unreadable policy, a base that is on origin but
not fetched, a mistyped `--base`) stops the push too; only a remote that has no branch except the one
being pushed skips the guards, as `GUARDS: not run`. Outside /ship, run the
command above yourself before `git push`.

gstack declares its own list in `.gstack/pregate.json`: `typecheck`,
`skill-size`, `parity-suite`, `context-budget`, `module-size`, `goldens`,
`doc-caps` and `conflict-markers`. Generated SKILL.md freshness is the `regen`
check's job. `conflict-markers` runs `scripts/check-conflict-markers.ts` on a
change to code, templates or config, and reads every line the branch adds
against its merge base with `origin/main`, both in the committed HEAD (what the
push publishes) and in the working tree's tracked files. A line starting with
`<<<<<<<` or `>>>>>>>` (then a space or the line end), or a line that is exactly
`=======`, stops the push, even inside a template literal the parser accepts.
In Markdown (`.md`, `.mdx`, `.markdown`, `.md.tmpl`) it skips fences whose info
string is empty, `text`, `txt`, `plaintext`, `diff` or `console`, the fences a
doc uses to show git output, and counts `=======` only between a `<<<<<<<` and
its close, so such a code block and a heading underline both pass; a conflict
inside a `bash` or `ts` fence is still refused. A fixture that shows markers on
purpose puts a line that is only `gstack-conflict-markers: fixture` (a comment
leader such as `#` or `//` is fine) in its first five lines; the phrase
anywhere else exempts nothing. Other
repos add their own `guards` the same way; the key needs no newer gstack than
the one that already reads `guards`.

<a id="guard-carry"></a>
### A guard that already passed at this tree does not run again

A guard is skipped as passed when its exact command already passed at this tree
(GST-1186). Two sources count, checked in this order:

1. **CI.** When the base branch's `ship_lanes_from` maps the guard's exact
   command, the guard is carried from the verified CI run at HEAD's clean tree,
   through the same `gstack-evidence record-ci` and `findCarry` path a /ship
   lane uses ([ci-carry](#ci-carry)). It prints `GUARD: <id> carried
   runs=<id>/<attempt>`, or `GUARD: <id> not owed: CI skipped at this tree …`
   when every job it maps was skipped by an unchanged gate
   ([skippable](#skippable)). When no run carries, it prints `CI_CARRY: none
   guard=<id> (<reason>)` and goes on to the ledger.
2. **The evidence ledger.** When the newest local ledger row for the exact
   command at this working tree, under any label, is a counted pass (`tests_ran`
   above zero under the runtime the guard would launch with, within 24 hours),
   the guard prints `GUARD: <id> reused label=<L> source=local ts=<ts>`. CI rows
   never count here: a CI pass counts only through `record-ci`'s live check
   against the base, so an old CI row does not outlive a refusal.
   `gstack-evidence passed -- <command>` is the same lookup by hand. A newer
   failure of the command at that tree vetoes an older pass.

Anything else runs the guard as before, with the same timeout, stall rule and
fix line. This matters for repos whose suites are guards rather than lanes
(founderstar declares `check-quick`, `play-through` and `assets` as guards),
which otherwise reran every suite /ship had just carried from CI.

Known limit: `ship_lanes_from` is read from `origin/<base>` only, so the pull
request that adds a mapping cannot carry from it. Prove it with the dry run in
[proving a new mapping](#prove-a-mapping) until it lands.

<a id="allowlist"></a>
## Allowlist: benign findings the secrets check accepts

The `secrets` check cannot be downgraded, and that is right for a key. It also
refused 1,800 per-trial dummy tokens in eval receipts (`"key": "sk-trial-<id>"`
reads as `env.kv`), an 11-digit Actions run id read as a phone number (one
after a run word such as `run`, `screen` or `gate` is exempt in the scanner
since the GSTA-121 follow-up; the allowlist still covers one after any other
word), and
excalidraw.com's public Firebase key that every rebuild of a bundle re-adds
(harness-evals #81/#83, GSTA-102, GSTA-106). `allowlist` in the policy names
those, each with its scope and its reason:

```json
{ "allowlist": [
    { "finding": "env.kv", "paths": ["evals/**/receipts/*.json"], "pattern": "sk-trial-[0-9a-f-]+", "reason": "dummy per-trial meter ids" },
    { "finding": "pii.phone.e164", "pattern": "\\d{11}", "reason": "GitHub Actions run ids in reports" },
    { "finding": "google.api_key", "paths": ["lib/render/dist/bundle.js"], "pattern": "AIza[0-9A-Za-z_-]{35}", "reason": "the vendor's public web key, restricted server-side" } ] }
```

- `finding` is a gstack-redact finding id (`env.kv`, `google.api_key`,
  `pii.phone.e164`, `internal.hostname`, …) or one of the categories `pii`,
  `internal`, `hygiene`, `legal`. A secret is always named by its id; the
  `secret` category cannot be allowlisted whole.
- `paths` are contained globs over the added file's repo path; `pattern` is a
  regular expression matched **at the finding's position in the added line**
  and ending at a token boundary, so a dummy token's shape never covers a real
  key that shares its line or starts the same way. One of the two is required;
  `reason` always is, and the record repeats it.
- **`env.value` is never allowlisted.** It is the real value of a
  credential-named variable of the environment pregate ran in (#3449), found in
  the added lines whatever its shape. Validation refuses an entry naming it
  (`PREGATE_CONFIG_INVALID`), and the matcher never consults the list for it,
  so a stale or hand-edited policy cannot silence it either. The scanner's own
  `engine.*` refusals (an oversize input fails closed) are refused and kept the
  same way: they are the scanner declining its input, not a finding in it.
- A `pattern` entry needs the finding's position. When the scanner gave none,
  the entry is inert for that finding and the row says so (`allowlist[0]
  env.kv not tested on env.kv (<file>): the scanner gave no position for its
  pattern; the finding is kept`) rather than silently keeping it.
- The position is where the flagged value starts, not the name before it.
  For `session: HttpSession` in a YAML file the pattern is `HttpSession`;
  `session: HttpSession` never matches there. An entry that names a finding
  by id and path, and whose pattern matches the line but not at the value,
  prints `allowlist[0] env.kv pattern did not match env.kv (<file>, added
  line N, col C): …; the finding is kept`.
- In Python and Dart source, a parameter or field annotation
  (`session: HttpSession,`) and a dict entry or Dart named argument that reads
  a name (`"password": request.password`) are code, not credentials, as they
  are in TypeScript (#3630). Python's keyword form (`password=request.password`)
  still reports. The same line inside a `"""` docstring, any other string or
  a Dart `/* */` comment is text and still reports; allowlist it by its value.
  Code inside a Python f-string or t-string `{…}` field, or a non-raw Dart
  string's `${…}`, is read as code, and its nested strings and quotes do not
  end the outer string (GST-738). The pre-push hook sees only added lines,
  so it scans Python and Dart lines without this exemption and may still warn
  (MEDIUM, non-blocking) on them.
- The first argument of a lookup call (`get`, `getenv`, `read`, `load`,
  `loads`, `open`, `pop`, `fetch`) that is a lowercase file name
  (`files.get("key.json")`) or a snake_case key of two or three words
  (`resp.json().get("access_token")`) is a name, not a credential (GST-1064).
  Any other call's literal (`make_password("orange_monkey_pass")`), a later
  argument or fallback (`os.getenv("SECRET_KEY", "orange_monkey_pass")`) and a
  kebab passphrase still report.

The `secrets` row says `N allowlisted (<ids>)` and lists each allowlisted
finding with the entry (`allowlisted env.kv (evals/receipts/t1.json, added line
3) by allowlist[0] env.kv: dummy per-trial meter ids`); `inputs.allowlist`
carries the entries' digest, so a changed list is a changed input. The list is
read from the base branch's copy (reviewed) or the user-owned file, like every
other key; an unparsed scanner report keeps its exit-code verdict and is never
allowlisted.

<a id="environment"></a>
## Environment failures, apart from diff failures

A lane that could not run is not a lane that failed. When a check could not run
its command because of the machine (truther #617: a root runner with a vitest
config that found no file, a corpus fetch that stalled on one host and passed
on another), the check is `incomplete` under its own code,
**`PREGATE_ENVIRONMENT`**, with `cause: "environment"` and an
`environment: { kind, evidence, proof }` object in `pregate.json`, an
`environment: <kind> — <evidence>` table line, and a fix that says so. A
failure the branch caused carries `cause: "diff"` (`PREGATE_LANE_FAILED`,
`PREGATE_GUARD_FAILED`, `PREGATE_SECRETS`). Kinds:

| Kind | Evidence |
|---|---|
| `missing-binary` | exit 127, `command not found`, a spawn `ENOENT`, a runner tool `not on PATH` (dart, flutter, cargo, a package manager, `python3`, or `pytest` when python3 cannot import it), Playwright's browsers not installed |
| `network` | `ENOTFOUND`, `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, `Could not resolve host`, `fetch failed`, a TLS handshake or certificate failure |
| `quota` | `quota`, `429 Too Many Requests`, `rate limit`, `insufficient_quota` (a vCPU quota on the remote backend) |
| `disk` | `ENOSPC`, `No space left on device`, `EDQUOT` |
| `runtime` | the install verdict or the pinned Bun refused (`BUN_RESOLUTION_DRIFT`, `INSTALL_UNVERIFIED`) |
| `tool` | gstack's own scanner (gstack-redact) did not finish or exited outside its contract |

The classifier is conservative. A local lane that exited non-zero is read from
its output **only when its runner reported no test summary** (nothing ran) and
the runner was not seen starting a test file; a run whose summary counts `N
ran, M failed` is the diff's failure whatever its log says, so a test that
failed on `ECONNREFUSED` is still a red test. One exception: when every
failed run is a Playwright run in which every test failed and Playwright says
its browsers are not installed, the lane is `missing-binary` with `proof:
"output"` (a partial install, where some tests pass, stays the diff's
failure). A remote gate that exited
without a `PREGATE_REMOTE:` line is read from its **preamble only** (its first
40 lines, before any test output could stream): a VM refused for quota or an
unreachable API there never ran the tests, so it is environment and the
obligation stays uncleared, while a `quota` in a streamed test name is not. A
guard that ran and said no is the diff's. Exit 127 and `command not found`
count as `missing-binary` only when the command's **own** binary is off
PATH: a runner, guard or gate script the diff controls that exits 127 (a
package script naming a tool that is not installed) is the diff's failure. A
stall or a timeout keeps `PREGATE_STALLED` / `PREGATE_INCOMPLETE`: a hang
has no single cause, and so does a runner killed by a signal.

`proof` records how the cause was established. `launch` is certain: the
command could not start, its binary is off PATH, the runtime or a gstack tool
refused; the fix ends `the diff is not at fault`. `output` means a rule
matched the command's text before any test was counted, which the diff's own
output could have written (a test that prints `fetch failed` and exits the
process before the summary); the table line says `(inferred from output)` and
the fix asks for confirmation on another machine or with `--remote` before
the diff is treated as clear. Neither proof ever passes the check.

`gstack-pregate verify` reports `PREGATE_ENVIRONMENT: <n> check(s) blocked by
the environment (<kinds>), not by the diff` when every incomplete check is
environment-caused, naming any check whose cause was inferred from output
alone, and names the kinds beside the generic `PREGATE_INCOMPLETE` otherwise;
`--json` carries `cause` and `environment` per check. A lane that waives such
a run cites the kind, the evidence and the proof, not a test name, and clears
the lane remotely (`--remote`, or `gstack-pregate clear` with a run URL)
rather than on the broken machine. Incomplete never passes.

<a id="scratch"></a>
## Scratch: one directory per run, under the state root

Every run owns `<state root>/projects/<slug>/pregate/runs/<run id>/` (mode
0700; `<run id>` is `--run <id>` reduced to `[A-Za-z0-9._-]`, else
`<UTC stamp>-<pid>-<4 hex>`). The secrets scan's added-line copies
(`secrets/`, deleted after the scan), the lane log (`lanes/lanes.log`), each
guard's log (`guards/<id>.log`) and the remote gate's log and file list
(`remote/`) live there, never under `os.tmpdir()`: two pregates in parallel
(two lanes on one machine, a subagent beside its parent) never share a path,
and the log a `fix:` line names survives a host that wipes `/tmp` between
wakes. `pregate.json` records the directory as `scratch` and the table prints
`scratch: <dir>`. A `--run <id>` whose directory already exists (a finished run
under the same name, or a second run beside a live one) is never shared, since
a second run would truncate the first's logs: the run takes `<id>-2` … `-9`
and the record names the directory it got. Runs older than 7 days under the
same project are pruned when a new run starts (the current run never is). An
unwritable state root falls back to a private directory under `os.tmpdir()`,
still one per run, and `--explain` says so.

<a id="timing"></a>
## Timing assertions

`timing` reads only the lines the branch added or changed in test code (test
files and files under `test/`, `tests/`, `spec/` or `__tests__/`; never
fixture trees). It reports three patterns:

| Pattern | Example |
|---|---|
| `wall-time-bound` | `expect(Date.now() - t0).toBeLessThan(400)`, `expect(elapsedMs).toBeLessThanOrEqual(2_000)`, `assert elapsed < 0.5` |
| `cpu-time-bound` | `expect(cpuMs(() => parse(x))).toBeLessThan(150)`, `assert time.process_time() - c0 < 0.2` |
| `sleep-then-assert` | `await Bun.sleep(50); expect(calls).toBe(1)` (a fixed sleep, not a polling loop) |

A comparison with `0`, a named bound (`timeoutMs`, `TTL_MS`), a timestamp
ordered against a bare `Date.now()` and a `while (… Date.now() < deadline)`
poll are not reported. Changing the bound of an existing assertion is a changed
line, so it is reported.

**Escape.** When the bound is the contract (a hang check with wide headroom, a
CPU-time bound on a pure function), put `gstack-timing-ok: <reason>` in a
comment, in any comment syntax (`//`, `#`, `/* */`, `--`), on the line or
the line above. The reason is required; an empty one is still reported with
`(gstack-timing-ok needs a reason)`. `--explain` lists every escape and its
reason.

**Warn, not block (measured 2026-10-16).** The detector was run over:

- gstack's own test tree: 263 hits in 123 of 1,566 test files (176
  `wall-time-bound`, 87 `sleep-then-assert`), mostly real timing assertions,
  most of them generous "does not hang" bounds.
- gstack's last 51 commits on main: 9 of the 47 that touched tests would have
  been flagged (29 hits; #3190 alone has 7).
- gbrain's last 100 commits on master: 37 of the 95 that touched tests would
  have been flagged (147 hits).
- The five gbrain timing-flake fixes (#6050, #6493, #6726, #6746, #6862): 31 of
  38 fix sites were flagged before the fix. The misses are flakes with no
  timing comparison on the line (an injected deadline in #6050, a
  `Promise.race` with a sleep and a deadline parameter in #6862) and ratio or
  percentile checks computed far from the clock read. The correct fix in
  #6726 (wall clock to thread CPU time) is still a bound and is reported 21
  times.

Blocking would stop about a fifth of gstack's and two fifths of gbrain's
test-touching commits, including correct fixes, so the check warns. A repo
that wants it stricter keeps the warning in its review rule (the /review
checklist has the same rule) and /investigate's flake playbook says what to do
with a timing flake: never raise the bound.

<a id="sealed"></a>
## Sealed output: the pre-push hook and `gstack-pregate sealed`

```json
{ "sealed": {
    "paths": ["heldout/**", "**/sealed/**"],
    "transcripts": ["runs/**/transcript*.jsonl"],
    "allow_paths": ["**/sealed/*/MANIFEST.json", "**/protected/MANIFEST.json"],
    "answer_markers": ["SEALED ANSWER:"],
    "seed_patterns": ["shuffle_seed=\\d+"],
    "local_paths": true,
    "case_insensitive": true,
    "label_keys": ["stratum", "decoy_set"] } }
```

A repo with a `sealed` key gets a configured local check against accidental
publication whenever the managed pre-push hook (`gstack-redact
install-prepush-hook`, no reinstall needed) or the standalone preflight runs:

```
gstack-pregate sealed [--range <a..b>] [--remote origin] [--base <branch>] [--no-skip] [--json]
```

- **Boundary.** Every commit the push publishes: `git rev-list <local sha>
  --not --remotes=<remote>` (and the remote tip when the ref exists); a
  destination with no refs means everything reachable. `--range` names the
  commits explicitly.
- <a id="sealed-skip"></a>**Skipped commits.** When the base branch resolves, a
  listed commit is not rescanned when the destination already holds it or its
  patch already landed. Held: an ancestor of the destination's own
  `refs/pull/<n>/head` for a squash commit `(#n)` on the base since the
  merge-base; the subject is only a hint, the fetched ref is the proof. That
  lookup lists and fetches at most 50 refs within 20 seconds (receipted, sink
  `sealed-guard`) and deletes the fetched refs afterwards. Landed: the commit's
  own `git patch-id --verbatim` equals a base commit's since the merge-base and
  so does its diff, apart from blob ids and line numbers; a merge never matches,
  and above 2,000 base or 400 listed commits this check is off. A landed commit
  skips only the path and text rules: `sealed.label_join` judges the whole file
  at that commit, which the base may never have held, so it still runs. Nothing
  matches a combined diff, so a parent whose commits were never published is
  scanned whole even when its squash landed. A lookup that fails, runs out of
  time or exceeds a limit prints one line and scans everything. Each PR group
  and landed commit is listed (`skipped <n> commit(s) the destination already
  has as refs/pull/<n>/head`, `skipped commit <sha> (its patch landed on the
  base as <sha>)`), the `SEALED:` line counts them as `skipped=<n>` (its
  `commits=` counts the commits scanned), and `--no-skip` scans every listed
  commit. The pre-push hook and `gstack-pregate sealed` skip the same way.
- **Rules.** `sealed.path` and `sealed.transcript` check every path a commit
  adds, renames or copies, whatever its content (binary, empty, deleted again
  in a later commit); `sealed.answer`, `sealed.seed` and `sealed.local_path`
  (`/home/<user>/`, `/Users/<user>/`, `C:\Users\<user>\`, including after a shell
  default such as `${VAR:-…}` or `${VAR-…}`) check each commit's added lines.
  Known limit: a path glued to the text before it, by a hyphen (`docs-…`,
  `$VAR-…`, `${VAR}-…`) or a letter (`-I…`, `-L…`), is not matched. Findings print rule, `file[:line]` and commit, never the text.
- **Globs.** `paths`, `transcripts` and `allow_paths` match the whole
  repo-relative path from the repository root. `*` and `?` stay inside one
  path segment; `**/` spans zero or more directories; a `**` not followed by
  `/` matches across directories (`heldout/**` covers every depth under
  `heldout/`); `[` and `{` are literal. So `sealed/**` misses `tasks/x/sealed/a.json`:
  to guard a `sealed/` directory wherever it sits, write `**/sealed/**`.
- **Case.** Matching is case-sensitive. `case_insensitive: true` folds case
  for `paths` and `transcripts` only, so `**/heldout/**` also catches
  `HELDOUT/` and `HeldOut/`. Separator and spelling variants (`hold-out/`,
  `held_out/`, `heldout-v2/`) are not folded: list each as its own glob.
  The effective value is the base branch's OR the pushed one (it only tightens).
- **Exceptions.** `allow_paths` exempts publishable files that sit next to
  sealed data (a `MANIFEST.json` of hashes and counts) from `sealed.path` and
  `sealed.transcript`, applied after the deny globs and before waivers. They
  are read from the destination base branch only: an exception a push adds
  takes effect once it lands on the base branch, so a branch can never widen
  its own. They never fold case. An entry whose file name contains `**`, or
  is only wildcards before its extension (`**`, `sealed/*`, `**/*.json`,
  `sealed/**.json`), is refused; a partial wildcard such as `MANIFEST*.json`
  is accepted and matches every file it spells, so name the file. An exempt file is checked by the
  text rules only, so configure `answer_markers` when you exempt files next to
  sealed data. Each exempt path is listed on every push (`exempt <rule>
  <file> commit <sha> (sealed.allow_paths <glob>)`) and counted as
  `exempt=<n>` on the `SEALED:` line.
- **Label joins.** Off unless `label_keys` names at least one field. Then
  `sealed.label_join` refuses a published record that puts a label field next
  to an identifier, the way a panel row with `stratum` beside `head` and
  `plan_bytes` tells a model under test which unit it is. A record is a JSON
  object at any depth (its own fields plus one level of nested objects, named
  like `meta.head`), a JSONL or NDJSON line, a CSV or TSV row, or a row of a
  Markdown pipe table (CSV and TSV cells may be quoted). Field names and table headers are compared after
  trimming, lowercasing and turning spaces and hyphens into underscores
  (`Tree SHA-256` is `tree_sha_256`); this is the rule's own normalization,
  separate from `case_insensitive`. An identifier is a field whose name
  matches an `identifier_keys` glob (`*` is the only wildcard; the default
  is `head`, `head_sha`, `sha`, `commit`, `tree`, `tree_sha*`, `*_sha`,
  `*_sha256`, `sha256`, `digest`, `*_digest`, `hash`, `*_hash`,
  `*_bytes`, `bytes`, `size`, `files`, `lines`), or any string value (or a
  list holding one) of 7 to 64 hex characters with at least one digit and
  one letter a to f. An
  object key of that shape counts as an identifier of the object it holds
  (shown as `(key)`), so a map keyed by sha joins too. Numbers count only
  through the field name. A field can be both a label and an identifier, and
  a record joins when it has a label field and a different identifier field,
  so adding identifier names to `label_keys` never hides a join. Both lists take bare field names: a nested field
  matches by its own name (`stratum`, never `meta.stratum`). For each supported file a commit adds,
  modifies, renames or copies, the guard fingerprints every joined record
  (sha256 over its label and identifier fields and their values, kept in
  memory) and compares the set with the parent's version of the file (the
  rename or copy source; every parent for a merge). A fingerprint no parent
  has is a finding, so unchanged records and formatting-only edits stay clear,
  and a replaced, added or widened record refuses even when the count stays
  the same. A file whose text never names a label key, ignoring double
  quotes (so `"Strat"um` still names `stratum`), cannot hold a join, so
  it is skipped without parsing (a commented `tsconfig.json` passes). A file
  with a `\u` escape, which could spell a label key, is always parsed, so a
  commented one is `sealed.label_join_unchecked`. A
  supported file over 4 MiB, one that names a label key and does not parse (one bad
  JSONL line is enough), one nested deeper than 64 levels, or a blob git
  cannot read is `sealed.label_join_unchecked`. It refuses too, and the
  `SEALED:` line counts it as `unchecked=<n>`. Findings print field names
  (`keys=`, label fields first), never values; `--json` carries them as
  `keys`. `allow_paths` never exempt either rule; a base-branch waiver does.
  Both lists are the union of the base branch's and the pushed policy's, each
  resolved to its default first, so a push can turn the rule on or widen it
  but never turn it off or narrow it. Without `label_keys` the guard reads no
  file contents and its output is unchanged. Known limits: joins across files,
  joins by reference inside a file (a `decoy_set` list naming units described
  elsewhere), a map from an identifier straight to a label value with no
  label field name, columnar JSON (`columns` plus `rows`), labels encoded in
  file names, and prose.
- **Version skew.** A gstack older than the release that adds a `sealed` key
  refuses it as unknown, so every push and `gstack-pregate run` in the
  repository fail on that machine. `allow_paths` and `case_insensitive` came
  with the release whose CHANGELOG adds `sealed.allow_paths`; `label_keys`
  and `identifier_keys` came with the release whose CHANGELOG adds
  `sealed.label_join`. Raise `min_gstack_version` in
  `.gstack/ship-policy.json` to that release before landing the key.
- **Policy.** The union of the destination base branch's `sealed` and the
  pushed commit's: a push can tighten it, never relax it (`allow_paths` come
  from the base branch alone, and a pushed deny glob cannot override one). The
  `SEALED:` line names both as `policy=<remote>/<base> + commit <sha12>`.
  `gstack-pregate sealed` only checks and never pushes, so confirm a push with
  `git ls-remote <remote> <ref>`. A malformed or
  unreadable policy refuses. Waivers come only from the base branch's
  `.gstack/sealed-allow.tsv` (`rule<TAB>path<TAB>sha<TAB>reason`) and are
  listed on every push. A waiver counts only when `sha` is the finding's full
  commit sha (40 hex characters, 64 in a SHA-256 repository); a shortened or
  mistyped one is ignored, so the finding still refuses, and stderr names it
  (`ignored waiver <rule>  <path>  sha <value> (...)`) with the finding's full
  commit, which needs a review before anyone waives it.
  `--json` lists them as `ignoredWaivers`.
- **Visibility.** `sealed.visibility` from the base branch, else a cache under
  the state root (`sealed-visibility.json`: a `public` answer for 24 hours, a
  `private` one for 1 hour before it may turn a refusal into a warning), else
  `gh repo view --json visibility` (5 s). Unknown, unreadable or newly created
  counts as public. Public refuses (`SEALED_OUTPUT_REFUSED`, exit 1); private
  warns.

Capy's pull-request tool may not run local git hooks, so an agent runs
`gstack-pregate sealed` before any push or PR creation in a repo with a
`sealed` config (the coordinator contract says so). Hosted CI on the public
repository only detects a bypass after the upload.

<a id="regate"></a>
## `gstack-pregate regate`: does the gate still cover HEAD

```
gstack-pregate regate --against <gated-head> --bundle <evidence-bundle.json> [--require <lane,...>]
                      [--pr <n>] [--from <gate-ahead.json>] [--predecessor-pr <n> | --predecessor-ref <ref>]
                      [--base <branch>] [--json]
gstack-pregate --against <gated-head> ...      the same verb
```

It evaluates a tree receipt now (never a stored one) between the gated head
and HEAD under the base branch's ship policy, so the repo's `stamp_files` and
`stamp_patterns` decide what a stamp is ([ship-policy](ship-policy.md#tree-receipt)).
Reuse needs an evidence bundle produced on the gated tree, the same execution
identity, and a predecessor head that is still the recorded one (read from
`--from`, default `.gstack/tmp/gate-ahead.json` when it names this gated
head). It prints each differing file (a non-stamp difference with its first
line), then:

```
STAMP_ONLY: yes|no files=<n> [changed=<n>]
LANE: <label> reusable|rerun|not-reusable (<reason>)      one per bundle lane and per --require lane
MIGRATION_COLLISION: none (...) | unknown (...) | <id> <file> vs <origin/main|PR #n> <file>
REGATE: not-needed | needed (<every reason>)
```

`REGATE: not-needed` (exit 0) only when the tree is stamp-only, every lane in
the bundle and in `--require` is reusable (a stamp-sensitive lane reruns, so it
needs a regate), the predecessor head is known and unmoved, and the migration
lookup finished with no collision. Anything else is `needed` (exit 1); no
bundle prints `REGATE: needed (no gate evidence for <head> ...)`.

Migrations come from the ship policy's `migrations` (`dir`, `id` regex with
one capture group). The numbers this branch adds under `dir` are compared with
the base branch's tree and with every other open PR
(`gh pr list --state open --limit 1000 --json number,headRefOid,files`; the PR
itself is skipped by head sha or `--pr`). A PR listing 100 files is truncated
by GitHub, so its full list is fetched with `gh api --paginate`. A failed
query, 1000 listed PRs or an unfetchable file list is
`MIGRATION_COLLISION: unknown (...)`, which blocks `not-needed`
([`MIGRATION_COLLISION`](troubleshooting.md#migration-collision)).

<a id="gbrain-worked-configs"></a>
## gbrain worked configs

gbrain commits these on master after the gstack that reads the new keys ships
(older gstack refuses unknown keys). Its `.gitignore` ignores `.gstack/*`
today, so the change also adds `!.gstack/pregate.json` and
`!.gstack/ship-policy.json`; both changes are gbrain's.

`.gstack/pregate.json`: guards for the gates the import graph cannot see.

```json
{
  "dependencies": {
    "test/**/*.serial.test.ts": ["test/scripts/serial-files.test.ts"],
    "scripts/serial-files.tsv": ["test/scripts/serial-files.test.ts"],
    "src/cli.ts": ["test/cli-goldens.test.ts"],
    "src/commands/**": ["test/cli-goldens.test.ts"],
    "src/core/operations*.ts": ["test/cli-goldens.test.ts"]
  },
  "guards": [
    { "id": "serial-manifest", "when": ["test/**/*.serial.test.ts", "scripts/serial-files.tsv", "scripts/run-serial-tests.sh"],
      "command": "bun test test/scripts/serial-files.test.ts",
      "fix": "add the serial file's row to scripts/serial-files.tsv" },
    { "id": "cli-goldens", "when": ["src/cli.ts", "src/cli/**", "src/commands/**", "src/core/operations*.ts", "src/core/ops/**"],
      "command": "bun test --timeout=60000 test/cli-goldens.test.ts test/cli-dispatch-phase.test.ts test/export-surface-golden.test.ts",
      "fix": "bun run regen:all, then justify each changed golden in the PR body" },
    { "id": "regen-check", "when": ["src/**", "skills/**", "templates/**", "plugin/**"],
      "command": "bun scripts/regen-all.ts --check",
      "fix": "bun run regen:all and commit the regenerated files" },
    { "id": "migration-order", "when": ["src/core/schema-migrations/**"],
      "command": "bun scripts/check-schema-migration-order.ts",
      "fix": "renumber the migration to the next free number on master" }
  ]
}
```

`.gstack/ship-policy.json`: the stamp rule and migrations. On a pure restamp
of a gbrain master tree from 0.60.188.0 to 0.60.189.0 the tree receipt
classifies all 16 changed files as stamps under this policy; an added line in
`src/core/behavior-change-notice.ts` stays a change.

```json
{
  "bump": "patch",
  "queue_mode": "stamp-at-merge",
  "changelog": "CHANGELOG.md",
  "stamp_files": [
    "VERSION", "package.json", "CHANGELOG.md", "openclaw.plugin.json",
    ".claude-plugin/plugin.json", ".codex-plugin/plugin.json",
    "plugin-variants/*/.claude-plugin/plugin.json", "plugin-variants/*/.codex-plugin/plugin.json",
    "plugin-variants/*/README.md", "plugin/README.md",
    "BOOTSTRAP_FOR_AGENTS.md", "templates/bootstrap/template-repo/README.md",
    "src/core/behavior-change-notice.ts"
  ],
  "stamp_patterns": [
    "\"version\": \"{version}\"",
    "since: '{version}'",
    "<!-- gbrain-plugin-tree-stamp: {version} -->",
    "<!-- gbrain-template-stamp: {version} -->",
    "<!-- gbrain-runbook-stamp: {version} -->"
  ],
  "migrations": { "dir": "src/core/schema-migrations", "id": "^v(\\d+)-" }
}
```

gbrain's `bun run release:restamp` fetches master, picks its own version,
refuses a dirty tree and commits, so it cannot be `restamp_command` as it
stands; the stamp rule above lets gstack's own restamp writer do the work.
A gbrain mode that takes the version and writes only stamps would make it one.

gbrain-evals `.gstack/pregate.json`: the sealed paths. The globs below are
placeholders in the shape the guard reads; gbrain-evals fills in its own
held-out and transcript layout.

```json
{ "sealed": {
    "paths": ["heldout/**"],
    "transcripts": ["runs/**/transcript*.jsonl"],
    "answer_markers": ["SEALED ANSWER:"],
    "seed_patterns": ["shuffle_seed=\\d+"],
    "local_paths": true } }
```

<a id="issue-links"></a>
## `gstack-issue-links`

```
gstack-issue-links [--base <ref>] [--issue <n>]... [--ci-run <id>]... [--supersedes <pr>]... [--credit <pr>]...
                   [--no-auto-links] [--author <login>] [--repo <owner/repo>] [--out issues.json] [--json]
```

Reads `origin/<base>..HEAD`. `Fixes #N` only on explicit closure intent: a
`Fixes`/`Closes`/`Resolves #N` trailer line or `--issue N`. A bare mention
(a subject's `(#N)` included), a partial fix, a deferred ask and every
cross-repo `owner/repo#N` are `Refs`. A parenthesised named reference,
`(name #N, #M)`, `(name PR #N)` or `(name issue #N)`, where the name is one
token that is not a closure, reference, filler or version word, is a
cross-repo `Refs name#N`, never a same-repo Refs line or a promotion
candidate; `(see #12)`, `(closing #12)` and `(#301)` stay bare refs.
Same-repo references are printed as
promotion candidates (`reference #N ← <commit line> (promote: fix #N)` on
stderr, `candidates` in `--json`): the owner's `fix #N` reply reruns with
`--issue N`; an unattended run keeps them `Refs` and lists them in the
handoff. Each closure issue is read through `gstack-issue-guard`; one that
cannot be read is `Refs #N (unreadable …)` with `ISSUE_UNREADABLE` (exit 1),
never `Fixes`.

Each `--ci-run <id>` is searched among open issues whose body names it and
rendered `Flake: #N (run <id>)` only for a bot-opened issue of this repository
that names that run (its `flake:json` `first_seen.run_id`, or this repository's
`actions/runs/<id>` URL) and a test (`flake:json` `file › test`, or a
`Flake: <test>` title). Two issues for the same test keep the lower number;
every refused match is printed with its reason.

Open PRs by other authors (not this branch, and not this PR's author: `--author`,
else the `gh` viewer; when the viewer is an app such as `capy-ai[bot]`, the HEAD
commit's GitHub user, else the owner of a user-owned repository, else the gap is
`ISSUE_LOOKUP_FAILED`) whose closing
set overlaps this PR's `Fixes` are `Related: #N (@author)`, read page by page
from each issue's closing-PR references, in unattended runs too. `Supersedes #N`
replaces that line and `Contributed by @author` is added (the credit lines of
`lib/contributor-mode.ts`) only with `--supersedes N` / `--credit N`, after the
owner confirms.
`--no-auto-links` skips the lookup. A failed lookup prints `ISSUE_LOOKUP_FAILED`
and keeps the other lines. The stderr preview names the source of each line.

The printed lines go under `## Issues` in the PR body; `--out` writes the
object (`fixes`, `refs`, `flakes`, `related`) `gstack-ship-receipt write
--issues @file` embeds. With `--body`, that write refuses a body missing any of
those lines (`ISSUE_LINKS_MISSING`).
