/**
 * Review Army resolver — parallel specialist reviewers for /review
 *
 * Generates template prose that instructs Claude to:
 * 1. Detect stack and scope (via gstack-diff-scope)
 * 2. Select and dispatch specialist subagents in parallel
 * 3. Collect, parse, merge, and deduplicate JSON findings
 * 4. Feed merged findings into the existing Fix-First pipeline
 *
 * Shipped as Release 2 of the self-learning roadmap (SELF_LEARNING_V0.md).
 */
import type { TemplateContext } from './types';

function generateSpecialistSelection(ctx: TemplateContext): string {
  return `## Step 4.5: Review Army — Specialist Dispatch

### Detect stack and scope

\`\`\`bash
source <(${ctx.paths.binDir}/gstack-diff-scope <base> 2>/dev/null) || true
# Detect stack for specialist context
STACK=""
[ -f Gemfile ] && STACK="\${STACK}ruby "
[ -f package.json ] && STACK="\${STACK}node "
[ -f requirements.txt ] || [ -f pyproject.toml ] && STACK="\${STACK}python "
[ -f go.mod ] && STACK="\${STACK}go "
[ -f Cargo.toml ] && STACK="\${STACK}rust "
echo "STACK: \${STACK:-unknown}"
DIFF_LINES=$(git diff origin/<base> --stat | tail -1 | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo "0")
echo "DIFF_LINES: $DIFF_LINES"
\`\`\`

### Select specialists

Based on the scope signals above, select which specialists to dispatch.

**Always-on (dispatch on every review with 50+ changed lines):**
1. **Testing** — read \`${ctx.paths.skillRoot}/review/specialists/testing.md\`
2. **Maintainability** — read \`${ctx.paths.skillRoot}/review/specialists/maintainability.md\`

**If DIFF_LINES < 50:** Skip all specialists. Print: "Small diff ($DIFF_LINES lines) — specialists skipped." Continue to Step 5.

**Conditional (dispatch if the matching scope signal is true):**
3. **Security** — if SCOPE_AUTH=true, OR if SCOPE_BACKEND=true AND DIFF_LINES > 100. Read \`${ctx.paths.skillRoot}/review/specialists/security.md\`
4. **Performance** — if SCOPE_BACKEND=true OR SCOPE_FRONTEND=true. Read \`${ctx.paths.skillRoot}/review/specialists/performance.md\`
5. **Data Migration** — if SCOPE_MIGRATIONS=true. Read \`${ctx.paths.skillRoot}/review/specialists/data-migration.md\`
6. **API Contract** — if SCOPE_API=true. Read \`${ctx.paths.skillRoot}/review/specialists/api-contract.md\`
7. **Design** — if SCOPE_FRONTEND=true. Use the existing design review checklist at \`${ctx.paths.skillRoot}/review/design-checklist.md\`

Note which specialists were selected and which were skipped. Print the selection:
"Dispatching N specialists: [names]. Skipped: [names] (scope not detected)."`;
}

function generateSpecialistDispatch(ctx: TemplateContext): string {
  return `### Dispatch specialists in parallel

For each selected specialist, launch an independent subagent via the Agent tool.
**Launch ALL selected specialists in a single message** (multiple Agent tool calls)
so they run in parallel. Each subagent has fresh context — no prior review bias.

**Each specialist subagent prompt:**

Construct the prompt for each specialist. The prompt includes:

1. The specialist's checklist content (you already read the file above)
2. Stack context: "This is a {STACK} project."
3. Past learnings for this domain (if any exist):

\`\`\`bash
${ctx.paths.binDir}/gstack-learnings-search --type pitfall --query "{specialist domain}" --limit 5 2>/dev/null || true
\`\`\`

If learnings are found, include them: "Past learnings for this domain: {learnings}"

4. Instructions:

"You are a specialist code reviewer. Read the checklist below, then run
\`git diff origin/<base>\` to get the full diff. Apply the checklist against the diff.

For each finding, output a JSON object on its own line:
{\\"severity\\":\\"CRITICAL|INFORMATIONAL\\",\\"confidence\\":N,\\"path\\":\\"file\\",\\"line\\":N,\\"category\\":\\"category\\",\\"summary\\":\\"description\\",\\"fix\\":\\"recommended fix\\",\\"fingerprint\\":\\"path:line:category\\",\\"specialist\\":\\"name\\"}

Required fields: severity, confidence, path, category, summary, specialist.
Optional: line, fix, fingerprint, evidence.

If no findings: output \`NO FINDINGS\` and nothing else.
Do not output anything else — no preamble, no summary, no commentary.

Stack context: {STACK}
Past learnings: {learnings or 'none'}

CHECKLIST:
{checklist content}"

**Subagent configuration:**
- Use \`subagent_type: "general-purpose"\`
- Do NOT use \`run_in_background\` — all specialists must complete before merge
- If any specialist subagent fails or times out, log the failure and continue with results from successful specialists. Specialists are additive — partial results are better than no results.`;
}

