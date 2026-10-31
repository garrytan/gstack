/**
 * GSTA-167 round 3: step priors were far too high. Step 8 was projected at
 * 16.43M (12 calls x the calibrated 750k per call + one 7.43M dispatch) and
 * cost 0.34M on gstack-evals #36 (ledger ship-20261030T020847-c940ef), and that
 * inflation is what blocks capped runs. On the Capy meter (the agent's own jam
 * counter) a step is priced at its calibrated call count times the run's own
 * median measured per-call charge (--prior-reading), once three calls are
 * measured; its dispatches are reserved by their own check, so a step prior
 * carries no dispatch.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { loadCalibration, stepProjection } from '../lib/ship-budget';
import { budgetHarness, type Harness } from './helpers/ship-budget-harness';

const cal = loadCalibration();
const stepCalls = (c: typeof cal, step: string) => c.step_calls[step] ?? c.step_calls.default ?? 0;
const harnesses: Harness[] = [];
const fresh = () => { const h = budgetHarness(); harnesses.push(h); return h; };
afterEach(() => { while (harnesses.length) harnesses.pop()!.cleanup(); });

describe('step priors from the run\'s own per-call charge', () => {
  // Value: protects=after three measured calls a step is priced at its calibrated calls x the run's median per-call charge, so #36's Step 8 no longer reserves 16.43M; fails_when=the step prior keeps the calibrated per_call (or a dispatch) after the run has measured its calls;
  //   why_new=no test fed per-call charges into a step projection; seam=none; no_claim=that the calibrated call counts fit every diff
  test('#36 replay: measured calls of 300k, 340k, 360k and 340k price Step 8 at its calls x their 340k median', () => {
    const h = fresh();
    const s = h.sb(['start', '--record', h.record(), '--token-cap', '40M', '--reading', '1300000', '--prior-reading', '1000000']);
    expect(s.code, s.out + s.err).toBe(0);
    const run = h.field(s.out, 'BUDGET_RUN', 'id');
    expect(h.field(s.out, 'BUDGET', 'projected')).toBe(String(stepProjection(cal, 'capy-tokens', '1')));
    const a = h.sb(['check', '--run', run, '--step', '3', '--next', '4', '--reading', '1640000', '--prior-reading', '1300000']);
    expect(h.field(a.out, 'BUDGET', 'call')).toBe('340000');
    const b = h.sb(['check', '--run', run, '--step', '6', '--next', '7', '--reading', '2000000', '--prior-reading', '1640000']);
    expect(b.code, b.out + b.err).toBe(0);
    const c = h.sb(['check', '--run', run, '--step', '7', '--next', '8', '--reading', '2440000', '--prior-reading', '2100000']);
    expect(c.code, c.out + c.err).toBe(0);
    expect(h.field(c.out, 'BUDGET', 'projected')).toBe(String(stepCalls(cal, '8') * 340_000));
    expect(h.field(c.out, 'BUDGET', 'calibration')).toEndWith(',call:340000');
    expect(Number(h.field(c.out, 'BUDGET', 'projected'))).toBeLessThan(5_000_000);
  });

  // Value: protects=a step prior holds only the step's own calls: the audits of Steps 7, 8 and 14.5 are reserved by their own dispatch check, and a child's segment estimate still counts them; fails_when=step_dispatches prices a dispatch into the step (double counted with its reservation) or the segment estimate drops it;
  //   why_new=no test separated the step prior from its dispatches; seam=none; no_claim=the audit always runs
  test('a step prior carries no dispatch; the segment estimate keeps the audits', () => {
    const k = cal.constants;
    for (const step of ['7', '8', '14.5']) {
      expect(stepProjection(cal, 'capy-tokens', step), step).toBe(stepCalls(cal, step) * k.per_call);
      expect(cal.segment_dispatches[step] ?? 0, step).toBeGreaterThanOrEqual(1);
    }
  });
});
