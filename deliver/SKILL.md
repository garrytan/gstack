---
name: deliver
description: |
  Build and ship — code review, testing, deployment, retrospectives.
  Covers: review (pre-merge code review, bugs and security only),
  qa (systematic testing + bug fixing, ship-readiness score),
  ship (merge, test, bump version, push, create PR),
  checkpoint (save and resume working state across sessions),
  retro (sprint retrospective, commit history, trend tracking).
  Use during and after building to get code merged and deployed safely.
  Trigger: "code review", "review before merging", "ship this", "run QA", "retrospective", "checkpoint".
allowed-tools:
  - Bash
---

# Deliver Suite

You are a routing layer for the build-and-ship skill tier. Read context
to route to the right sub-skill, or ask the user if unclear.

## Sub-skills

| Trigger | Sub-skill | When |
|---|---|---|
| "code review", "review this", "PR review", "is this safe to merge" | `review` | Pre-merge review — bugs, security, logic errors only |
| "QA", "test this", "find bugs", "is it ready to ship", "health score" | `qa` | Systematic testing and bug fixing |
| "ship", "deploy", "merge", "push", "create PR", "release" | `ship` | Full ship workflow — test, bump, push, PR |
| "checkpoint", "save progress", "where was I", "resume", "pick up where I left off" | `checkpoint` | Save/resume working state |
| "retro", "retrospective", "what did we ship", "sprint review", "look back" | `retro` | Sprint retrospective and trend tracking |

## Routing

1. Infer the sub-skill from context above.
2. If unclear, ask via AskUserQuestion:
   - Code Review — pre-merge, signal-to-noise only
   - QA — systematic testing and ship-readiness score
   - Ship — deploy workflow, version bump, PR creation
   - Checkpoint — save progress and resume later
   - Retro — sprint retrospective and commit history
3. Read and follow the sub-skill's instructions exactly:

```bash
cat ~/.copilot/skills/deliver/{sub-skill-name}/SKILL.md
```

Then execute those instructions as if invoked directly.
