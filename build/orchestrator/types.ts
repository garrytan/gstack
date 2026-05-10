/**
 * Shared types for the gstack-build orchestrator.
 *
 * Three domain objects:
 *   Feature     — parsed from the plan markdown (groups executable phases)
 *   Phase       — parsed from the plan markdown (immutable after parse)
 *   PhaseState  — runtime state of executing a phase (mutates as we go)
 *
 * Plus the top-level BuildState that the persistence layer reads/writes.
 */

import type { RoleConfigs } from "./role-config";

export type PhaseStatus =
  | "pending"
  | "test_spec_running"
  | "test_spec_done"
  | "tests_red"
  | "gemini_running"
  | "impl_done"
  | "test_fix_running"
  | "tests_green"
  | "codex_running"
  | "review_clean"
  | "committed"
  | "failed"
  // Dual-implementor states (--dual-impl flag)
  | "dual_impl_running"
  | "dual_impl_done"
  | "dual_tests_running"
  | "dual_judge_pending"
  | "dual_judge_running"
  | "dual_winner_pending";

export type FeatureStatus =
  | "pending"
  | "running"
  | "phases_done"
  | "feature_review_pending"
  | "feature_review_running"
  | "feature_redo_pending"
  | "feature_blocked"
  | "shipping"
  | "release_queued"
  | "landed"
  | "origin_verifying"
  | "origin_verified"
  | "committed"
  | "failed"
  | "paused";

/**
 * Named gates for a single build phase. Each gate corresponds to one
 * checkbox in the plan markdown. Gate presence in the plan is optional
 * (legacy plans may only have implementation + review).
 */
export type PhaseGate =
  | "test_spec"
  | "verify_red"
  | "implementation"
  | "green_tests"
  | "review_qa";

/**
 * Named gates for a feature (across all its phases). These appear under
 * the feature heading in the plan, not under individual phase headings.
 */
export type FeatureGate =
  | "feature_review"
  | "ship_land"
  | "origin_verification";

/** State of a single plan-file gate checkbox. */
export interface PlanGateState {
  /** True when the checkbox is [x]. */
  done: boolean;
  /** 1-based line number of this checkbox in the plan file. */
  line: number;
  /** Optional status note parsed from _(note)_ suffix on the line. */
  note?: string;
}

export interface Feature {
  /** Zero-based index in the order features appear in the plan file. */
  index: number;
  /** Feature number as written in the heading, e.g. "1", "2". */
  number: string;
  /** Feature name (everything after `## Feature N: `). */
  name: string;
  /** Free-form body between the feature heading and its first phase. */
  body: string;
  /** Phase indexes that belong to this feature. */
  phaseIndexes: number[];
  /** Parsed gate state for feature-level checkboxes (feature_review, ship_land, origin_verification). */
  gates?: Partial<Record<FeatureGate, PlanGateState>>;
}

export interface Phase {
  /** Zero-based index in the order phases appear in the plan file. */
  index: number;
  /** Phase number as written in the heading, e.g. "1", "2.1". */
  number: string;
  /** Phase name (everything after `### Phase N: `). */
  name: string;
  /** Zero-based feature index that owns this phase. */
  featureIndex: number;
  /** Feature number as written in the heading, e.g. "1". */
  featureNumber: string;
  /** Feature name. */
  featureName: string;
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
  /** Parsed gate state for per-phase checkboxes (test_spec, verify_red, implementation, green_tests, review_qa). */
  gates?: Partial<Record<PhaseGate, PlanGateState>>;
}

export interface DualImplTestResult {
  worktreePath: string;
  testExitCode: number | null;
  testLogPath: string;
  timedOut: boolean;
  /** Parsed count of failing test cases from test output. */
  failureCount?: number;
}

export type DualImplCandidateKey = "primary" | "secondary";

export interface DualImplCandidateState {
  worktreePath: string;
  branch: string;
  provider?: string;
  model?: string;
  testResult?: DualImplTestResult;
  /**
   * Number of recursive fix passes this implementor needed to reach its final test state.
   * 0 = passed on first try. null = fix loop did not run (impl crashed or no test command).
   */
  fixIterations?: number | null;
  /** HEAD commit SHA in the worktree at the time tests last ran. Used to detect stale cached results on resume. */
  testedCommit?: string;
  /**
   * Formatted log of what test failures this implementor hit at each fix iteration.
   * Each entry = "--- Fix iteration N ---\n<truncated test output>".
   * Passed to the judge so it can see what bugs each model encountered and fixed.
   */
  fixHistory?: string;
}

