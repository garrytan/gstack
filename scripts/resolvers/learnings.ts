/**
 * Learnings resolver — cross-skill institutional memory
 *
 * Learnings are stored per-project at ~/.gstack/projects/{slug}/learnings.jsonl.
 * Each entry is a JSONL line with: ts, skill, type, key, insight, confidence,
 * source, branch, commit, files[].
 *
 * Storage is append-only. Duplicates (same key+type with same insight text) are
 * resolved at read time by gstack-learnings-search (highest confidence wins).
 * Different insights with the same key+type are preserved (shown with provenance).
 *
 * Projects belong to named "learnings groups" stored in ~/.gstack/groups.json.
 * When searching, --scope group returns learnings from all projects in the same
 * group. Prompt-on-first-use assigns new projects to a group.
 *
 * Cross-project discovery is controlled by the learning_scope config:
 *   project — just this project (old cross_project_learnings=false)
 *   group   — all projects in the same group (new default)
 *   global  — all projects on this machine (old cross_project_learnings=true)
 */
import type { TemplateContext } from './types';

export function generateLearningsSearch(ctx: TemplateContext): string {
  if (ctx.host === 'codex') {
    // Codex: project-only, no group awareness, no prompting
    return `## Prior Learnings

Search for relevant learnings from previous sessions on this project:

\`\`\`bash
$GSTACK_BIN/gstack-learnings-search --scope project --limit 10 2>/dev/null || true
\`\`\`

If learnings are found, incorporate them into your analysis. When a review finding
matches a past learning, note it: "Prior learning applied: [key] (confidence N, from [date])"`;
  }

  return `## Prior Learnings

Check which learnings group this project belongs to:

\`\`\`bash
${ctx.paths.binDir}/gstack-group which 2>/dev/null || echo "NO_GROUP"
\`\`\`

If the output is \`NO_GROUP\`, this project hasn't been assigned to a learnings group yet.
Use AskUserQuestion:

> This project isn't in a learnings group yet. Learnings groups let gstack share
> knowledge across related projects (e.g., all repos in your company's org).
> Which group should this project belong to?

To see available groups and get smart suggestions, run:

\`\`\`bash
${ctx.paths.binDir}/gstack-group suggest 2>/dev/null || ${ctx.paths.binDir}/gstack-group list 2>/dev/null || echo "No groups yet"
\`\`\`

Options: [list the groups from the output above] + "Create a new group"

If "Create a new group": ask for a name, then run:
\`\`\`bash
${ctx.paths.binDir}/gstack-group create "GROUP_NAME" && ${ctx.paths.binDir}/gstack-group assign "GROUP_NAME"
\`\`\`

If an existing group: run:
\`\`\`bash
${ctx.paths.binDir}/gstack-group assign "GROUP_NAME"
\`\`\`

After assignment (or if the project was already assigned), search for learnings:

\`\`\`bash
${ctx.paths.binDir}/gstack-learnings-search --scope group --limit 10 2>/dev/null || true
\`\`\`

If learnings are found, incorporate them into your analysis. When a review finding
matches a past learning, display:

**"Prior learning applied: [key] (confidence N/10, from [date])"**

This makes the compounding visible. The user should see that gstack is getting
smarter on their codebase over time.`;
}

export function generateLearningsLog(ctx: TemplateContext): string {
  const binDir = ctx.host === 'codex' ? '$GSTACK_BIN' : ctx.paths.binDir;

  return `## Capture Learnings

If you discovered a non-obvious pattern, pitfall, or architectural insight during
this session, log it for future sessions:

\`\`\`bash
${binDir}/gstack-learnings-log '{"skill":"${ctx.skillName}","type":"TYPE","key":"SHORT_KEY","insight":"DESCRIPTION","confidence":N,"source":"SOURCE","files":["path/to/relevant/file"]}'
\`\`\`

**Types:** \`pattern\` (reusable approach), \`pitfall\` (what NOT to do), \`preference\`
(user stated), \`architecture\` (structural decision), \`tool\` (library/framework insight),
\`operational\` (project environment/CLI/workflow knowledge).

**Sources:** \`observed\` (you found this in the code), \`user-stated\` (user told you),
\`inferred\` (AI deduction), \`cross-model\` (both Claude and Codex agree).

**Confidence:** 1-10. Be honest. An observed pattern you verified in the code is 8-9.
An inference you're not sure about is 4-5. A user preference they explicitly stated is 10.

**files:** Include the specific file paths this learning references. This enables
staleness detection: if those files are later deleted, the learning can be flagged.

**Only log genuine discoveries.** Don't log obvious things. Don't log things the user
already knows. A good test: would this insight save time in a future session? If yes, log it.`;
}
