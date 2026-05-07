/**
 * Phase runner — pure state machine.
 *
 * No I/O, no spawning. Driver passes the current phase state plus the
 * result of the last sub-agent invocation (if any), and we return:
 *   - the next Action to take
 *   - the updated PhaseState reflecting that result
 *
 * The driver in cli.ts owns:
 *   - actually running sub-agents
 *   - mutating the plan file (flipping checkboxes)
 *   - persisting state to disk
 *
 * The reason we keep this pure: it's the heart of the orchestrator and
 * needs to be exhaustively testable. By isolating the state transitions,
 * we can unit-test every branch with a few lines and a mock result.
 */

import type {
  DualImplCandidateKey,
  DualImplState,
  DualImplTestResult,
  Phase,
  PhaseState,
} from "./types";
import type { SubAgentResult, Verdict } from "./sub-agents";
import { parseVerdict } from "./sub-agents";
import { BUILD_DEFAULTS, envNumberOrDefault } from "./build-config";

/** Maximum recursive Codex review iterations before giving up. */
export const DEFAULT_MAX_CODEX_ITERATIONS = envNumberOrDefault(
  "GSTACK_BUILD_CODEX_MAX_ITER",
  BUILD_DEFAULTS.limits.codexMaxIterations,
);

/** Maximum times Gemini may re-write tests when VERIFY_RED shows tests pass trivially. */
export const DEFAULT_MAX_RED_SPEC_ITERATIONS = envNumberOrDefault(
  "GSTACK_BUILD_RED_MAX_ITER",
  BUILD_DEFAULTS.limits.redSpecMaxIterations,
);

export const DEFAULT_MAX_TEST_ITERATIONS = envNumberOrDefault(
  "GSTACK_BUILD_TEST_MAX_ITER",
  BUILD_DEFAULTS.limits.testMaxIterations,
);

/** After this many consecutive Codex GATE FAILs, re-invoke Gemini with reviewer findings. 0 = disabled. */
export const DEFAULT_CODEX_GEMINI_RERUN_FREQ = envNumberOrDefault(
  "GSTACK_BUILD_CODEX_GEMINI_RERUN_FREQ",
  2,
);

/**
 * Default cap on per-feature meta-review cycles. After this many cycles
 * without FEATURE_PASS, the orchestrator pauses and prompts the user via
 * stdin readline whether to allow another cycle. Non-TTY runs (CI,
 * background) take the cap as final and write BLOCKED-feature-N.md.
 * 0 disables the feature-level review entirely.
 */
export const DEFAULT_FEATURE_REVIEW_MAX_ITER = envNumberOrDefault(
  "GSTACK_BUILD_FEATURE_REVIEW_MAX_ITER",
  BUILD_DEFAULTS.limits.featureReviewMaxIterations,
);

/**
 * Stable prefix the FAIL action's `reason` carries when convergence is the
 * cause. Consumers (cli.ts BLOCKED.md handler) match on this prefix instead
 * of substring-matching against the human-readable error message — the
 * latter would silently disable the BLOCKED.md write on any rephrasing.
 */
export const CODEX_CONVERGENCE_FAILURE_REASON_PREFIX =
  "Codex review failed to converge";

export function isCodexConvergenceFailure(reason: string): boolean {
  return reason.startsWith(CODEX_CONVERGENCE_FAILURE_REASON_PREFIX);
}

function isLegacyDualImplState(dualImpl: unknown): boolean {
  return (
    !!dualImpl &&
    typeof dualImpl === "object" &&
    ("geminiWorktreePath" in dualImpl || "codexWorktreePath" in dualImpl)
  );
}

function legacyDualImplError(): string {
  return "Existing dual-impl state uses the old gemini/codex shape. Delete the stale build state or rerun this phase so gstack-build can create primary/secondary worktrees.";
}

function firstHygieneFailureLine(stdout: string): string | null {
  if (!stdout.includes("# Post-agent hygiene failure")) return null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (
      line === "" ||
      line === "# Post-agent hygiene failure" ||
      line === "GATE FAIL" ||
      line.startsWith("Original agent log:")
    ) {
      continue;
    }
    return line;
  }
  return "post-agent hygiene failure";
}

