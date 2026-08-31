import type { TemplateContext } from '../types';

/**
 * Evidence-before-claimed-limitations (fork port wave 2, D1).
 *
 * The single highest-leverage judgment clause from the fork's live App Store
 * releases: nine release failures in two days shared one root — the agent
 * asserting folklore as fact ("the API can't do this", "X requires a
 * password") instead of running the ten-second check that would have
 * disproven it. Adapted as ONE directive into the shared preamble (the
 * fork's full SHARED-JUDGMENT contract is deliberately not imported).
 */
export function generateEvidenceDirective(ctx?: TemplateContext): string {
  if (ctx?.explainLevel === 'terse') return '';
  return `## Claimed Limitations Need Evidence

A claimed limitation or requirement ("the API can't do this", "X requires a credential", "that's impossible on this platform") is a material claim. State one only with the verbatim error, the documented statement, or a live probe in hand — pattern-matching a failure to a familiar story is not evidence. When a cheap probe settles the question, run it BEFORE asking the user anything or declaring a step blocked.`;
}
