/** Version 2 gates supported behavior; comparative efficacy stays research-only.
 * Version 1 required efficacy lift. Never reinterpret its recorded failures.
 */
export const OVERLAY_CONTRACT = {
  name: 'overlay-behavior',
  version: 2,
  releaseGate: 'execution_scope_complete_sampling_and_on_correctness',
  comparisonRole: 'research_only',
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
  'test/skill-e2e-overlay-harness-opus-4-7-effort-match-trivial-sonnet.test.ts': 'opus-4-7-effort-match-trivial-sonnet',
  'test/skill-e2e-overlay-harness-opus-4-7-literal-interpretation-sonnet.test.ts': 'opus-4-7-literal-interpretation-sonnet',
};
