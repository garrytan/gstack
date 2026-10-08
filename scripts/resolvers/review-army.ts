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
import { CC_BACKGROUND_DEFAULT_SINCE, FOREGROUND_IF_AVAILABLE, BACKGROUND_RECOVERY } from './constants';
import { learningsCapture, LEARNINGS_VERDICT } from './learnings';
import { DEFENSIVE_REVIEW_FRAMING, FIXTURE_SUMMARY_MODE } from './defensive-review';

function generateSpecialistSelection(ctx: TemplateContext): string {
  const isShip = ctx.skillName === 'ship';
  const stepSel = isShip ? '9.1' : '4.5';
  const stepMerge = isShip ? '9.2' : '4.6';
  const nextStep = isShip ? 'Step 9.3 (cross-review dedup)' : 'Step 4.8 (adversarial review), then Step 5';
  return `## Step ${stepSel}: Review Army — Specialist Dispatch

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

**Always-on (dispatch on every review with 50+ changed lines):**
1. **Testing** — read \`${ctx.paths.skillRoot}/review/specialists/testing.md\`
2. **Maintainability** — read \`${ctx.paths.skillRoot}/review/specialists/maintainability.md\`

**If DIFF_LINES < 50:** Skip all specialists. Print: "Small diff ($DIFF_LINES lines) — specialists skipped." Continue to Step ${stepMerge} with the ${isShip ? 'core/design-lite' : 'core'} findings and an empty specialist list, then the parent's Exploratory QA step and ${nextStep}. Small diffs skip fan-out, never the parent-owned smoke probes. Core shared-code checks also remain required.

**Conditional (dispatch if the matching scope signal is true):**
3. **Security** — if SCOPE_AUTH=true, OR if SCOPE_BACKEND=true AND DIFF_LINES > 100. Read \`${ctx.paths.skillRoot}/review/specialists/security.md\`
4. **Performance** — if SCOPE_BACKEND=true OR SCOPE_FRONTEND=true. Read \`${ctx.paths.skillRoot}/review/specialists/performance.md\`
5. **Data Migration** — if SCOPE_MIGRATIONS=true. Read \`${ctx.paths.skillRoot}/review/specialists/data-migration.md\`
6. **API Contract** — if SCOPE_API=true. Read \`${ctx.paths.skillRoot}/review/specialists/api-contract.md\`
7. **Design** — if SCOPE_FRONTEND=true. Use the existing design review checklist at \`${ctx.paths.skillRoot}/review/design-checklist.md\` and run the mechanical pass at the top of that checklist (the user-installed design detector, when present) before the LLM items
8. **Simplification** — if DIFF_LINES > 100. Read \`${ctx.paths.skillRoot}/review/specialists/simplification.md\`. Advisory-only lens: hunts unrequested structure (hand-rolled stdlib, one-implementation abstractions, dependencies duplicating platform features), never coverage.

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
  return `### Dispatch specialists in parallel

For each selected specialist, launch an independent subagent via the Agent tool.
**Launch ALL selected specialists in a single message** (multiple Agent tool calls)
so they run in parallel. Each subagent has fresh context — no prior review bias.

**Each specialist subagent prompt:**

Construct the prompt for each specialist. The prompt includes:

1. The specialist's checklist path from the selection above (the subagent reads it; never paste its content)
2. Stack context: "This is a {STACK} project."
3. Past learnings for this domain (if any exist):

\`\`\`bash
${learningsCapture(`${ctx.paths.binDir}/gstack-learnings-search --type pitfall --query "{specialist domain}" --limit 5`)}
${LEARNINGS_VERDICT}
\`\`\`

If learnings are found, include them: "Past learnings for this domain: {learnings}"

4. **Defensive framing (Security specialist and the Red Team below only).** Begin the prompt with:
"${DEFENSIVE_REVIEW_FRAMING}"
and replace its full-diff command with: "${FIXTURE_SUMMARY_MODE}"
Every other specialist, including Testing, reads the full diff with fixtures.

5. Instructions:

"You are a specialist code reviewer. Read the checklist at {checklist path}, then run
\`DIFF_BASE=$(git merge-base origin/<base> HEAD) && git diff "$DIFF_BASE"\` to get the full diff. Apply the checklist against the diff.

For each finding, output a JSON object on its own line:
{\\"severity\\":\\"CRITICAL|INFORMATIONAL\\",\\"confidence\\":N,\\"path\\":\\"file\\",\\"line\\":N,\\"category\\":\\"category\\",\\"summary\\":\\"description\\",\\"fix\\":\\"recommended fix\\",\\"fingerprint\\":\\"path:line:category\\",\\"specialist\\":\\"name\\"}

Required fields: severity, confidence, path, category, summary, specialist.
Optional: line, fix, fingerprint, evidence, test_stub, advisory, evidence_paths, helper_target.

Optional extraction advice belongs to the core shared-code check; do not duplicate its proposals. Report real defects in duplicated code independently. Preserve advisory metadata when returning structural advice, and never label a demonstrated defect advisory merely because sharing a helper could fix it.

If you can write a test that would catch this issue, include it in the \`test_stub\` field.
Use the detected test framework ({TEST_FW}). Write a minimal skeleton — describe/it/test
blocks with clear intent. Skip test_stub for architectural or design-only findings.

If no findings: output \`NO FINDINGS\` and nothing else.
Do not output anything else — no preamble, no summary, no commentary.

Stack context: {STACK}
Past learnings: {learnings or 'none'}"

**Subagent configuration:**
- Use \`subagent_type: "general-purpose"\`
- Pass ${FOREGROUND_IF_AVAILABLE} on every specialist Agent call — background is the default since ${CC_BACKGROUND_DEFAULT_SINCE}; omitting an available flag is not foreground. ${BACKGROUND_RECOVERY}

**Wait for readers before editing:**
- Confirm that each task has finished or is stopped. A timeout alone does not prove termination. If a reader or writer is still active, wait; if its state is unknown, inspect its task/process status. If you cannot confirm it stopped, use the parent's Fix-First stop path without edits.
- A failed task may be stopped without having completed its review. Record the failure and retain usable partial findings.
- Continue independent evidence collection after a terminal failure. Missing dispatched coverage remains incomplete, never completed or clean; successful peers cannot replace it.`;
}

