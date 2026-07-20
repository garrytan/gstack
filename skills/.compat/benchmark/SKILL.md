---
name: benchmark
description: >-
  Compatibility alias for the retired /benchmark command. Routes to $qa --mode Report --module benchmark without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /benchmark

Print this replacement invocation, then dispatch to it exactly:

`$qa --mode Report --module benchmark`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `benchmark` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack/skills --skill qa`.
