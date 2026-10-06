import * as fs from 'fs';
import * as path from 'path';
import type { AgentSdkResult, QueryProvider } from './agent-sdk-runner';
import type { OverlayFixture } from '../fixtures/overlay-nudges';
import { assertSuccessfulExecution, assessComparison } from './overlay-measurement';
import { assertWorkspaceChanges, snapshotWorkspace } from './overlay-workspace';

export interface OverlayTrialOutcome {
  /** Successful execution and a valid measurement, not an efficacy verdict. */
  passed: boolean;
  taskCorrect: boolean;
  metric?: number;
  /** Contract v4: a completed answer that failed the fixture's output check. */
  answerError?: string;
  result?: AgentSdkResult;
  error?: string;
  exitReason: string;
  before?: Record<string, string>;
  after?: Record<string, string>;
}

/** Setup → native terminal → scoped validation → one record → caller cleanup. */
export async function runOverlayTrial(options: {
  fixture: OverlayFixture;
  directory: string;
  invoke: () => Promise<AgentSdkResult>;
  record: (outcome: OverlayTrialOutcome) => void;
  isActive?: () => boolean;
  deadlineAt?: number;
}): Promise<OverlayTrialOutcome> {
  const { fixture, directory } = options;
  let result: AgentSdkResult | undefined;
  let before: Record<string, string> | undefined;
  let after: Record<string, string> | undefined;
  let metric: number | undefined;
  let outcome: OverlayTrialOutcome;
  let phase: 'setup' | 'runner' | 'validation' = 'setup';
  const checkActive = () => {
    if (options.isActive?.() === false || (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt)) {
      throw Object.assign(new Error('overlay case work deadline expired'), { name: 'OverlayDeadlineError' });
    }
  };
  try {
    checkActive();
    fixture.setupWorkspace(directory);
    before = snapshotWorkspace(directory);
    phase = 'runner';
    checkActive();
    result = await options.invoke();
    checkActive();
    phase = 'validation';
    assertSuccessfulExecution(result);
    after = snapshotWorkspace(directory);
    assertWorkspaceChanges(before, after, fixture.allowedChanges ?? []);
    checkActive();
    metric = fixture.metric(result, directory, options.deadlineAt);
    checkActive();
    if (!Number.isFinite(metric) || (fixture.comparison && (metric < fixture.comparison.minimum ||
      (fixture.comparison.maximum !== undefined && metric > fixture.comparison.maximum)))) {
      throw new Error(`invalid fixture metric: ${metric}`);
    }
    let answerError: string | undefined;
    try { fixture.verify?.(result, directory, metric); }
    catch (error) { answerError = error instanceof Error ? `${error.name}: ${error.message}` : String(error); }
    checkActive();
    // Implementation oracles execute agent-written code. Their side effects
    // must obey the same scope contract and appear in the retained snapshot.
    after = snapshotWorkspace(directory);
    assertWorkspaceChanges(before, after, fixture.allowedChanges ?? []);
    // Contract v4: a wrong completed answer is a measured correctness result in
    // either arm, not an invalid measurement.
    outcome = {
      passed: true, taskCorrect: !answerError && (fixture.taskCorrect?.(metric) ?? true),
      metric, result, exitReason: result.exitReason, before, after, ...(answerError ? { answerError } : {}),
    };
  } catch (error) {
    // Capture post-failure files when possible; preserve the first failure if
    // the workspace is absent or evidence capture itself cannot complete.
    if (options.isActive?.() !== false) {
      try { after = snapshotWorkspace(directory); } catch { /* original cause below */ }
    }
    outcome = {
      passed: false, taskCorrect: false, metric, result, before, after,
      exitReason: error instanceof Error && error.name === 'OverlayDeadlineError' ? 'timeout'
        : result && result.exitReason !== 'success' ? result.exitReason
        : error instanceof Error && error.name === 'RateLimitExhaustedError' ? 'rate_limit_exhausted'
        : phase === 'validation' ? 'validation_failed' : 'harness_error',
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
  // A recording failure is a harness failure; do not catch and record twice.
  options.record(outcome);
  return outcome;
}

/** All workers settle before a retry can start or temporary evidence is removed. */
export async function awaitOverlayWorkers(workers: Promise<void>[]): Promise<void> {
  const settled = await Promise.allSettled(workers);
  const errors = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
  if (errors.length) throw new AggregateError(errors, 'overlay workers failed');
}

export function assessOverlayArms(fixture: OverlayFixture, overlay: OverlayTrialOutcome[], off: OverlayTrialOutcome[]) {
  if (!fixture.comparison) throw new Error(`fixture ${fixture.id}: missing comparison specification`);
  const metrics = {
    overlay: overlay.filter((trial) => trial?.passed).map((trial) => trial.metric!),
    off: off.filter((trial) => trial?.passed).map((trial) => trial.metric!),
  };
  const comparison = assessComparison(metrics, fixture.trials, fixture.comparison, fixture.pass);
  // Only execution, scope and metric failures invalidate a trial, in both arms.
  const measurementsValid = comparison.status !== 'incomplete' && [overlay, off].every((arm) =>
    arm.length === fixture.trials && Array.from(arm).every((trial) => trial?.passed));
  // Task correctness is a measured result in both arms (OFF may score 0..3 or
  // answer wrongly); only ON correctness gates the case.
  const correctnessPassed = measurementsValid && overlay.every((trial) => trial.taskCorrect);
  // A fixture with a gate also blocks on its comparison (dedicated tools: 20%
  // fewer Bash calls, or none at a zero baseline). Without a gate the
  // comparison verdict stays research evidence.
  const gatePassed = measurementsValid && (fixture.gate?.(metrics) ?? true);
  return { metrics, comparison, measurementsValid, correctnessPassed, gatePassed, passed: correctnessPassed && gatePassed };
}

/** Preserve each SDK retry stream, including events emitted before an exception. */
export function captureOverlayQueryAttempts(directory: string, stem: string, provider: QueryProvider): QueryProvider {
  if (!/^[a-z0-9-]+$/.test(stem)) throw new Error('invalid overlay query artifact stem');
  let attempt = 0;
  return (options) => {
    const nativeAttempt = ++attempt;
    fs.mkdirSync(directory, { recursive: true });
    const raw = path.join(directory, `${stem}-sdk-attempt-${nativeAttempt}.jsonl`);
    const metadata = path.join(directory, `${stem}-sdk-attempt-${nativeAttempt}.json`);
    fs.writeFileSync(raw, '', { flag: 'wx' });
    let streamCompleted = false;
    let error: string | undefined;
    let query: ReturnType<QueryProvider>;
    const finish = () => fs.writeFileSync(metadata, JSON.stringify({ nativeAttempt, streamCompleted, error }) + '\n', { flag: 'wx' });
    try { query = provider(options); }
    catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      finish();
      throw cause;
    }
    return new Proxy(query, {
      get(target, property, receiver) {
        if (property !== Symbol.asyncIterator) {
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return async function* () {
          try {
            for await (const event of target) {
              fs.appendFileSync(raw, JSON.stringify(event) + '\n');
              yield event;
            }
            streamCompleted = true;
          } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
            throw cause;
          } finally { finish(); }
        };
      },
    });
  };
}
