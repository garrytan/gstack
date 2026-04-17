---
name: gstack-freeze
description: Edit-scope discipline for OpenClaw. Use when you want changes limited to one directory, package, or file area so unrelated parts of the repo stay untouched.
---

OpenClaw does not provide the original gstack hook-based enforcement here.
Use this skill as an explicit boundary-setting rule.

Workflow:
1. State the allowed edit boundary in the reply.
2. Before each edit, check whether the target path is inside that boundary.
3. Refuse or ask before changing files outside the frozen area.
4. Re-state the boundary if the task starts to drift.

Good uses:
- debugging one module without opportunistic cleanup
- minimizing blast radius in a large repo
- protecting unrelated code during focused refactors
