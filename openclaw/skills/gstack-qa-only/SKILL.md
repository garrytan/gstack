---
name: gstack-qa-only
description: Report-only QA for OpenClaw. Use when the user wants a structured bug report, reproduction evidence, and release risk assessment without making code changes.
---

Do not edit code in this mode.

Workflow:
1. Confirm target environment and core journeys to test.
2. Exercise the most important flows first.
3. Capture screenshots, console errors, and exact repro steps.
4. Classify issues by severity and likelihood.
5. Summarize product risk and recommended next fixes.

Prefer:
- `browser` for live testing and evidence capture
- `exec` for running existing test suites if useful
- `read` for understanding expected behavior

Deliver a concise QA report with:
- scope tested
- bugs found
- severity per bug
- evidence / repro steps
- release recommendation
