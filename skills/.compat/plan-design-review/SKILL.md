---
name: plan-design-review
description: >-
  Compatibility alias for the retired /plan-design-review command. Routes to $design --mode Critique --module plan-design-review without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /plan-design-review

Print this replacement invocation, then dispatch to it exactly:

`$design --mode Critique --module plan-design-review`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `plan-design-review` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack/skills --skill design`.
