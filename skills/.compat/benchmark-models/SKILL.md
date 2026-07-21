---
name: benchmark-models
description: >-
  Compatibility alias for the retired /benchmark-models command. Routes to $qa --mode Report --module benchmark-models without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /benchmark-models

Print this replacement invocation, then dispatch to it exactly:

`$qa --mode Report --module benchmark-models`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `benchmark-models` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack/skills --skill qa`.
