---
name: gstack-upgrade
description: >-
  Compatibility alias for the retired /gstack-upgrade command. Routes to $ship --mode Prepare --module gstack-upgrade without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /gstack-upgrade

Print this replacement invocation, then dispatch to it exactly:

`$ship --mode Prepare --module gstack-upgrade`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `gstack-upgrade` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack/skills --skill ship`.
