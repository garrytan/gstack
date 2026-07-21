---
name: document-release
description: >-
  Compatibility alias for the retired /document-release command. Routes to $ship --mode Prepare --module document-release without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /document-release

Print this replacement invocation, then dispatch to it exactly:

`$ship --mode Prepare --module document-release`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `document-release` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack/skills --skill ship`.
