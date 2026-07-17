---
name: plan-eng-review
description: >-
  Compatibility alias for the retired /plan-eng-review command. Routes to $plan --mode Engineering --module plan-eng-review without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /plan-eng-review

Print this replacement invocation, then dispatch to it exactly:

`$plan --mode Engineering --module plan-eng-review`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `plan-eng-review` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack --skill plan`.
