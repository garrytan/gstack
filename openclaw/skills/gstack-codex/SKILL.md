---
name: gstack-codex
description: External coding-agent second opinion for OpenClaw. Use when you want an independent review, adversarial critique, or consultation from Codex or another delegated coding agent.
---

In OpenClaw, prefer the `coding-agent` skill rather than assuming a local Codex wrapper.

Modes:
- review: ask a coding agent to inspect a diff or implementation and report issues
- challenge: ask it to actively try to break assumptions or find edge cases
- consult: ask focused technical questions and summarize the advice

Workflow:
1. Define the question or review scope precisely.
2. Delegate with `coding-agent` if the task merits an independent pass.
3. Keep the request read-only unless fixes are explicitly desired.
4. Summarize findings with your own judgment instead of blindly deferring.
