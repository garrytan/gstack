import type { TemplateContext } from '../types';

// First-run guidance (P4 scaffold + P3 loop tip), unified into one section.
// Branches on the persistent `.activated` lifecycle marker — NOT `_SESSIONS`,
// which counts concurrent sessions in the last 120 min, not first-vs-returning.
//
// The FIRST_TASK enum is computed at runtime in generate-preamble-bash.ts (gated
// so the detector only runs on the first run) and printed as `FIRST_TASK: <token>`.
// This section maps the token the model SAW in that output to a one-line nudge
// (no description string ever crosses an eval boundary) and sets markers:
//   ~/.gstack/.activated           — set at the end of the first-ever skill run
//   ~/.gstack/.first-loop-tip-shown — set when the returning-session tip is shown
//
// Note: bash blocks run in separate shells, so the runtime token cannot be read
// from a shell var here — the model substitutes the token it saw for TASK_TOKEN,
// exactly like the Telemetry section substitutes SKILL_NAME/OUTCOME.
export function generateFirstRunGuidance(ctx: TemplateContext): string {
  return `## First-run guidance (one-time)

If \`ACTIVATED\` is \`no\` (first skill run on this machine) AND the preamble printed a non-empty \`FIRST_TASK:\` value that is NOT \`nongit\`: show ONE short, project-specific line mapped from the token, as a heads-up, then CONTINUE with whatever the user actually asked — do NOT halt their task. Map the token: \`greenfield\` → "Fresh repo — shape it first with \`/spec\` or \`/office-hours\`." \`code_node\`/\`code_python\`/\`code_rust\`/\`code_go\`/\`code_ruby\`/\`code_ios\` → "There's code here — \`/qa\` to see it work, or \`/investigate\` if something's off." \`branch_ahead\` → "Unshipped work on this branch — \`/review\` then \`/ship\`." \`dirty_default\` → "Uncommitted changes — \`/review\` before committing." \`clean_default\` → "Pick one: \`/spec\`, \`/investigate\`, or \`/qa\`." Then substitute the token you saw for TASK_TOKEN and run (best-effort), and mark activated:
\`\`\`bash
${ctx.paths.binDir}/gstack-telemetry-log --event-type first_task_scaffold_shown --skill "TASK_TOKEN" --outcome shown 2>/dev/null || true
touch ~/.gstack/.activated 2>/dev/null || true
\`\`\`

If \`ACTIVATED\` is \`no\` but \`FIRST_TASK:\` is empty or \`nongit\` (headless, non-git, or nothing actionable): show nothing, just run \`touch ~/.gstack/.activated 2>/dev/null || true\`.

Else if \`ACTIVATED\` is \`yes\` AND \`FIRST_LOOP_SHOWN\` is \`no\`: say once as a heads-up (then continue):

> Tip: gstack pays off when you complete one loop — **plan → review → ship**. A common first loop: \`/office-hours\` or \`/spec\` to shape it, \`/plan-eng-review\` to lock it, then \`/ship\`.

Then run \`touch ~/.gstack/.first-loop-tip-shown 2>/dev/null || true\`.

Skip this section if \`ACTIVATED\` and \`FIRST_LOOP_SHOWN\` are both \`yes\`.`;
}
