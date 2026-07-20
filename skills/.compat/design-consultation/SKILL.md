---
name: design-consultation
description: >-
  Compatibility alias for the retired /design-consultation command. Routes to $design --mode Generate --module design-consultation without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /design-consultation

Print this replacement invocation, then dispatch to it exactly:

`$design --mode Generate --module design-consultation`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `design-consultation` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack/skills --skill design`.
