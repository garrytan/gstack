---
name: investigate
description: >-
  Compatibility alias for the retired /investigate command. Routes to $debug --mode Diagnose-only --module investigate without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /investigate

Print this replacement invocation, then dispatch to it exactly:

`$debug --mode Diagnose-only --module investigate`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `investigate` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack/skills --skill debug`.
