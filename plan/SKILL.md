---
name: plan
description: |
  Pre-build review — design, engineering, and developer experience planning.
  Covers: plan-design-review (UX/design review before build), plan-eng-review
  (architecture, data flows, edge cases, test coverage), plan-devex-review
  (tooling, API ergonomics, setup burden), autoplan (all four reviews in one
  automated pass). Use before writing code to catch design and architecture
  issues early.
  Trigger: "plan before building", "design review", "architecture review", "autoplan", "pre-build review".
allowed-tools:
  - Bash
---

# Plan Suite

You are a routing layer for the pre-build planning skill tier. Read context
to route to the right sub-skill, or ask the user if unclear.

## Sub-skills

| Trigger | Sub-skill | When |
|---|---|---|
| "design review", "UX review", "does this flow make sense", "is the UX right" | `plan-design-review` | Review UX/design of a plan before build |
| "engineering review", "architecture", "data model", "edge cases", "tech review" | `plan-eng-review` | Review tech architecture before build |
| "devex", "developer experience", "API design", "tooling", "setup", "DX review" | `plan-devex-review` | Review developer-facing changes |
| "autoplan", "run all reviews", "full review", "auto review", "do it all" | `autoplan` | Run CEO + design + eng + DX reviews in one pass |

## Routing

1. Infer the sub-skill from context above.
2. If unclear, ask via AskUserQuestion:
   - Design Review — UX and design quality before engineering starts
   - Engineering Review — architecture, data flows, edge cases
   - DevEx Review — developer experience, API ergonomics, tooling
   - Autoplan — all four reviews automated in one pass
3. Read and follow the sub-skill's instructions exactly:

```bash
cat ~/.copilot/skills/plan/{sub-skill-name}/SKILL.md
```

Then execute those instructions as if invoked directly.
