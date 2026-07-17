---
name: document-generate
description: >-
  Compatibility alias for the retired /document-generate command. Routes to $ship --mode Prepare --module document-generate without copying specialist judgment.
metadata:
  internal: true
---

# Compatibility alias: /document-generate

Print this replacement invocation, then dispatch to it exactly:

`$ship --mode Prepare --module document-generate`

Do not reproduce or summarize the retired specialist here. The canonical dispatcher must load its preserved `document-generate` module. If that dispatcher is not installed, tell the user to install it with `npx skills add time-attack/gstack --skill ship`.
