/**
 * Spec review loops, benefits-from, and the anti-shortcut clause.
 *
 * Moved from scripts/resolvers/review.ts.
 */
import { type TemplateContext } from './types';
import { generateInvokeSkill } from './composition';
import { CC_BACKGROUND_DEFAULT_SINCE } from './constants';
import { DESIGN_DOC_DISCOVERY_BLOCK } from './design-doc-discovery';

export function generateAntiShortcutClause(_ctx: TemplateContext): string {
  if (_ctx.skillName === 'plan-ceo-review') return `**Anti-shortcut clause:** Analyze → resolve → apply for each section before advancing. The plan file records the interactive review; it cannot replace it. Do not prewrite the remaining sections or their implementation tasks and then walk through a fixed question list. Proposed findings are not accepted plan changes: mark them pending until their actual decisions are made. Ask once per unresolved or reopened issue, wait for the answer, and apply only the exact accepted choice and scope to the working plan. An earlier approach selection does not authorize unrelated choices. Keep established contracts, accepted decisions, and their evidence available to later sections; new material risks or changed remedies still need approval. Cross-referencing settled decisions never replaces the full review and terminal report. Follow the working review decisions below; never invent a question merely because a new section starts.`;
  if (_ctx.skillName === 'plan-design-review') return `**Anti-shortcut clause:** Review every section and outside voice finding. The plan records the review; writing a finding into it is not approval. For each finding:

- **New or reopened choice:** Ask once per independent decision, wait for the actual answer, then apply only its accepted scope. Present concrete new risks or changed assumptions that reopen an earlier choice.
- **Work already approved:** Necessary code, tests and docs for an exact previously selected contract do not reopen it. Cite the selected answer and scope, retain the finding and proof, and disclose the follow-through. A broad approach or recommendation does not approve independent remedies or optional verification depth.
- **Factual correction:** Correct descriptions against source evidence without authorizing behavior changes.

Never skip sections or the terminal report. Do not invent a question merely because a finding came from another section or reviewer.`;
  if (_ctx.skillName === 'plan-eng-review') return `**Anti-shortcut clause:** Use the decision gate for all four sections and outside voice. Retain findings and evidence. Ask only for new or reopened choices and apply their exact answers. Never prewrite unapproved remedies or skip sections or the terminal report.`;

  if (_ctx.skillName === 'plan-devex-review') return `**Anti-shortcut clause:** Evaluate every section and outside voice finding through the decision gate below. The plan records the interactive review; writing findings into it never substitutes for approval. Ask once per new or reopened independent decision, wait for the actual answer, and apply only its accepted scope. Necessary code, tests and docs for an exact previously selected contract do not reopen it: cite that selected answer and scope, retain the finding and proof, and disclose the follow-through. Correct factual descriptions against source evidence without authorizing behavior changes. A broad approach or recommendation does not approve independent remedies or optional verification depth. Concrete new risks or changed assumptions may reopen a decision and must be presented. Never skip sections or the terminal report, or invent a question merely because a finding came from another section or reviewer.`;
  return `**Anti-shortcut clause:** The plan file records the interactive review; it cannot replace it. Take each non-trivial finding through AskUserQuestion, wait for the answer, and apply only the accepted choice before writing it into the plan. Only a review with zero findings in every section reaches ExitPlanMode without asking. Never skip sections or the terminal report.`;
}

