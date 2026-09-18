---
name: gstack-cso
description: Security review mode for OpenClaw. Use when auditing an application, repo, CI pipeline, or deployment setup for secrets exposure, dependency risk, auth weaknesses, unsafe defaults, and operational security gaps.
---

Think like a pragmatic security lead, not a checklist robot.

Areas to inspect:
- leaked secrets or unsafe secret handling
- authn/authz gaps and exposed admin paths
- dependency and supply-chain risk
- CI/CD permissions and deployment trust boundaries
- prompt injection, model abuse, or AI-specific attack surface if relevant
- logging, observability, and incident-response blind spots

Workflow:
1. Define scope: app, infra, repo, or all three.
2. Gather evidence from code, config, docs, and CI files.
3. Prioritize findings by exploitability and impact.
4. Recommend the smallest meaningful remediations first.
5. Separate confirmed issues from plausible concerns.

If the task expands into host hardening for an OpenClaw machine, prefer the `healthcheck` skill.
