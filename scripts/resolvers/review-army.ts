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
import { RED_TEAM_INTRO, RED_TEAM_OUTPUT, SPECIALIST_CONTRACT, SPECIALIST_INTRO, packetBrief } from '../../lib/review-prompts';

/** A lib/review-prompts.ts string inside a quoted prose prompt. */
const quoted = (s: string) => s.replaceAll('"', '\\"');

function generateSpecialistSelection(ctx: TemplateContext): string {
  const isShip = ctx.skillName === 'ship';
  const stepSel = isShip ? '9.1' : '4.5';
  const stepMerge = isShip ? '9.2' : '4.6';
  const nextStep = isShip ? 'Step 9.3 (cross-review dedup)' : 'Step 4.8 (adversarial review), then Step 5';
  return `## Step ${stepSel}: Review Army — Specialist Dispatch

### Detect stack and scope

\`\`\`bash
_SM=$(${ctx.paths.binDir}/gstack-state-matrix detect --base <base>) || _SM=SCOPE_STATE_MACHINE=unknown; source <(echo "$_SM")
source <(${ctx.paths.binDir}/gstack-diff-scope <base> 2>/dev/null) || true
set | grep '^SCOPE_'
STACK=""
[ -f Gemfile ] && STACK="\${STACK}ruby "
[ -f package.json ] && STACK="\${STACK}node "
[ -f requirements.txt ] || [ -f pyproject.toml ] && STACK="\${STACK}python "
[ -f go.mod ] && STACK="\${STACK}go "
[ -f Cargo.toml ] && STACK="\${STACK}rust "
[ -f pubspec.yaml ] && STACK="\${STACK}dart "
echo "STACK: \${STACK:-unknown}"
DIFF_BASE=$(git merge-base origin/<base> HEAD)
DIFF_LINES=$(git diff "$DIFF_BASE" --numstat | awk '{n+=$1+$2} END {print n+0}')
echo "DIFF_LINES: $DIFF_LINES"
# Detect test framework
TEST_FW=""
{ [ -f jest.config.ts ] || [ -f jest.config.js ]; } && TEST_FW="jest"
[ -f vitest.config.ts ] && TEST_FW="vitest"
{ [ -f spec/spec_helper.rb ] || [ -f .rspec ]; } && TEST_FW="rspec"
{ [ -f pytest.ini ] || [ -f conftest.py ]; } && TEST_FW="pytest"
[ -f go.mod ] && TEST_FW="go-test"
[ -f pubspec.yaml ] && TEST_FW="dart-test" && grep -qsE '^ +sdk: *.?flutter' pubspec.yaml && TEST_FW="flutter-test"
echo "TEST_FW: \${TEST_FW:-unknown}"
\`\`\`

### Read specialist hit rates (adaptive gating)

\`\`\`bash
${ctx.paths.binDir}/gstack-specialist-stats 2>/dev/null || true
\`\`\`

### Select specialists

Select specialists from the scope signals above.

**Always-on (every review with 50+ changed lines):**
1. **Testing** — read \`${ctx.paths.skillRoot}/review/specialists/testing.md\`
2. **Maintainability** — read \`${ctx.paths.skillRoot}/review/specialists/maintainability.md\`

**If DIFF_LINES < 50:** Skip all specialists except State Machines (item 9 decides it). Print: "Small diff ($DIFF_LINES lines) — specialists skipped." Continue to Step ${stepMerge} with the ${isShip ? 'core/design-lite' : 'core'} findings and an empty or State Machines-only specialist list, then the parent's Exploratory QA step and ${nextStep}. Small diffs skip fan-out, never the parent-owned smoke probes or core shared-code checks.

**Conditional (dispatch when its scope signal is true):**
3. **Security** — if SCOPE_AUTH=true, OR if SCOPE_BACKEND=true AND DIFF_LINES > 100. Read \`${ctx.paths.skillRoot}/review/specialists/security.md\`
4. **Performance** — if SCOPE_BACKEND=true OR SCOPE_FRONTEND=true. Read \`${ctx.paths.skillRoot}/review/specialists/performance.md\`
5. **Data Migration** — if SCOPE_MIGRATIONS=true. Read \`${ctx.paths.skillRoot}/review/specialists/data-migration.md\`
6. **API Contract** — if SCOPE_API=true. Read \`${ctx.paths.skillRoot}/review/specialists/api-contract.md\`
7. **Design** — if SCOPE_FRONTEND=true. Use the existing design review checklist at \`${ctx.paths.skillRoot}/review/design-checklist.md\` and run the mechanical pass at the top of that checklist (the user-installed design detector, when present) before the LLM items
8. **Simplification** — if DIFF_LINES > 100. Read \`${ctx.paths.skillRoot}/review/specialists/simplification.md\`. Advisory-only lens: hunts unrequested structure (hand-rolled stdlib, one-implementation abstractions, dependencies duplicating platform features), never coverage.
9. **State Machines** — if SCOPE_STATE_MACHINE is true or unknown: read \`${ctx.paths.skillRoot}/review/specialists/state-machines.md\`, run \`${ctx.paths.binDir}/gstack-state-matrix outfile\`, Read the file it prints, write the full output there, then run \`${ctx.paths.binDir}/gstack-state-matrix check <file>\` on it.

### Adaptive gating

After scope-based selection, apply adaptive gating based on specialist hit rates:

For each conditional specialist that passed scope gating, read the \`gstack-specialist-stats\` output:
- If tagged \`[GATE_CANDIDATE]\` (0 findings in 10+ dispatches): skip it. Print: "[specialist] auto-gated (0 findings in N reviews)."
- If tagged \`[NEVER_GATE]\`: always dispatch regardless of hit rate.

**Force flags:** \`--<specialist>\` (e.g. \`--simplification\`) or \`--all-specialists\` in the prompt force-includes it.

Print the selection:
"Dispatching N specialists: [names]. Skipped: [names] (scope not detected). Gated: [names] (0 findings in N+ reviews)."`;
}