export interface DualImplState {
  candidates: Record<DualImplCandidateKey, DualImplCandidateState>;
  baseCommit: string;
  /**
   * Hardening notes emitted by the configured judge after seeing both fix histories.
   * Lists concrete issues from EITHER implementor's failure history that the
   * final code must handle. Passed into the Codex review prompt.
   */
  judgeHardeningNotes?: string;
  judgeLogPath?: string;
  judgeVerdict?: DualImplCandidateKey;
  judgeReasoning?: string;
  selectedImplementor?: DualImplCandidateKey;
  /** 'judge' = judge decided; 'auto' = one passed/fewer failures; winner was obvious */
  selectedBy?: "judge" | "auto";
  /** ISO timestamp when worktrees were torn down. */
  worktreesTornDownAt?: string;
}

export interface SubAgentInvocation {
  startedAt: string;
  completedAt?: string;
  outputLogPath: string;
  /**
   * Path to the structured output file the sub-agent wrote (the artifact —
   * a clean review report or implementation summary). Distinct from
   * `outputLogPath`, which is the raw spawn shell capture (command + stdout +
   * stderr) used for forensics. Consumers that want to FEED a sub-agent's
   * artifact into the next sub-agent (e.g. RUN_GEMINI_FROM_REVIEW reading the
   * prior review report) MUST read `outputFilePath`, not `outputLogPath`.
   */
  outputFilePath?: string;
  retries: number;
  exitCode?: number;
  error?: string;
}

export interface CodexReviewState {
  iterations: number;
  finalVerdict?: "GATE PASS" | "GATE FAIL" | "TIMEOUT";
  outputLogPaths: string[];
  /**
   * Parallel array to `outputLogPaths`: each entry is the path to the
   * structured review report (the artifact Codex wrote to its outputFilePath).
   * Use this — NOT outputLogPaths — when feeding prior reviewer findings
   * back to a sub-agent or when building escalation reports (BLOCKED.md).
   * Optional for backwards compatibility with state files written before
   * this field existed.
   */
  outputFilePaths?: string[];
  /** Number of Gemini re-runs triggered by review feedback (RUN_GEMINI_FROM_REVIEW). */
  geminiReRunCount?: number;
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
    finalStatus: "red" | "green" | "timeout";
  };
  /** State of the recursive Gemini fix calls when tests fail post-impl. */
  testFix?: {
    iterations: number;
    outputLogPaths: string[];
  };
  codexReview?: CodexReviewState;
  /** Origin-plan verification issue report that must be fixed during the next review loop. */
  originIssueLogPath?: string;
  /** Dual-implementor tournament state (populated when --dual-impl is active). */
  dualImpl?: DualImplState;
  committedAt?: string;
  error?: string;
}

/**
 * Per-feature meta-review state. Populated when --skip-feature-review is
 * NOT set and the feature has more than one phase OR any phase needed
 * more than one Codex iteration to converge. Tracks the configurable
 * post-implementation review cycle that runs after `phases_done` and
 * before `shipping`.
 */
export interface FeatureReviewState {
  /** Number of review cycles run so far for this feature. */
  iterations: number;
  /** Spawn shell logs for each review invocation (forensics). */
  outputLogPaths: string[];
  /**
   * Parallel array of clean review report paths. Use these — NOT
   * outputLogPaths — when feeding the prior verdict into the next loop
   * iteration or building the BLOCKED-feature-N.md report.
   */
  outputFilePaths: string[];
  /** Verdict from the most recent invocation. */
  finalVerdict?:
    | "FEATURE_PASS"
    | "FEATURE_NEEDS_PHASES"
    | "FEATURE_REDO"
    | "FEATURE_BLOCKED"
    | "TIMEOUT";
  /** Set when a timed-out review artifact had pass-like test/no-findings evidence but no parseable sentinel. */
  timeoutEvidence?: "pass";
  /** Phase indexes the reviewer asked us to reset (FEATURE_REDO). */
  phasesReset?: number[];
  /** Count of phases the reviewer appended to the plan (FEATURE_NEEDS_PHASES). */
  phasesAdded?: number;
  /**
   * True after the user explicitly opted in to a 4th+ cycle past the
   * convergence cap. Resets when the verdict becomes FEATURE_PASS.
   */
  userApprovedExtension?: boolean;
}

