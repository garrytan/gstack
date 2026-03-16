---
name: gstack-plan-eng-review
description: Pressure-test a plan technically for architecture, failure modes, rollout, and tests.
---

# gstack-plan-eng-review

Use this skill when the user says `/plan-eng-review` or wants technical review of a plan before implementation.

## First steps

1. Read `../../../references/workflows/plan-eng-review.md`.
2. Read `../../../references/workflows/compatibility.md` if the request used slash-style aliases.

## Tool expectations

- Audit the existing system surface first.
- Review architecture, failure modes, security, rollout, rollback, and tests.
- Prefer concrete diagrams and explicit invariants over generic advice.
- Use Codex-native user input only for real architecture or scope decisions.

## Boundaries

- Do not start implementing in this mode.
