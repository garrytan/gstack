import type { TemplateContext } from './types';

/**
 * Preamble for research-stack skills.
 *
 * Provides: session tracking, learnings count, branch detection,
 * and context recovery. Stripped of gstack-specific features
 * (telemetry, upgrade checks, proactive routing, browse/design).
 */

function generatePreambleBash(ctx: TemplateContext): string {
  return `## Preamble (run first)

\`\`\`bash
_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "BRANCH: $_BRANCH"
# Learnings count
eval "$(${ctx.paths.binDir}/gstack-slug 2>/dev/null)" 2>/dev/null || true
_LEARN_FILE="\${GSTACK_HOME:-$HOME/.gstack}/projects/\${SLUG:-unknown}/learnings.jsonl"
if [ -f "$_LEARN_FILE" ]; then
  _LEARN_COUNT=$(wc -l < "$_LEARN_FILE" 2>/dev/null | tr -d ' ')
  echo "LEARNINGS: $_LEARN_COUNT entries loaded"
  if [ "$_LEARN_COUNT" -gt 5 ] 2>/dev/null; then
    ${ctx.paths.binDir}/gstack-learnings-search --limit 3 2>/dev/null || true
  fi
else
  echo "LEARNINGS: 0"
fi
# Session timeline
_SESSION_ID="$$-$(date +%s)"
_TEL_START=$(date +%s)
${ctx.paths.binDir}/gstack-timeline-log '{"skill":"${ctx.skillName}","event":"started","branch":"'"$_BRANCH"'","session":"'"$_SESSION_ID"'"}' 2>/dev/null &
\`\`\``;
}

function generateAskUserFormat(_ctx: TemplateContext): string {
  return `## AskUserQuestion — MUST use the tool

When the workflow says to ask the researcher a question, **you MUST call the AskUserQuestion tool**.
Do NOT just print the options as text in the chat. The tool renders clickable options in the UI.

**How to call it:** Use the AskUserQuestion tool with a \`question\` string and an \`options\` array.
Include a recommendation in the question text itself.

**Question format:**
1. Re-ground: state the project, branch, and current task (1-2 sentences)
2. Explain the decision in plain English
3. Add \`RECOMMENDATION: [option]\` with a one-line reason
4. The options array provides the choices — keep them short and actionable

Assume the user hasn't looked at this window in 20 minutes.`;
}

function generateCompletenessSection(): string {
  return `## Completeness Principle

AI makes completeness near-free. Always recommend the complete option over shortcuts.

**Effort reference:**

| Task type | Human team | CC+research-stack | Compression |
|-----------|-----------|-----------|-------------|
| Boilerplate | 2 days | 15 min | ~100x |
| Parameter sweep | 1 day | 15 min | ~50x |
| Analysis + plots | 4 hours | 15 min | ~20x |
| Hypothesis spec | 2 hours | 5 min | ~25x |`;
}

function generateRepoModeSection(): string {
  return `## Repo Ownership

If working in a collaborative repo, flag issues outside your branch via
AskUserQuestion rather than fixing directly (may be someone else's work).`;
}

export function generateTestFailureTriage(): string {
  return `## Test Failure Triage

When tests fail, classify each failure:

1. **In-branch:** the failing test or code it tests was modified on this branch → STOP and fix.
2. **Pre-existing:** neither test nor tested code was changed → flag and continue.

\`\`\`bash
git diff origin/<base>...HEAD --name-only
\`\`\`

For pre-existing failures, use AskUserQuestion to let the researcher decide:
- A) Investigate and fix now
- B) Add as TODO
- C) Skip`;
}

function generateSearchBeforeBuildingSection(ctx: TemplateContext): string {
  return `## Search Before Building

Before building anything unfamiliar, **search first.**
- Search for "{runtime} {thing} built-in"
- Search for "{thing} best practice {current year}"
- Check official docs

Three layers: **Layer 1** (tried and true), **Layer 2** (new and popular),
**Layer 3** (first principles). Prize Layer 3 above all.`;
}

function generateCompletionStatus(ctx: TemplateContext): string {
  return `## Completion Status

When completing a skill workflow, report status:
- **DONE** — All steps completed successfully.
- **DONE_WITH_CONCERNS** — Completed with issues to note.
- **BLOCKED** — Cannot proceed. State what is blocking.
- **NEEDS_CONTEXT** — Missing information required.

### Operational Learning

Before completing, reflect:
- Did any commands fail unexpectedly?
- Did you discover a project-specific quirk?
- Did something take longer than expected?

If yes, log an operational learning:

\`\`\`bash
${ctx.paths.binDir}/gstack-learnings-log '{"skill":"${ctx.skillName}","type":"operational","key":"SHORT_KEY","insight":"DESCRIPTION","confidence":N,"source":"observed"}'
\`\`\`

### Telemetry (run last)

\`\`\`bash
_TEL_END=$(date +%s)
_TEL_DUR=$(( _TEL_END - _TEL_START ))
${ctx.paths.binDir}/gstack-timeline-log '{"skill":"${ctx.skillName}","event":"completed","branch":"'$(git branch --show-current 2>/dev/null || echo unknown)'","outcome":"OUTCOME","duration_s":"'"$_TEL_DUR"'","session":"'"$_SESSION_ID"'"}' 2>/dev/null || true
\`\`\`

Replace \`OUTCOME\` with success/error/abort.`;
}

function generateContextRecovery(ctx: TemplateContext): string {
  return `## Context Recovery

After compaction or at session start, check for recent project artifacts:

\`\`\`bash
eval "$(${ctx.paths.binDir}/gstack-slug 2>/dev/null)"
_PROJ="\${GSTACK_HOME:-$HOME/.gstack}/projects/\${SLUG:-unknown}"
if [ -d "$_PROJ" ]; then
  echo "--- RECENT ARTIFACTS ---"
  [ -f "$_PROJ/timeline.jsonl" ] && tail -5 "$_PROJ/timeline.jsonl"
  echo "--- END ARTIFACTS ---"
fi
\`\`\`

If artifacts are listed, mention recent activity briefly.`;
}

function generateVoiceDirective(tier: number): string {
  return `## Voice

**Tone:** direct, concrete, precise. Sound like a researcher, not a consultant.
Name the file, the function, the exact parameter. No filler.

**Writing rules:**
- No em dashes. Use commas, periods, or "..." instead.
- No AI vocabulary: delve, crucial, robust, comprehensive, nuanced, etc.
- Short paragraphs. Be specific with numbers and file paths.
- End with what to do next.`;
}

// Preamble Composition
// T1: core + voice + completion
// T2: T1 + context-recovery + ask format + completeness + repo-mode + search
export function generatePreamble(ctx: TemplateContext): string {
  const tier = ctx.preambleTier ?? 2;
  const sections = [
    generatePreambleBash(ctx),
    generateVoiceDirective(tier),
    ...(tier >= 2 ? [
      generateContextRecovery(ctx),
      generateAskUserFormat(ctx),
      generateCompletenessSection(),
      generateRepoModeSection(),
      generateSearchBeforeBuildingSection(ctx),
    ] : []),
    generateCompletionStatus(ctx),
  ];
  return sections.join('\n\n');
}