function generateFindingsMerge(ctx: TemplateContext): string {
  const isShip = ctx.skillName === 'ship';
  const stepMerge = isShip ? '9.2' : '4.6';
  const fixFirstRef = isShip ? 'Step 9.3 dedup, then Step 9.4 Fix-First' : 'Step 5 Fix-First';
  const critPassRef = isShip ? 'the checklist pass (Step 9)' : 'the CRITICAL pass findings from Step 4';
  const persistRef = isShip ? 'the review-log persist' : 'the review-log entry in Step 5.8';
  return `### Step ${stepMerge}: Collect and merge findings

Follow these stages in order. Validate core and specialist findings alike, but keep
their source labels: specialist scoring is not the final review's defect count.

#### 1. Parse outputs

After specialist attempts settle, collect their outputs, tagged by actual source.
Successful \`NO FINDINGS\` is a completed empty result. Otherwise parse each JSON line and
skip invalid lines. Missing or unusable output is incomplete coverage, not an
empty success. Retain each specialist's returned findings for activity stats.

#### 2. Validate severity

For core and specialist findings with \`"severity":"CRITICAL"\` and \`"advisory":true\`,
remove \`advisory\` and retain its \`CRITICAL\` severity. Treat these as defects before
identity, merging, counting, scoring or Fix-First. Never downgrade severity to make
advisory metadata consistent. Valid INFORMATIONAL advisories remain advisory in
every category, including simplification.

#### 3. Identify and merge

Partition defects and advisories BEFORE grouping by fingerprint. Never merge a
defect with advice, even on a supplied-hash collision. Neither higher-confidence
advice nor a prior skipped extraction may replace, downgrade or suppress a defect.

Compute identities for both core and specialist findings:
- Shared-code advice (category \`shared-libs\` or fingerprint prefix \`shared-libs:\`):
  call installed \`sharedLibsFingerprint\` from \`${ctx.paths.skillRoot}/lib/review-evidence.ts\`
  with \`evidence_paths\` and \`helper_target\` as literal JSON on stdin, as in the core pass;
  never trust a supplied hash or generate one yourself. Missing/malformed metadata
  cannot deduplicate or reuse a saved decision.
- Other findings: use supplied \`fingerprint\`, else \`{path}:{line}:{category}\`
  or \`{path}:{category}\` when no line exists.

Within the specialist list, merge matching identities in the same partition: keep
the highest confidence and all source names. Confirmation by distinct specialists
adds +1 (cap at 10) and \`MULTI-SPECIALIST CONFIRMED ({specialist1} + {specialist2})\`.
Core findings never earn a specialist confidence boost. Preserve \`advisory\`,
\`evidence_paths\` and \`helper_target\` through every merge.

#### 4. Apply specialist confidence gates

- Confidence 7+: show normally in the findings output
- Confidence 5-6: show with caveat "Medium confidence — verify this is actually an issue"
- Confidence 3-4: move to appendix (suppress from main findings)
- Confidence 1-2: suppress entirely

Core findings keep the core Confidence Calibration gates.

#### 5. Score and present specialists

Only specialist findings enter this header and \`quality_score\`; core findings do not.
Use the merged NON-advisory specialist findings for both counts and score;
the header's N is X + Y, so advisory findings never add to it:
\`quality_score = max(0, 10 - (critical_count * 2 + informational_count * 0.5))\`
Cap at 10 and retain for ${persistRef}. These are not final unresolved-defect totals.
Print only this block: the stage 6 activity object and \`test_stub\` bodies are log and Fix-First data.
Validated \`"advisory": true\` findings from any source are excluded from score,
header, unresolved-defect totals and clean-status blockers. Show them separately;
they remain ASK-only, never auto-applied. Real defects follow normal Fix-First.

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

Do not add core shared-code savings to this specialist footer. Explain any overlap once in the core proposal instead of presenting duplicate savings.

#### 6. Save specialist activity

Compile a \`specialists\` object for ${persistRef}.
${isShip ? 'For each specialist' : 'For DIFF_LINES < 50, keep `specialists: {}`; do not manufacture per-specialist scope records. Otherwise record each considered specialist'} (testing, maintainability, security, performance, data-migration, api-contract, design, simplification, red-team):
- If dispatched: \`{"dispatched": true, "findings": N, "critical": N, "informational": N}\`
- If skipped by scope: \`{"dispatched": false, "reason": "scope"}\`
- If skipped by gating: \`{"dispatched": false, "reason": "gated"}\`
- If not applicable (e.g., red-team not activated): omit from the object

Count only findings that specialist actually returned, before deduplication.
Advisory findings COUNT in the stats \`findings\` field, not its defect counts.
Include Design despite its different checklist. Preserve dispatch/failure status:
zero returned findings from a failed attempt is not a clean review.

#### 7. Hand off to Fix-First

Send these findings to ${fixFirstRef} alongside ${critPassRef}.
Consolidate equivalent shared-code advice under the core proposal, retaining all
sources and counting overlapping savings once. Keep actual specialist stats;
core-only advice must not create a specialist dispatch or finding.
Normal AUTO-FIX/ASK rules apply, with advice ASK-only. Missing coverage still blocks
completion. Advice never permits edits while readers are active or replaces a required review.`;
}

