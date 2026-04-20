

export function generateContinuousCheckpoint(): string {
  return `## Continuous Checkpoint Mode

If \`CHECKPOINT_MODE\` is \`"continuous"\` (from preamble output): auto-commit work as
you go with \`WIP:\` prefix so session state survives crashes and context switches.

**When to commit (continuous mode only):**
- After creating a new file (not scratch/temp files)
- After finishing a function/component/module
- After fixing a bug that's verified by a passing test
- Before any long-running operation (install, full build, full test suite)

**Commit format** — include structured context in the body:

\`\`\`
WIP: <concise description of what changed>

[gstack-context]
Decisions: <key choices made this step>
Remaining: <what's left in the logical unit>
Tried: <failed approaches worth recording> (omit if none)
Skill: </skill-name-if-running>
[/gstack-context]
\`\`\`

**Rules:**
- Stage only files you intentionally changed. NEVER \`git add -A\` in continuous mode.
- Do NOT commit with known-broken tests. Fix first, then commit. The [gstack-context]
  example values MUST reflect a clean state.
- Do NOT commit mid-edit. Finish the logical unit.
- Push ONLY if \`CHECKPOINT_PUSH\` is \`"true"\` (default is false). Pushing WIP commits
  to a shared remote can trigger CI, deploys, and expose secrets — that is why push
  is opt-in, not default.
- Background discipline — do NOT announce each commit to the user. They can see
  \`git log\` whenever they want.

**When \`/context-restore\` runs,** it parses \`[gstack-context]\` blocks from WIP
commits on the current branch to reconstruct session state. When \`/ship\` runs, it
filter-squashes WIP commits only (preserving non-WIP commits) via
\`git rebase --autosquash\` so the PR contains clean bisectable commits.

If \`CHECKPOINT_MODE\` is \`"explicit"\` (the default): no auto-commit behavior. Commit
only when the user explicitly asks, or when a skill workflow (like /ship) runs a
commit step. Ignore this section entirely.`;
}