function generateFindingsMerge(_ctx: TemplateContext): string {
  return `### Step 4.6: Collect and merge findings

After all specialist subagents complete, collect their outputs.

**Parse findings:**
For each specialist's output:
1. If output is "NO FINDINGS" — skip, this specialist found nothing
2. Otherwise, parse each line as a JSON object. Skip lines that are not valid JSON.
3. Collect all parsed findings into a single list, tagged with their specialist name.

**Fingerprint and deduplicate:**
For each finding, compute its fingerprint:
- If \`fingerprint\` field is present, use it
- Otherwise: \`{path}:{line}:{category}\` (if line is present) or \`{path}:{category}\`

Group findings by fingerprint. For findings sharing the same fingerprint:
- Keep the finding with the highest confidence score
- Tag it: "MULTI-SPECIALIST CONFIRMED ({specialist1} + {specialist2})"
- Boost confidence by +1 (cap at 10)
- Note the confirming specialists in the output

**Apply confidence gates:**
- Confidence 7+: show normally in the findings output
- Confidence 5-6: show with caveat "Medium confidence — verify this is actually an issue"
- Confidence 3-4: move to appendix (suppress from main findings)
- Confidence 1-2: suppress entirely

**Compute PR Quality Score:**
After merging, compute the quality score:
\`quality_score = max(0, 10 - (critical_count * 2 + informational_count * 0.5))\`
Cap at 10. Log this in the review result at the end.

**Output merged findings:**
Present the merged findings in the same format as the current review:

\`\`\`
SPECIALIST REVIEW: N findings (X critical, Y informational) from Z specialists

[For each finding, in order: CRITICAL first, then INFORMATIONAL, sorted by confidence descending]
[SEVERITY] (confidence: N/10, specialist: name) path:line — summary
  Fix: recommended fix
  [If MULTI-SPECIALIST CONFIRMED: show confirmation note]

PR Quality Score: X/10
\`\`\`

These findings flow into Step 5 Fix-First alongside the CRITICAL pass findings from Step 4.
The Fix-First heuristic applies identically — specialist findings follow the same AUTO-FIX vs ASK classification.`;
}

function generateRedTeam(ctx: TemplateContext): string {
  return `### Red Team dispatch (conditional)

**Activation:** Only if DIFF_LINES > 200 OR any specialist produced a CRITICAL finding.

If activated, dispatch one more subagent via the Agent tool (foreground, not background).

The Red Team subagent receives:
1. The red-team checklist from \`${ctx.paths.skillRoot}/review/specialists/red-team.md\`
2. The merged specialist findings from Step 4.6 (so it knows what was already caught)
3. The git diff command

Prompt: "You are a red team reviewer. The code has already been reviewed by N specialists
who found the following issues: {merged findings summary}. Your job is to find what they
MISSED. Read the checklist, run \`git diff origin/<base>\`, and look for gaps.
Output findings as JSON objects (same schema as the specialists). Focus on cross-cutting
concerns, integration boundary issues, and failure modes that specialist checklists
don't cover."

If the Red Team finds additional issues, merge them into the findings list before
Step 5 Fix-First. Red Team findings are tagged with \`"specialist":"red-team"\`.

If the Red Team returns NO FINDINGS, note: "Red Team review: no additional issues found."
If the Red Team subagent fails or times out, skip silently and continue.`;
}

export function generateReviewArmy(ctx: TemplateContext): string {
  // Codex host: strip entirely — Codex should not run Review Army
  if (ctx.host === 'codex') return '';

  const sections = [
    generateSpecialistSelection(ctx),
    generateSpecialistDispatch(ctx),
    generateFindingsMerge(ctx),
    generateRedTeam(ctx),
  ];

  return sections.join('\n\n---\n\n');
}
