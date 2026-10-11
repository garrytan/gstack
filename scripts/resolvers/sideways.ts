/**
 * Sideways review (multi-agent wave D2, shared with D3's flake recipe).
 *
 * A finding is a defect class, not a line: the same pattern usually sits at
 * another ingress, command or call site, and the severity is the worst
 * sibling's. These resolvers render that rule once:
 *
 *   {{SIDEWAYS_SWEEP}}          review Step 4: sweep + the forced-CRITICAL list
 *   {{SIDEWAYS_SWEEP:cso}}      /cso Phase 12: the sibling sweep only (D2: nothing else)
 *   {{FLAKE_FIX_NUMBER:review}} a test-only flake fix needs P(fail | regression) before and after
 *   {{FLAKE_FIX_NUMBER:investigate}}
 *                               the same number, as the flake recipe computes it
 *
 * `undeclaredBehaviorLines()` is the Scope Check addition the plan-completion
 * resolver (scripts/resolvers/plan-gates.ts, review mode) renders: diff
 * behavior the author's summary omits, and no approval without a recorded
 * full-diff read. The forced-CRITICAL classes are data so the review checklist
 * test and the rendered prose cannot drift (decision D8a: CRITICAL/INFORMATIONAL
 * stay the vocabulary; the list is what no lane may downgrade).
 */
import type { TemplateContext } from './types';

export const FORCED_CRITICAL = ['data loss', 'trust-boundary bypass', 'uncapped spend'] as const;

export function forcedCriticalPhrase(): string {
  return 'data loss, a trust-boundary bypass or uncapped spend';
}

export function generateSidewaysSweep(_ctx: TemplateContext, args?: string[]): string {
  if (args?.[0] === 'cso') {
    return 'After supporting a finding, grep its pattern at every other in-scope ingress, command and call site; severity follows the worst sibling.';
  }
  return `**Sideways sweep (every finding; reads code OUTSIDE the diff).** Grep the finding's pattern at every other ingress, command and call site, Read each match and rate severity on the worst sibling; a new enum value, status, tier or type constant is traced through every consumer the same way (checklist: Sideways sweep). ${forcedCriticalPhrase().replace(/^d/, 'D')} is forced CRITICAL: no lane, specialist, dedup or saved decision downgrades it. Keep findings anchored to changed code.`;
}

export function generateFlakeFixNumber(_ctx: TemplateContext, args?: string[]): string {
  if (args?.[0] === 'investigate') {
    return `**The flake-fix number.** A fix that touches only the test (a wider timeout, a retry,
a looser assertion, a skip) must state \`P(fail | regression)\`: the probability the test
still fails when the behavior it guards regresses, before and after the change. Derive
it from the forced probe (break the behavior on purpose, run the test N times, count
failures) and write both numbers in \`## Flake evidence\`. A number that drops is a gate
relaxation (review tag RH-15) and needs the owner's decision, not a merge.`;
  }
  return `A test-only flake fix (timeout, retry, looser assertion, skip) states \`P(fail | regression)\` before and after, from a forced probe; without both numbers it is RH-15.`;
}

/** The Scope Check lines the review-mode plan-completion audit adds (D2). */
export function undeclaredBehaviorLines(): { fields: string; rule: string } {
  return {
    fields: `Diff read: full (<n> files, <m> hunks) | partial (<unread paths>)
Undeclared behavior changes: <behavior the diff changes that the PR body, commit messages and plan do not state> | none`,
    rule: `\`Diff read\` records the full-diff read Step 3 required; \`Scope Check: CLEAN\`, and options B and C above, count as approved only with \`Diff read: full\` recorded. A partial read is \`DRIFT DETECTED\` naming the unread paths. \`Undeclared behavior changes\` lists every behavior the diff changes (a default, an exit code, a stored value, a route, a side effect) that the author's own summary omits; each is a Scope Check item for the reviewer, never silently CLEAN.`,
  };
}
