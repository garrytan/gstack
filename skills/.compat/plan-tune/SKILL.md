---
name: plan-tune
description: >-
  Compatibility alias for the retired /plan-tune command. Routes to $plan --mode Discovery --module plan-tune without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /plan-tune

Print this replacement invocation, then dispatch to it exactly:

`$plan --mode Discovery --module plan-tune`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `plan-tune` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack/skills --skill plan`.
