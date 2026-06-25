import type { TemplateContext } from './types';

/**
 * MARGIN_PHONE_REVIEW — the shared "review this plan on your phone" loop.
 *
 * Publishes the reviewed plan to Margin (a hosted reviewer), hands the user a
 * private link, reads their anchored comments back, folds them into the plan,
 * and re-publishes to the SAME document. Referenced by /autoplan and every
 * plan-*-review skill so the loop is defined in exactly one place.
 *
 * Emits the BODY only (no top-level heading) so each skill frames it under its
 * own section title. Bin paths come from ctx.paths.binDir so every host
 * (Claude, Codex, …) gets the correct path to bin/gstack-margin.
 */
export function generateMarginPhoneReview(ctx: TemplateContext): string {
  const bin = ctx.paths.binDir;
  return `When the user wants to review this plan on their phone ("review on my phone",
"send it to Margin", "let me comment on it"), publish the reviewed plan to
**Margin** — a hosted reviewer at the URL from \`${bin}/gstack-config get margin_url\`
(default \`https://margin.fieldspan.ai\`). The user opens a private link on their
phone, selects any text, and leaves comments anchored to exactly that text; you
read them back, fold them into the plan, and re-publish. No API key — the first
publish self-provisions a per-document token that \`gstack-margin\` caches locally
(per project + branch, mode 0600, never printed).

**1 · Render the reviewed plan to self-contained HTML.** Convert the plan file
(including the \`## GSTACK REVIEW REPORT\` section — the scores and findings are
what the reviewer reacts to) to one static HTML document. Margin's sandbox runs
with **scripts off**, so: inline CSS only, no external scripts/stylesheets/fonts,
images as \`data:\` or absolute \`https:\` only. Render headings, tables, lists, and
code blocks so the reviewer reads the formatted plan, not raw markdown. Lead with
a one-line "what I'd like you to weigh in on". Write it to a temp file:

\`\`\`bash
eval "$(${bin}/gstack-paths)"
HTML="$TMP_ROOT/plan-margin.html"   # write the rendered HTML here
\`\`\`

**2 · Publish and hand over the link.**

\`\`\`bash
${bin}/gstack-margin publish "$HTML" --title "Plan review: <feature>"
\`\`\`

It prints the reviewer URL. Give it to the user as a clickable link and tell
them: open it (phone or browser), select any text, leave a comment. Then stop and
wait — do not approve on their behalf.

**3 · Read the comments back** (when the user says they've commented, or "check"):

\`\`\`bash
${bin}/gstack-margin comments
\`\`\`

Each \`.threads[]\` entry carries \`.body\` (what they want), the \`.anchor.quote\` /
\`.anchor.block_text\` it is attached to (which part of the plan), and an \`.id\`.

**4 · Fold each comment into the plan.** Treat phone comments exactly like an
in-terminal revision: edit the plan file, and re-run any affected review step.
Honor the same revision bound your flow already uses.

**5 · Re-publish to the SAME document and resolve handled threads.** This keeps
the link stable and the comments anchored — never create a fresh doc per round
(\`gstack-margin\` reuses the cached doc automatically):

\`\`\`bash
${bin}/gstack-margin publish "$HTML" --summary "addressed phone comments"
${bin}/gstack-margin resolve <comment_id>   # one per handled thread
\`\`\`

**6 · Loop** until the user has no more comments, then continue your normal flow
(re-present the approval gate, or proceed to the exit-plan-mode gate). On final
approval, if a Margin doc exists, re-publish the approved plan one last time so
the phone copy matches what ships.`;
}
