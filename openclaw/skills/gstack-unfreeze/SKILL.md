---
name: gstack-unfreeze
description: Remove or relax an explicit edit-boundary in OpenClaw. Use when a prior gstack-freeze or gstack-guard constraint is no longer appropriate and the allowed scope needs to expand in a controlled way.
---

Use this as the companion to `gstack-freeze`.

Workflow:
1. Restate the current boundary.
2. Confirm whether the boundary is being removed entirely or expanded to a larger path.
3. If only expanding, define the new boundary clearly.
4. Continue with the updated scope and avoid silent drift beyond it.

Because this OpenClaw port is procedural rather than hook-enforced, the main value is making scope changes explicit and visible.
