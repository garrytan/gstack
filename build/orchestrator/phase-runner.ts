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

import type { PhaseState, Phase, DualImplTestResult } from './types';
import type { SubAgentResult, Verdict } from './sub-agents';
import { parseVerdict } from './sub-agents';
import { BUILD_DEFAULTS, envNumberOrDefault } from './build-config';

/** Maximum recursive Codex review iterations before giving up. */
export const DEFAULT_MAX_CODEX_ITERATIONS =
  envNumberOrDefault('GSTACK_BUILD_CODEX_MAX_ITER', BUILD_DEFAULTS.limits.codexMaxIterations);

/** Maximum times Gemini may re-write tests when VERIFY_RED shows tests pass trivially. */
export const DEFAULT_MAX_RED_SPEC_ITERATIONS =
  envNumberOrDefault('GSTACK_BUILD_RED_MAX_ITER', BUILD_DEFAULTS.limits.redSpecMaxIterations);

export const DEFAULT_MAX_TEST_ITERATIONS =
  envNumberOrDefault('GSTACK_BUILD_TEST_MAX_ITER', BUILD_DEFAULTS.limits.testMaxIterations);

export type Action =
  | { type: 'RUN_GEMINI'; phaseIndex: number; iteration: number }
  | { type: 'RUN_CODEX_REVIEW'; phaseIndex: number; iteration: number }
  | { type: 'MARK_COMPLETE'; phaseIndex: number }
  | { type: 'FAIL'; phaseIndex: number; reason: string }
  | { type: 'DONE'; phaseIndex: number }
  | { type: 'RUN_GEMINI_TEST_SPEC'; phaseIndex: number; iteration: number }
  | { type: 'VERIFY_RED'; phaseIndex: number }
  | { type: 'RUN_TESTS'; phaseIndex: number; iteration: number }
  | { type: 'RUN_GEMINI_FIX'; phaseIndex: number; iteration: number }
  // Dual-implementor actions (--dual-impl flag)
  | { type: 'RUN_DUAL_IMPL'; phaseIndex: number; iteration: number }
  | { type: 'RUN_DUAL_TESTS'; phaseIndex: number }
  | { type: 'RUN_JUDGE'; phaseIndex: number }
  | { type: 'APPLY_WINNER'; phaseIndex: number; winner: 'gemini' | 'codex' };

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
  maxRedSpecIterations: number = DEFAULT_MAX_RED_SPEC_ITERATIONS
): Action {
  switch (phaseState.status) {
    case 'pending':
      if (phase && !phase.testSpecDone) {
        return { type: 'RUN_GEMINI_TEST_SPEC', phaseIndex: phaseState.index, iteration: 1 };
      }
      // Prewritten test spec + dual-impl: confirm tests are red before spawning
      // both implementors — same guarantee as the standard TDD path.
      // Guard on testSpecCheckboxLine !== -1 to skip legacy 2-checkbox plans
      // (which set testSpecDone=true via the "no checkbox = already done" compat
      // path). Legacy plans should run the unchanged single-Gemini flow.
      if (phase?.dualImpl && phase.testSpecCheckboxLine !== -1) {
        return { type: 'VERIFY_RED', phaseIndex: phaseState.index };
      }
      return {
        type: 'RUN_GEMINI',
        phaseIndex: phaseState.index,
        iteration: (phaseState.gemini?.retries ?? 0) + 1,
      };

    case 'gemini_running':
      // Should not happen in practice: caller should have applied the
      // gemini result before re-asking. But if we resumed from a crash
      // mid-gemini, treat as pending and start over.
      return {
        type: 'RUN_GEMINI',
        phaseIndex: phaseState.index,
        iteration: 1,
      };

    case 'test_spec_running':
      if (phase?.testSpecDone) {
        // Prewritten test spec: VERIFY_RED ran and found tests pass trivially.
        // Re-running the test spec generator makes no sense — the spec is
        // user-authored. Fail with a clear message.
        if ((phaseState.redSpecAttempts ?? 0) > 0) {
          return {
            type: 'FAIL',
            phaseIndex: phaseState.index,
            reason:
              'Prewritten tests pass before implementation — fix the tests so they fail first, then re-run with --dual-impl',
          };
        }
        // redSpecAttempts=0: process crashed between writing test_spec_running
        // and launching VERIFY_RED. Retry VERIFY_RED rather than spuriously
        // failing or running the test spec generator on a prewritten spec.
        return { type: 'VERIFY_RED', phaseIndex: phaseState.index };
      }
      return {
        type: 'RUN_GEMINI_TEST_SPEC',
        phaseIndex: phaseState.index,
        iteration: (phaseState.redSpecAttempts ?? 0) + 1,
      };

    case 'test_spec_done':
      return { type: 'VERIFY_RED', phaseIndex: phaseState.index };

    case 'tests_red':
      if (phase?.dualImpl) {
        return { type: 'RUN_DUAL_IMPL', phaseIndex: phaseState.index, iteration: 1 };
      }
      return {
        type: 'RUN_GEMINI',
        phaseIndex: phaseState.index,
        iteration: (phaseState.gemini?.retries ?? 0) + 1,
      };

    case 'impl_done':
      // For TDD phases (testSpecDone=false) or prewritten-testspec+dual-impl phases,
      // run tests to verify the adopted code on main cwd.
      // For legacy phases (testSpecDone=true, !dualImpl), go straight to Codex review.
      if (phase && (!phase.testSpecDone || phase.dualImpl)) {
        return {
          type: 'RUN_TESTS',
          phaseIndex: phaseState.index,
          iteration: (phaseState.testRun?.iterations ?? 0) + 1,
        };
      }
      return {
        type: 'RUN_CODEX_REVIEW',
        phaseIndex: phaseState.index,
        iteration: (phaseState.codexReview?.iterations ?? 0) + 1,
      };

    case 'test_fix_running': {
      const nextIter = (phaseState.testFix?.iterations ?? 0) + 1;
      if (nextIter > maxTestIterations) {
        return {
          type: 'FAIL',
          phaseIndex: phaseState.index,
          reason: `Tests still failing after ${maxTestIterations} fix iterations`,
        };
      }
      return { type: 'RUN_GEMINI_FIX', phaseIndex: phaseState.index, iteration: nextIter };
    }

    case 'tests_green':
      return {
        type: 'RUN_CODEX_REVIEW',
        phaseIndex: phaseState.index,
        iteration: (phaseState.codexReview?.iterations ?? 0) + 1,
      };

    case 'codex_running': {
      // Need another iteration. Cap is reached when we've already run
      // maxIterations times — caller will see FAIL on the next call.
      const iter = (phaseState.codexReview?.iterations ?? 0) + 1;
      if (iter > maxCodexIterations) {
        return {
          type: 'FAIL',
          phaseIndex: phaseState.index,
          reason: `Codex review failed to converge after ${maxCodexIterations} iterations`,
        };
      }
      return {
        type: 'RUN_CODEX_REVIEW',
        phaseIndex: phaseState.index,
        iteration: iter,
      };
    }

    case 'review_clean':
      return { type: 'MARK_COMPLETE', phaseIndex: phaseState.index };

    case 'committed':
      return { type: 'DONE', phaseIndex: phaseState.index };

    case 'failed':
      return {
        type: 'FAIL',
        phaseIndex: phaseState.index,
        reason: phaseState.error || 'phase previously failed',
      };

    // Dual-implementor states
    case 'dual_impl_running':
      return { type: 'RUN_DUAL_IMPL', phaseIndex: phaseState.index, iteration: 1 };

    case 'dual_impl_done':
      return { type: 'RUN_DUAL_TESTS', phaseIndex: phaseState.index };

    case 'dual_tests_running':
      return { type: 'RUN_DUAL_TESTS', phaseIndex: phaseState.index };

    case 'dual_judge_pending':
    case 'dual_judge_running':
      return { type: 'RUN_JUDGE', phaseIndex: phaseState.index };

    case 'dual_winner_pending': {
      const winner = phaseState.dualImpl?.selectedImplementor;
      if (!winner) {
        return {
          type: 'FAIL',
          phaseIndex: phaseState.index,
          reason: 'dual_winner_pending without selectedImplementor — state corrupted',
        };
      }
      return { type: 'APPLY_WINNER', phaseIndex: phaseState.index, winner };
    }

    default: {
      // Exhaustiveness check — TypeScript flags new statuses here.
      const _never: never = phaseState.status;
      void _never;
      return {
        type: 'FAIL',
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
  dualImplInit?: {
    geminiWorktreePath: string;
    codexWorktreePath: string;
    geminiBranch: string;
    codexBranch: string;
    baseCommit: string;
    /** Pre-computed by in-impl fix loops — lets RUN_DUAL_TESTS skip re-running tests. */
    geminiTestResult?: DualImplTestResult;
    codexTestResult?: DualImplTestResult;
    geminiFixIterations?: number | null;
    codexFixIterations?: number | null;
    geminiFixHistory?: string;
    codexFixHistory?: string;
    geminiTestedCommit?: string;
    codexTestedCommit?: string;
  };
  /** RUN_DUAL_TESTS: individual test outcomes for each worktree */
  geminiTestResult?: DualImplTestResult;
  codexTestResult?: DualImplTestResult;
  /** RUN_JUDGE: configured judge decision */
  judgeVerdict?: 'gemini' | 'codex';
  judgeReasoning?: string;
  judgeHardeningNotes?: string;
}

/**
 * Apply a sub-agent result to the phase state. Returns a NEW PhaseState
 * (does not mutate the input).
 */
export function applyResult(
  phaseState: PhaseState,
  action: Action,
  result: SubAgentResult,
  extra?: ApplyResultExtra
): PhaseState {
  const next: PhaseState = { ...phaseState };

  if (action.type === 'RUN_GEMINI') {
    next.gemini = {
      startedAt: phaseState.gemini?.startedAt ?? new Date(Date.now() - result.durationMs).toISOString(),
      completedAt: new Date().toISOString(),
      outputLogPath: result.logPath,
      retries: result.retries,
      exitCode: result.exitCode ?? undefined,
    };
    if (result.timedOut) {
      next.status = 'failed';
      next.error = `Gemini timed out (after ${result.retries} retry${result.retries === 1 ? '' : 'es'})`;
      return next;
    }
    if (result.exitCode !== 0) {
      next.status = 'failed';
      next.error = `Gemini exited ${result.exitCode}; see ${result.logPath}`;
      next.gemini.error = next.error;
      return next;
    }
    next.status = 'impl_done';
    return next;
  }

  if (action.type === 'RUN_CODEX_REVIEW') {
    const prevIters = phaseState.codexReview?.iterations ?? 0;
    const prevPaths = phaseState.codexReview?.outputLogPaths ?? [];
    next.codexReview = {
      iterations: prevIters + 1,
      outputLogPaths: [...prevPaths, result.logPath],
    };
    if (result.timedOut) {
      next.codexReview.finalVerdict = 'TIMEOUT';
      next.status = 'failed';
      next.error = `Codex review timed out after ${result.retries} retry${result.retries === 1 ? '' : 'es'}`;
      return next;
    }
    if (result.exitCode !== 0) {
      next.status = 'failed';
      next.error = `Codex exited ${result.exitCode}; see ${result.logPath}`;
      return next;
    }
    const verdict: Verdict = parseVerdict(result.stdout);
    if (verdict === 'pass') {
      next.codexReview.finalVerdict = 'GATE PASS';
      next.status = 'review_clean';
      return next;
    }
    if (verdict === 'fail') {
      next.codexReview.finalVerdict = 'GATE FAIL';
      next.status = 'codex_running';
      return next;
    }
    // verdict === 'unclear'
    next.status = 'failed';
    next.error =
      'Codex output did not contain GATE PASS or GATE FAIL — cannot determine review outcome';
    return next;
  }

  if (action.type === 'RUN_GEMINI_TEST_SPEC') {
    next.geminiTestSpec = {
      startedAt: phaseState.geminiTestSpec?.startedAt ?? new Date(Date.now() - result.durationMs).toISOString(),
      completedAt: new Date().toISOString(),
      outputLogPath: result.logPath,
      retries: result.retries,
      exitCode: result.exitCode ?? undefined,
    };
    if (result.timedOut || result.exitCode !== 0) {
      next.status = 'failed';
      next.error = `Gemini test-spec step failed: exit ${result.exitCode}`;
      return next;
    }
    next.status = 'test_spec_done';
    return next;
  }

  if (action.type === 'VERIFY_RED') {
    if (result.timedOut) {
      next.status = 'failed';
      next.error = 'Test verification timed out';
      return next;
    }
    if (result.exitCode !== 0) {
      // Tests fail as expected → Red phase confirmed. Proceed to implementation.
      next.redSpecAttempts = 0;
      next.status = 'tests_red';
      return next;
    }
    // Tests trivially pass before implementation → need harder tests.
    const attempts = (phaseState.redSpecAttempts ?? 0) + 1;
    next.redSpecAttempts = attempts;
    if (attempts >= DEFAULT_MAX_RED_SPEC_ITERATIONS) {
      next.status = 'failed';
      next.error = `Gemini could not produce failing tests after ${attempts} attempts (GSTACK_BUILD_RED_MAX_ITER)`;
      return next;
    }
    next.status = 'test_spec_running';
    return next;
  }

  if (action.type === 'RUN_TESTS') {
    const prevIter = phaseState.testRun?.iterations ?? 0;
    next.testRun = {
      iterations: prevIter + 1,
      finalStatus: result.timedOut ? 'timeout' : result.exitCode === 0 ? 'green' : 'red',
    };
    if (result.timedOut) {
      next.status = 'failed';
      next.error = 'Test run timed out';
      return next;
    }
    next.status = result.exitCode === 0 ? 'tests_green' : 'test_fix_running';
    return next;
  }

  if (action.type === 'RUN_GEMINI_FIX') {
    const prevIter = phaseState.testFix?.iterations ?? 0;
    const prevPaths = phaseState.testFix?.outputLogPaths ?? [];
    next.testFix = {
      iterations: prevIter + 1,
      outputLogPaths: [...prevPaths, result.logPath],
    };
    if (result.timedOut || result.exitCode !== 0) {
      next.status = 'failed';
      next.error = `Gemini fix step failed: exit ${result.exitCode}`;
      return next;
    }
    // After a successful fix, re-run tests (route back through impl_done → RUN_TESTS).
    next.status = 'impl_done';
    return next;
  }

  if (action.type === 'RUN_DUAL_IMPL') {
    if (result.timedOut || result.exitCode !== 0) {
      next.status = 'failed';
      next.error = `Dual implementation failed: exit ${result.exitCode}`;
      return next;
    }
    if (!extra?.dualImplInit) {
      next.status = 'failed';
      next.error = 'RUN_DUAL_IMPL requires dualImplInit (worktree paths/branches/baseCommit) in extra';
      return next;
    }
    next.dualImpl = { ...(phaseState.dualImpl ?? {}), ...extra.dualImplInit };
    next.status = 'dual_impl_done';
    return next;
  }

  if (action.type === 'RUN_DUAL_TESTS') {
    const g = extra?.geminiTestResult;
    const c = extra?.codexTestResult;
    if (!g || !c) {
      next.status = 'failed';
      next.error = 'RUN_DUAL_TESTS requires geminiTestResult and codexTestResult in extra';
      return next;
    }
    // Both timing out is treated as a hard failure — no test evidence to pick a winner.
    if (g.timedOut && c.timedOut) {
      next.dualImpl = {
        ...(phaseState.dualImpl as any),
        geminiTestResult: g,
        codexTestResult: c,
      };
      next.status = 'failed';
      next.error = 'Both dual-impl test runs timed out — cannot select a winner';
      return next;
    }

    const gPass = g.testExitCode === 0 && !g.timedOut;
    const cPass = c.testExitCode === 0 && !c.timedOut;

    let selectedImplementor: 'gemini' | 'codex' | undefined;
    let nextStatus: PhaseState['status'];
    if (gPass && cPass) {
      nextStatus = 'dual_judge_pending';
    } else if (gPass) {
      selectedImplementor = 'gemini';
      nextStatus = 'dual_winner_pending';
    } else if (cPass) {
      selectedImplementor = 'codex';
      nextStatus = 'dual_winner_pending';
    } else {
      // Both failed (no timeouts). If failureCount is missing on both, fail closed —
      // we have no signal to choose a winner.
      if (g.failureCount == null && c.failureCount == null) {
        next.dualImpl = {
          ...(phaseState.dualImpl as any),
          geminiTestResult: g,
          codexTestResult: c,
        };
        next.status = 'failed';
        next.error = 'Both dual-impl test runs failed and failureCount is missing on both — cannot select winner';
        return next;
      }
      const gFails = g.failureCount ?? Number.MAX_SAFE_INTEGER;
      const cFails = c.failureCount ?? Number.MAX_SAFE_INTEGER;
      // Ties (cFails === gFails) intentionally pick gemini — documented preference.
      selectedImplementor = cFails < gFails ? 'codex' : 'gemini';
      nextStatus = 'dual_winner_pending';
    }

    next.dualImpl = {
      ...(phaseState.dualImpl as any),
      geminiTestResult: g,
      codexTestResult: c,
      ...(selectedImplementor && { selectedImplementor, selectedBy: 'auto' as const }),
    };
    next.status = nextStatus;
    return next;
  }

  if (action.type === 'RUN_JUDGE') {
    if (result.timedOut || result.exitCode !== 0) {
      next.status = 'failed';
      next.error = `Judge failed: exit ${result.exitCode}`;
      return next;
    }
    const verdict = extra?.judgeVerdict;
    if (!verdict) {
      next.status = 'failed';
      next.error = 'RUN_JUDGE requires judgeVerdict in extra';
      return next;
    }
    next.dualImpl = {
      ...(phaseState.dualImpl as any),
      judgeVerdict: verdict,
      judgeReasoning: extra?.judgeReasoning,
      judgeHardeningNotes: extra?.judgeHardeningNotes,
      judgeLogPath: result.logPath,
      selectedImplementor: verdict,
      selectedBy: 'judge',
    };
    next.status = 'dual_winner_pending';
    return next;
  }

  if (action.type === 'APPLY_WINNER') {
    // The CLI runs applyWinner() + teardownWorktrees() before calling this.
    // We just transition state — the cherry-pick + teardown have happened.
    next.dualImpl = {
      ...(phaseState.dualImpl as any),
      worktreesTornDownAt: new Date().toISOString(),
    };
    next.status = 'impl_done';
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
    status: 'committed',
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
    if (phaseStates[i].status !== 'committed') return i;
  }
  return -1;
}
