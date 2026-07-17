---
name: office-hours
description: >-
  Compatibility alias for the retired /office-hours command. Routes to $plan --mode Discovery --module office-hours without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /office-hours

Print this replacement invocation, then dispatch to it exactly:

`$plan --mode Discovery --module office-hours`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `office-hours` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack --skill plan`.
