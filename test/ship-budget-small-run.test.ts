/**
 * GSTA-167 PR 4: a small run keeps its segment instead of delegating it. A child
 * costs a fixed 2-4.5M (boot, install check, verify-handoff, section reads,
 * reconcile; gstack-evals #34), so a light-depth diff whose segment costs less
 * than a child can save continues in the parent's context.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { CHILD_FIXED_COST, keepsSmallRun, loadCalibration, SMALL_RUN_LINES, SMALL_RUN_SEGMENT, smallRunSegment } from '../lib/ship-budget';
import { budgetHarness, type Harness } from './helpers/ship-budget-harness';

const cal = loadCalibration();
const harnesses: Harness[] = [];
const fresh = () => { const h = budgetHarness(); harnesses.push(h); return h; };
afterEach(() => { while (harnesses.length) harnesses.pop()!.cleanup(); });

describe('small-run rule', () => {
  // Value: protects=the threshold is the child's fixed cost over the share of a call a fresh child can save, so a segment under it never pays for a child; fails_when=the constants drift apart or the segment ignores this run's own per-call charge;
  //   why_new=no prior test prices a segment from the measured per-call charge; seam=none; no_claim=the #34 measurements themselves
  test('the segment threshold is derived from the child cost; the segment is its calibrated calls at this run\'s per-call charge', () => {
    expect(SMALL_RUN_SEGMENT).toBe(12_000_000);
    expect(SMALL_RUN_SEGMENT * 0.375).toBe(CHILD_FIXED_COST);
    const calls = ['7', '8', '9', '10', '11', '11.5'].reduce((n, s) => n + (cal.step_calls[s] ?? cal.step_calls.default!), 0);
    expect(smallRunSegment(cal, '7', '11.5', 200_000)).toBe(calls * 200_000);
    expect(smallRunSegment(cal, '7', '11.5', null)).toBe(calls * 250_000);
  });

  // Value: protects=only a light diff with a cheap segment keeps it, and a missing runtime count keeps today's delegation; fails_when=a large diff or a costly context stops delegating, or an unknown diff size is treated as small;
  //   why_new=keepsSmallRun is new; seam=none; no_claim=what the parent does after continuing
  test('keeps only a light diff whose segment is under the threshold; an unknown runtime count never keeps', () => {
    expect(keepsSmallRun(cal, { runtimeLines: 0, from: '7', to: '11.5', call: 220_000 })).toContain('SMALL_RUN: runtime_lines=0');
    expect(keepsSmallRun(cal, { runtimeLines: SMALL_RUN_LINES, from: '12', to: '22', call: 300_000 })).not.toBeNull();
    expect(keepsSmallRun(cal, { runtimeLines: SMALL_RUN_LINES + 1, from: '7', to: '11.5', call: 220_000 })).toBeNull();
    expect(keepsSmallRun(cal, { runtimeLines: 0, from: '7', to: '11.5', call: 400_000 })).toBeNull();
    expect(keepsSmallRun(cal, { runtimeLines: undefined, from: '7', to: '11.5', call: 220_000 })).toBeNull();
  });
});

describe('check --runtime-lines', () => {
  // Value: protects=the registered check command continues a small run at a segment boundary and still delegates a large one; fails_when=check ignores --runtime-lines or applies it to a large diff;
  //   why_new=the delegation tests never pass a diff size; seam=none; no_claim=the handoff itself
  test('a light diff continues at the 6->7 boundary with a SMALL_RUN line; a large diff and an omitted count still delegate', () => {
    const h = fresh();
    const start = (cap: string) => {
      const r = h.sb(['start', '--record', h.record(`r${cap}.md`), '--token-cap', cap, '--reading', '0', '--call-floor', '0']);
      return h.field(r.out, 'BUDGET_RUN', 'id');
    };
    const small = h.sb(['check', '--run', start('80M'), '--step', '8', '--next', '9', '--reading', '1220000', '--prior-reading', '1000000', '--runtime-lines', '0']);
    expect(small.code).toBe(0);
    expect(h.field(small.out, 'BUDGET', 'verdict')).toBe('continue');
    expect(small.out).toContain('SMALL_RUN: runtime_lines=0');
    expect(small.out).not.toContain('DELEGATE:');
    const large = h.sb(['check', '--run', start('81M'), '--step', '8', '--next', '9', '--reading', '1220000', '--prior-reading', '1000000', '--runtime-lines', '900']);
    expect(h.field(large.out, 'BUDGET', 'verdict')).toBe('delegate');
    const omitted = h.sb(['check', '--run', start('82M'), '--step', '8', '--next', '9', '--reading', '1220000', '--prior-reading', '1000000']);
    expect(h.field(omitted.out, 'BUDGET', 'verdict')).toBe('delegate');
    expect(h.sb(['check', '--run', start('83M'), '--step', '8', '--next', '9', '--reading', '5', '--runtime-lines', 'many']).code).toBe(2);
  });
});
