---
name: claude
description: >-
  Compatibility alias for the retired /claude command. Routes to $review --mode Deep --module claude without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /claude

Print this replacement invocation, then dispatch to it exactly:

`$review --mode Deep --module claude`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `claude` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack/skills --skill review`.
