---
name: gstack-ship
preamble-tier: 4
version: 1.0.0
description: >-
  Agent entry for gstack ship. Claude Code's built-in /ship shadows the flat ship
  skill; invoke gstack-ship so the ~/dev PR gate can arm clearance. (gstack)
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
triggers:
  - gstack-ship
  - ship this branch
  - open a pr with gstack ship
---

# gstack-ship (agent alias)

This directory is a **thin alias** only. The workflow body lives in the canonical
gstack ship skill and changes on every `gstack` upgrade.

## Run the real workflow

1. Resolve gstack root, then read the canonical skill **in full** before any step:

```bash
[ -d "${GSTACK_ROOT:-/-}/bin" ]&&[ -d "$GSTACK_ROOT/ship" ]||GSTACK_ROOT=~/.claude/skills/gstack
[ -f "$GSTACK_ROOT/ship/SKILL.md" ]||GSTACK_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)/.cursor/skills/gstack
```

**Read** `$GSTACK_ROOT/ship/SKILL.md` with the Read tool and follow it step by step
(starting at its Preamble / Step 0). Section paths in that file are relative to
`$GSTACK_ROOT/ship/`. Do not work from memory.

2. Run skill-start for **`ship`** (not `gstack-ship`), exactly as the canonical preamble
   specifies: `"$GSTACK_ROOT/bin/gstack-skill-start" --skill "ship" --model "claude"`.

3. `sections/` beside this file is a symlink to `$GSTACK_ROOT/ship/sections/` so any
   relative `sections/...` reads from the alias path still resolve after upgrades.

Humans may still type `/ship` in panes where the built-in command is intended; agents
should use this skill (Skill tool: `gstack-ship`) when they need the gstack ship workflow.

Install: run `./setup` from the gstack checkout (see `gstack-ship/README.md`).