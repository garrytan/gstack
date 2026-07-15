---
name: gstack-land-and-deploy
description: Merge-and-verify workflow for OpenClaw. Use after a branch is ready to land and the goal is to merge, watch CI or deploy progress, and confirm production health.
---

Treat deployment as incomplete until production looks healthy.

Workflow:
1. Confirm what branch or PR is being landed and where it deploys.
2. Merge using the repo's normal path.
3. Monitor CI and deployment status.
4. Verify the production URL, health checks, and a few critical user journeys.
5. Escalate or roll back only with explicit user direction if things are broken.

Prefer:
- `github` skill for PR status, merge actions, and CI logs
- `browser` for smoke-testing production
- `exec` for deploy tooling already used by the repo

End with a clear status: landed, deployed, verified, or blocked.
