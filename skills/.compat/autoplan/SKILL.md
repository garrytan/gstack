---
name: autoplan
description: >-
  Compatibility alias for the retired /autoplan command. Routes to $plan --mode Full chain --module autoplan without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /autoplan

Print this replacement invocation, then dispatch to it exactly:

`$plan --mode Full chain --module autoplan`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `autoplan` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack/skills --skill plan`.
