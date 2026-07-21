---
name: pair-agent
description: >-
  Compatibility alias for the retired /pair-agent command. Routes to $qa --mode Report --module pair-agent without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /pair-agent

Print this replacement invocation, then dispatch to it exactly:

`$qa --mode Report --module pair-agent`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `pair-agent` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack/skills --skill qa`.
