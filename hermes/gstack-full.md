# gstack-full Pipeline

Injected by the orchestrator for complete feature builds. Append to the session context.

## Full Pipeline
1. Read AGENTS.md and understand the project context.
2. Run /autoplan to review your approach (CEO + eng + design review pipeline).
   - Load skill: ~/.hermes/skills/gstack-autoplan/SKILL.md
   - Follow the skill instructions using Hermes tools
3. Implement the approved plan. Follow the planning discipline above.
   - Use terminal, read_file, write_file, patch for file work
   - Use delegate_task for complex subtasks that need isolation
4. Run /ship to create a PR with tests, changelog, and version bump.
   - Load skill: ~/.hermes/skills/gstack-ship/SKILL.md
   - Follow the skill instructions
5. Report back: PR URL, what shipped, decisions made, anything uncertain.

Do not ask for human input until the PR is ready for review.
