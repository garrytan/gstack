---
name: health
description: >-
  Compatibility alias for the retired /health command. Routes to $review --mode Deep --module health without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /health

Print this replacement invocation, then dispatch to it exactly:

`$review --mode Deep --module health`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `health` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack/skills --skill review`.
