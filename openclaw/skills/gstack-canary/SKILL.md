---
name: gstack-canary
description: Post-deploy canary check for OpenClaw. Use when monitoring a fresh deploy for obvious regressions, console errors, broken flows, or health-check failures in the first validation window.
---

Canary work is short, skeptical production verification.

Workflow:
1. Identify the production or staging URL and the most important flows.
2. Check health endpoints or status pages if they exist.
3. Load the app with `browser`, watch for console errors, and exercise key paths.
4. Compare behavior to the expected baseline.
5. Report anomalies quickly and clearly.

This skill is for verification, not long-running synthetic monitoring.
If sustained monitoring is needed, recommend dedicated observability tooling.
