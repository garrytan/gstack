---
name: skillify
description: >-
  Compatibility alias for the retired /skillify command. Routes to $qa --mode Report --module skillify without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /skillify

Print this replacement invocation, then dispatch to it exactly:

`$qa --mode Report --module skillify`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `skillify` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack/skills --skill qa`.
