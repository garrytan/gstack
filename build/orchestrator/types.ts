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
  | 'gemini_running'
  | 'gemini_done'
  | 'codex_running'
  | 'review_clean'
  | 'committed'
  | 'failed';

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
  /** Free-form body between the phase heading and the next phase. Used as Gemini context. */
  body: string;
  /** Line number (1-based) of the `[ ] **Implementation` checkbox in the plan file. */
  implementationCheckboxLine: number;
  /** Line number (1-based) of the `[ ] **Review` checkbox in the plan file. */
  reviewCheckboxLine: number;
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
  codexReview?: CodexReviewState;
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
}
