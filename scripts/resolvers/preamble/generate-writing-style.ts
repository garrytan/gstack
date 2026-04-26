import * as fs from 'fs';
import * as path from 'path';
import type { TemplateContext } from '../types';

function loadJargonList(): string[] {
  const jargonPath = path.join(__dirname, '..', '..', 'jargon-list.json');
  try {
    const raw = fs.readFileSync(jargonPath, 'utf-8');
    const data = JSON.parse(raw);
    if (Array.isArray(data?.terms)) return data.terms.filter((t: unknown): t is string => typeof t === 'string');
  } catch {
    // Missing or malformed: fall back to empty list. Writing Style block still fires,
    // but with no terms to gloss — graceful degradation.
  }
  return [];
}

export function generateWritingStyle(_ctx: TemplateContext): string {
  const terms = loadJargonList();
  const jargonBlock = terms.length > 0
    ? `Jargon list, gloss on first use if the term appears:\n${terms.map(t => `- ${t}`).join('\n')}`
    : `Jargon list unavailable. Skip jargon glossing until \`scripts/jargon-list.json\` is restored.`;

  return `## Writing Style (skip entirely if \`EXPLAIN_LEVEL: terse\` appears in the preamble echo OR the user's current message explicitly requests terse / no-explanations output)

Applies to AskUserQuestion, user replies, and findings. AskUserQuestion Format is structure; this is prose quality.

- Gloss curated jargon on first use per skill invocation, even if the user pasted the term.
- Frame questions in outcome terms: what pain is avoided, what capability unlocks, what user experience changes.
- Use short sentences, concrete nouns, active voice.
- Close decisions with user impact: what the user sees, waits for, loses, or gains.
- User-turn override wins: if the current message asks for terse / no explanations / just the answer, skip this section.
- Terse mode (EXPLAIN_LEVEL: terse): no glosses, no outcome-framing layer, shorter responses.

${jargonBlock}
`;
}
