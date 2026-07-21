---
name: context-restore
description: >-
  Compatibility alias for the retired /context-restore command. Routes to $plan --mode Discovery --module context-restore without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /context-restore

Print this replacement invocation, then dispatch to it exactly:

`$plan --mode Discovery --module context-restore`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `context-restore` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack/skills --skill plan`.
