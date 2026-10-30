/**
 * GST-101: the /ship budget projection is calibrated from the run's own meter
 * (the prior only until the first measurement), the tail reserve scales with
 * it, a dispatch's reservation settles when its reviewer returns, and each
 * measured reservation prints its projected and actual cost. The replays use
 * the numbers measured on GSTA-2 (gstack-evals #35/#36, 1.91.319.0) and on
 * GSTA-152 PR B (#3596, run ship-20261029T083816-a4cc20; handoffs/token-efficiency/
 * ship-budget-projection-GSTA-152-prb.md in the GStack Minder drive).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { loadCalibration, measureSettled, settleIn, SHIP_STEPS, unitConstants } from '../lib/ship-budget';
import { budgetHarness, type Harness } from './helpers/ship-budget-harness';

const cal = loadCalibration();
const K = unitConstants(cal, 'capy-tokens');
const harnesses: Harness[] = [];
const fresh = () => { const h = budgetHarness(); harnesses.push(h); return h; };
afterEach(() => { while (harnesses.length) harnesses.pop()!.cleanup(); });

function started(h: Harness, cap: string) {
  const r = h.sb(['start', '--record', h.record(), '--token-cap', cap, '--reading', '0']);
  expect(r.code).toBe(0);
  return { run: h.field(r.out, 'BUDGET_RUN', 'id'), ledger: h.field(r.out, 'BUDGET_RUN', 'ledger') };
}
const finishRow = () => JSON.stringify({ skill: 'review', timestamp: new Date().toISOString(), status: 'clean', issues_found: 0, critical: 0, informational: 0 });

/** GSTA-2: about 0.27M per step on Steps 1-5 (1.35M), 165-200k per call; the prior projected 2.25M per step plus a 4.48M reserve. */
const GSTA2_STEP = 270_000;
const GSTA2_STOP = 4 * 200_000;
/** GSTA-152 PR B pass 2, one reviewer at a time on a 127-line fix range (counter delta per dispatch). */
const PASS2: Array<[string, number]> = [
  ['specialist', 373_254], ['specialist', 511_454], ['specialist', 364_113], ['specialist', 362_494],
  ['specialist', 366_058], ['specialist', 234_661], ['red-team', 1_016_168],
];
const PASS3: Array<[string, number]> = [['red-team', 1_049_900], ['fix-check', 368_801]];
/** One parent call late in GSTA-152 (376-384k), and #26's measured stop overhead. */
const PARENT_CALL = 380_000;
const LEAN_DISPATCH = 500_000;
const STOP_26 = 1_650_000;

