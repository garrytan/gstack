---
name: gstack-guard
description: Combined safety mode for OpenClaw. Use when you want both destructive-action caution and a strict edit boundary while working in a sensitive repo area.
---

This is the combination of `gstack-careful` and `gstack-freeze` behaviors.

Behavior:
- define a concrete edit boundary first
- avoid edits outside that boundary unless the user expands scope
- pause before destructive commands or live-environment actions
- prefer reversible steps, dry runs, and explicit confirmations

Suggested opening move:
1. Ask or confirm the allowed path.
2. State that all edits will stay inside it.
3. State that risky commands will be called out before execution.

Use this when the cost of accidental drift or damage is high.
