---
name: gstack-ship
description: Execute deterministic shell-driven release steps for a ready branch.
---

# gstack-ship

Use this skill when the user says `/ship` or wants deterministic shell-driven release steps for a ready branch.

## First steps

1. Read `../../../references/workflows/ship.md`.
2. Read `../../../references/workflows/review.md` if a pre-landing review has not already been done.

## Tool expectations

- Execute the repo’s real validation and release commands.
- Prefer documented wrappers and scripts over ad hoc command chains.
- Stop on merge conflicts, failing validation, or missing release prerequisites.
- Use Codex-native user input only when a real release decision is required.

## Boundaries

- Do not ship from `main`.
- Do not invent project commands that the repo does not actually have.
