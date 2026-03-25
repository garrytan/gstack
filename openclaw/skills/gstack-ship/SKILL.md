---
name: gstack-ship
description: Pre-merge shipping workflow for OpenClaw. Use when preparing a branch to land: verify diff quality, run checks, update release notes if needed, commit cleanly, and prepare a PR or merge request.
---

Ship means making the branch ready to land, not blindly pushing code.

Workflow:
1. Inspect branch status and diff against the target base.
2. Run the smallest credible validation: tests, lint, build, or smoke checks.
3. Review the diff for accidental churn, debug code, or missing docs.
4. Update changelog, version, or release notes only if the repo uses them.
5. Create clean commits and prepare the PR summary.
6. Hand off to `gstack-land-and-deploy` if the task continues through merge and production verification.

Use:
- `exec` for git, tests, and release checks
- `read` for repo docs and release conventions
- `github` skill if PR creation or CI inspection is needed
