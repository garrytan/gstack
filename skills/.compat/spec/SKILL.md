---
name: spec
description: >-
  Compatibility alias for the retired /spec command. Routes to $plan --mode Specification --module spec without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /spec

Print this replacement invocation, then dispatch to it exactly:

`$plan --mode Specification --module spec`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `spec` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack/skills --skill plan`.
