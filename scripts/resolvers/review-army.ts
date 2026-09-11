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
import { CC_BACKGROUND_DEFAULT_SINCE } from './constants';

function generateSpecialistSelection(ctx: TemplateContext): string {
  const isShip = ctx.skillName === 'ship';
  const stepSel = isShip ? '9.1' : '4.5';
  const stepMerge = isShip ? '9.2' : '4.6';
  const nextStep = isShip ? 'the Fix-First flow (item 4)' : 'Step 5';
  return `## Step ${stepSel}: Review Army — Specialist Dispatch

### Resolve scope and requirements once

\`\`\`bash
REVIEW_PLAN=$($GSTACK_ANCHOR_INVOCATION gstack-execution-plan resolve \\
  --skill ${ctx.skillName} --work-kind review --finish-line ${isShip ? 'pr_open' : 'review_receipt'} \\
  --lane auto --assert-target-ref origin/<base> --json) || exit 1
# Consume REVIEW_PLAN.manifest.roles and REVIEW_PLAN.requirements. Do not invoke
# identity/profile/manifest/requirements/evidence helpers again for this decision.
# Detect stack for specialist context
STACK=""
[ -f Gemfile ] && STACK="\${STACK}ruby "
[ -f package.json ] && STACK="\${STACK}node "
[ -f requirements.txt ] || [ -f pyproject.toml ] && STACK="\${STACK}python "
[ -f go.mod ] && STACK="\${STACK}go "
[ -f Cargo.toml ] && STACK="\${STACK}rust "
echo "STACK: \${STACK:-unknown}"
DIFF_BASE=$(git merge-base origin/<base> HEAD)
DIFF_INS=$(git diff "$DIFF_BASE" --stat | tail -1 | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo "0")
DIFF_DEL=$(git diff "$DIFF_BASE" --stat | tail -1 | grep -oE '[0-9]+ deletion' | grep -oE '[0-9]+' || echo "0")
DIFF_LINES=$((DIFF_INS + DIFF_DEL))
echo "DIFF_LINES: $DIFF_LINES"
# Detect test framework for specialist test stub generation
TEST_FW=""
{ [ -f jest.config.ts ] || [ -f jest.config.js ]; } && TEST_FW="jest"
[ -f vitest.config.ts ] && TEST_FW="vitest"
{ [ -f spec/spec_helper.rb ] || [ -f .rspec ]; } && TEST_FW="rspec"
{ [ -f pytest.ini ] || [ -f conftest.py ]; } && TEST_FW="pytest"
[ -f go.mod ] && TEST_FW="go-test"
echo "TEST_FW: \${TEST_FW:-unknown}"
\`\`\`

### Read specialist hit rates (adaptive gating)

\`\`\`bash
${ctx.paths.binDir}/gstack-specialist-stats 2>/dev/null || true
\`\`\`

### Select specialists

Based on the scope signals above, select which specialists to dispatch.

Apply this precedence exactly; changed-line count never suppresses a hard role:

1. **Explicit user-forced specialist** flags select their named specialist.
2. **auth hard trigger** — role \`auth\` selects Security at any size.
3. **schema/data hard trigger** — either role selects Data Migration at any size.
4. **contract hard trigger** — role \`contract\` selects API Contract at any size.
5. Other semantic roles: \`ui\` selects Design; \`runtime|code\` may select Performance.
6. **size-based optional specialists** — only after semantic selection, add Testing
   and Maintainability for 50+ changed lines and Performance for large backend diffs.

**Checklist mapping and selection conditions:**
1. **Testing** — for 50+ changed lines or an explicit force flag. Read \`${ctx.paths.skillRoot}/review/specialists/testing.md\`
2. **Maintainability** — for 50+ changed lines or an explicit force flag. Read \`${ctx.paths.skillRoot}/review/specialists/maintainability.md\`
3. **Security** — for role \`auth\` at any size, or a large backend/runtime diff. Read \`${ctx.paths.skillRoot}/review/specialists/security.md\`
4. **Performance** — for role \`runtime\`, \`code\`, or \`ui\` (the former backend/frontend scope signals). Read \`${ctx.paths.skillRoot}/review/specialists/performance.md\`
5. **Data Migration** — for role \`schema\` or \`data\`. Read \`${ctx.paths.skillRoot}/review/specialists/data-migration.md\`
6. **API Contract** — for role \`contract\`. Read \`${ctx.paths.skillRoot}/review/specialists/api-contract.md\`
7. **Design** — for role \`ui\`. Use \`${ctx.paths.skillRoot}/review/design-checklist.md\` and run the mechanical pass at the top of that checklist (the user-installed design detector, when present) before the LLM items
8. **Simplification** — for 100+ changed lines. Read \`${ctx.paths.skillRoot}/review/specialists/simplification.md\`. This advisory-only lens hunts unrequested structure (hand-rolled stdlib, one-implementation abstractions, dependencies duplicating platform features), never coverage.

Read the corresponding checklist for every selected specialist. A docs-only diff
may skip specialists. A rename-only diff retains roles from its destination path.
If \`SCOPE_ERROR\` is set or \`SEMANTIC_ROLES_JSON\` is invalid/unknown, fail closed
into Testing + Maintainability core review instead of reporting clean.

Skipped specialists have state \`not_assessed\`; they never contribute a synthetic
quality score. Continue to ${nextStep} only after every hard role was assessed.

### Adaptive gating

After scope-based selection, apply adaptive gating based on specialist hit rates:

For each conditional specialist that passed scope gating, check the \`gstack-specialist-stats\` output above:
- If tagged \`[GATE_CANDIDATE]\` (0 findings in 10+ dispatches): skip it. Print: "[specialist] auto-gated (0 findings in N reviews)."
- If tagged \`[NEVER_GATE]\`: always dispatch regardless of hit rate. Security and data-migration are insurance policy specialists — they should run even when silent.

**Force flags:** If the user's prompt includes \`--security\`, \`--performance\`, \`--testing\`, \`--maintainability\`, \`--data-migration\`, \`--api-contract\`, \`--design\`, \`--simplification\`, or \`--all-specialists\`, force-include that specialist regardless of gating.

Note which specialists were selected, gated, and skipped. Print the selection:
"Dispatching N specialists: [names]. Skipped: [names] (scope not detected). Gated: [names] (0 findings in N+ reviews)."`;
}

