---
name: freeze
description: >-
  Compatibility alias for the retired /freeze command. Routes to $debug --mode Diagnose-only --module freeze without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /freeze

Print this replacement invocation, then dispatch to it exactly:

`$debug --mode Diagnose-only --module freeze`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `freeze` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack --skill debug`.
