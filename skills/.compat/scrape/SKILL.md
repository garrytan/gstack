---
name: scrape
description: >-
  Compatibility alias for the retired /scrape command. Routes to $qa --mode Report --module scrape without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /scrape

Print this replacement invocation, then dispatch to it exactly:

`$qa --mode Report --module scrape`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `scrape` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack --skill qa`.
