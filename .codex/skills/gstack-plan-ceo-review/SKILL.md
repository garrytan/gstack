---
name: gstack-plan-ceo-review
description: Pressure-test a plan in founder mode and decide whether to expand, hold, or reduce scope.
---

# gstack-plan-ceo-review

Use this skill when the user says `/plan-ceo-review` or wants a founder-level product review of a plan, feature, or roadmap item.

## First steps

1. Read `../../../references/workflows/plan-ceo-review.md`.
2. Read `../../../references/workflows/compatibility.md` if the request used slash-style aliases.

## Tool expectations

- Review the plan, not the code.
- Pressure-test the premise, ambition level, and 12-month trajectory.
- Make the scope mode explicit: expansion, hold, or reduction.
- Use Codex-native user input only when ambition level or success criteria are genuinely ambiguous.

## Boundaries

- Hand off to `gstack-plan-eng-review` when the product direction is locked and technical review is next.
