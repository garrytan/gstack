# Architecture

This document explains **why** gstack is built the way it is. For setup and commands, see CLAUDE.md. For contributing, see CONTRIBUTING.md.

## The core idea

gstack gives Claude Code a set of opinionated workflow skills and browser automation via [agent-browser](https://github.com/vercel-labs/agent-browser). The browser is a Rust-based CLI maintained by Vercel — gstack focuses on skills, not browser infrastructure.

```
Claude Code                     gstack
─────────                      ──────
                               ┌──────────────────────┐
  Tool call:                   │  agent-browser CLI    │
  agent-browser snapshot -i    │  (installed globally) │
  ─────────────────────────→   │  • Rust CDP client    │
                               │  • persistent daemon  │
                               │  • accessibility tree │
                               └──────────────────────┘
```

agent-browser provides 50+ commands, the same `@e` ref concept for element selection, and a persistent daemon model. First call starts the browser (~3s). Every call after: sub-second.

## The ref system

Refs (`@e1`, `@e2`, etc.) are how the agent addresses page elements without writing CSS selectors or XPath.

### How it works

```
1. Agent runs: agent-browser snapshot -i
2. agent-browser produces an accessibility tree with refs: @e1, @e2, @e3...
3. Agent runs: agent-browser click @e3
4. agent-browser resolves @e3 and clicks the element
```

No DOM mutation. No injected scripts. The accessibility tree is the source of truth.

## SKILL.md template system

### The problem

SKILL.md files tell Claude how to use the agent-browser commands. If the docs list a flag that doesn't exist, or miss a command that was added, the agent hits errors. Hand-maintained docs always drift from code.

### The solution

```
SKILL.md.tmpl          (human-written prose + placeholders)
       ↓
gen-skill-docs.ts      (reads source code metadata)
       ↓
SKILL.md               (committed, auto-generated sections)
```

Templates contain the workflows, tips, and examples that require human judgment. The `{{COMMAND_REFERENCE}}` and `{{SNAPSHOT_FLAGS}}` placeholders are filled from `lib/agent-browser-commands.ts` and `lib/snapshot-flags.ts` at build time. This is structurally sound — if a command exists in the registry, it appears in docs. If it doesn't exist, it can't appear.

### Why committed, not generated at runtime?

Three reasons:

1. **Claude reads SKILL.md at skill load time.** There's no build step when a user invokes a skill. The file must already exist and be correct.
2. **CI can validate freshness.** `gen:skill-docs --dry-run` + `git diff --exit-code` catches stale docs before merge.
3. **Git blame works.** You can see when a command was added and in which commit.

### Template test tiers

| Tier | What | Cost | Speed |
|------|------|------|-------|
| 1 — Static validation | Parse every `agent-browser` command in SKILL.md, validate against registry | Free | <2s |
| 2 — E2E via `claude -p` | Spawn real Claude session, run each skill, check for errors | ~$3.85 | ~20min |
| 3 — LLM-as-judge | Sonnet scores docs on clarity/completeness/actionability | ~$0.15 | ~30s |

Tier 1 runs on every `bun test`. Tiers 2+3 are gated behind `EVALS=1`. The idea is: catch 95% of issues for free, use LLMs only for judgment calls.

## Command registry

Commands are categorized by side effects:

- **READ** (get text, get html, eval, get styles, ...): No mutations. Safe to retry. Returns page state.
- **WRITE** (open, click, fill, press, ...): Mutates page state. Not idempotent.
- **META** (snapshot, screenshot, tab, ...): Server-level operations that don't fit neatly into read/write.

The registry in `lib/agent-browser-commands.ts` exports `ALL_COMMANDS`, `COMMAND_DESCRIPTIONS`, `READ_COMMANDS`, `WRITE_COMMANDS`, and `META_COMMANDS`. These sets drive doc generation, skill validation, and the health dashboard.

## Error philosophy

Errors are for AI agents, not humans. Every error message must be actionable:

- "Element not found" → "Element not found or not interactable. Run `snapshot -i` to see available elements."
- "Selector matched multiple elements" → "Use @refs from `snapshot` instead."
- Timeout → "Navigation timed out. The page may be slow or the URL may be wrong."

The agent should be able to read the error and know what to do next without human intervention.

## E2E test infrastructure

### Session runner (`test/helpers/session-runner.ts`)

E2E tests spawn `claude -p` as a completely independent subprocess — not via the Agent SDK, which can't nest inside Claude Code sessions. The runner:

1. Writes the prompt to a temp file (avoids shell escaping issues)
2. Spawns `sh -c 'cat prompt | claude -p --output-format stream-json --verbose'`
3. Streams NDJSON from stdout for real-time progress
4. Races against a configurable timeout
5. Parses the full NDJSON transcript into structured results

The `parseNDJSON()` function is pure — no I/O, no side effects — making it independently testable.

### Eval persistence (`test/helpers/eval-store.ts`)

The `EvalCollector` accumulates test results and writes them in two ways:

1. **Incremental:** `savePartial()` writes `_partial-e2e.json` after each test (atomic: write `.tmp`, `fs.renameSync`). Survives kills.
2. **Final:** `finalize()` writes a timestamped eval file (e.g. `e2e-20260314-143022.json`). The partial file is never cleaned up — it persists alongside the final file for observability.

`eval:compare` diffs two eval runs. `eval:summary` aggregates stats across all runs in `~/.gstack-dev/evals/`.

### Test tiers

| Tier | What | Cost | Speed |
|------|------|------|-------|
| 1 — Static validation | Parse `agent-browser` commands, validate against registry, observability unit tests | Free | <5s |
| 2 — E2E via `claude -p` | Spawn real Claude session, run each skill, scan for errors | ~$3.85 | ~20min |
| 3 — LLM-as-judge | Sonnet scores docs on clarity/completeness/actionability | ~$0.15 | ~30s |

Tier 1 runs on every `bun test`. Tiers 2+3 are gated behind `EVALS=1`. The idea: catch 95% of issues for free, use LLMs only for judgment calls and integration testing.

## What's intentionally not here

- **No custom browser infrastructure.** agent-browser handles the Chromium daemon, CDP, and all browser lifecycle. gstack focuses on skills and workflow.
- **No MCP protocol.** MCP adds JSON schema overhead per request and requires a persistent connection. Plain CLI + plain text output is lighter on tokens and easier to debug.
- **No multi-user support.** One agent-browser session per workspace, one user.
