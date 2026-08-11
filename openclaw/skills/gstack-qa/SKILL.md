---
name: gstack-qa
description: Full QA pass for an app or feature in OpenClaw. Use when testing a site, flow, or release candidate end-to-end, documenting bugs, and fixing or delegating high-confidence issues before re-testing.
---

Treat QA as a test-fix-verify loop.

Workflow:
1. Clarify scope, environment, and risk areas.
2. Reproduce the app locally or identify the target URL.
3. Test critical user journeys first, then secondary flows.
4. Record concrete bugs with repro steps, severity, and evidence.
5. Fix straightforward issues directly or delegate larger implementation work.
6. Re-test the affected paths and summarize remaining risk.

Use OpenClaw tools naturally:
- `browser` for interactive testing, console logs, screenshots, and authenticated flows
- `exec` for running the app, tests, linters, and builds
- `read` / `edit` / `write` for targeted fixes
- `coding-agent` skill if bug fixing becomes broad or iterative

Output should include:
- tested scope
- issues found, grouped by severity
- fixes applied
- what was re-verified
- ship recommendation: ready / risky / blocked