function generateSpecialistDispatch(ctx: TemplateContext): string {
  const learningsContext = ctx.skillName === 'ship'
    ? `3. No implicit learnings search. Use only context already present in the
current task and repository.`
    : `3. Past learnings for this domain (if any exist):

\`\`\`bash
${ctx.paths.binDir}/gstack-learnings-search --type pitfall --query "{specialist domain}" --limit 5 2>/dev/null || true
\`\`\`

If learnings are found, include them: "Past learnings for this domain: {learnings}"`;

  return `### Dispatch specialists in parallel

For each selected specialist, launch an independent subagent via the Agent tool.
**Launch ALL selected specialists in a single message** (multiple Agent tool calls)
so they run in parallel. Each subagent has fresh context — no prior review bias.

**Each specialist subagent prompt:**

Construct the prompt for each specialist. The prompt includes:

1. The specialist's checklist content (you already read the file above)
2. Stack context: "This is a {STACK} project."
${learningsContext}

4. Instructions:

"You are a report-only specialist code reviewer. You have no file-write,
comment, commit, push, PR, merge, or deploy authority. Read the checklist below, then run
\`DIFF_BASE=$(git merge-base origin/<base> HEAD) && git diff "$DIFF_BASE"\` to get the full diff. Apply the checklist against the diff.

For each finding, output a JSON object on its own line:
{\\"severity\\":\\"CRITICAL|INFORMATIONAL\\",\\"confidence\\":N,\\"path\\":\\"file\\",\\"line\\":N,\\"category\\":\\"category\\",\\"summary\\":\\"description\\",\\"fix\\":\\"recommended fix\\",\\"fingerprint\\":\\"path:line:category\\",\\"specialist\\":\\"name\\"}

Required fields: severity, confidence, path, category, summary, specialist.
Optional: line, fix, fingerprint, evidence, test_stub.

If you can write a test that would catch this issue, include it in the \`test_stub\` field.
Use the detected test framework ({TEST_FW}). Write a minimal skeleton — describe/it/test
blocks with clear intent. Skip test_stub for architectural or design-only findings.

If no findings: output \`NO FINDINGS\` and nothing else.
Do not output anything else — no preamble, no summary, no commentary.

Stack context: {STACK}
Past learnings: {learnings or 'none'}

CHECKLIST:
{checklist content}"

**Subagent configuration:**
- Use \`subagent_type: "general-purpose"\`
- Pass \`run_in_background: false\` on every specialist Agent call — subagents run in the BACKGROUND by default since ${CC_BACKGROUND_DEFAULT_SINCE}, and all specialists must complete before merge. (Merely omitting the flag no longer produces a foreground run; it must be explicitly false.)
- If any specialist subagent fails or times out, log the failure and continue with results from successful specialists. Specialists are additive — partial results are better than no results.`;
}

