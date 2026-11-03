**/investigate's and /review's "Done means" list now runs the contract checker through gstack's own bin path (GST-1088 lane B follow-up).** The list told the agent to run a bare `gstack-skill-contract check`, but a standard install doesn't put gstack's bin folder on PATH, so the command failed with "command not found" and the contract check never ran. It now names the same host-resolved path every other gstack command uses, for example `~/.claude/skills/gstack/bin/gstack-skill-contract check` on Claude Code.

### Fixed
- **Done-means check and waive commands**: `scripts/resolvers/contract-done-means.ts` renders `check` and `waive` through each host's bin directory instead of the bare command name. The rest of the wording is unchanged.

### Tests
- `test/skill-descriptions.test.ts`: on every host, /investigate and /review render the checker through that host's bin path and never as a bare command, and the checked-in /review SKILL.md shows the Claude path. /review's skeleton and size pins rise by the measured 56 bytes (24 chars per non-Claude host render).