export interface FeatureState {
  index: number;
  number: string;
  name: string;
  phaseIndexes: number[];
  status: FeatureStatus;
  branch?: string;
  shippedAt?: string;
  /** PR number set at queue time; required for release_queued to be trusted as terminal. */
  prNumber?: number;
  landedAt?: string;
  originVerifiedAt?: string;
  completedAt?: string;
  issueLogPath?: string;
  originIssueLogPaths?: string[];
  originVerificationAttempts?: number;
  /** Files that conflicted while syncing the owned feature branch with base before shipping. */
  baseSyncConflictFiles?: string[];
  /** Meta-review state (populated when feature-level review fires). */
  featureReview?: FeatureReviewState;
  error?: string;
}

export interface BuildLaunchOptions {
  /** Raw argv passed to gstack-build, excluding the node/bun executable. */
  argv: string[];
  /** Resolved target repository root for this invocation. */
  projectRoot: string;
  /** Original checkout root when this run executes inside a private worktree. */
  baseProjectRoot?: string;
  /** Durable run identity. When present, state slug is build-<runId>. */
  runId?: string;
  /** Prefix used for branches owned by this run. */
  branchPrefix?: string;
  /** Active-run registry directory used to protect branches owned by sibling runs. */
  activeRunRegistry?: string;
  /** Persisted state slug for wrong-run resume detection. */
  stateSlug?: string;
  /** Source/origin plan path, when this run was launched with --origin-plan. */
  originPlan?: string;
  /** True when this invocation is a simulation and must not write/ship. */
  dryRun: boolean;
  /** True only when --skip-ship was explicitly passed. */
  skipShip: boolean;
  /** True only when --skip-feature-review was explicitly passed. */
  skipFeatureReview: boolean;
  /** ISO timestamp for this specific launch/resume attempt. */
  launchedAt: string;
}

export interface BuildRunManifestRun {
  runId: string;
  repoPath: string;
  repoSlug: string;
  sourcePlanPath?: string;
  livingPlanPath: string;
  originPlanPath?: string;
  worktreePath: string;
  stateSlug: string;
  branchPrefix: string;
  pidFile: string;
  stdoutLog: string;
  /** Exact argv used to launch or resume this run. Executable is element 0. */
  launchCommand: string[];
  /** Explicit environment overrides for launchCommand. */
  launchEnv?: Record<string, string>;
}

export interface BuildRunManifest {
  manifestId: string;
  runGroupId: string;
  tmpDir: string;
  workspaceRoot?: string;
  gstackRepo?: string;
  runs: BuildRunManifestRun[];
}

export type PlanReviewSeverity = "APPROVE" | "REVISE";

export interface PlanReviewObjection {
  severity: "CRITICAL" | "IMPORTANT" | "SUGGESTION";
  /** e.g. "Feature 2, Phase 1" */
  location: string;
  issue: string;
  suggestion: string;
}

export interface PlanReviewVerdict {
  verdict: PlanReviewSeverity;
  objections: PlanReviewObjection[];
  assessment: string;
  /** Model name, e.g. "gpt-5.5". "skipped-unavailable" when review was bypassed. */
  reviewedBy: string;
  /** 1 or 2 — for re-synthesis round tracking in SKILL.md Step 5.5. */
  round: number;
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
  /** Last CLI launch/resume options, persisted for audit/recovery. */
  launch?: BuildLaunchOptions;
  /** Zero-based index of the next phase to run. */
  currentPhaseIndex: number;
  /** Zero-based index of the next feature to run. */
  currentFeatureIndex?: number;
  /** Per-feature runtime state, parallel array to parsed features. */
  features?: FeatureState[];
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
  /** Role-based provider/model/reasoning/command routing. */
  roleConfigs?: RoleConfigs;
  /** Result of the planReviewer second-opinion pass. undefined = not yet reviewed or skipped. */
  planReview?: PlanReviewVerdict;
}
