import type { OverlayFixture } from '../fixtures/overlay-nudges';
import { assessOverlayArms, type OverlayTrialOutcome } from './overlay-attempt';
import { OVERLAY_CONTRACT, OVERLAY_CASE_WORK_MS, OVERLAY_RECORD_GRACE_MS } from './overlay-case-policy';

export type OverlayArm = 'overlay-on' | 'overlay-off';
export class OverlayDeadlineError extends Error {
  constructor() { super('overlay case work deadline expired'); this.name = 'OverlayDeadlineError'; }
}
interface StartedTrial { arm: OverlayArm; index: number; outcome?: OverlayTrialOutcome }
export interface OverlayCaseSummary {
  contract: typeof OVERLAY_CONTRACT;
  passed: boolean;
  timedOut: boolean;
  cleanupIncomplete: boolean;
  plannedTrials: number;
  startedTrials: number;
  errors: string[];
  assessment: ReturnType<typeof assessOverlayArms>;
}

/**
 * admit trial → run/validate → record once
 * work deadline → close admission + abort → record unfinished trials
 * → settle workers → clean workspaces (one shared grace ≤5s)
 * → one aggregate. Late providers cannot validate, record, or start more work.
 */
export async function runOverlayCaseLifecycle(options: {
  fixture: OverlayFixture;
  execute: (arm: OverlayArm, index: number, signal: AbortSignal, active: () => boolean, deadlineAt: number) => Promise<OverlayTrialOutcome>;
  recordTrial: (arm: OverlayArm, index: number, outcome: OverlayTrialOutcome) => void;
  recordAggregate: (summary: OverlayCaseSummary) => void;
  cleanup: () => Promise<void>;
  workMs?: number;
  graceMs?: number;
}): Promise<OverlayCaseSummary> {
  const workMs = options.workMs ?? OVERLAY_CASE_WORK_MS;
  const graceMs = options.graceMs ?? OVERLAY_RECORD_GRACE_MS;
  if (![workMs, graceMs].every(n => Number.isFinite(n) && n >= 0)) throw new Error('overlay budgets must be finite and nonnegative');
  const deadlineAt = Date.now() + workMs;
  const controller = new AbortController();
  const started: StartedTrial[] = [];
  const errors: string[] = [];
  let finalized = false;
  let timedOut = false;
  const active = () => !finalized && Date.now() < deadlineAt;
  const record = (trial: StartedTrial, outcome: OverlayTrialOutcome) => {
    if (trial.outcome) return;
    trial.outcome = outcome; // reserve before the callback; failures never retry a record
    try { options.recordTrial(trial.arm, trial.index, outcome); }
    catch (cause) { errors.push(`trial record failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
  };
  const deadlineOutcome = (): OverlayTrialOutcome => ({ passed: false, taskCorrect: false, exitReason: 'timeout', error: new OverlayDeadlineError().message });
  let expire!: () => void;
  const expired = new Promise<void>(resolve => {
    expire = () => {
      if (finalized) return;
      timedOut = true;
      finalized = true;
      controller.abort(new OverlayDeadlineError());
      for (const trial of started) if (!trial.outcome) record(trial, deadlineOutcome());
      resolve();
    };
  });
  const timer = setTimeout(expire, workMs);
  const workers = (['overlay-on', 'overlay-off'] as const).flatMap(arm => {
    let next = 0;
    return Array.from({ length: options.fixture.concurrency ?? 3 }, async () => {
      while (active()) {
        const index = next++;
        if (index >= options.fixture.trials) return;
        const trial: StartedTrial = { arm, index };
        started.push(trial);
        let outcome: OverlayTrialOutcome;
        try { outcome = await options.execute(arm, index, controller.signal, active, deadlineAt); }
        catch (cause) { outcome = { passed: false, taskCorrect: false, exitReason: 'harness_error', error: cause instanceof Error ? cause.message : String(cause) }; }
        if (!active()) { expire(); return; }
        record(trial, outcome);
      }
    });
  });
  const allWorkers = Promise.allSettled(workers);
  try {
    await Promise.race([allWorkers, expired]);
    if (Date.now() >= deadlineAt && !finalized) expire();
    finalized = true;
    controller.abort(new Error('overlay case finalized'));
    clearTimeout(timer);
    // Finish worker writes before deleting their directories, within one grace.
    let cleanupError: unknown;
    const graceDeadlineAt = (timedOut ? deadlineAt : Date.now()) + graceMs;
    const graceRemaining = Math.max(0, graceDeadlineAt - Date.now());
    let graceClosed = false;
    const cleanup = allWorkers.then(async () => {
      // A worker settling after the aggregate must not start late filesystem work.
      if (graceClosed || Date.now() >= graceDeadlineAt) return false;
      try { await options.cleanup(); }
      catch (cause) { cleanupError = cause; }
      return true;
    });
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      cleanup,
      new Promise<false>(resolve => { graceTimer = setTimeout(() => { graceClosed = true; resolve(false); }, graceRemaining); }),
    ]);
    graceClosed = true;
    if (graceTimer) clearTimeout(graceTimer);
    if (cleanupError) errors.push(`cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    if (!drained) errors.push('overlay workers or cleanup did not settle within recording grace');
    const outcomes = (arm: OverlayArm) => started.filter(trial => trial.arm === arm).sort((a, b) => a.index - b.index).map(trial => trial.outcome!);
    const assessment = assessOverlayArms(options.fixture, outcomes('overlay-on'), outcomes('overlay-off'));
    const summary: OverlayCaseSummary = {
      contract: OVERLAY_CONTRACT,
      passed: !timedOut && drained && errors.length === 0 && assessment.passed,
      timedOut, cleanupIncomplete: !drained || !!cleanupError,
      plannedTrials: 2 * options.fixture.trials, startedTrials: started.length, errors, assessment,
    };
    options.recordAggregate(summary);
    return summary;
  } finally { finalized = true; clearTimeout(timer); controller.abort(new Error('overlay lifecycle closed')); }
}
