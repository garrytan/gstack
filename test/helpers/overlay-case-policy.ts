/** Version 4 keeps v3's gate but scores a completed wrong answer in either arm
 * as a correctness result; only execution, scope and metric failures invalidate
 * a trial. An OFF wrong answer no longer fails the comparison.
 * Version 3 gates supported behavior, plus the comparison for fixtures that
 * declare a gate (dedicated tools: correct output and 20% fewer Bash calls,
 * replacing v2's zero Bash in every ON trial). Other comparisons stay research-only.
 * Version 1 required efficacy lift. Never reinterpret recorded failures of earlier versions.
 */
export const OVERLAY_CONTRACT = {
  name: 'overlay-behavior',
  version: 4,
  releaseGate: 'execution_scope_complete_sampling_on_correctness_and_fixture_gate',
  comparisonRole: 'research_only_unless_fixture_gate',
  resourceNonRegression: 'not_established',
} as const;

/** A complete fixture owns a process; model-work budgets are unchanged. */
export const OVERLAY_CASE_WORK_MS = 1_800_000;
export const OVERLAY_RECORD_GRACE_MS = 5_000;
export const OVERLAY_CASE_OUTER_MS = OVERLAY_CASE_WORK_MS + 10_000;
export const OVERLAY_MIN_FILE_WALL_MS = OVERLAY_CASE_WORK_MS + 30_000;

/** Canonical wrapper census. Runner integration must serialize these files. */
export const OVERLAY_CASE_FILES: Record<string, string> = {
  'test/skill-e2e-overlay-harness-claude-dedicated-tools-vs-bash.test.ts': 'claude-dedicated-tools-vs-bash',
  'test/skill-e2e-overlay-harness-opus-4-7-effort-match-trivial.test.ts': 'opus-4-7-effort-match-trivial',
  'test/skill-e2e-overlay-harness-opus-4-7-literal-interpretation.test.ts': 'opus-4-7-literal-interpretation',
  'test/skill-e2e-overlay-harness-claude-dedicated-tools-vs-bash-sonnet.test.ts': 'claude-dedicated-tools-vs-bash-sonnet',
  'test/skill-e2e-overlay-harness-claude-dedicated-tools-vs-bash-opus-5-5.test.ts': 'claude-dedicated-tools-vs-bash-opus-5-5',
};
