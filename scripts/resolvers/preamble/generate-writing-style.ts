import type { TemplateContext } from '../types';

/**
 * Writing Style preamble section.
 *
 * v1.45.0.0 changes (T3):
 * - Jargon list is referenced by path, not inlined. The 80-term list was
 *   duplicated into every tier-2+ skill (~1.5-2 KB × 48 skills = ~80 KB
 *   across the corpus). The pointer asks the agent to Read the JSON on
 *   first jargon term encountered — one extra Read per session, but the
 *   per-corpus payload is ~30 bytes.
 * - When `ctx.explainLevel === 'terse'`, the entire section is replaced
 *   with a one-line pointer. Saves ~1.5 KB per tier-2+ skill in the
 *   opt-in terse build.
 */
export function generateWritingStyle(ctx: TemplateContext): string {
  if (ctx.explainLevel === 'terse') {
    return `## Writing Style\n\nTerse mode (build-time): skip jargon glossing, outcome-framing layer, and decision-impact closers. Lead with the answer.\n`;
  }

  const jargonPath = `${ctx.paths.skillRoot}/scripts/jargon-list.json`;

  return `## Writing Style (skip entirely if \`EXPLAIN_LEVEL: terse\` appears in the preamble echo OR the user's current message explicitly requests terse / no-explanations output)

Applies to AskUserQuestion, user replies, and findings. AskUserQuestion Format is structure; this is prose quality.

- Gloss curated jargon on first use per skill invocation, even if the user pasted the term.
- Frame questions in outcome terms: what pain is avoided, what capability unlocks, what user experience changes.
- Use short sentences, concrete nouns, active voice.
- Close decisions with user impact: what the user sees, waits for, loses, or gains.
- User-turn override wins: if the current message asks for terse / no explanations / just the answer, skip this section.
- Terse mode (EXPLAIN_LEVEL: terse): no glosses, no outcome-framing layer, shorter responses.

Curated jargon list lives at \`${jargonPath}\` (80+ terms). On the first jargon term you encounter this session, Read that file once; treat the \`terms\` array as the canonical list. The list is repo-owned and may grow between releases.
`;
}
