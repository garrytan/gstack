---
name: devex-review
description: >-
  Compatibility alias for the retired /devex-review command. Routes to $qa --mode Report --module devex-review without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /devex-review

Print this replacement invocation, then dispatch to it exactly:

`$qa --mode Report --module devex-review`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `devex-review` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack/skills --skill qa`.
