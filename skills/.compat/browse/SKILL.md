---
name: browse
description: >-
  Compatibility alias for the retired /browse command. Routes to $qa --mode Report --module browse without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /browse

Print this replacement invocation, then dispatch to it exactly:

`$qa --mode Report --module browse`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `browse` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack --skill qa`.
