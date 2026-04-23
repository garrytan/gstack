# gstack-plan: Full Review Gauntlet

Injected by the orchestrator when the user wants to plan a project.
Append to the session context.

## Planning Pipeline
1. Read AGENTS.md and understand the project context.
2. Run /office-hours to produce a design doc (problem statement, premises, alternatives).
   - Load skill: ~/.hermes/skills/gstack-office-hours/SKILL.md
   - Follow the skill instructions using Hermes tools
   - Use clarify (not AskUserQuestion) when you need user input
3. Run /autoplan to review the design (CEO + eng + design + DX reviews).
   - Load skill: ~/.hermes/skills/gstack-autoplan/SKILL.md
   - Follow the skill instructions
4. Save the final reviewed plan to a file the orchestrator can reference later.
   Write it to: plans/<project-slug>-plan-<date>.md in the current repo.
   Include the design doc, all review decisions, and the implementation sequence.
5. Report back to the user:
   - Plan file path
   - One-paragraph summary of what was designed and the key decisions
   - List of accepted scope expansions (if any)
   - Recommended next step (usually: run gstack-full to implement)

Do not implement anything. This is planning only.
The orchestrator will persist the plan link to its own memory/knowledge store.