function generateOfficeHoursSpecReviewLoop(): string {
  return `## Spec Review Loop

Run an adversarial review before presenting the final document to the user.
Follow the calling workflow's approval steps.
The reviewer's saved JSON is the complete verdict. A prose summary is not a second
finding inventory: the report helper preserves every problem/remedy and counts the
records mechanically. Do not rewrite, condense, deduplicate, or recount its blocks.

**Step 1: Prepare and dispatch the reviewer**

Create a fresh review directory next to the design:

\`\`\`bash
mktemp -d "<design-path>.review.XXXXXX"
\`\`\`
Remember its actual path for this invocation. Keep these evidence files with the design.
Maximum 3 iterations total. Before EACH dispatch, generate the complete prompt using
all preceding valid round files in order (omit them for round 1):

\`\`\`bash
~/.claude/skills/gstack/bin/gstack-office-hours-review prepare --design "<design-path>" --out-dir "<review-directory>" "<round-1.json if present>" "<round-2.json if present>"
\`\`\`

Omit absent arguments rather than passing placeholders. The helper chooses the next
round and writes \`round-N.prompt.md\`. It includes the full finding schema, all five
review dimensions (Completeness, Consistency, Clarity, Scope, Feasibility), the
office-hours coaching contract, and the COMPLETE preceding JSON verdict.

Use the Agent tool with \`run_in_background: false\` and its returned \`dispatch\`
string unchanged as the prompt. The reviewer must Read the entire prepared prompt
file before reviewing the design. Do not recreate the prompt, copy selected fields,
or summarize prior findings. A parent Read does not deliver the file to the reviewer.
The reviewer has fresh context and cannot see the brainstorming conversation.
Its prepared contract requires a complete JSON Write, sealed by the dispatch's
\`Seal:\` command, and a one-line \`OFFICE_HOURS_VERDICT\` receipt as its entire response.
It protects the required coaching and Assignment sections, distinguishes unknown
customer facts from committed behavior, and requires evidence for every prior status.

**Step 2: Check stop conditions, then fix and re-dispatch**

After each verdict, BEFORE fixing any findings or dispatching again, validate the
saved files with the helper. Pass the reviewer's entire response unchanged as the
receipt and list every completed round in order:

\`\`\`bash
~/.claude/skills/gstack/bin/gstack-office-hours-review check --receipt "<reviewer response>" "<round-1.json>" "<round-2.json if present>" "<round-3.json if present>"
\`\`\`

A missing, malformed, or mismatched receipt fails the check: that attempt is a failed review.

Omit absent arguments rather than passing placeholders.
**Convergence guard and stopping rules:** Read its stop reason:
- PASS: no unresolved findings; proceed to Step 3.
- CONVERGENCE: the reviewer explicitly marked a prior obligation persisting with
  a concrete prior/current finding pair and document evidence. Stop even if new
  findings appear. Shared topic labels or new refinements alone are insufficient.
- MAX_ITERATIONS: round 3 completed; stop.
- CONTINUE: fix the listed findings in the design, then return to Step 1 to prepare and dispatch the next review.

On a stop, do not fix again or re-dispatch. Run the finalizer before approval:

\`\`\`bash
~/.claude/skills/gstack/bin/gstack-office-hours-review finalize --design "<design-path>" "<round-1.json>" "<round-2.json if present>" "<round-3.json if present>"
\`\`\`

It installs the complete \`## Reviewer Concerns\` section directly from the JSON.
Recording concerns does not mark them fixed. Do not edit that generated section.
Then proceed to Step 3 and the existing user approval.

If the subagent fails, times out, or is unavailable — stop the loop and present the
document unreviewed. Tell the user: "Spec review unavailable — presenting unreviewed doc."
A missing or invalid verdict is an explicit review failure, never PASS. Preserve the
failed output and its error. Finalize with \`--unreviewed "<actual failure cause>"\`
and only the preceding valid round files (none if round 1 failed); their known
concerns remain visible. Do not fabricate JSON or hide a completed verdict behind
UNREVIEWED. The independent review remains a quality bonus, not an approval gate.

**Step 3: Report and persist metrics**

The finalizer prints the exact Spec Review block, quality score, and metrics. Tell the user the
result using that block; link the design and saved verdicts for details. Report
finding observations across rounds separately from unresolved final findings.
Confirmed resolutions require explicit later reviewer evidence; attempted fix
rounds are counted separately and never described as successful fixes.

When writing a completion report, write its other sections normally, then run the
same finalizer with \`--report "<report-path>"\` after the report exists. This installs
its authoritative \`## Spec Review\` section and Disposition mechanically. Do not
summarize or replace that section afterward; refer to it elsewhere instead of
inventing duplicate counts. Preserve the Assignment, coaching, approval, and Handoff.

Append the helper's actual metrics to the existing analytics log (telemetry is
best-effort and must not block approval):
\`\`\`bash
GSTACK_STATE_ROOT=$(~/.claude/skills/gstack/bin/gstack-paths --get GSTACK_STATE_ROOT); : "\${GSTACK_STATE_ROOT:?gstack-paths failed; reinstall with ./setup or /gstack-upgrade}"
mkdir -p "$GSTACK_STATE_ROOT/analytics"
echo '{"skill":"office-hours","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","iterations":ITERATIONS,"issues_found":FOUND,"issues_fixed":FIXED,"remaining":REMAINING,"quality_score":SCORE}' >> "$GSTACK_STATE_ROOT/analytics/spec-review.jsonl" 2>/dev/null || true
\`\`\`
Use iterations, issues_found, issues_fixed, remaining, and quality_score from the
helper. FOUND counts finding observations across rounds; FIXED counts only
reviewer-confirmed resolutions. An unavailable score is null, never invented.`;
}

