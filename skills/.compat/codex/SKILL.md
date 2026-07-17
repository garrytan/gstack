---
name: codex
description: >-
  Compatibility alias for the retired /codex command. Routes to $review --mode Deep --module codex without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /codex

Print this replacement invocation, then dispatch to it exactly:

`$review --mode Deep --module codex`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `codex` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack --skill review`.
