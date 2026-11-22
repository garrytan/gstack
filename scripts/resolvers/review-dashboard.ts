/**
 * Review dashboard and plan-file review report resolvers.
 *
 * Moved from scripts/resolvers/review.ts.
 */
import { type TemplateContext } from './types';

export function generateReviewDashboard(ctx: TemplateContext): string {
  const result = `## Review Readiness Dashboard

${ctx.skillName === 'ship' ? 'In pre-flight, read the review log and config to show readiness; Step 9 runs the new pre-landing review.' : 'After completing the review, read the review log and config to display the dashboard.'}

\`\`\`bash
~/.claude/skills/gstack/bin/gstack-review-read
\`\`\`

**1. Choose the records to display.** Use the latest record for each row below.
Do not use a record older than 7 days to clear a row, and never substitute an older
success for a newer failure. Ship metrics are not review records.

| Row | Choose the latest of | Status suffix |
|---|---|---|
| Eng Review | \`review\` or \`plan-eng-review\` | (DIFF) or (PLAN) |
| CEO Review | \`plan-ceo-review\` | — |
| Design Review | \`plan-design-review\` or \`design-review-lite\` | (FULL) or (LITE) |
| Adversarial | \`adversarial-review\` or legacy \`codex-review\` | — |
| Outside Voice | \`codex-plan-review\` from CEO or Eng review | — |

Keep each record's host, source, outside_provider, outside_status and phase.
Historical source "claude" is a native subagent; "claude-code" is the external CLI.
Do not infer old providers or unknown models from today's harness. A native result
does not fill missing, disabled or skipped outside coverage.

**Source attribution:** Append a recorded \`via\` to the suffix ("CLEAR (PLAN via
/autoplan)"); without one, keep "CLEAR (PLAN)" or "CLEAR (DIFF)". Below the dashboard, group \`autoplan-voices\`
and \`design-outside-voices\` by workflow run and phase. Show each phase's provider
and outside_status; retain partial coverage. These details do not clear Eng Review.

**2. Check freshness before choosing a verdict.**

- **Content-first rule:** For \`review\`, \`adversarial-review\`, \`codex-review\`,
  ship-stage reviews and \`design-review-lite\`, use \`review_freshness.status\`
  and show its \`reason\`. CURRENT means a completed clean review whose start and
  end content fingerprints equal the current \`---WTREE---\` fingerprint.
  STALE or UNVERIFIED cannot clear Eng Review. Missing \`review_freshness\`,
  including legacy log-only records, means UNVERIFIED. Never fall back to HEAD
  equality or commit distance for diff evidence, even at zero commits.
  Show recorded cycles, completed/converged fields and missing source/phase
  coverage. Unknown coverage is not a pass.
- **Plan records** (plan-ceo-review, plan-eng-review, plan-design-review and
  codex-plan-review) use the 7-day window, not the working-tree fingerprint.
  If \`plan_sha256\` is present, you may compare the plan file and report a mismatch.
  Compare the recorded commit with \`---HEAD---\`; if different, run
  \`git rev-list --count STORED_COMMIT..HEAD\` and report
  "Note: {skill} review from {date} may be stale — {N} commits since review".
  A failed command means UNKNOWN, treated as stale; without commit tracking,
  suggest a re-run. Omit notes when all reviews are current.

**3. Choose the historical verdict.** CLEARED requires the selected Eng Review
to be \`clean\`, within 7 days and fresh under step 2. Otherwise report NOT CLEARED
and its missing, stale or open-issue reason.${ctx.skillName === 'ship' ? ` With no Eng Review record, say "no saved Eng Review: run the \`PERSIST:\` line a read-only /plan-eng-review printed, or rerun it" (docs/troubleshooting.md#plan-eng-review-not-persisted).` : ''} If \`skip_eng_review\` is true, show
"SKIPPED (global)" for Eng Review and CLEARED for this dashboard.
${ctx.skillName === 'ship' ? 'This verdict never skips Step 9 or its finding, approval and convergence gates. Continue Step 1 even when history is NOT CLEARED.' : 'Eng Review is required by default; `gstack-config set skip_eng_review true` disables that requirement.'}

Other rows provide context, not a substitute for Eng Review:
- Recommend CEO Review for product/business or scope decisions, not routine fixes or cleanup.
- Recommend Design Review for UI/UX work, not backend, infrastructure or prompt-only work.
${ctx.skillName === 'ship' ? '- Step 9\'s review plan decides the adversarial passes (Step 11).\n' : '- Adversarial review always includes a native pass. Available, enabled outside\n  challenges supplement it; diffs of 200+ lines also get the structured P1 gate.\n'}- Outside Voice is the default-on plan review after CEO/Eng review. \`codex_reviews\`
  disables that extra step. Provider failure uses native fallback and records
  missing outside coverage; this dashboard row never gates shipping.

**4. Display the dashboard.** Show missing, stale, disabled or unavailable results
explicitly, never as CLEAR. Display a fresh \`clean\` result as CLEAR and
\`issues_open\` as ISSUES OPEN without changing the stored status.

${ctx.skillName === 'ship' ? `**REVIEW READINESS DASHBOARD**

Use one row for each entry in step 1. Only Eng Review is marked required.

| Review | Runs | Last run | Status | Required |
|---|---:|---|---|---|
| {row and suffix} | {count} | {timestamp or —} | {actual status and reason} | {yes/no} |

VERDICT: {CLEARED or NOT CLEARED} — {reason}` : `\`\`\`
+====================================================================+
|                    REVIEW READINESS DASHBOARD                       |
+====================================================================+
| Review          | Runs | Last Run            | Status    | Required |
|-----------------|------|---------------------|-----------|----------|
| Eng Review      |  1   | 2026-03-16 15:00    | CLEAR     | YES      |
| CEO Review      |  0   | —                   | —         | no       |
| Design Review   |  0   | —                   | —         | no       |
| Adversarial     |  0   | —                   | —         | no       |
| Outside Voice   |  0   | —                   | —         | no       |
+--------------------------------------------------------------------+
| VERDICT: CLEARED — Eng Review passed                                |
+====================================================================+
\`\`\``}`;
  return ctx.skillName === 'plan-eng-review' ? result.replaceAll('\\`', '`') : result;
}

export function generatePlanFileReviewReport(ctx: TemplateContext): string {
  const beforeLog = ['plan-ceo-review', 'plan-eng-review', 'plan-design-review', 'plan-devex-review'].includes(ctx.skillName);
  const ceo = ctx.skillName === 'plan-ceo-review';
  const eng = ctx.skillName === 'plan-eng-review';
  const reviewFile = eng ? 'report file' : 'plan file';
  const conditionalWrites = ceo || ctx.skillName === 'plan-eng-review';
  const storagePolicy = ceo ? 'Step 0 storage policy' : 'Review record and write policy';
  const result = `## Plan File Review Report

${beforeLog ? (conditionalWrites ? (eng ? 'After Required outputs are prepared, save the working plan and complete review body with the terminal report below. Apply **Review record and write policy**.' : `Produce the complete accepted plan and review output, including this report, under the ${storagePolicy} before announcing completion.`) : 'Save the accepted plan changes and full review output, including the report below, before logging or announcing completion.') : `After displaying the Review Readiness Dashboard in conversation output, also update the
**plan file** itself so review status is visible to anyone reading the plan.`}

### ${ctx.skillName === 'plan-eng-review' ? 'Use the selected report file' : 'Detect the plan file'}

${ctx.skillName === 'plan-eng-review' ? 'Use the report file already selected under **Review record and write policy**. Do not choose another destination here.' : beforeLog ? `Use an explicitly requested output/report file first. Otherwise use the reviewed plan named by the user, then the host active plan. ${conditionalWrites ? `Apply the ${storagePolicy}. Without a permitted file, produce the complete reviewed plan and report in chat, labeled not persisted; do not skip report generation.` : 'If no file is in scope, skip this section; ordinary no-file review logging still applies.'}` : `1. Check if there is an active plan file in this conversation (the host provides plan file
   paths in system messages — look for plan file references in the conversation context).
2. If not found, skip this section silently — not every review runs in plan mode.`}

### Generate the report

${beforeLog ? `Run \`~/.claude/skills/gstack/bin/gstack-review-read\` for prior review entries.
Use the current ${conditionalWrites ? 'Completion Summary' : 'Completion Summary or DX Scorecard'} for this review's status and findings;
apply the Review Log field rules below and add exactly one to its prior run count.
Do not pre-log this run to populate the report.
Use prior entries for other reviews, retaining their status, attribution and freshness.` : `Read the review log output you already have from the Review Readiness Dashboard step above.`}

Parse each JSONL entry using recorded provenance. Historical source "claude" is a native Claude subagent; "claude-code" is the external CLI. Keep historical codex identifiers and never relabel old records from the current harness. Unknown model identity remains unknown. For new records, show host, outside_provider, outside_status, and phase. Only completed external records establish outside coverage; native fallbacks do not.

Each skill logs different fields:

- **plan-ceo-review**: \\\`status\\\`, \\\`unresolved\\\`, \\\`critical_gaps\\\`, \\\`mode\\\`, \\\`scope_proposed\\\`, \\\`scope_accepted\\\`, \\\`scope_deferred\\\`, \\\`commit\\\`
  → Findings: "{scope_proposed} proposals, {scope_accepted} accepted, {scope_deferred} deferred"
  → If scope fields are 0 or missing (HOLD/REDUCTION mode): "mode: {mode}, {critical_gaps} critical gaps"
- **plan-eng-review**: \\\`status\\\`, \\\`unresolved\\\`, \\\`critical_gaps\\\`, \\\`issues_found\\\`, \\\`mode\\\`, \\\`commit\\\`
  → Findings: "{issues_found} issues, {critical_gaps} critical gaps"
- **plan-design-review**: \\\`status\\\`, \\\`initial_score\\\`, \\\`overall_score\\\`, \\\`unresolved\\\`, \\\`decisions_made\\\`, \\\`commit\\\`
  → Findings: "score: {initial_score}/10 → {overall_score}/10, {decisions_made} decisions"
- **plan-devex-review**: \\\`status\\\`, \\\`initial_score\\\`, \\\`overall_score\\\`, \\\`product_type\\\`, \\\`tthw_current\\\`, \\\`tthw_target\\\`, \\\`mode\\\`, \\\`persona\\\`, \\\`competitive_tier\\\`, \\\`unresolved\\\`, \\\`commit\\\`
  → Findings: "score: {initial_score}/10 → {overall_score}/10, TTHW: {tthw_current} → {tthw_target}"
- **devex-review**: \\\`status\\\`, \\\`overall_score\\\`, \\\`product_type\\\`, \\\`tthw_measured\\\`, \\\`dimensions_tested\\\`, \\\`dimensions_inferred\\\`, \\\`boomerang\\\`, \\\`commit\\\`
  → Findings: "score: {overall_score}/10, TTHW: {tthw_measured}, {dimensions_tested} tested/{dimensions_inferred} inferred"
- **codex-review**: \\\`status\\\`, \\\`gate\\\`, \\\`findings\\\`, \\\`findings_fixed\\\`
  → Findings: "{findings} findings, {findings_fixed}/{findings} fixed"

${ceo ? `For **Outside Review**, use this run's completed reviewer output and finding
dispositions: "N findings; R resolved; U unresolved". With no findings, write
"0 findings — completed review". Label native fallback findings as native and
keep external coverage unavailable. For disabled or unavailable attempts, write
the actual reason and "no completed external review"; never imply zero findings.
If prior history lacks counts, say "finding count not recorded". Preserve each
attempt's provider and outcome in OUTSIDE COVERAGE.

` : ''}${beforeLog ? (conditionalWrites ? 'The current row describes this actual review. Mark an unlogged current run as not persisted; do not present it as a saved dashboard entry.' : 'The current row and its later log must describe the same saved review.') : `All fields needed for the Findings column are now present in the JSONL entries.
For the review you just completed, you may use richer details from your own Completion
Summary. For prior reviews, use the JSONL fields directly — they contain all required data.`}

${conditionalWrites ? 'Display `clean` as CLEAR and `issues_open` as ISSUES OPEN, retaining freshness and not-persisted labels. Other statuses keep their recorded meaning.\n\n' : ''}Produce this markdown table:

\\\`\\\`\\\`markdown
## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | \\\`/plan-ceo-review\\\` | Scope & strategy | {runs} | {status} | {findings} |
| Outside Review | {recorded provider and trigger} | Independent 2nd opinion | {runs} | {outside_status} | {findings} |
| Eng Review | \\\`/plan-eng-review\\\` | Architecture & tests (required) | {runs} | {status} | {findings} |
| Design Review | \\\`/plan-design-review\\\` | UI/UX gaps | {runs} | {status} | {findings} |
| DX Review | \\\`/plan-devex-review\\\` | Developer experience gaps | {runs} | {status} | {findings} |
\\\`\\\`\\\`

Below the table, add these lines. **OUTSIDE COVERAGE** and **CROSS-MODEL** are conditional:
include them when the phase ran, was disabled/skipped/unavailable, or has findings;
omit them only when no such phase applies. **VERDICT** is always present:

- **OUTSIDE COVERAGE:** provider, phase, completion state, and findings. Include unavailable, disabled, and skipped phases; never infer completion from another phase.
- **CROSS-MODEL:** only when native and completed external reviews exist — overlap analysis with recorded providers and known model identity. Do not infer distinct model families from harness names.
- **VERDICT:** list reviews that are CLEAR (e.g., "CEO + ENG CLEARED — ready to implement").
  If Eng Review is not CLEAR and not skipped globally, append "eng review required".

${ceo ? `**Unresolved-decisions status (MANDATORY):** This is the report's final content,
after VERDICT. Count this review's open items from its ledger. For prior reviews,
sum \`unresolved\` over the latest fresh row per skill (the dashboard's seven-day
window), excluding the current skill so it is not counted twice.

- If both counts are zero, end with the exact unbolded line \`NO UNRESOLVED DECISIONS\`.
- Otherwise use the bold label \`**UNRESOLVED DECISIONS:**\` (not a new heading),
  then one bullet per current open item. When the prior count N is positive, add
  a final bullet \`- + N unresolved from prior reviews\`, even if there are no
  current items. The last bullet is the final non-whitespace line; append no
  separate count line or trailing prose. Never omit this status.
` : `**Unresolved-decisions status (MANDATORY — never omitted; the report's final non-whitespace
line).** After VERDICT, end the report (content under the \\\`## GSTACK REVIEW REPORT\\\`
heading — a bold label, never a new \\\`## \\\` heading; exempt from the "omit when empty"
rule) with exactly one: the exact unbolded line \\\`NO UNRESOLVED DECISIONS\\\` (a bolded one
does NOT count), OR a \\\`**UNRESOLVED DECISIONS:**\\\` header + one bullet per open item
(last bullet = final line; add \\\`+ N unresolved from prior reviews\\\` only when N > 0).
This avoids double-counting: list THIS review's open items from context; for prior reviews
sum \\\`unresolved\\\` over the latest fresh row per skill (dashboard 7-day window) after you
DROP the current skill's row; emit the sentinel only when both are zero.`}