export function generateSpecReviewLoop(_ctx: TemplateContext): string {
  if (_ctx.skillName === 'office-hours') return generateOfficeHoursSpecReviewLoop();
  const ceo = _ctx.skillName === 'plan-ceo-review';
  return `${ceo ? '####' : '##'} Spec Review Loop

Run an adversarial review before presenting the final document to the user.
${ceo ? 'Use 0D for any new or reopened amendment discovered by the reviewer. The later 0H approval approves only the completed working plan and CEO summary, not unresolved amendments.' : "Follow the calling workflow's approval steps."}

**Step 1: Dispatch reviewer subagent**

${ceo ? `Read Agent's tool definition. Set \`run_in_background: false\` if that field is available; omit it otherwise. Launch one reviewer with both inputs below.

If the result contains a completed review, consume it. If it returns a pending task, use the host's wait tool. With no wait tool, end this response and resume on its completion notification. While waiting, do not advance, edit either input or launch another reviewer.` : `Use Agent with JSON boolean \`run_in_background: false\`, never string \`"false"\`.
Subagents default to background since ${CC_BACKGROUND_DEFAULT_SINCE}. Async launch metadata
is not a verdict: wait for that agent's final review before continuing; do not launch a duplicate.
The reviewer has fresh context: only the document, not the conversation.`}

Prompt the subagent with:
- ${ceo ? 'Both saved absolute paths, or both complete labeled texts if either input is not persisted: CEO scope summary and current amended working plan. No other conversation context.' : 'The file path of the document just written'}
${ceo ? `- "Read both inputs in full. Evaluate them together on all five dimensions.
  Flag contradictions, unsupported accepted expansions and required behavior
  missing from both. Cite input and requirement for each finding. If either
  input is unavailable or incomplete, report that failure instead of grading
  partial input."` : `- "Read this document and review it on 5 dimensions. For each dimension, note PASS or
  list specific issues with suggested fixes. At the end, output a quality score (1-10)
  across all dimensions."`}

**Dimensions:**
${ceo ? `1. **Completeness** — requirements and edge cases.
2. **Consistency** — no contradictions.
3. **Clarity** — implementable without follow-up questions.
4. **Scope** — no unapproved creep or YAGNI.
5. **Feasibility** — buildable with the stated approach.` : `1. **Completeness** — Are all requirements addressed? Missing edge cases?
2. **Consistency** — Do parts of the document agree with each other? Contradictions?
3. **Clarity** — Could an engineer implement this without asking questions? Ambiguous language?
4. **Scope** — Does the document creep beyond the original problem? YAGNI violations?
5. **Feasibility** — Can this actually be built with the stated approach? Hidden complexity?`}

The subagent should return:
- A quality score (1-10)${ceo ? " across all dimensions" : ""}
${ceo ? '- For each dimension, PASS or numbered issues with suggested fixes. Overall PASS only if all dimensions pass.' : '- PASS if no issues, or a numbered list of issues with dimension, description, and fix'}

${ceo ? `**Step 2: Process the result**

- **Unavailable:** If launch or review fails, times out, or cannot review both complete inputs, stop the loop. Say "Spec review unavailable — presenting unreviewed doc." Preserve the failure and all prior findings. Continue to Step 3 to record the unavailable outcome; a successful reviewer result is not required.
- **PASS:** Stop the loop.
- **Issues:** Stop after the third review, or when consecutive reviews repeat the same unresolved issues (the same requirements and problems). Otherwise use 0D for new or reopened choices, amend the working plan and CEO summary under the storage policy, Keep both consistent, and re-dispatch with both updated inputs and the same instructions.

Make at most three reviewer launches. A missing score alone does not require another review.` : `**Step 2: Fix and re-dispatch**

If the reviewer returns issues:
1. Fix each issue in the document on disk (use Edit tool)
2. Re-dispatch the reviewer subagent with the updated document
3. Maximum 3 iterations total

**Convergence guard:** If the reviewer returns the same issues on consecutive iterations
(the fix didn't resolve them or the reviewer disagrees with the fix), stop the loop
and persist those issues as "Reviewer Concerns" in the document rather than looping
further.

If the subagent fails, times out, or is unavailable — skip the review loop entirely.
Tell the user: "Spec review unavailable — presenting unreviewed doc." The document is
already written to disk; the review is a quality bonus, not a gate.`}

**Step 3: Report and persist metrics**

${ceo ? `Report the outcome and fields below. Show full reviewer output on request. List unresolved issues under "## Reviewer Concerns" in the CEO summary, citing the owning input.

SCORE is the latest attempt's reported 1–10 grade after reviewing both full inputs. For an unavailable review or missing/invalid grade, use JSON \`null\` ("score unavailable"). Label earlier grades "prior review score".

Recording the **0H spec-review metrics** is
required when writing is permitted, even if the reviewer failed. Append the
actual outcome below; failed mkdir or append stops the review. When writing is
forbidden, show the actual fields as not persisted and continue without writing.
If the reviewer fails, report that limit and continue after recording the outcome;
if a required save fails, stop before claiming completion.` : `After the loop completes (PASS, max iterations, or convergence guard):

1. Tell the user the result — summary by default:
   "Your doc survived N rounds of adversarial review. M issues caught and fixed.
   Quality score: X/10."
   If they ask "what did the reviewer find?", show the full reviewer output.

2. If issues remain after max iterations or convergence, add a "## Reviewer Concerns"
   section to the document listing each unresolved issue. Downstream skills will see this.

3. Append metrics:`}
\`\`\`bash
GSTACK_STATE_ROOT=$(~/.claude/skills/gstack/bin/gstack-paths --get GSTACK_STATE_ROOT); : "\${GSTACK_STATE_ROOT:?gstack-paths failed; reinstall with ./setup or /gstack-upgrade}"
mkdir -p "$GSTACK_STATE_ROOT/analytics"${ceo ? ' || exit 1' : ''}
echo '{"skill":"${_ctx.skillName}","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","iterations":ITERATIONS,"issues_found":FOUND,"issues_fixed":FIXED,"remaining":REMAINING,"quality_score":SCORE}' >> "$GSTACK_STATE_ROOT/analytics/spec-review.jsonl"${ceo ? ' || exit 1' : ' 2>/dev/null || true'}
\`\`\`
${ceo ? 'ITERATIONS counts actual reviewer launches. FOUND, FIXED and REMAINING count reported issues, reviewer-confirmed fixes and reported unresolved issues. Use actual counts, never estimates.' : 'Replace ITERATIONS, FOUND, FIXED, REMAINING, SCORE with actual values from the review.'}`;
}

