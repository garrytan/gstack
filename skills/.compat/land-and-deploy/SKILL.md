---
name: land-and-deploy
description: >-
  Compatibility alias for the retired /land-and-deploy command. Routes to $ship --mode Land --module land-and-deploy without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /land-and-deploy

Print this replacement invocation, then dispatch to it exactly:

`$ship --mode Land --module land-and-deploy`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `land-and-deploy` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack --skill ship`.
