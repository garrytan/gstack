# Demo businesses

This folder contains small, runnable business scenarios for testing agent logic
inside gstack.

## Current demo

- `northstar-pantry/` — a fictional subscription snack company with:
  - `agent-logic/` for the decision rules,
  - `gbrain/` for persistent-memory samples,
  - `data/` for live business state,
  - `run_demo.py` for the executable walkthrough.

## Why this exists

The point is to give gstack something concrete to reason about:

1. the business state changes,
2. the agent checks memory,
3. the agent picks the highest-value action,
4. the decision can be replayed and tested.

If you want more scenarios later, add another subfolder next to
`northstar-pantry/`.