function generateRedTeam(ctx: TemplateContext): string {
  const isShip = ctx.skillName === 'ship';
  const stepMerge = isShip ? '9.2' : '4.6';
  const fixFirstRef = isShip ? 'Step 9.3 dedup, then Step 9.4 Fix-First' : 'Step 5 Fix-First';
  return `### Red Team dispatch (conditional)

**Activation:** Only if DIFF_LINES > 200 OR any specialist produced a CRITICAL finding.

If activated, dispatch one more subagent via the Agent tool (pass ${FOREGROUND_IF_AVAILABLE} — foreground; subagents default to background since ${CC_BACKGROUND_DEFAULT_SINCE}; ${BACKGROUND_RECOVERY})

The Red Team subagent receives:
1. The red-team checklist path \`${ctx.paths.skillRoot}/review/specialists/red-team.md\` (it reads the file)
2. The merged specialist findings from Step ${stepMerge}, one line each (so it knows what was already caught)
3. The git diff command

Prompt, after the defensive framing and fixture handling from item 4 of the specialist dispatch: "You are a red team reviewer. The code has already been reviewed by N specialists
who found the following issues: {merged findings summary}. Your job is to find what they
MISSED. Read the checklist at {red-team checklist path}, list changed files with \`DIFF_BASE=$(git merge-base origin/<base> HEAD) && git diff --name-status "$DIFF_BASE"\`, read them as that fixture handling says, and look for gaps.
Output findings as JSON objects (same schema as the specialists). Focus on cross-cutting
concerns, integration boundary issues, and failure modes that specialist checklists
don't cover."

If the Red Team finds additional issues, tag them \`"specialist":"red-team"\`.
Add them to the original specialist outputs and rerun stages 1–7 of Step ${stepMerge}
before ${fixFirstRef}; do not boost or count the earlier findings twice.

If the Red Team returns NO FINDINGS, note: "Red Team review: no additional issues found."
If the Red Team fails or times out, confirm it stopped and record its review as incomplete, just as for other specialists. ${isShip ? "Return to the parent's Exploratory QA step, then dedup and persistence; Step 9.4 cannot certify missing dispatched coverage as completed or clean." : 'Continue independent Step 4.7 QA and Step 4.8 adversarial review; Step 5.8 cannot certify missing dispatched coverage as completed or clean.'}`;
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
