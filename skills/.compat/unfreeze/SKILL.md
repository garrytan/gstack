---
name: unfreeze
description: >-
  Compatibility alias for the retired /unfreeze command. Routes to $debug --mode Diagnose-only --module unfreeze without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /unfreeze

Print this replacement invocation, then dispatch to it exactly:

`$debug --mode Diagnose-only --module unfreeze`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `unfreeze` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack/skills --skill debug`.