function geminiExitError(prefix: string, result: SubAgentResult): string {
  const hygieneLine = firstHygieneFailureLine(result.stdout);
  if (hygieneLine) {
    return `${prefix} hygiene failed: ${hygieneLine}; see ${result.logPath}`;
  }
  return `${prefix} exited ${result.exitCode}; see ${result.logPath}`;
}

export type Action =
  | { type: "RUN_GEMINI"; phaseIndex: number; iteration: number }
  | {
      type: "RUN_GEMINI_FROM_REVIEW";
      phaseIndex: number;
      iteration: number;
      reviewFeedbackPath: string;
    }
  | { type: "RUN_CODEX_REVIEW"; phaseIndex: number; iteration: number }
  | { type: "MARK_COMPLETE"; phaseIndex: number }
  | { type: "FAIL"; phaseIndex: number; reason: string }
  | { type: "DONE"; phaseIndex: number }
  | { type: "RUN_GEMINI_TEST_SPEC"; phaseIndex: number; iteration: number }
  | { type: "VERIFY_RED"; phaseIndex: number }
  | { type: "RUN_TESTS"; phaseIndex: number; iteration: number }
  | { type: "RUN_GEMINI_FIX"; phaseIndex: number; iteration: number }
  // Dual-implementor actions (--dual-impl flag)
  | { type: "RUN_DUAL_IMPL"; phaseIndex: number; iteration: number }
  | { type: "RUN_DUAL_TESTS"; phaseIndex: number }
  | { type: "RUN_JUDGE"; phaseIndex: number }
  | {
      type: "APPLY_WINNER";
      phaseIndex: number;
      winner: DualImplCandidateKey;
    }
  // Feature-level meta-review (fires after all phases of a feature commit).
  // Carries featureIndex (NOT phaseIndex) and the iteration counter so the
  // handler can build the prompt with prior verdict context.
  | {
      type: "RUN_FEATURE_REVIEW";
      featureIndex: number;
      iteration: number;
      /**
       * Optional path to the prior review's clean report. Set when iter>1
       * so the reviewer can see what it asked for last cycle and whether
       * the orchestrator complied.
       */
      priorReportPath?: string;
    };

/**
 * Given a phase's runtime state, decide what to do next.
 *
 * This is the entry point the driver calls in a loop:
 *   while (true) {
 *     const action = decideNextAction(phaseState, maxIterations);
 *     if (action.type === 'DONE' || action.type === 'FAIL') break;
 *     ...execute action, get result...
 *     phaseState = applyResult(phaseState, action, result);
 *   }
 */
