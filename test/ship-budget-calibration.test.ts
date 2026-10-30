/**
 * Calibration (GSTA-152 plan item 8): the committed constants are the
 * conservative fit of the recorded observations, and a fit on two metered runs
 * is at or above the meter on the third (leave-one-out) for every constant
 * three runs observed.
 */
import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { fitConstant, loadCalibration, unitConstants } from '../lib/ship-budget';

const cal = loadCalibration(path.join(import.meta.dir, '..', 'lib/ship-budget-calibration.json'));

describe('ship-budget calibration', () => {
  test('constants equal the conservative fit of their observations', () => {
    for (const [name, rows] of Object.entries(cal.observations)) {
      expect(cal.constants[name as keyof typeof cal.constants]).toBe(fitConstant(rows.map(r => r.value), cal.headroom, cal.round_to));
      for (const row of rows) expect(row.source.length).toBeGreaterThan(20);
    }
  });

  test('leave-one-out: fitted on two runs, the constant is at or above the meter on the third', () => {
    const covered = Object.entries(cal.observations).filter(([, rows]) => new Set(rows.map(r => r.run)).size >= 3);
    expect(covered.map(([name]) => name)).toContain('per_call');
    for (const [name, rows] of covered) {
      for (const held of rows) {
        const fit = fitConstant(rows.filter(r => r.run !== held.run).map(r => r.value), cal.headroom, cal.round_to);
        expect(fit, `${name} fitted without ${held.run}`).toBeGreaterThanOrEqual(held.value);
      }
    }
  });

  test('every meter unit has its own per-call floor: the largest round_to multiple at or below its observed fresh call, justified', () => {
    for (const unit of ['capy-tokens', 'claude-usage-tokens', 'estimate-tokens']) {
      const u = cal.units[unit]!;
      expect(u.call_floor_why?.length ?? 0, unit).toBeGreaterThan(80);
      const observed = u.call_floor_observed ?? 0;
      expect(u.call_floor, unit).toBe(Math.floor(observed / cal.round_to) * cal.round_to);
    }
  });

  test('every meter unit resolves to constants (calibration is per meter)', () => {
    for (const unit of ['capy-tokens', 'claude-usage-tokens', 'estimate-tokens']) {
      expect(unitConstants(cal, unit).per_dispatch).toBeGreaterThan(0);
    }
  });
});
