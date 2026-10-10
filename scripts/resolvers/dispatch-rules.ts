/**
 * {{IMPLEMENTER_DISPATCH_RULES}} — rules for an implementing child agent.
 *
 * docs/designs/HONEST_WORK_GATE_INTEGRITY.md W7. Rendered into /spec's issue
 * body template (the archived spec is the prompt `/spec --execute` pipes to
 * `claude -p`, so the rules travel inside it) and into /ship Step 7's
 * test-generation child prompt, before its LAST-line JSON protocol. One
 * constant so the two cannot drift. The child's JSON contracts are untouched:
 * gate-edit disclosure uses the prose the protocols already permit before the
 * JSON line. test/dispatch-rules.test.ts pins the rendering sites.
 */

export const IMPLEMENTER_DISPATCH_RULES_HEADING = 'Rules for the implementing agent';

export const IMPLEMENTER_DISPATCH_RULES_ITEMS = [
  'Acceptance criteria are the `protects / fails_when / no_claim` profile of each test: the observable it protects, the wrong result it rejects, and what green does not prove. Never "make the tests pass".',
  'Real code and real tests land in the same change; a placeholder, a stub assertion or a test deferred to a follow-up is not done.',
  'Any change to a test, validator, CI step, timeout, tolerance, threshold, snapshot or suppression pragma is reported on its own line in your summary with its justification, before any other result.',
  'A reported command names the command and its observed result (exit status, counts, the failing line); a command you did not run is not reported, and stderr is never silenced in a command you cite.',
  'Your report is a claim until the parent re-executes it: say what you verified, what you reused, and what you could not check.',
] as const;

/** The numbered list only; each rendering site supplies its own heading line (`## ` in the spec body, `label:` in a child prompt). */
export const IMPLEMENTER_DISPATCH_RULES = IMPLEMENTER_DISPATCH_RULES_ITEMS.map((rule, index) => `${index + 1}. ${rule}`).join('\n');

export function generateImplementerDispatchRules(): string {
  return IMPLEMENTER_DISPATCH_RULES;
}