export function decideNextAction(
  phaseState: PhaseState,
  maxCodexIterations: number = DEFAULT_MAX_CODEX_ITERATIONS,
  phase?: Phase,
  maxTestIterations: number = DEFAULT_MAX_TEST_ITERATIONS,
  maxRedSpecIterations: number = DEFAULT_MAX_RED_SPEC_ITERATIONS,
  codexGeminiRerunFreq: number = DEFAULT_CODEX_GEMINI_RERUN_FREQ,
): Action {
  switch (phaseState.status) {
    case "pending":
      if (phase && !phase.testSpecDone) {
        return {
          type: "RUN_GEMINI_TEST_SPEC",
          phaseIndex: phaseState.index,
          iteration: 1,
        };
      }
      // Prewritten test spec + dual-impl: confirm tests are red before spawning
      // both implementors — same guarantee as the standard TDD path.
      // Guard on testSpecCheckboxLine !== -1 to skip legacy 2-checkbox plans
      // (which set testSpecDone=true via the "no checkbox = already done" compat
      // path). Legacy plans should run the unchanged single-Gemini flow.
      if (phase?.dualImpl && phase.testSpecCheckboxLine !== -1) {
        return { type: "VERIFY_RED", phaseIndex: phaseState.index };
      }
      return {
        type: "RUN_GEMINI",
        phaseIndex: phaseState.index,
        iteration: (phaseState.gemini?.retries ?? 0) + 1,
      };

    case "gemini_running":
      // Should not happen in practice: caller should have applied the
      // gemini result before re-asking. But if we resumed from a crash
      // mid-gemini, treat as pending and start over.
      return {
        type: "RUN_GEMINI",
        phaseIndex: phaseState.index,
        iteration: 1,
      };

    case "test_spec_running":
      if (phase?.testSpecDone) {
        // Prewritten test spec: VERIFY_RED ran and found tests pass trivially.
        // Re-running the test spec generator makes no sense — the spec is
        // user-authored. Fail with a clear message.
        if ((phaseState.redSpecAttempts ?? 0) > 0) {
          return {
            type: "FAIL",
            phaseIndex: phaseState.index,
            reason:
              "Prewritten tests pass before implementation — fix the tests so they fail first, then re-run with --dual-impl",
          };
        }
        // redSpecAttempts=0: process crashed between writing test_spec_running
        // and launching VERIFY_RED. Retry VERIFY_RED rather than spuriously
        // failing or running the test spec generator on a prewritten spec.
        return { type: "VERIFY_RED", phaseIndex: phaseState.index };
      }
      return {
        type: "RUN_GEMINI_TEST_SPEC",
        phaseIndex: phaseState.index,
        iteration: (phaseState.redSpecAttempts ?? 0) + 1,
      };

    case "test_spec_done":
      return { type: "VERIFY_RED", phaseIndex: phaseState.index };

    case "tests_red":
      if (phase?.dualImpl) {
        return {
          type: "RUN_DUAL_IMPL",
          phaseIndex: phaseState.index,
          iteration: 1,
        };
      }
      return {
        type: "RUN_GEMINI",
        phaseIndex: phaseState.index,
        iteration: (phaseState.gemini?.retries ?? 0) + 1,
      };

    case "impl_done":
      // For TDD phases (testSpecDone=false) or prewritten-testspec+dual-impl phases,
      // run tests to verify the adopted code on main cwd.
      // For legacy phases (testSpecDone=true, !dualImpl), go straight to Codex review.
      if (phase && (!phase.testSpecDone || phase.dualImpl)) {
        return {
          type: "RUN_TESTS",
          phaseIndex: phaseState.index,
          iteration: (phaseState.testRun?.iterations ?? 0) + 1,
        };
      }
      return {
        type: "RUN_CODEX_REVIEW",
        phaseIndex: phaseState.index,
        iteration: (phaseState.codexReview?.iterations ?? 0) + 1,
      };

    case "test_fix_running": {
      const nextIter = (phaseState.testFix?.iterations ?? 0) + 1;
      if (nextIter > maxTestIterations) {
        return {
          type: "FAIL",
          phaseIndex: phaseState.index,
          reason: `Tests still failing after ${maxTestIterations} fix iterations`,
        };
      }
      return {
        type: "RUN_GEMINI_FIX",
        phaseIndex: phaseState.index,
        iteration: nextIter,
      };
    }

    case "tests_green":
      return {
        type: "RUN_CODEX_REVIEW",
        phaseIndex: phaseState.index,
        iteration: (phaseState.codexReview?.iterations ?? 0) + 1,
      };

    case "codex_running": {
      const nextIter = (phaseState.codexReview?.iterations ?? 0) + 1;
      if (nextIter > maxCodexIterations) {
        return {
          type: "FAIL",
          phaseIndex: phaseState.index,
          reason: `${CODEX_CONVERGENCE_FAILURE_REASON_PREFIX} after ${maxCodexIterations} iterations`,
        };
      }
      // Every codexGeminiRerunFreq Codex GATE FAILs, re-invoke Gemini with reviewer context.
      // Uses `iterations % freq === 0` so it fires at iterations 2, 4, 6 (with freq=2).
      // The cap check above takes priority: if maxCodexIterations is e.g. 4, the re-run
      // at iterations=4 is preempted by FAIL before this check runs.
      const reviewCount = phaseState.codexReview?.iterations ?? 0;
      // Read the artifact path (clean review report), NOT the shell log path.
      // outputFilePaths is the parallel array of structured report paths;
      // outputLogPaths captures noisy spawn-stdout/stderr forensics.
      const feedbackPath = phaseState.codexReview?.outputFilePaths?.at(-1);
      if (
        codexGeminiRerunFreq > 0 &&
        reviewCount > 0 &&
        reviewCount % codexGeminiRerunFreq === 0 &&
        feedbackPath
      ) {
        return {
          type: "RUN_GEMINI_FROM_REVIEW",
          phaseIndex: phaseState.index,
          iteration: nextIter,
          reviewFeedbackPath: feedbackPath,
        };
      }
      return {
        type: "RUN_CODEX_REVIEW",
        phaseIndex: phaseState.index,
        iteration: nextIter,
      };
    }

    case "review_clean":
      return { type: "MARK_COMPLETE", phaseIndex: phaseState.index };

    case "committed":
      return { type: "DONE", phaseIndex: phaseState.index };

    case "failed":
      return {
        type: "FAIL",
        phaseIndex: phaseState.index,
        reason: phaseState.error || "phase previously failed",
      };

    // Dual-implementor states
    case "dual_impl_running":
      return {
        type: "RUN_DUAL_IMPL",
        phaseIndex: phaseState.index,
        iteration: 1,
      };

    case "dual_impl_done":
      if (isLegacyDualImplState(phaseState.dualImpl)) {
        return {
          type: "FAIL",
          phaseIndex: phaseState.index,
          reason: legacyDualImplError(),
        };
      }
      return { type: "RUN_DUAL_TESTS", phaseIndex: phaseState.index };

    case "dual_tests_running":
      if (isLegacyDualImplState(phaseState.dualImpl)) {
        return {
          type: "FAIL",
          phaseIndex: phaseState.index,
          reason: legacyDualImplError(),
        };
      }
      return { type: "RUN_DUAL_TESTS", phaseIndex: phaseState.index };

    case "dual_judge_pending":
    case "dual_judge_running":
      if (isLegacyDualImplState(phaseState.dualImpl)) {
        return {
          type: "FAIL",
          phaseIndex: phaseState.index,
          reason: legacyDualImplError(),
        };
      }
      return { type: "RUN_JUDGE", phaseIndex: phaseState.index };

    case "dual_winner_pending": {
      if (isLegacyDualImplState(phaseState.dualImpl)) {
        return {
          type: "FAIL",
          phaseIndex: phaseState.index,
          reason: legacyDualImplError(),
        };
      }
      const winner = phaseState.dualImpl?.selectedImplementor;
      if (!winner) {
        return {
          type: "FAIL",
          phaseIndex: phaseState.index,
          reason:
            "dual_winner_pending without selectedImplementor — state corrupted",
        };
      }
      return { type: "APPLY_WINNER", phaseIndex: phaseState.index, winner };
    }

    default: {
      // Exhaustiveness check — TypeScript flags new statuses here.
      const _never: never = phaseState.status;
      void _never;
      return {
        type: "FAIL",
        phaseIndex: phaseState.index,
        reason: `unknown status: ${phaseState.status}`,
      };
    }
  }
}

