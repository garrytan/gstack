import { describe, expect, it } from 'vitest';
import {
  bandedIdeal,
  fromTable,
  higherIsBetter,
  logistic,
  lowerIsBetter,
  toScore100,
} from '@/domain/scoring/normalize';

describe('higherIsBetter', () => {
  it('maps the range endpoints to 0 and 1', () => {
    expect(higherIsBetter(0, 0, 10)).toBe(0);
    expect(higherIsBetter(10, 0, 10)).toBe(1);
    expect(higherIsBetter(5, 0, 10)).toBe(0.5);
  });

  it('clamps outside the range', () => {
    expect(higherIsBetter(-5, 0, 10)).toBe(0);
    expect(higherIsBetter(50, 0, 10)).toBe(1);
  });

  it('returns a neutral 0.5 for a degenerate range instead of dividing by zero', () => {
    expect(higherIsBetter(5, 5, 5)).toBe(0.5);
  });
});

describe('lowerIsBetter', () => {
  it('inverts the direction of goodness', () => {
    expect(lowerIsBetter(0, 0, 10)).toBe(1);
    expect(lowerIsBetter(10, 0, 10)).toBe(0);
    expect(lowerIsBetter(2.5, 0, 10)).toBe(0.75);
  });

  it('clamps beyond the worst case', () => {
    expect(lowerIsBetter(100, 0, 10)).toBe(0);
  });
});

describe('bandedIdeal', () => {
  it('peaks at the ideal', () => {
    expect(bandedIdeal(10, 10, 5)).toBe(1);
  });

  it('falls off symmetrically and floors at zero', () => {
    expect(bandedIdeal(12.5, 10, 5)).toBe(0.5);
    expect(bandedIdeal(7.5, 10, 5)).toBe(0.5);
    expect(bandedIdeal(30, 10, 5)).toBe(0);
  });

  it('degenerates to an exact match when tolerance is zero', () => {
    expect(bandedIdeal(10, 10, 0)).toBe(1);
    expect(bandedIdeal(11, 10, 0)).toBe(0);
  });
});

describe('logistic', () => {
  it('scores 0.5 at the midpoint', () => {
    expect(logistic(100, 100, 0.05)).toBeCloseTo(0.5, 6);
  });

  it('is monotonically increasing', () => {
    expect(logistic(50, 100, 0.05)).toBeLessThan(logistic(150, 100, 0.05));
  });
});

describe('fromTable', () => {
  it('reads a known label', () => {
    expect(fromTable<'a' | 'b'>('a', { a: 1, b: 0 })).toBe(1);
  });

  it('falls back for an unknown or missing label', () => {
    expect(fromTable(undefined, { a: 1 }, 0.3)).toBe(0.3);
  });
});

describe('toScore100', () => {
  it('scales a unit value onto the product scale', () => {
    expect(toScore100(0.734)).toBe(73.4);
    expect(toScore100(1)).toBe(100);
    expect(toScore100(0)).toBe(0);
  });
});
