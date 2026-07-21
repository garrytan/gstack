---
name: setup-deploy
description: >-
  Compatibility alias for the retired /setup-deploy command. Routes to $ship --mode Deploy --module setup-deploy without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /setup-deploy

Print this replacement invocation, then dispatch to it exactly:

`$ship --mode Deploy --module setup-deploy`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `setup-deploy` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack/skills --skill ship`.