/**
 * Extra data for dual-implementor actions that can't fit in a single SubAgentResult.
 * All fields are optional — only relevant ones need to be populated per action type.
 */
export interface ApplyResultExtra {
  /** RUN_DUAL_IMPL: worktree paths + branches set up by createWorktrees() */
  dualImplInit?: DualImplState;
  /** RUN_DUAL_TESTS: individual test outcomes for each worktree */
  candidateTestResults?: Record<DualImplCandidateKey, DualImplTestResult>;
  /** RUN_JUDGE: configured judge decision */
  judgeVerdict?: DualImplCandidateKey;
  judgeReasoning?: string;
  judgeHardeningNotes?: string;
  /**
   * Path to the structured artifact written by the sub-agent (the review
   * report or implementation summary file — NOT the spawn shell log).
   * Stored on phaseState so consumers that want the clean artifact (e.g.
   * RUN_GEMINI_FROM_REVIEW reading the prior review report, or BLOCKED.md
   * embedding it) can read from a known-clean path instead of the noisy
   * shell capture in `result.logPath`.
   */
  outputFilePath?: string;
}

/**
 * Apply a sub-agent result to the phase state. Returns a NEW PhaseState
 * (does not mutate the input).
 */
export function applyResult(
  phaseState: PhaseState,
  action: Action,
  result: SubAgentResult,
  extra?: ApplyResultExtra,
): PhaseState {
  const next: PhaseState = { ...phaseState };

  if (action.type === "RUN_GEMINI") {
    next.gemini = {
      startedAt:
        phaseState.gemini?.startedAt ??
        new Date(Date.now() - result.durationMs).toISOString(),
      completedAt: new Date().toISOString(),
      outputLogPath: result.logPath,
      outputFilePath: extra?.outputFilePath,
      retries: result.retries,
      exitCode: result.exitCode ?? undefined,
    };
    if (result.timedOut) {
      next.status = "failed";
      next.error = `Gemini timed out (after ${result.retries} retry${result.retries === 1 ? "" : "es"})`;
      return next;
    }
    if (result.exitCode !== 0) {
      next.status = "failed";
      next.error = geminiExitError("Gemini", result);
      next.gemini.error = next.error;
      return next;
    }
    next.status = "impl_done";
    return next;
  }

  if (action.type === "RUN_CODEX_REVIEW") {
    const prevIters = phaseState.codexReview?.iterations ?? 0;
    const prevLogPaths = phaseState.codexReview?.outputLogPaths ?? [];
    const prevFilePaths = phaseState.codexReview?.outputFilePaths ?? [];
    // Spread prior codexReview to preserve forensic fields (geminiReRunCount,
    // finalVerdict from a prior cycle) — they were silently dropped before
    // because the object was rebuilt from scratch on every iteration.
    next.codexReview = {
      ...(phaseState.codexReview ?? {}),
      iterations: prevIters + 1,
      outputLogPaths: [...prevLogPaths, result.logPath],
      // Track the artifact path (clean review report) alongside the shell
      // log. Consumers that feed reviewer findings to a sub-agent should
      // read from outputFilePaths, not outputLogPaths.
      outputFilePaths: extra?.outputFilePath
        ? [...prevFilePaths, extra.outputFilePath]
        : prevFilePaths,
    };
    if (result.timedOut) {
      next.codexReview.finalVerdict = "TIMEOUT";
      next.status = "failed";
      next.error = `Codex review timed out after ${result.retries} retry${result.retries === 1 ? "" : "es"}`;
      return next;
    }
    if (result.exitCode !== 0) {
      next.status = "failed";
      next.error = `Codex exited ${result.exitCode}; see ${result.logPath}`;
      return next;
    }
    const verdict: Verdict = parseVerdict(result.stdout);
    if (verdict === "pass") {
      next.codexReview.finalVerdict = "GATE PASS";
      next.status = "review_clean";
      return next;
    }
    if (verdict === "fail") {
      next.codexReview.finalVerdict = "GATE FAIL";
      next.status = "codex_running";
      return next;
    }
    // verdict === 'unclear'
    next.status = "failed";
    next.error =
      "Codex output did not contain GATE PASS or GATE FAIL — cannot determine review outcome";
    return next;
  }

  if (action.type === "RUN_GEMINI_FROM_REVIEW") {
    next.codexReview = {
      ...(phaseState.codexReview ?? { iterations: 0, outputLogPaths: [] }),
      geminiReRunCount: (phaseState.codexReview?.geminiReRunCount ?? 0) + 1,
    };
    next.gemini = {
      // Preserve the original startedAt across reruns so per-phase wall-clock
      // metrics reflect the cumulative gemini work, not just the last rerun.
      startedAt:
        phaseState.gemini?.startedAt ??
        new Date(Date.now() - result.durationMs).toISOString(),
      completedAt: new Date().toISOString(),
      outputLogPath: result.logPath,
      outputFilePath: extra?.outputFilePath,
      retries: result.retries,
      exitCode: result.exitCode ?? undefined,
    };
    // Clear stale fix-loop bookkeeping: this rerun produces a fresh
    // implementation, so any prior testRun/testFix counters from before the
    // rerun would mislead the next RUN_TESTS path (premature FAIL on max-iter,
    // confusing iteration numbers in logs).
    next.testRun = undefined;
    next.testFix = undefined;
    if (result.timedOut) {
      next.status = "failed";
      next.error = `Gemini re-run (from review feedback) timed out`;
      return next;
    }
    if (result.exitCode !== 0) {
      next.status = "failed";
      next.error = geminiExitError(
        "Gemini re-run (from review feedback)",
        result,
      );
      return next;
    }
    next.status = "impl_done";
    return next;
  }

  if (action.type === "RUN_GEMINI_TEST_SPEC") {
    next.geminiTestSpec = {
      startedAt:
        phaseState.geminiTestSpec?.startedAt ??
        new Date(Date.now() - result.durationMs).toISOString(),
      completedAt: new Date().toISOString(),
      outputLogPath: result.logPath,
      retries: result.retries,
      exitCode: result.exitCode ?? undefined,
    };
    if (result.timedOut || result.exitCode !== 0) {
      next.status = "failed";
      next.error = `Gemini test-spec step failed: exit ${result.exitCode}`;
      return next;
    }
    next.status = "test_spec_done";
    return next;
  }

  if (action.type === "VERIFY_RED") {
    if (result.timedOut) {
      next.status = "failed";
      next.error = "Test verification timed out";
      return next;
    }
    if (result.exitCode !== 0) {
      // Tests fail as expected → Red phase confirmed. Proceed to implementation.
      next.redSpecAttempts = 0;
      next.status = "tests_red";
      return next;
    }
    // Tests trivially pass before implementation → need harder tests.
    const attempts = (phaseState.redSpecAttempts ?? 0) + 1;
    next.redSpecAttempts = attempts;
    if (attempts >= DEFAULT_MAX_RED_SPEC_ITERATIONS) {
      next.status = "failed";
      next.error = `Gemini could not produce failing tests after ${attempts} attempts (GSTACK_BUILD_RED_MAX_ITER)`;
      return next;
    }
    next.status = "test_spec_running";
    return next;
  }

  if (action.type === "RUN_TESTS") {
    const prevIter = phaseState.testRun?.iterations ?? 0;
    next.testRun = {
      iterations: prevIter + 1,
      finalStatus: result.timedOut
        ? "timeout"
        : result.exitCode === 0
          ? "green"
          : "red",
    };
    if (result.timedOut) {
      next.status = "failed";
      next.error = "Test run timed out";
      return next;
    }
    next.status = result.exitCode === 0 ? "tests_green" : "test_fix_running";
    return next;
  }

  if (action.type === "RUN_GEMINI_FIX") {
    const prevIter = phaseState.testFix?.iterations ?? 0;
    const prevPaths = phaseState.testFix?.outputLogPaths ?? [];
    next.testFix = {
      iterations: prevIter + 1,
      outputLogPaths: [...prevPaths, result.logPath],
    };
    if (result.timedOut || result.exitCode !== 0) {
      next.status = "failed";
      next.error = `Gemini fix step failed: exit ${result.exitCode}`;
      return next;
    }
    // After a successful fix, re-run tests (route back through impl_done → RUN_TESTS).
    next.status = "impl_done";
    return next;
  }

  if (action.type === "RUN_DUAL_IMPL") {
    if (result.timedOut || result.exitCode !== 0) {
      next.status = "failed";
      next.error = `Dual implementation failed: exit ${result.exitCode}`;
      return next;
    }
    if (!extra?.dualImplInit) {
      next.status = "failed";
      next.error =
        "RUN_DUAL_IMPL requires dualImplInit (worktree paths/branches/baseCommit) in extra";
      return next;
    }
    next.dualImpl = extra.dualImplInit;
    next.status = "dual_impl_done";
    return next;
  }

  if (action.type === "RUN_DUAL_TESTS") {
    const candidateResults = extra?.candidateTestResults;
    const primary = candidateResults?.primary;
    const secondary = candidateResults?.secondary;
    if (!primary || !secondary) {
      next.status = "failed";
      next.error =
        "RUN_DUAL_TESTS requires primary and secondary test results in extra";
      return next;
    }
    // Both timing out is treated as a hard failure — no test evidence to pick a winner.
    if (primary.timedOut && secondary.timedOut) {
      const dual = phaseState.dualImpl;
      next.dualImpl = dual
        ? {
            ...dual,
            candidates: {
              primary: { ...dual.candidates.primary, testResult: primary },
              secondary: {
                ...dual.candidates.secondary,
                testResult: secondary,
              },
            },
          }
        : dual;
      next.status = "failed";
      next.error =
        "Both dual-impl test runs timed out — cannot select a winner";
      return next;
    }

    const primaryPass = primary.testExitCode === 0 && !primary.timedOut;
    const secondaryPass =
      secondary.testExitCode === 0 && !secondary.timedOut;

    let selectedImplementor: DualImplCandidateKey | undefined;
    let nextStatus: PhaseState["status"];
    if (primaryPass && secondaryPass) {
      nextStatus = "dual_judge_pending";
    } else if (primaryPass) {
      selectedImplementor = "primary";
      nextStatus = "dual_winner_pending";
    } else if (secondaryPass) {
      selectedImplementor = "secondary";
      nextStatus = "dual_winner_pending";
    } else {
      // Both failed (no timeouts). If failureCount is missing on both, fail closed —
      // we have no signal to choose a winner.
      if (primary.failureCount == null && secondary.failureCount == null) {
        const dual = phaseState.dualImpl;
        next.dualImpl = dual
          ? {
              ...dual,
              candidates: {
                primary: { ...dual.candidates.primary, testResult: primary },
                secondary: {
                  ...dual.candidates.secondary,
                  testResult: secondary,
                },
              },
            }
          : dual;
        next.status = "failed";
        next.error =
          "Both dual-impl test runs failed and failureCount is missing on both — cannot select winner";
        return next;
      }
      const primaryFails = primary.failureCount ?? Number.MAX_SAFE_INTEGER;
      const secondaryFails =
        secondary.failureCount ?? Number.MAX_SAFE_INTEGER;
      // Ties intentionally pick primary — documented preference.
      selectedImplementor =
        secondaryFails < primaryFails ? "secondary" : "primary";
      nextStatus = "dual_winner_pending";
    }

    const dual = phaseState.dualImpl;
    next.dualImpl = {
      ...(dual as DualImplState),
      candidates: {
        primary: {
          ...(dual as DualImplState).candidates.primary,
          testResult: primary,
        },
        secondary: {
          ...(dual as DualImplState).candidates.secondary,
          testResult: secondary,
        },
      },
      ...(selectedImplementor && {
        selectedImplementor,
        selectedBy: "auto" as const,
      }),
    };
    next.status = nextStatus;
    return next;
  }

  if (action.type === "RUN_JUDGE") {
    if (result.timedOut || result.exitCode !== 0) {
      next.status = "failed";
      next.error = `Judge failed: exit ${result.exitCode}`;
      return next;
    }
    const verdict = extra?.judgeVerdict;
    if (!verdict) {
      next.status = "failed";
      next.error = "RUN_JUDGE requires judgeVerdict in extra";
      return next;
    }
    next.dualImpl = {
      ...(phaseState.dualImpl as DualImplState),
      judgeVerdict: verdict,
      judgeReasoning: extra?.judgeReasoning,
      judgeHardeningNotes: extra?.judgeHardeningNotes,
      judgeLogPath: result.logPath,
      selectedImplementor: verdict,
      selectedBy: "judge",
    };
    next.status = "dual_winner_pending";
    return next;
  }

  if (action.type === "APPLY_WINNER") {
    // The CLI runs applyWinner() + teardownWorktrees() before calling this.
    // We just transition state — the cherry-pick + teardown have happened.
    next.dualImpl = {
      ...(phaseState.dualImpl as DualImplState),
      worktreesTornDownAt: new Date().toISOString(),
    };
    next.status = "impl_done";
    return next;
  }

  // No-op for terminal/transitional actions; driver handles them.
  return next;
}

/**
 * Mark a phase as committed — called after the plan-mutator successfully
 * flipped the checkboxes. Pure transition.
 */
export function markCommitted(phaseState: PhaseState): PhaseState {
  return {
    ...phaseState,
    status: "committed",
    committedAt: new Date().toISOString(),
  };
}

/**
 * Find the index of the next phase that needs work, or -1 if all done.
 * Mirrors parser.findNextPhase but operates on PhaseState (the runtime
 * view) so it can see in-progress states like `impl_done`.
 */
export function findNextPhaseIndex(phaseStates: PhaseState[]): number {
  for (let i = 0; i < phaseStates.length; i++) {
    if (phaseStates[i].status !== "committed") return i;
  }
  return -1;
}
