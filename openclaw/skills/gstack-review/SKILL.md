---
name: gstack-review
description: Structured pre-ship review for OpenClaw. Use when reviewing code, plans, docs, or changes for bugs, regressions, poor assumptions, missing tests, or production risks before shipping.
---

Review with skepticism.

Look for:
- breakage that happy-path checks miss
- missing tests
- unsafe assumptions
- UX or product regressions
- operational risks

If the change is large, consider recommending a subagent review pass.