/**
 * The diff command every dispatched reviewer runs. In /ship the parent writes the
 * base sha into the prompt (the merge base on pass 1, RANGE_BASE from pass 2 on):
 * a reviewer is its own process and never sees the parent's shell variables, so a
 * `$RANGE_BASE` reference there would silently fall back to the whole branch.
 */
function diffBase(ctx: TemplateContext): string {
  return ctx.skillName === 'ship' ? 'DIFF_BASE=<diff-base>' : 'DIFF_BASE=$(git merge-base origin/<base> HEAD)';
}

function generateSpecialistDispatch(ctx: TemplateContext): string {
  if (ctx.skillName === 'ship') return generatePacketDispatch(ctx);
  return `### Dispatch specialists in parallel

For each selected specialist, launch an independent subagent via the Agent tool.
**Launch ALL selected specialists in a single message** (multiple Agent tool calls)
so they run in parallel. Each subagent has fresh context — no prior review bias.

**Each specialist subagent prompt:**

Each specialist prompt includes:

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

"${SPECIALIST_INTRO} Read the checklist at {checklist path}, then run
\`${diffBase(ctx)} && git diff "$DIFF_BASE"\` to get the full diff. Apply the checklist against the diff.

${quoted(SPECIALIST_CONTRACT)}

Stack context: {STACK}
Past learnings: {learnings or 'none'}"

**Subagent configuration:**
- Use \`subagent_type: "general-purpose"\`
- Pass ${FOREGROUND_IF_AVAILABLE} on every specialist Agent call — background is the default since ${CC_BACKGROUND_DEFAULT_SINCE}; omitting an available flag is not foreground. ${BACKGROUND_RECOVERY}

${WAIT_FOR_READERS}`;
}

const WAIT_FOR_READERS = `**Wait for readers before editing:**
- Confirm that each task has finished or is stopped. A timeout alone does not prove termination. If a reader or writer is still active, wait; if its state is unknown, inspect its task/process status. If you cannot confirm it stopped, use the parent's Fix-First stop path without edits.
- A failed task may be stopped without having completed its review. Record the failure and retain usable partial findings.
- Continue independent evidence collection after a terminal failure. Missing dispatched coverage remains incomplete, never completed or clean; successful peers cannot replace it.`;

/**
 * /ship dispatches by packet (docs/review-policy.md#reviewer-packets): each reviewer reads one
 * file gstack-review-packet wrote from the same plan, and the parent reads only collect's record.
 */