describe('projection calibrated from the run\'s own meter (GST-101)', () => {
  test('GSTA-2 replay: an 8M cap admits Steps 6 and 6.5 after Steps 1-5 cost 0.27M each, and stops with room to stop', () => {
    const h = fresh();
    const cap = 8_000_000;
    const s = started(h, '8M');
    const steps = SHIP_STEPS.slice(SHIP_STEPS.indexOf('1'));
    let reading = 0;
    const admitted: string[] = [];
    let stop = '';
    for (let i = 0; i + 1 < steps.length; i++) {
      const calls = cal.step_calls[steps[i]!] ?? cal.step_calls.default!;
      reading += Math.round((GSTA2_STEP / 3) * calls * (1 + 0.05 * i)) + (cal.step_dispatches[steps[i]!] ?? 0) * LEAN_DISPATCH;
      expect(reading, `spend after Step ${steps[i]}`).toBeLessThanOrEqual(cap);
      const c = h.sb(['check', '--run', s.run, '--step', steps[i]!, '--next', steps[i + 1]!, '--reading', String(reading)]);
      if (c.code === 3) { stop = c.out; break; }
      expect(c.code).toBe(0);
      admitted.push(steps[i + 1]!);
      if (steps[i + 1] === '6') expect(Number(h.field(c.out, 'BUDGET', 'projected'))).toBeLessThan(1_000_000);
    }
    expect(admitted).toEqual(['2', '3', '4', '5', '6', '6.5']);
    expect(stop).toContain('STOP: reason=budget_exhausted');
    expect(reading + GSTA2_STOP).toBeLessThanOrEqual(cap);
  });

  test('GSTA-152 PR B replay: per-dispatch admission never holds returned reviewers, the 29.28M refusal is admitted, and the run stops before the cap', () => {
    const h = fresh();
    const cap = 29_280_000;
    const s = started(h, '29.28M');
    let reading = 0;
    const steps = SHIP_STEPS.slice(SHIP_STEPS.indexOf('1'), SHIP_STEPS.indexOf('9') + 1);
    for (let i = 0; i + 1 < steps.length; i++) {
      reading += 750_000;
      expect(h.sb(['check', '--run', s.run, '--step', steps[i]!, '--next', steps[i + 1]!, '--reading', String(reading)]).code).toBe(0);
    }
    let previous = '';
    const dispatch = (role: string) => {
      reading += PARENT_CALL;
      const c = h.sb(['check', '--run', s.run, '--step', '9', '--next', `dispatch:${role}`, '--reading', String(reading), ...(previous ? ['--returned', previous] : [])]);
      return c;
    };
    for (const [role, cost] of [...PASS2, ...PASS3]) {
      const c = dispatch(role);
      expect(c.code, c.out + c.err).toBe(0);
      previous = h.field(c.out, 'RESERVATION', 'id');
      expect(h.reviewLog(['--start', 'review', '--reservation', previous]).code).toBe(0);
      reading += cost;
    }
    const lean = h.ledger(s.ledger).reservations.filter((r: any) => r.kind === 'dispatch' && r.actual !== undefined);
    expect(lean.length).toBe(PASS2.length + PASS3.length - 1);
    const settled = h.sb(['settle', '--run', s.run, '--reservation', previous, '--reading', String(reading)]);
    expect(settled.out).toMatch(/^DRIFT: id=\S+ kind=dispatch next=dispatch:fix-check projected=\d+ actual=368801 ratio=\d+\.\d\d$/m);
    reading = 17_790_000;
    previous = '';
    const fixCheck = dispatch('fix-check');
    expect(fixCheck.code, fixCheck.out).toBe(0);
    const projected = Number(h.field(fixCheck.out, 'BUDGET', 'projected'));
    expect(projected).toBeLessThan(K.per_dispatch / 3);
    expect(projected).toBeGreaterThanOrEqual(1_049_900);
    previous = h.field(fixCheck.out, 'RESERVATION', 'id');
    expect(h.reviewLog(['--start', 'review-fix-check', '--reservation', previous]).code).toBe(0);
    reading += 368_801;
    let parent = PARENT_CALL;
    let stop = '';
    for (let round = 0; round < 40 && !stop; round++) {
      parent += 50_000;
      reading += parent;
      const c = h.sb(['check', '--run', s.run, '--step', '9', '--next', 'dispatch:fix-check', '--reading', String(reading), '--returned', previous]);
      if (c.code === 3) { stop = c.out; break; }
      previous = h.field(c.out, 'RESERVATION', 'id');
      expect(h.reviewLog(['--start', 'review-fix-check', '--reservation', previous]).code).toBe(0);
      reading += 368_801;
      expect(reading).toBeLessThanOrEqual(cap);
    }
    expect(stop).toContain('STOP: reason=budget_exhausted');
    expect(reading + STOP_26).toBeLessThanOrEqual(cap);
  }, 120_000);

  test('the prior holds until the first measurement; the tail reserve scales with the measured step cost', () => {
    const h = fresh();
    const s = started(h, '100M');
    const first = h.sb(['check', '--run', s.run, '--step', '1', '--next', '2', '--reading', '0']);
    expect(Number(h.field(first.out, 'BUDGET', 'projected'))).toBe(3 * K.per_call);
    expect(Number(h.field(first.out, 'BUDGET', 'tail'))).toBe(2_000_000 + K.stop_overhead);
    expect(h.field(first.out, 'BUDGET', 'calibration')).toBe('step:prior,dispatch:prior');
    const second = h.sb(['check', '--run', s.run, '--step', '2', '--next', '3', '--reading', '450000']);
    const factor = (450_000 / (3 * K.per_call)) * cal.headroom;
    expect(Number(h.field(second.out, 'BUDGET', 'projected'))).toBe(Math.ceil((3 * K.per_call * factor) / cal.round_to) * cal.round_to);
    expect(Number(h.field(second.out, 'BUDGET', 'tail'))).toBe(Math.ceil((2_000_000 * factor) / cal.round_to) * cal.round_to + K.stop_overhead);
    expect(second.out).toMatch(/^DRIFT: id=\S+ kind=step next=2 projected=2250000 actual=450000 ratio=0\.20$/m);
    const d = h.sb(['check', '--run', s.run, '--step', '3', '--next', 'dispatch:specialist,red-team', '--reading', '900000']);
    expect(Number(h.field(d.out, 'BUDGET', 'projected'))).toBe(2 * K.per_dispatch);
  });

  test('an explicit --reserve is kept as given, and the stop overhead keeps its calibrated fit', () => {
    const h = fresh();
    const r = h.sb(['start', '--record', h.record(), '--token-cap', '100M', '--reading', '0', '--reserve', '3M']);
    const run = h.field(r.out, 'BUDGET_RUN', 'id');
    h.sb(['check', '--run', run, '--step', '1', '--next', '2', '--reading', '450000']);
    const c = h.sb(['check', '--run', run, '--step', '2', '--next', '3', '--reading', '900000']);
    expect(h.field(c.out, 'BUDGET', 'calibration')).not.toStartWith('step:prior');
    expect(Number(h.field(c.out, 'BUDGET', 'tail'))).toBe(3_000_000 + K.stop_overhead);
  });
});