function generateFindingsMerge(ctx: TemplateContext): string {
  const isShip = ctx.skillName === 'ship';
  const stepMerge = isShip ? '9.2' : '4.6';
  const stepSel = isShip ? '9.1' : '4.5';
  const fixFirstRef = isShip ? 'the Fix-First flow (item 4)' : 'Step 5 Fix-First';
  const critPassRef = isShip ? 'the checklist pass (Step 9)' : 'the CRITICAL pass findings from Step 4';
  const persistRef = isShip ? 'the review-log persist in this generated ship section' : 'the standalone generated review-log persist';
  return `### Step ${stepMerge}: Collect and merge findings

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

**Advisory carve-out (simplification specialist):**
Findings with \`"advisory": true\` are excluded from BOTH the quality_score
summation and the findings-count header below — they are structure suggestions,
not defects, and must not make "5 findings … 10/10" look contradictory. In
Fix-First they are ASK-only: NEVER auto-applied, even when mechanical.

**Compute PR Quality Score:**
After merging, compute the quality score over NON-advisory findings only:
\`quality_score = max(0, 10 - (critical_count * 2 + informational_count * 0.5))\`
Cap at 10. Log this in the review result at the end.

**Output merged findings:**
Present the merged findings in the same format as the current review:

\`\`\`
SPECIALIST REVIEW: N findings (X critical, Y informational) from Z specialists

[For each finding, in order: CRITICAL first, then INFORMATIONAL, sorted by confidence descending;
 advisory findings last, each rendered with an [ADVISORY] label in place of the severity]
[SEVERITY] (confidence: N/10, specialist: name) path:line — summary
  Fix: recommended fix
  [If MULTI-SPECIALIST CONFIRMED: show confirmation note]

PR Quality Score: X/10
\`\`\`

**Simplification footer (after the score line):**
- If the simplification specialist was dispatched and returned findings, sum
  their \`lines_removable\` values and print: \`net: -N lines possible\` (omit
  findings without the field from the sum).
- If it was dispatched and returned NO FINDINGS, print:
  \`Simplification: lean already — nothing to cut.\`
- If it was not dispatched, print neither line.

These findings flow into ${fixFirstRef} alongside ${critPassRef}.
The Fix-First heuristic applies identically — specialist findings follow the same AUTO-FIX vs ASK classification (except advisory findings, which are ASK-only per the carve-out above).

**Compile per-specialist stats:**
After merging findings, compile a \`specialists\` object for ${persistRef}.
For each specialist (testing, maintainability, security, performance, data-migration, api-contract, design, simplification, red-team):
- If dispatched: \`{"dispatched": true, "findings": N, "critical": N, "informational": N}\`
- If skipped by scope: \`{"dispatched": false, "reason": "scope"}\`
- If skipped by gating: \`{"dispatched": false, "reason": "gated"}\`
- If not applicable (e.g., red-team not activated): omit from the object

Advisory findings COUNT in the stats \`findings\` field — the advisory
carve-out governs the quality score and the findings-count header only.
Logging simplification's advisories as \`findings: 0\` would auto-gate the
lens into permanent silence after 10 dispatches.

Include the Design specialist even though it uses \`design-checklist.md\` instead of the specialist schema files.
Remember these stats — you will need them for ${persistRef}.`;
}

function generateRedTeam(ctx: TemplateContext): string {
  const isShip = ctx.skillName === 'ship';
  const stepMerge = isShip ? '9.2' : '4.6';
  const fixFirstRef = isShip ? 'the Fix-First flow (item 4)' : 'Step 5 Fix-First';
  return `### Red Team dispatch (conditional)

**Activation:** Only if DIFF_LINES > 200 OR any specialist produced a CRITICAL finding.

If activated, dispatch one more subagent via the Agent tool (pass \`run_in_background: false\` — foreground; subagents default to background since ${CC_BACKGROUND_DEFAULT_SINCE}).

The Red Team subagent receives:
1. The red-team checklist from \`${ctx.paths.skillRoot}/review/specialists/red-team.md\`
2. The merged specialist findings from Step ${stepMerge} (so it knows what was already caught)
3. The git diff command

Prompt: "You are a red team reviewer. The code has already been reviewed by N specialists
who found the following issues: {merged findings summary}. Your job is to find what they
MISSED. Read the checklist, run \`DIFF_BASE=$(git merge-base origin/<base> HEAD) && git diff "$DIFF_BASE"\`, and look for gaps.
Output findings as JSON objects (same schema as the specialists). Focus on cross-cutting
concerns, integration boundary issues, and failure modes that specialist checklists
don't cover."

If the Red Team finds additional issues, merge them into the findings list before
${fixFirstRef}. Red Team findings are tagged with \`"specialist":"red-team"\`.

If the Red Team returns NO FINDINGS, note: "Red Team review: no additional issues found."
If the Red Team subagent fails or times out, skip silently and continue.`;
}

