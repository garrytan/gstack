

export function generateContinuousCheckpoint(): string {
  return `## Continuous Checkpoint Mode

If \`CHECKPOINT_MODE\` is \`"continuous"\`: auto-commit completed logical units with \`WIP:\` prefix.

Commit after new intentional files, completed functions/modules, verified bug fixes, and before long-running install/build/test commands.

Commit format:

\`\`\`
WIP: <concise description of what changed>

[gstack-context]
Decisions: <key choices made this step>
Remaining: <what's left in the logical unit>
Tried: <failed approaches worth recording> (omit if none)
Skill: </skill-name-if-running>
[/gstack-context]
\`\`\`

Rules: stage only intentional files, NEVER \`git add -A\`, do not commit broken tests or mid-edit state, and push only if \`CHECKPOINT_PUSH\` is \`"true"\`. Do not announce each WIP commit.

\`/context-restore\` reads \`[gstack-context]\`; \`/ship\` squashes WIP commits into clean commits.

If \`CHECKPOINT_MODE\` is \`"explicit"\`: ignore this section unless a skill or user asks to commit.`;
}
