---
name: canary
description: >-
  Compatibility alias for the retired /canary command. Routes to $qa --mode Report --module canary without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /canary

Print this replacement invocation, then dispatch to it exactly:

`$qa --mode Report --module canary`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `canary` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack/skills --skill qa`.
