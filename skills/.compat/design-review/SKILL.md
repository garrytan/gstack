---
name: design-review
description: >-
  Compatibility alias for the retired /design-review command. Routes to $design --mode Implement --module design-review without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /design-review

Print this replacement invocation, then dispatch to it exactly:

`$design --mode Implement --module design-review`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `design-review` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack/skills --skill design`.
