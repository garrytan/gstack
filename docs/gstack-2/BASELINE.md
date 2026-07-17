# GStack 2.0 baseline

This is the measured starting point, not a completion claim. The audit was run
from detached base worktree `/tmp/gstack2-baseline.e2qk7F` at commit
`bb57306d98c97011b0919c6132705a15b1579781` on 2026-07-16.

## Skill surface and size

| Measure | Baseline |
|---|---:|
| Source `SKILL.md.tmpl` templates | 55 |
| Primary generated skill outputs | 54 |
| Generated section files | 16 |
| Primary surface | 61,093 lines / 3,301,287 bytes |
| Audited union | 67,996 lines / 3,695,876 bytes |
| Repeated preambles | 49 |
| Repeated-preamble footprint | 35,802 lines / 2,132,374 bytes |
| Generated hosts | 10 |

The 10 generated hosts observed in the generator/check logs are Claude Code,
OpenAI Codex CLI, Factory Droid, Kiro, OpenCode, Slate, Cursor, OpenClaw,
Hermes, and GBrain.

The catalog-token audit has two materially different numbers:

- Correct YAML parsing of the names and descriptions for 54 skills is about
  **1,100 token-equivalents**.
- The official buggy capture reported
  `captureBaseline().estTotalCatalogTokens = 4,214`. It applied the same
  four-characters-per-token estimate to **16,857 incorrectly parsed
  description bytes**. The 4,214 figure is therefore an instrument bug, not the
  real catalog cost.

These counts establish the consolidation problem: they do not by themselves
set a target or prove that any repeated instruction is safe to remove.

## Installer/discovery baseline

The old standard-container path has a concrete root-shadow failure. From the
detached base worktree, this command:

```bash
DISABLE_TELEMETRY=1 npx --yes skills add . --list
```

reported `Found 1 skill` and listed only the root `gstack` skill. Under the
skills CLI discovery rule, the shallower root `SKILL.md` is discovered first
and shadows discovery of the nested standard-container skills. Separately,
legacy `./setup` installs 54 host-specific skills. Thus “the legacy installer
works” is not evidence that the standard installer exposes the same surface;
both install roots and collision behavior need migration tests.

## Command baseline

The baseline runner recorded these commands:

```bash
bun install
bun run gen:skill-docs --host all
bun run skill:check
bun run build
bun test
bun run test:windows
bun test design/test
bun test ios-qa/daemon/test
```

Results are intentionally not summarized as “green”:

- dependency installation completed with 297 packages;
- all-host generation reached its final `llms.txt` summary;
- the build reached its final Node server bundle step;
- `skill:check` exited 1 because `claude/SKILL.md` was missing;
- the broad `bun test` capture contains seven explicit failed tests and one
  unhandled between-tests error, then ends without Bun's terminal summary or
  exit record;
- the Windows-safe run exited 1 on shard 5 of 20;
- the targeted design suite contains one failed timing assertion and no
  terminal summary;
- the targeted iOS daemon suite completed with 91 pass / 0 fail.

The precise assertions and log paths are in
[TEST-EVIDENCE.md](./TEST-EVIDENCE.md). An empty
`/tmp/gstack2-baseline-logs/git-status-after.txt` records no tracked/untracked
status output after the baseline runner, but it is not a substitute for test
success.

## Backlog baseline

The frozen API inputs contain 755 unique open GitHub items after reconciling
the issues endpoint (which also contains PRs) with the PR endpoint:

- `garrytan/gstack`: 748 items;
- `time-attack/gstack`: 7 items;
- 326 issues and 429 pull requests in total;
- 1,184 raw open-endpoint records, including 429 reconciled duplicates;
- 16 required upstream PRs with separate detail and changed-file snapshots.

See [BACKLOG-MAP.json](./BACKLOG-MAP.json) for the complete mapping and
`scripts/gstack2/generate-backlog-map.ts` for the deterministic, offline
generator.