function generateEcpeReviewArmyObservation(): string {
  return `### ECPE review-army observation

For every specialist or red-team process that actually launches, add one
content-free helper \`spawn\` partial with a closed specialist ID and
\`execution_effect:"read"\`. Record the decisive merged result with closed
capability/receipt IDs only. Do not include findings, file references, prompts,
test stubs, or agent output. Accumulate in the existing run-local batch and
flush only at skill end.`;
}

function generateCodexInHostReviewArmy(ctx: TemplateContext): string {
  const step = ctx.skillName === 'ship' ? '9.1' : '4.5';
  const next = ctx.skillName === 'ship' ? 'the Fix-First flow (item 4)' : 'Step 5';
  return `## Step ${step}: Review Army — bounded in-host passes

Use the current Codex agent for every selected pass. Do not launch another
model, helper reviewer, or recursive review process.

### Select from the fused authority decision

Run the installed execution-plan authority once and consume its schema-checked
manifest roles (the JSON equivalent of \`SEMANTIC_ROLES_JSON\`). It already binds
the trusted base, work profile, semantic manifest, requirements, and initial
section batch. Do not run another identity, diff-scope, profile, manifest,
requirements, evidence, or section-selection process for this decision.

\`\`\`bash
REVIEW_PLAN=$($GSTACK_ANCHOR_INVOCATION gstack-execution-plan resolve \\
  --skill ${ctx.skillName} --work-kind review --finish-line ${ctx.skillName === 'ship' ? 'pr_open' : 'review_receipt'} \\
  --lane auto --assert-target-ref origin/<base> --json) || exit 1
printf '%s\n' "SEMANTIC_ROLES_JSON is REVIEW_PLAN.manifest.roles"
\`\`\`

Apply this compiled map exactly:

- \`auth\` -> security
- \`schema|data\` -> data-migration
- \`contract\` -> api-contract
- \`ui\` -> design
- \`runtime|code\` -> performance
- explicit testing/maintainability flags -> their named pass

If \`SCOPE_ERROR\` is set or \`SEMANTIC_ROLES_JSON\` is missing, invalid, or
unknown, select the conservative hard-section set: security, data-migration,
api-contract, testing, and maintainability. Never interpret invalid scope as a
clean result. A docs-only role set may select no specialist batch.

History-wide specialist statistics, per-specialist learning lookup, and a
second semantic-manifest authority process are forbidden on this hot path. Selection is
independent of Git history size and specialist count.

### Execute the selected passes directly

For each selected name, read exactly one checklist from
\`${ctx.paths.skillRoot}/review/specialists/<name>.md\` (Design uses
\`${ctx.paths.skillRoot}/review/design-checklist.md\`). Apply it directly to the
already-resolved diff as a report-only pass. Each selected checklist is opened
at most once. Do not write files, comments, commits, pushes, PR state, merge
state, or deploy state.

Emit findings with severity, confidence, path, line when known, category,
summary, fix, and specialist. Merge duplicate fingerprints, keep the highest
confidence, and note multi-specialist confirmation. Missing checklist bytes are
missing coverage, never \`NO FINDINGS\`.

The current Codex agent then performs one bounded red-team pass only when the
diff exceeds 200 lines or an earlier pass found a critical issue. Read
\`${ctx.paths.skillRoot}/review/specialists/red-team.md\` once and look only for
gaps across the merged findings. This is still the same in-host process.

Continue to ${next} after every selected pass has a visible disposition. ECPE
records zero helper/model spawns for these in-host passes; record only closed
capability and receipt IDs in the existing final batch.`;
}

export function generateReviewArmy(ctx: TemplateContext): string {
  if (ctx.host === 'codex') return generateCodexInHostReviewArmy(ctx);

  const sections = [
    generateSpecialistSelection(ctx),
    generateSpecialistDispatch(ctx),
    generateFindingsMerge(ctx),
    generateRedTeam(ctx),
    generateEcpeReviewArmyObservation(),
  ];

  return sections.join('\n\n---\n\n');
}
