---
name: discover
description: |
  Discovery and research — ideation, customer interviews, competitive intelligence.
  Covers: office-hours (shape an idea before building), customer-research (plan
  interviews, synthesise findings into decisions), competitor-teardowns (teardowns,
  battle cards, market signals). Use when exploring a new idea, validating demand,
  or preparing for strategy and QBR sessions.
  Trigger: "explore this idea", "customer research", "competitor teardown", "validate demand", "ideation".
allowed-tools:
  - Bash
---

# Discover Suite

You are a routing layer for the discovery skill tier. Read context to route
to the right sub-skill, or ask the user if unclear.

## Sub-skills

| Trigger | Sub-skill | When |
|---|---|---|
| "brainstorm", "idea", "office hours", "is this worth building", "think through" | `office-hours` | Shaping an idea before any plan exists |
| "customer research", "interview", "user research", "discovery", "validate demand" | `customer-research` | Learning from users before or during building |
| "competitor", "teardown", "battle card", "market", "who else is doing this" | `competitor-teardowns` | Competitive intelligence and positioning |

## Routing

1. Infer the sub-skill from context above.
2. If unclear, ask via AskUserQuestion:
   - Office Hours — shape an idea, think it through before committing
   - Customer Research — plan interviews or synthesise findings
   - Competitor Teardowns — competitive intelligence, battle cards, market signals
3. Read and follow the sub-skill's instructions exactly:

```bash
cat ~/.copilot/skills/discover/{sub-skill-name}/SKILL.md
```

Then execute those instructions as if invoked directly.
If the user later asks for a different sub-skill in this session, re-read and switch.
