/** Record complete office-hours attempts only after their existing oracle settles. */
import { recordE2E } from './e2e-helpers';
import type { EvalCollector, EvalTestEntry } from './eval-store';
import type { SkillTestResult } from './session-runner';
import { CAPTURE_LONG_MS } from './eval-budgets';

export const OFFICE_HOURS_RECORD_GRACE_MS = 5_000;
export const OFFICE_HOURS_BUN_GRACE_MS = 10_000;
class OfficeHoursDeadline extends Error {}

export interface OfficeHoursAttemptOptions {
  collector: EvalCollector | null;
  name: string;
  suite: string;
  model: string;
  budgetMs?: number;
  /** Deferred judge metadata; terminal pass/failure stays owned by this attempt. */
  judgeMetadata?: Pick<EvalTestEntry, 'judge_scores' | 'judge_reasoning'>;
  run: (signal: AbortSignal) => Promise<SkillTestResult>;
  validate: (result: SkillTestResult, signal: AbortSignal) => void | Promise<void>;
}

export async function runRecordedOfficeHoursAttempt(opts: OfficeHoursAttemptOptions): Promise<SkillTestResult> {
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? CAPTURE_LONG_MS;
  const deadlineAt = started + budgetMs;
  const controller = new AbortController();
  let result: SkillTestResult | undefined;
  let passed = false;
  let recorded = false;
  let failure: unknown;
  let deadlineTimer: ReturnType<typeof setTimeout>;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const expire = () => {
    if (!controller.signal.aborted) controller.abort(new OfficeHoursDeadline(`${opts.name} attempt exceeded ${budgetMs}ms`));
    return controller.signal.reason;
  };
  const checkDeadline = () => {
    if (Date.now() >= deadlineAt) expire();
    controller.signal.throwIfAborted();
  };
  // Arm before calling the runner so its synchronous entry/setup counts too.
  const timedOut = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => reject(expire()), Math.max(0, deadlineAt - Date.now()));
  });
  const work = (async () => {
    checkDeadline();
    const captured = await opts.run(controller.signal);
    if (!recorded) result = captured; // Keep bounded cleanup's usage, ignore later completions.
    checkDeadline(); // Never launch a judge or fixture validation after expiry.
    await opts.validate(captured, controller.signal);
    checkDeadline();
    passed = true;
    return captured;
  })();
  try {
    return await Promise.race([work, timedOut]);
  } catch (error) {
    failure = error;
    controller.abort(error);
    if (error instanceof OfficeHoursDeadline) {
      // Give cancellation a bounded chance to return transcript/usage. A
      // non-cooperative runner/judge cannot postpone the terminal record.
      await Promise.race([
        work.catch(() => {}),
        new Promise<void>(resolve => {
          drainTimer = setTimeout(resolve, Math.max(0, deadlineAt + OFFICE_HOURS_RECORD_GRACE_MS - Date.now()));
        }),
      ]);
    }
    throw error;
  } finally {
    clearTimeout(deadlineTimer!);
    clearTimeout(drainTimer);
    controller.abort(); // Cancellation always precedes recording/finalization.
    recorded = true;
    const error = passed ? undefined : failure instanceof Error ? failure.message : String(failure);
    const timedOut = failure instanceof OfficeHoursDeadline;
    if (result) {
      // Keep runner exit reasons and all existing usage/transcript diagnostics.
      // A successful process can still fail the fixture or posture assertions.
      recordE2E(opts.collector, opts.name, opts.suite, result, {
        ...opts.judgeMetadata,
        passed, ...(passed ? {} : { error }),
        ...(timedOut ? {
          // Preserve genuine process failures even if pipe cleanup met the deadline.
          exit_reason: ['success', 'error_max_turns'].includes(result.exitReason) ? 'timeout' : result.exitReason,
          duration_ms: Date.now() - started,
        } : {}),
      });
    } else {
      // No result means usage is unavailable; zero is not a billing claim.
      opts.collector?.addTest({
        name: opts.name,
        suite: opts.suite,
        tier: 'e2e',
        passed: false,
        duration_ms: Date.now() - started,
        cost_usd: 0,
        model: opts.model,
        exit_reason: timedOut ? 'timeout' : 'harness_error',
        error: `${error}\nRunner returned no result; cost and usage unavailable.`,
      });
    }
  }
}