export function generateBenefitsFrom(ctx: TemplateContext): string {
  if (!ctx.benefitsFrom || ctx.benefitsFrom.length === 0) return '';

  const skillList = ctx.benefitsFrom.map(s => `\`/${s}\``).join(' or ');
  const first = ctx.benefitsFrom[0];

  // Reuse the INVOKE_SKILL resolver for the actual loading instructions
  const invokeBlock = generateInvokeSkill(ctx, [first]);

  return `## Prerequisite Skill Offer

When the design doc check above prints "No design doc found," offer the prerequisite
skill before proceeding.

${ctx.skillName === 'plan-eng-review' ? 'Build the next full decision brief from these facts and options, using the preamble transport, numbering and format:' : 'Say to the user via AskUserQuestion:'}

> "No design doc found for this branch. ${skillList} produces a structured problem
> statement, premise challenge, and explored alternatives — it gives this review much
> sharper input to work with. Takes about 10 minutes. The design doc is per-feature,
> not per-product — it captures the thinking behind this specific change."

Options:
- A) Run /${first} now (we'll pick up the review right after)
- B) Skip — proceed with standard review

If they skip: "No worries — standard review. If you ever want sharper input, try
/${first} first next time." Then proceed normally. Do not re-offer later in the session.

If they choose A:

Say: "Running /${first} inline. Once the design doc is ready, I'll pick up
the review right where we left off."

${invokeBlock}

${ctx.skillName === 'plan-eng-review' ? `After /${first} completes, rerun the complete **Design Doc Check** block above.
This is a fresh execution: the prerequisite may have created a design doc.
Read the resulting doc if found; otherwise continue the standard review.
Do not rerun the preamble or re-offer the prerequisite.` : `After /${first} completes, re-run the design doc check:
\`\`\`bash
setopt +o nomatch 2>/dev/null || true  # zsh compat
SLUG=$(~/.claude/skills/gstack/browse/bin/remote-slug 2>/dev/null || basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null | tr '/' '-' || echo 'no-branch')
${DESIGN_DOC_DISCOVERY_BLOCK}
\`\`\`

If a design doc is now found, read it and continue the review.
If none was produced (user may have cancelled), proceed with standard review.`}`;
}