describe('dispatch reservations settle when the reviewer returns (GST-101)', () => {
  test('check --returned settles a consumed reservation, so the next per-dispatch admission is not blocked by it', () => {
    const h = fresh();
    const s = started(h, '20M');
    const a = h.sb(['check', '--run', s.run, '--step', '9', '--next', 'dispatch:specialist', '--reading', '0']);
    const first = h.field(a.out, 'RESERVATION', 'id');
    expect(h.reviewLog(['--start', 'review', '--reservation', first]).code).toBe(0);
    const b = h.sb(['check', '--run', s.run, '--step', '9', '--next', 'dispatch:specialist', '--reading', '400000', '--returned', first]);
    expect(b.code, b.out + b.err).toBe(0);
    expect(h.field(b.out, 'BUDGET', 'reserved')).toBe('0');
    expect(h.ledger(s.ledger).reservations.find((r: any) => r.id === first)).toMatchObject({ state: 'settled', actual: 400_000 });
    const bad = h.sb(['check', '--run', s.run, '--step', '9', '--next', 'dispatch:specialist', '--reading', '400000', '--returned', 'nope']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('--returned');
  });

  test('--finish settles every consumed dispatch reservation of the pass, and the next reading measures them as one group', () => {
    const h = fresh();
    const s = started(h, '80M');
    const tokens: string[] = [];
    let reading = 0;
    for (const role of ['specialist', 'specialist', 'red-team']) {
      const id = h.field(h.sb(['check', '--run', s.run, '--step', '9', '--next', `dispatch:${role}`, '--reading', String(reading)]).out, 'RESERVATION', 'id');
      const st = h.reviewLog(['--start', 'review', '--reservation', id]);
      expect(st.code).toBe(0);
      tokens.push(st.out.trim());
      reading += 500_000;
    }
    expect(h.reviewLog([finishRow(), '--finish', tokens[0]!]).code).toBe(0);
    const dispatches = () => h.ledger(s.ledger).reservations.filter((r: any) => r.kind === 'dispatch');
    expect(dispatches().map((r: any) => r.state)).toEqual(['settled', 'settled', 'settled']);
    const next = h.sb(['check', '--run', s.run, '--step', '9', '--next', '10', '--reading', String(reading)]);
    expect(h.field(next.out, 'BUDGET', 'reserved')).toBe('0');
    expect(dispatches().map((r: any) => r.actual)).toEqual([500_000, 500_000, 500_000]);
  });

  test('moving to the next step settles dispatch reservations a reviewer consumed in the step before', () => {
    const h = fresh();
    const s = started(h, '80M');
    const id = h.field(h.sb(['check', '--run', s.run, '--step', '11', '--next', 'dispatch:outside-voice', '--reading', '0']).out, 'RESERVATION', 'id');
    expect(h.reviewLog(['--start', 'adversarial-review', '--reservation', id]).code).toBe(0);
    const c = h.sb(['check', '--run', s.run, '--step', '11', '--next', '11.5', '--reading', '600000']);
    expect(c.code).toBe(0);
    expect(h.ledger(s.ledger).reservations.find((r: any) => r.id === id)).toMatchObject({ state: 'settled', actual: 600_000 });
  });

  test('close prints projected against actual for the run', () => {
    const h = fresh();
    const s = started(h, '80M');
    h.sb(['check', '--run', s.run, '--step', '1', '--next', '2', '--reading', '300000']);
    const close = h.sb(['close', '--run', s.run, '--reading', '700000']);
    expect(close.code).toBe(0);
    expect(close.out).toMatch(/^BUDGET_DRIFT: steps=2 step_projected=\d+ step_actual=700000 dispatches=0 dispatch_projected=0 dispatch_actual=0$/m);
  });
});

describe('the gate fixes from /ship review (GST-101)', () => {
  test('a dispatch settled --unknown is never measured, so the dispatch factor stays at the prior', () => {
    const h = fresh();
    const s = started(h, '40M');
    const id = h.field(h.sb(['check', '--run', s.run, '--step', '11', '--next', 'dispatch:outside-voice', '--reading', '0']).out, 'RESERVATION', 'id');
    expect(h.reviewLog(['--start', 'adversarial-review', '--reservation', id]).code).toBe(0);
    const settled = h.sb(['settle', '--run', s.run, '--reservation', id, '--unknown', '--reading', '100000']);
    expect(settled.code, settled.out + settled.err).toBe(0);
    expect(settled.out).not.toContain('DRIFT:');
    const next = h.sb(['check', '--run', s.run, '--step', '11', '--next', 'dispatch:outside-voice', '--reading', '200000']);
    expect(h.field(next.out, 'BUDGET', 'calibration')).toEndWith('dispatch:prior');
    expect(Number(h.field(next.out, 'BUDGET', 'projected'))).toBe(K.per_dispatch);
    expect(Number(h.field(next.out, 'BUDGET', 'unknown'))).toBe(K.per_dispatch);
  });

  test('a Claude-metered outside voice is booked unknown and never measured', () => {
    const r = { id: 'r1', kind: 'dispatch', step: '11', next: 'dispatch:outside-voice', roles: ['outside-voice'], tokens: K.per_dispatch, at: '', state: 'consumed', reading_at: 0, epoch: 1 };
    const l: any = { meter: { contract: { meter: 'claude' }, epoch: 1, last: 100_000 }, reservations: [r], unknown: 0, samples: [] };
    settleIn(l, r as any);
    expect(l.unknown).toBe(K.per_dispatch);
    expect(measureSettled(l)).toEqual([]);
    expect(l.samples).toEqual([]);
  });

  test('a calibrated delegate verdict is one the handoff admits: both hold back the same reserve', () => {
    const h = fresh();
    const cap = 12_000_000;
    const s = started(h, '12M');
    const sb = (args: string[]) => { const c = h.sb(['check', '--run', s.run, ...args]); expect(c.code, c.out + c.err).toBe(0); return c; };
    for (const [i, step] of ['1', '2', '3'].entries()) sb(['--step', step, '--next', String(i + 2), '--reading', String(300_000 * (i + 1)), '--prior-reading', String(300_000 * i + 200_000)]);
    const d = h.field(sb(['--step', '4', '--next', 'dispatch:specialist', '--reading', '1200000', '--prior-reading', '1100000']).out, 'RESERVATION', 'id');
    expect(h.reviewLog(['--start', 'review', '--reservation', d]).code).toBe(0);
    const c = sb(['--step', '4', '--next', '12', '--reading', '8000000', '--returned', d]);
    expect(h.field(c.out, 'BUDGET', 'verdict')).toBe('delegate');
    const tail = Number(h.field(c.out, 'BUDGET', 'tail'));
    expect(cap - 8_000_000).toBeLessThan(2_000_000 + K.stop_overhead);
    const ho = h.sb(['handoff', '--run', s.run, '--from', '12', '--to', '22', '--base', 'origin/main', '--reading', '8000000']);
    expect(ho.code, ho.out + ho.err).toBe(0);
    expect(Number(ho.out.match(/^HANDOFF: \S+ sha256=\S+ sub_cap=(\d+)$/m)![1])).toBe(cap - 8_000_000 - tail);
  });
});