function generatePacketDispatch(ctx: TemplateContext): string {
  const bin = ctx.paths.binDir;
  return `### Dispatch specialists by packet

Each reviewer reads one packet and nothing else. \`gstack-review-packet build\` runs the
plan \`gstack-review-plan\` runs (pass the same flags) and writes one packet per \`DISPATCH:\`
line: the role's instructions and findings contract, its checklists inlined (all of
\`checklists=\` for \`specialist batched\`), its \`DIFF_CMD:\` diff at -U8 against the literal
diff base with a stat, past learnings, a read budget and its output path. With
\`_PK=.gstack/tmp/review-packets-p$PASS\`, run \`${bin}/gstack-review-packet build --base <base>
--out-dir "$_PK" --only specialist,red-team\` plus the plan run's flags, \`--range <sha>\` (the literal \`RANGE_BASE\` sha)
from pass 2 on and \`--plan-file <plan>\` when a plan is bound. Each \`PACKET:\` line is one
reviewer; a diff past 200 KB is split by path into shards (\`testing.1of3\`), each its
own reviewer. Its \`read=\` ranges are what the reviewer reads in parallel, each under one
read call's budget. \`PACKETS:\` carries the plan's fingerprint; under a token cap,
\`gstack-ship-budget check --next\` takes build's \`BUDGET_NEXT:\` value (one
\`budget_role=\` per packet), never packet names. Step 9.1 dispatches every
packet; the Red Team's waits for collect (below) and Step 11 builds its own.

Launch one subagent per packet via the Agent tool (\`subagent_type: "general-purpose"\`,
${FOREGROUND_IF_AVAILABLE}; ${BACKGROUND_RECOVERY}) at its \`effort=\` on the same model
family. The whole brief is "${packetBrief('<file>', '<out>')}" with that packet's \`read=\` ranges. Never paste a diff,
checklist or finding into a brief.

**Fan-out (\`--review-fanout auto|serial|parallel\` in the prompt; default \`auto\`).**
Under \`auto\`, when the host reports fewer free subagent slots than selected
specialists (Capy caps a thread at 8 running subagents, and waiting or idle ones hold
a slot), dispatch in batches of the free-slot count, at least one per batch, each
batch in one message, and start the next batch only after every reader of the
previous one has finished or is confirmed stopped; print \`Fan-out: N specialists in
M batches of K\`. A host that reports no slot count runs one parallel batch.
\`serial\` is batches of one; \`parallel\` is one batch regardless of slots (a refused
launch is a failed reader, never silently dropped coverage). Batching changes the
order, never the set: every selected specialist still runs before Step 9.2 merges.

${WAIT_FOR_READERS}

**Collect:** \`${bin}/gstack-review-packet collect --dir "$_PK"\` reads every packet's output
file and prints one \`REVIEWER:\` line each, every CRITICAL on one line and counts for
INFORMATIONAL. It does stages 1–3 of Step 9.2 into \`$_PK/merged.jsonl\` and writes
\`$_PK/informational.md\` for Step 19's PR body. Exit 3 \`REVIEW_COVERAGE_INCOMPLETE\` is
missing dispatched coverage (decision 1). Step 9.2 continues from that output and
\`merged.jsonl\`, never from a reviewer's transcript. When a state-machines packet ran,
run \`${bin}/gstack-state-matrix check <its out file>\` on its output.`;
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

After specialist attempts settle, collect their outputs, tagged by actual source.${isShip ? ' In /ship, \`gstack-review-packet collect\` has done stages 1–3 for the dispatched reviewers: read its output and \`merged.jsonl\`.' : ''}
\`NO FINDINGS\` is a completed, clean result, never a failed reviewer. Otherwise parse
each JSON line and skip invalid lines. Missing or unusable output is incomplete
coverage, not an empty success. Keep each specialist's returned findings for activity stats.

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
the highest confidence and all source names. Confirmation by distinct specialists adds +1 (cap at 10) and \`MULTI-SPECIALIST CONFIRMED ({specialist1} + {specialist2})\`.
Core findings never earn a specialist confidence boost. Preserve \`advisory\`,
\`evidence_paths\` and \`helper_target\` through every merge.

#### 4. Lead judgment

Reviewers fill the space they are given. Before a merged finding counts, the
parent reads it and drops or downgrades it on these grounds, saying so:
- **Nit gravity.** A reviewer whose whole return is style, naming and preference
  found nothing; say so and count no defect.
- **Hypothetical, not actual.** A defect names the call site or input that reaches
  it; one that does not is a note until someone traces it.
- **Structure for a case that does not exist.** Advice to abstract, generalize or
  guard a path nothing takes is advisory.
- **A different design is not a defect.** "I would have done it differently" with
  no failing case is dropped.
- **Missing context.** A finding that assumes a rule the repository documents
  otherwise is dropped with the pointer.
- **On record.** A class \`docs/review-policy.md\` rules below the floor is a note,
  named by its ruling.
Independent agreement between reviewers is the strongest signal (the
\`MULTI-SPECIALIST CONFIRMED\` boost records it). A reviewer that
returned \`NO FINDINGS\` was right until a traced defect says otherwise.

#### 5. Apply specialist confidence gates

- Confidence 7+: show normally in the findings output
- Confidence 5-6: show with caveat "Medium confidence — verify this is actually an issue"
- Confidence 3-4: move to appendix (suppress from main findings)
- Confidence 1-2: suppress entirely

Core findings keep the core Confidence Calibration gates.

#### 6. Score and present specialists

Only specialist findings enter this header and \`quality_score\`; core findings do not.
Use the merged NON-advisory specialist findings for both counts and score;
the header's N is X + Y, so advisory findings never add to it:
\`quality_score = max(0, 10 - (critical_count * 2 + informational_count * 0.5))\`
Cap at 10 and retain for ${persistRef}. These are not final unresolved-defect totals.
Print only this block: the stage 7 activity object and \`test_stub\` bodies are log and Fix-First data.
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

Core shared-code savings never enter this footer; explain any overlap once in the core proposal.

#### 7. Save specialist activity

Compile a \`specialists\` object for ${persistRef}.
${isShip ? 'For each specialist' : 'For DIFF_LINES < 50, keep `specialists: {}` (or `state-machines` alone when it dispatched); do not manufacture per-specialist scope records. Otherwise record each considered specialist'} (testing, maintainability, security, performance, data-migration, api-contract, design, simplification, state-machines, red-team):
- If dispatched: \`{"dispatched": true, "findings": N, "critical": N, "informational": N}\`
- If skipped by scope: \`{"dispatched": false, "reason": "scope"}\`
- If skipped by gating: \`{"dispatched": false, "reason": "gated"}\`
- If not applicable (e.g., red-team not activated): omit from the object

Count only findings that specialist actually returned, before deduplication.
Advisory findings COUNT in the stats \`findings\` field, not its defect counts.
Include Design despite its different checklist. Preserve dispatch/failure status:
zero returned findings from a failed attempt is not a clean review.

#### 8. Hand off to Fix-First

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
  const dispatch = isShip ? `If the plan lists \`DISPATCH: red-team\`, build its packet once Step 9.1's collect has run:
\`${ctx.paths.binDir}/gstack-review-packet build --only red-team --findings "$_PK/merged.jsonl"\` plus
the Step 9.1 build's flags. It inlines the red-team checklist, the merged findings one
line each, the defensive framing and the diff with fixtures in summary mode. Dispatch
it with the same packet brief, then run collect again: Step 9.4 needs a collect with \`pending=0\`.` : `If activated, dispatch one more subagent via the Agent tool (pass ${FOREGROUND_IF_AVAILABLE} — foreground; subagents default to background since ${CC_BACKGROUND_DEFAULT_SINCE}; ${BACKGROUND_RECOVERY})

The Red Team subagent receives:
1. The red-team checklist path \`${ctx.paths.skillRoot}/review/specialists/red-team.md\` (it reads the file)
2. The merged specialist findings from Step ${stepMerge}, one line each (so it knows what was already caught)
3. The git diff command

Prompt, after the defensive framing and fixture handling from item 4 of the specialist dispatch: "${RED_TEAM_INTRO} Read the checklist at {red-team checklist path}, list changed files with \`${diffBase(ctx)} && git diff --name-status "$DIFF_BASE"\`, read them as that fixture handling says, and look for gaps.
${RED_TEAM_OUTPUT}"`;
  return `### Red Team dispatch (conditional)

**Activation:** Only if DIFF_LINES > 200 OR any specialist produced a CRITICAL finding.

${dispatch}

Tag Red Team findings \`"specialist":"red-team"\`.
Add them to the original specialist outputs and rerun stages 1–8 of Step ${stepMerge}
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
