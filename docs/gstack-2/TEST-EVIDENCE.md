# GStack 2.0 baseline test evidence

Scope: detached base worktree `/tmp/gstack2-baseline.e2qk7F`, commit
`bb57306d98c97011b0919c6132705a15b1579781`, captured 2026-07-16. These are
baseline observations only; no result below was produced by the GStack 2.0
implementation.

## Command ledger

| Command | Evidence | Observed result |
|---|---|---|
| `bun install` | `/tmp/gstack2-baseline-logs/bun-install.log` | Completed; Bun 1.3.14 reported 297 packages installed. |
| `bun run gen:skill-docs --host all` | `/tmp/gstack2-baseline-logs/gen-all.log` | Reached the final GBrain token table and `llms.txt` summary (`55 skills, 76 browse commands`); no error marker is present. |
| `bun run skill:check` | `/tmp/gstack2-baseline-logs/skill-check.log` | **Exit 1**: `claude/SKILL.md — generated file missing`. The same run reported 54/54 outputs for each of the 10 hosts and fresh generated files, but the missing primary output keeps the command red. |
| `bun run build` | `/tmp/gstack2-baseline-logs/build.log` | Reached the final Node-compatible server bundle (`server-node.mjs`, 0.83 MB); no error marker is present. |
| `bun test` | `/tmp/gstack2-baseline-logs/bun-test.log` | **Not green and incompletely terminated**: 4,292 `(pass)` markers, 488 `(skip)` markers, seven explicit `(fail)` markers, and one unhandled between-tests error. The capture ends after `browse/test/findport.test.ts` without Bun's aggregate summary or exit record. |
| `bun run test:windows` | `/tmp/gstack2-baseline-logs/test-windows.log` | **Exit 1** on shard 5/20. The runner selected 189 Windows-safe files and excluded 155. Completed shard summaries contain 593 passes, 14 skips, and one failed test before the run stopped. |
| `bun test design/test` | `/tmp/gstack2-baseline-logs/design-test.log` | **Not green**: 64 pass markers and one explicit failure. The log ends on daemon shutdown without an aggregate summary or exit record. |
| `bun test ios-qa/daemon/test` | `/tmp/gstack2-baseline-logs/ios-daemon-test.log` | **Pass**: 91 pass, 0 fail, 217 assertions across 10 files. |

`/tmp/gstack2-baseline-logs/git-status-after.txt` is empty, recording no status
entries after the runner. The logs are external audit artifacts and are not
vendored into the repository.

## Pre-existing `bun test` failures

The broad-suite log records these seven explicit failures:

1. `gstack-decision-search --recent / --scope / datamark > --scope filters by scope`
   expected output containing `branch-call` and received an empty string.
2. `gstack-gbrain-detect > emits valid JSON even when nothing is configured`
   expected status 0 and received 127.
3. `gstack-gbrain-detect > reports gstack_brain_git: true when GSTACK_HOME has a .git dir`
   attempted to parse empty output and raised `Unexpected EOF`.
4. `gstack-gbrain-detect > reports gbrain_config + engine when ~/.gbrain/config.json exists`
   attempted to parse empty output and raised `Unexpected EOF`.
5. `gstack-gbrain-detect > malformed config returns null engine, does not crash`
   expected status 0 and received 127.
6. `gstack-gbrain-detect > detects a mocked gbrain binary on PATH and reports its version`
   expected status 0 and received 127.
7. `resolve-user-slug fallback chain > persists resolution to user_slug_at_<hash> on first call`
   expected a hashed key and observed `user_slug_at_local: persisttest`.

Separately, `test/gbrain-refresh-install-render.test.ts` raised an unhandled
between-tests error: `Could not locate gbrain-refresh ok) branch`. Because the
log has no terminal Bun summary, the marker counts are evidence of what ran,
not a claim that all files were reached or that the command had only those
failures.

## Other pre-existing failures

- `skill:check`: the primary `claude/SKILL.md` generated file was absent; the
  script explicitly exited with code 1.
- Windows-safe shard 5:
  `Source-level guard: terminal-agent > lazy spawn: claude PTY is spawned in message handler, not on upgrade`
  still looked for `spawnClaude(`, while the source excerpt used
  `maybeSpawnPty(...)`. The shard reported 82 pass / 1 skip / 1 fail and the
  remaining 15 shards did not run.
- Design target:
  `generateVariant Retry-After handling > HTTP-date: honors a future date with no extra leading exponential`
  expected a delay of at least 2,500 ms and observed 2,246 ms.

## What this evidence does not establish

- It does not establish a green baseline.
- It does not establish that GStack 2.0 preserves behavior; replacement
  contract tests have not yet been implemented.
- It does not turn incomplete logs into passes.
- It does not attribute these failures to later changes; every failure above
  was captured from the stated base SHA before GStack 2.0 work.
