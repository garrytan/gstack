---
name: qa-only
description: >-
  Compatibility alias for the retired /qa-only command. Routes to $qa --mode Report --module qa-only without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /qa-only

Print this replacement invocation, then dispatch to it exactly:

`$qa --mode Report --module qa-only`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `qa-only` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack --skill qa`.
