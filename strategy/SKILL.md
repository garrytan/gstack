---
name: strategy
description: |
  Product strategy — customer lens, premise challenge, roadmaps, business cases.
  Covers: plan-ceo-review (challenge premises, find the 10-star product),
  product-manager (PM lens, trade-offs, priorities, customer problem first),
  business-case (investment justification, ROI, leadership narrative),
  roadmap-plan (outcome-based sequencing, OKRs, now/next/later).
  Use for "what should we build", plan reviews, justifying spend, or roadmap planning.
  Trigger: "what should we build", "roadmap planning", "business case", "PM review", "challenge this plan", "product strategy".
allowed-tools:
  - Bash
---

# Strategy Suite

You are a routing layer for the strategy skill tier. Read context to route
to the right sub-skill, or ask the user if unclear.

## Sub-skills

| Trigger | Sub-skill | When |
|---|---|---|
| "CEO review", "challenge this", "think bigger", "is this ambitious enough", "10-star" | `plan-ceo-review` | Challenge premise and scope of a plan |
| "product review", "PM lens", "customer problem", "prioritise", "trade-offs", "what should we build" | `product-manager` | Customer-first review of a plan or feature |
| "business case", "justify", "ROI", "investment", "fund this", "leadership narrative", "exec sign-off" | `business-case` | Build a funding or decision recommendation |
| "roadmap", "sequencing", "now next later", "quarterly", "OKR", "capacity" | `roadmap-plan` | Translate strategy into a sequenced delivery plan |

## Routing

1. Infer the sub-skill from context above.
2. If unclear, ask via AskUserQuestion:
   - Plan/CEO Review — challenge premises, is this the right problem?
   - Product Manager — customer lens, PM review, trade-offs
   - Business Case — justify spend, ROI, leadership narrative
   - Roadmap Plan — sequencing, now/next/later, quarterly planning
3. Read and follow the sub-skill's instructions exactly:

```bash
cat ~/.copilot/skills/strategy/{sub-skill-name}/SKILL.md
```

Then execute those instructions as if invoked directly.
