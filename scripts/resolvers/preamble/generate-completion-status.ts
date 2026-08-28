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

In plan mode, allowed because they inform the plan: \`$B\`, \`$D\`, \`codex exec\`/\`codex review\`, writes to \`~/.gstack/\`, writes to the plan file, and \`open\` for generated artifacts.

## Skill Invocation During Plan Mode

If the user invokes a skill in plan mode, the skill takes precedence over generic plan mode behavior. **Treat the skill file as executable instructions, not reference.** Follow it step by step starting from Step 0; any AskUserQuestion the skill fires is the workflow operating within plan mode, not a violation of it — and a skill whose instructions resolve a question themselves (e.g. a plan-mode auto-select) may legitimately not ask it. AskUserQuestion (any variant — \`mcp__*__AskUserQuestion\` or native; see "AskUserQuestion Format → Tool resolution") satisfies plan mode's end-of-turn requirement. If AskUserQuestion is unavailable or a call fails, follow the AskUserQuestion Format failure fallback: \`headless\` → BLOCKED; \`interactive\` → the prose fallback (also satisfies end-of-turn). At a STOP point, stop immediately. Do not continue the workflow or call ExitPlanMode there. Commands marked "PLAN MODE EXCEPTION — ALWAYS RUN" execute. Call ExitPlanMode only after the skill workflow completes, or if the user tells you to cancel the skill or leave plan mode.`;
}

export function generateCompletionStatus(ctx: TemplateContext): string {
  return `## Completion Status Protocol

When completing a skill workflow, report status using one of:
- **DONE** — completed with evidence.
- **DONE_WITH_CONCERNS** — completed, but list concerns.
- **BLOCKED** — cannot proceed; state blocker and what was tried.
- **NEEDS_CONTEXT** — missing info; state exactly what is needed.

Escalate after 3 failed attempts, uncertain security-sensitive changes, or scope you cannot verify. Format: \`STATUS\`, \`REASON\`, \`ATTEMPTED\`, \`RECOMMENDATION\`.

## Operational Self-Improvement

Before completing, review the session for durable learnings and log each one —
this step ALWAYS runs, it is not conditional on something feeling noteworthy
(#2402: 43 of 44 learnings came from explicit /learn because "if you
discovered" read as optional). A durable learning is a project quirk, command
fix, pitfall, or pattern that would save 5+ minutes in a future session. If
the review genuinely surfaces none, state "No durable learnings this session"
in your completion summary — an explicit empty result, not a skipped step.

\`\`\`bash
${ctx.paths.binDir}/gstack-learnings-log '{"skill":"SKILL_NAME","type":"operational","key":"SHORT_KEY","insight":"DESCRIPTION","confidence":N,"source":"observed"}'
\`\`\`

Do not log obvious facts or one-time transient errors.

## Telemetry (run last)

After workflow completion, log telemetry with ONE command. OUTCOME is
success/error/abort/unknown; \`SESSION_ID\` and \`TEL_START\` are the values the
preamble's skill-start output echoed. It also drains the artifacts-sync queue
(the former skill-end sync step — do not run gstack-brain-sync separately).

**PLAN MODE EXCEPTION — ALWAYS RUN:** This writes telemetry to
\`~/.gstack/analytics/\`, matching preamble analytics writes.

\`\`\`bash
${ctx.paths.binDir}/gstack-skill-end --skill "${ctx.skillName}" --outcome OUTCOME \\
  --session-id "SESSION_ID" --tel-start "TEL_START" --used-browse USED_BROWSE \\
  --error-message "ERROR_MESSAGE" --failed-step "FAILED_STEP" 2>/dev/null || true
\`\`\`

Replace \`OUTCOME\` and \`USED_BROWSE\` (yes/no) before running; substitute
\`SESSION_ID\`/\`TEL_START\` from the skill-start echoes. \`ERROR_MESSAGE\`/\`FAILED_STEP\`
are "" unless outcome is error. If the command is missing (stale install), skip
telemetry — it never blocks the workflow.

## Plan Status Footer

Skills that run plan reviews (\`/plan-*-review\`, \`/codex review\`) include the EXIT PLAN MODE GATE blocking checklist at the end of the skill, which verifies the plan file ends with \`## GSTACK REVIEW REPORT\` before ExitPlanMode is called. Skills that don't run plan reviews (operational skills like \`/ship\`, \`/qa\`, \`/review\`) typically don't operate in plan mode and have no review report to verify; this footer is a no-op for them. Writing the plan file is the one edit allowed in plan mode.`;
}
