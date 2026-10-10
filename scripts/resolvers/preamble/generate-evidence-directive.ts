import type { TemplateContext } from '../types';

/**
 * Claims Need Evidence: the preamble's honesty kernel (fork port wave 2, D1;
 * extended by docs/designs/HONEST_WORK_GATE_INTEGRITY.md W4).
 *
 * Started as one directive: a claimed limitation ("the API can't do this")
 * needs the verbatim error, documented statement or live probe, because nine
 * App Store release failures in two days shared that one root. W4 widened it
 * to a five-bullet kernel covering claimed executions, evidence kinds, failure
 * disclosure and null results. It is a correctness rule, not prose style, so
 * it renders for every tier that composes it (2–4) and for `terse` builds;
 * tier 1 skills have no evidence claim to make. The bullets stay at or under
 * KERNEL_MAX_BYTES; test/honesty-kernel.test.ts pins that budget.
 */
export const KERNEL_MAX_BYTES = 800;

export const EVIDENCE_KERNEL_HEADING = '## Claims Need Evidence';

export const EVIDENCE_KERNEL_BULLETS = [
  'A claimed limitation ("the API can\'t", "X needs a credential") needs the verbatim error, documented statement or live probe; probe before asking or blocking.',
  'A claimed execution ran and you saw its result: name the command and the revision or content fingerprint; never cite a command whose stderr was silenced.',
  'State the evidence kind (static read, unit test, fixture/replay, live run, production) and never pass one off as another: a mock is not a live check. Reuse rules: Step 16.',
  'Disclose any failure or missing coverage that would change the reader\'s conclusion; "done, unverified" is not "done".',
  'A checked null result ("ran X, found nothing material") is a success; an unsupported positive claim is worse than silence. Agreeing agents, or repeated reads of one source, are one datum.',
] as const;

export function generateEvidenceDirective(_ctx?: TemplateContext): string {
  return `${EVIDENCE_KERNEL_HEADING}

${EVIDENCE_KERNEL_BULLETS.map(bullet => `- ${bullet}`).join('\n')}`;
}
