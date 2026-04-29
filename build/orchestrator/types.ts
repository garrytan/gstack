/**
 * Shared types for the gstack-build orchestrator.
 *
 * Two domain objects:
 *   Phase       — parsed from the plan markdown (immutable after parse)
 *   PhaseState  — runtime state of executing a phase (mutates as we go)
 *
 * Plus the top-level BuildState that the persistence layer reads/writes.
 */

export type PhaseStatus =
  | 'pending'
  | 'test_spec_running'
  | 'test_spec_done'
  | 'tests_red'
  | 'gemini_running'
  | 'impl_done'
  | 'test_fix_running'
  | 'tests_green'
  | 'codex_running'
  | 'review_clean'
  | 'committed'
  | 'failed'
  // Dual-implementor states (--dual-impl flag)
  | 'dual_impl_running'
  | 'dual_impl_done'
  | 'dual_tests_running'
  | 'dual_judge_pending'
  | 'dual_judge_running'
  | 'dual_winner_pending';

export interface Phase {
  /** Zero-based index in the order phases appear in the plan file. */
  index: number;
  /** Phase number as written in the heading, e.g. "1", "2.1". */
  number: string;
  /** Phase name (everything after `### Phase N: `). */
  name: string;
  /** True if `[x] **Implementation` appears in the parsed plan. */
  implementationDone: boolean;
  /** True if `[x] **Review` appears in the parsed plan. */
  reviewDone: boolean;
  /** True if `[x] **Test Specification` appears in the parsed plan, or if the phase has no test spec checkbox (legacy plan backward compat). */
  testSpecDone: boolean;
  /** Free-form body between the phase heading and the next phase. Used as Gemini context. */
  body: string;
  /** Line number (1-based) of the `[ ] **Implementation` checkbox in the plan file. */
  implementationCheckboxLine: number;
  /** Line number (1-based) of the `[ ] **Review` checkbox in the plan file. */
  reviewCheckboxLine: number;
  /** Line number (1-based) of the `[ ] **Test Specification` checkbox in the plan file. -1 if not present (legacy plan). */
  testSpecCheckboxLine: number;
  /** True when --dual-impl CLI flag is active; stamped by the CLI after parse. */
  dualImpl: boolean;
}

export interface DualImplTestResult {
  worktreePath: string;
  testExitCode: number | null;
  testLogPath: string;
  timedOut: boolean;
  /** Parsed count of failing test cases from test output. */
  failureCount?: number;
}

export interface DualImplState {
  geminiWorktreePath: string;
  codexWorktreePath: string;
  geminiBranch: string;
  codexBranch: string;
  baseCommit: string;
  geminiTestResult?: DualImplTestResult;
  codexTestResult?: DualImplTestResult;
  /**
   * Number of recursive fix passes Gemini needed to reach its final test state.
   * 0 = passed on first try. null = fix loop did not run (impl crashed or no test command).
   */
  geminiFixIterations?: number | null;
  /**
   * Number of recursive fix passes Codex needed to reach its final test state.
   * 0 = passed on first try. null = fix loop did not run (impl crashed or no test command).
   */
  codexFixIterations?: number | null;
  /** HEAD commit SHA in the Gemini worktree at the time tests last ran. Used to detect stale cached results on resume. */
  geminiTestedCommit?: string;
  /** HEAD commit SHA in the Codex worktree at the time tests last ran. */
  codexTestedCommit?: string;
  /**
   * Formatted log of what test failures Gemini hit at each fix iteration.
   * Each entry = "--- Fix iteration N ---\n<truncated test output>".
   * Passed to the judge so it can see what bugs each model encountered and fixed.
   */
  geminiFixHistory?: string;
  /** Same as geminiFixHistory but for Codex. */
  codexFixHistory?: string;
  /**
   * Hardening notes emitted by the Opus judge after seeing both fix histories.
   * Lists concrete issues from EITHER implementor's failure history that the
   * final code must handle. Passed into the Codex review prompt.
   */
  judgeHardeningNotes?: string;
  judgeLogPath?: string;
  judgeVerdict?: 'gemini' | 'codex';
  judgeReasoning?: string;
  selectedImplementor?: 'gemini' | 'codex';
  /** 'judge' = Opus decided; 'auto' = one passed/fewer failures; winner was obvious */
  selectedBy?: 'judge' | 'auto';
  /** ISO timestamp when worktrees were torn down. */
  worktreesTornDownAt?: string;
}

export interface SubAgentInvocation {
  startedAt: string;
  completedAt?: string;
  outputLogPath: string;
  retries: number;
  exitCode?: number;
  error?: string;
}

export interface CodexReviewState {
  iterations: number;
  finalVerdict?: 'GATE PASS' | 'GATE FAIL' | 'TIMEOUT';
  outputLogPaths: string[];
}

export interface PhaseState {
  index: number;
  number: string;
  name: string;
  status: PhaseStatus;
  gemini?: SubAgentInvocation;
  /** Invocation record for the test-specification Gemini call. */
  geminiTestSpec?: SubAgentInvocation;
  /** Number of times VERIFY_RED returned exit==0 (tests too easy). Capped by GSTACK_BUILD_RED_MAX_ITER. */
  redSpecAttempts?: number;
  /** State of the post-testspec / post-impl test runs. */
  testRun?: {
    iterations: number;
    finalStatus: 'red' | 'green' | 'timeout';
  };
  /** State of the recursive Gemini fix calls when tests fail post-impl. */
  testFix?: {
    iterations: number;
    outputLogPaths: string[];
  };
  codexReview?: CodexReviewState;
  /** Dual-implementor tournament state (populated when --dual-impl is active). */
  dualImpl?: DualImplState;
  committedAt?: string;
  error?: string;
}

export interface BuildState {
  /** Absolute path to the plan markdown. */
  planFile: string;
  /** Plan basename without extension — used for the state slug. */
  planBasename: string;
  /** Slug used for state files and gbrain pages. */
  slug: string;
  /** Git branch active when the build started. */
  branch: string;
  /** ISO 8601. */
  startedAt: string;
  /** ISO 8601, updated on every state write. */
  lastUpdatedAt: string;
  /** Zero-based index of the next phase to run. */
  currentPhaseIndex: number;
  /** Per-phase runtime state, parallel array to the parsed phases. */
  phases: PhaseState[];
  /** True after the ship step completes. */
  completed: boolean;
  /** Set when a phase fails terminally. */
  failedAtPhase?: number;
  /** Human-readable failure description. */
  failureReason?: string;
  /** Model used for Gemini (Implementor A). Stored for resume mismatch detection. */
  geminiModel?: string;
  /** Model used for Codex (Implementor B, dual-impl). Stored for resume mismatch detection. */
  codexModel?: string;
  /** Model used for Codex review pass. Stored for resume mismatch detection. */
  codexReviewModel?: string;
}