### Write to the ${reviewFile}

${beforeLog ? (conditionalWrites ? `${ceo ? 'If no destination is selected' : 'If the report destination is absent'} or writing is forbidden, assemble the same complete ${eng ? 'working plan' : 'plan'}, review output and terminal report in chat, labeled not persisted. Do not run the file-writing steps below or claim their Read-back gate passed.${ctx.skillName === 'plan-eng-review' ? ' Then use **Report-back outcome**.' : " Follow Stage 3's blocked chat return; no completed-review log or handoff."} Otherwise save only accepted changes, keeping unresolved choices pending:` : '**PLAN MODE EXCEPTION — ALWAYS RUN:** Save the complete reviewed plan/report with only accepted changes applied; keep unresolved choices pending.') : `**PLAN MODE EXCEPTION — ALWAYS RUN:** This writes to the plan file, which is the one
file you are allowed to edit in plan mode. The plan file review report is part of the
plan's living status.`}

The report must always be the LAST section of the ${reviewFile} — never mid-file.
Use a single delete-then-append flow:

${beforeLog ? `1. Read the existing ${eng ? 'report file' : 'plan/report'}, if present. Preserve its content and apply only
   accepted changes; include the full review output. Locate any existing
   \`## GSTACK REVIEW REPORT\` section.` : `1. Read the plan file (Read tool) to see its full current content. Search the read
   output for a \\\`## GSTACK REVIEW REPORT\\\` heading anywhere in the file.`}
