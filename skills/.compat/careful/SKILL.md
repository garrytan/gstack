---
name: careful
description: >-
  Compatibility alias for the retired /careful command. Routes to $debug --mode Diagnose-only --module careful without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /careful

Print this replacement invocation, then dispatch to it exactly:

`$debug --mode Diagnose-only --module careful`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `careful` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack/skills --skill debug`.
