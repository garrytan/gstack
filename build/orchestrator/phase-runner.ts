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

import type { PhaseState, Phase } from './types';
import type { SubAgentResult, Verdict } from './sub-agents';
import { parseVerdict } from './sub-agents';

/** Maximum recursive Codex review iterations before giving up. */
export const DEFAULT_MAX_CODEX_ITERATIONS =
  Number(process.env.GSTACK_BUILD_CODEX_MAX_ITER) || 5;

export type Action =
  | { type: 'RUN_GEMINI'; phaseIndex: number; iteration: number }
  | { type: 'RUN_CODEX_REVIEW'; phaseIndex: number; iteration: number }
  | { type: 'MARK_COMPLETE'; phaseIndex: number }
  | { type: 'FAIL'; phaseIndex: number; reason: string }
  | { type: 'DONE'; phaseIndex: number };

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
  maxCodexIterations: number = DEFAULT_MAX_CODEX_ITERATIONS
): Action {
  switch (phaseState.status) {
    case 'pending':
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

    case 'gemini_done':
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
 * Apply a sub-agent result to the phase state. Returns a NEW PhaseState
 * (does not mutate the input).
 */
export function applyResult(
  phaseState: PhaseState,
  action: Action,
  result: SubAgentResult
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
    next.status = 'gemini_done';
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
 * view) so it can see in-progress states like `gemini_done`.
 */
export function findNextPhaseIndex(phaseStates: PhaseState[]): number {
  for (let i = 0; i < phaseStates.length; i++) {
    if (phaseStates[i].status !== 'committed') return i;
  }
  return -1;
}