2. If found, use the Edit tool to DELETE the entire existing section. Match from
   \\\`## GSTACK REVIEW REPORT\\\` through either the next \\\`## \\\` heading or end of
   file, whichever comes first. Replace with the empty string. This applies
   regardless of where the section currently lives — mid-file deletion is
   intentional, not a special case. ${ceo ? 'If the Edit fails, report the error and stop before Review Log or decision logging.' : `If the Edit fails (e.g., concurrent edit\n   changed the content), re-read the ${reviewFile} and retry once.`}
${ceo ? `3. Save the complete updated plan and review body with the new
   \`## GSTACK REVIEW REPORT\` at EOF:
   - If the destination file exists, Read it now, whether or not step 2 deleted
     a report. Use Edit with the suffix from this Read, or Write the complete file.
   - If the destination file does not exist, use Write to create the complete file.
   In both cases, keep the report last and continue to the Read-back gate.` : `3. If a report was deleted, Read the updated file. Append the new
   \\\`## GSTACK REVIEW REPORT\\\` at EOF. Use Edit to match the suffix
   confirmed by the latest Read, or Write the full file with the report last.${beforeLog ? ' Append whether or not a prior report existed.' : ''}
   "Unresolved Decisions" is not an EOF anchor when other sections follow it.`}
${beforeLog ? `4. **Read-back gate:** Read the saved file. Verify the accepted changes, full review
   output, current review row, verdict and final unresolved-decisions status, with
   \`## GSTACK REVIEW REPORT\` as the last section. If writing or verification fails,
   ${ctx.skillName === 'plan-eng-review' ? 'report the error and follow **Blocked outcome** before Review Log or decision logging.' : 'report the error and stop before Review Log or decision logging.'}` : `4. Verify with the Read tool that \\\`## GSTACK REVIEW REPORT\\\` is the last
   \\\`## \\\` heading in the file before continuing. If it isn't, repeat steps
   2-3 once.`}

${ceo || ctx.skillName === 'plan-eng-review' ? 'Do NOT replace the section in place; delete it and append the new report at EOF.' : `Do NOT replace the section in place; delete it and append the new report at EOF,
so the review report is always the plan's last section.`}`;
  return conditionalWrites ? result.replaceAll('\\`', '`') : result;
}
