---
name: landing-report
description: >-
  Compatibility alias for the retired /landing-report command. Routes to $ship --mode Prepare --module landing-report without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /landing-report

Print this replacement invocation, then dispatch to it exactly:

`$ship --mode Prepare --module landing-report`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `landing-report` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack/skills --skill ship`.
