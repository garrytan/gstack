import type { TemplateContext } from '../types';

/**
 * Plan-mode-skill semantics block.
 *
 * Lives at the TOP of the preamble (position 1) so models read the authoritative
 * plan-mode rule before any other instructions. Replaces the vestigial
 * generate-plan-mode-handshake.ts that used to sit at this position and told
 * interactive review skills to emit an exit-and-rerun handshake instead of
 * running their interactive STOP-Ask workflow.
 *
 * Text is the same "Plan Mode Safe Operations" + "Skill Invocation During Plan
 * Mode" blocks that previously lived at the tail of generateCompletionStatus().
 * Only the position changes. All skills (not just interactive: true) see this.
 *
 * Composition position: index 1 in scripts/resolvers/preamble.ts — after
 * generatePreambleBash (so _SESSION_ID / _BRANCH / _TEL env vars exist before
 * any plan-mode-aware telemetry) and before generateUpgradeCheck + onboarding
 * gates. See ceo-plan 2026-04-24 "remove vestigial plan-mode handshake" for
 * the full rationale.
 */
export function generatePlanModeInfo(_ctx: TemplateContext): string {
  return `## Plan Mode Safe Operations

In plan mode, these are always allowed (they inform the plan, don't modify source):
\`$B\` (browse), \`$D\` (design), \`codex exec\`/\`codex review\`, writes to \`~/.gstack/\`,
writes to the plan file, \`open\` for generated artifacts.

## Skill Invocation During Plan Mode

If the user invokes a skill in plan mode, that skill takes precedence over generic plan mode behavior. Treat it as executable instructions, not reference. Follow step
by step. AskUserQuestion calls satisfy plan mode's end-of-turn requirement. At a STOP
point, stop immediately. Do not continue the workflow past a STOP point and do not call ExitPlanMode there. Commands marked "PLAN
MODE EXCEPTION — ALWAYS RUN" execute. Other writes need to be already permitted
above or explicitly exception-marked. Call ExitPlanMode only after the skill
workflow completes — only then call ExitPlanMode (or if the user tells you to cancel the skill or leave plan mode).`;
}

export function generateCompletionStatus(ctx: TemplateContext): string {
  return `## Completion Status Protocol

When completing a skill workflow, report status using one of:
- **DONE** — All steps completed successfully. Evidence provided for each claim.
- **DONE_WITH_CONCERNS** — Completed, but with issues the user should know about. List each concern.
- **BLOCKED** — Cannot proceed. State what is blocking and what was tried.
- **NEEDS_CONTEXT** — Missing information required to continue. State exactly what you need.

### Escalation

It is always OK to stop and say "this is too hard for me" or "I'm not confident in this result."

Bad work is worse than no work. You will not be penalized for escalating.
- If you have attempted a task 3 times without success, STOP and escalate.
- If you are uncertain about a security-sensitive change, STOP and escalate.
- If the scope of work exceeds what you can verify, STOP and escalate.

Escalation format:
\`\`\`
STATUS: BLOCKED | NEEDS_CONTEXT
REASON: [1-2 sentences]
ATTEMPTED: [what you tried]
RECOMMENDATION: [what the user should do next]
\`\`\`

## Operational Self-Improvement

Before completing, reflect on this session:
- Did any commands fail unexpectedly?
- Did you take a wrong approach and have to backtrack?
- Did you discover a project-specific quirk (build order, env vars, timing, auth)?
- Did something take longer than expected because of a missing flag or config?

If yes, log an operational learning for future sessions:

\`\`\`bash
${ctx.paths.binDir}/gstack-learnings-log '{"skill":"SKILL_NAME","type":"operational","key":"SHORT_KEY","insight":"DESCRIPTION","confidence":N,"source":"observed"}'
\`\`\`

Replace SKILL_NAME with the current skill name. Only log genuine operational discoveries.
Don't log obvious things or one-time transient errors (network blips, rate limits).
A good test: would knowing this save 5+ minutes in a future session? If yes, log it.

## Telemetry (run last)

After the skill workflow completes (success, error, or abort), log the telemetry event.
Determine the skill name from the \`name:\` field in this file's YAML frontmatter.
Determine the outcome from the workflow result (success if completed normally, error
if it failed, abort if the user interrupted).

**PLAN MODE EXCEPTION — ALWAYS RUN:** This command writes telemetry to
\`~/.gstack/analytics/\` (user config directory, not project files). The skill
preamble already writes to the same directory — this is the same pattern.
Skipping this command loses session duration and outcome data.

Run this bash:

\`\`\`bash
_TEL_END=$(date +%s)
_TEL_DUR=$(( _TEL_END - _TEL_START ))
rm -f ~/.gstack/analytics/.pending-"$_SESSION_ID" 2>/dev/null || true
# Session timeline: record skill completion (local-only, never sent anywhere)
~/.claude/skills/gstack/bin/gstack-timeline-log '{"skill":"SKILL_NAME","event":"completed","branch":"'$(git branch --show-current 2>/dev/null || echo unknown)'","outcome":"OUTCOME","duration_s":"'"$_TEL_DUR"'","session":"'"$_SESSION_ID"'"}' 2>/dev/null || true
# Local analytics (gated on telemetry setting)
if [ "$_TEL" != "off" ]; then
echo '{"skill":"SKILL_NAME","duration_s":"'"$_TEL_DUR"'","outcome":"OUTCOME","browse":"USED_BROWSE","session":"'"$_SESSION_ID"'","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
fi
# Remote telemetry (opt-in, requires binary)
if [ "$_TEL" != "off" ] && [ -x ~/.claude/skills/gstack/bin/gstack-telemetry-log ]; then
  ~/.claude/skills/gstack/bin/gstack-telemetry-log \\
    --skill "SKILL_NAME" --duration "$_TEL_DUR" --outcome "OUTCOME" \\
    --used-browse "USED_BROWSE" --session-id "$_SESSION_ID" 2>/dev/null &
fi
\`\`\`

Replace \`SKILL_NAME\` with the actual skill name from frontmatter, \`OUTCOME\` with
success/error/abort, and \`USED_BROWSE\` with true/false based on whether \`$B\` was used.
If you cannot determine the outcome, use "unknown". The local JSONL always logs. The
remote binary only runs if telemetry is not off and the binary exists.

## Plan Status Footer

In plan mode, before ExitPlanMode: if the plan file lacks a \`## GSTACK REVIEW REPORT\`
section, run \`~/.claude/skills/gstack/bin/gstack-review-read\` and append a report.
With JSONL entries (before \`---CONFIG---\`), format the standard runs/status/findings
table. With \`NO_REVIEWS\` or empty, append a 5-row placeholder table (CEO/Codex/Eng/
Design/DX Review) with all zeros and verdict "NO REVIEWS YET — run \`/autoplan\`".
If a richer review report already exists, skip — review skills wrote it.

PLAN MODE EXCEPTION — always allowed (it's the plan file).`;
}

