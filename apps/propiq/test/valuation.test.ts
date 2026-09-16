import { describe, expect, it } from 'vitest';
import {
  MIN_COMPARABLES,
  adjustComparable,
  comparableWeight,
  negotiationGuidance,
  valueProperty,
} from '@/domain/valuation/engine';
import type { Comparable } from '@/domain/valuation/types';
import { NOW, testProperty } from './support/factories';

const comp = (overrides: Partial<Comparable> = {}): Comparable => ({
  label: 'Comp',
  soldOrListedAt: '2026-05-01T00:00:00Z',
  isTransaction: true,
  carpetAreaSqFt: 1120,
  pricePerSqFt: 14_000,
  distanceKm: 1,
  dataStatus: 'verified',
  ...overrides,
});

const ctx = (comparables: Comparable[], drift = 7) => ({
  property: testProperty(),
  comparables,
  marketDriftPercentPerYear: drift,
  now: NOW,
});

describe('adjustComparable', () => {
  it('carries an older comparable forward at the market drift rate', () => {
    const { adjustedPsf, adjustments } = adjustComparable(
      comp({ soldOrListedAt: '2025-06-01T00:00:00Z' }),
      ctx([], 10),
    );
    expect(adjustedPsf).toBeGreaterThan(14_000);
    expect(adjustments.find((a) => a.factor === 'time')).toBeDefined();
  });

  it('discounts an asking price toward a clearing price', () => {
    const asking = adjustComparable(comp({ isTransaction: false }), ctx([]));
    const sold = adjustComparable(comp({ isTransaction: true }), ctx([]));
    expect(asking.adjustedPsf).toBeLessThan(sold.adjustedPsf);
    expect(asking.adjustments.find((a) => a.factor === 'listingDiscount')).toBeDefined();
  });

  it('adjusts upward when the subject sits above the comparable floor', () => {
    // Subject is on floor 8.
    const lower = adjustComparable(comp({ floor: 2 }), ctx([]));
    const higher = adjustComparable(comp({ floor: 12 }), ctx([]));
    expect(lower.adjustedPsf).toBeGreaterThan(higher.adjustedPsf);
  });

  it('adjusts an older building up to a new-build basis', () => {
    const aged = adjustComparable(comp({ ageYears: 10 }), ctx([]));
    const fresh = adjustComparable(comp({ ageYears: 0 }), ctx([]));
    expect(aged.adjustedPsf).toBeGreaterThan(fresh.adjustedPsf);
  });

  it('records a reason for every adjustment it applies', () => {
    const { adjustments } = adjustComparable(
      comp({
        soldOrListedAt: '2025-01-01T00:00:00Z',
        isTransaction: false,
        floor: 1,
        ageYears: 5,
        carpetAreaSqFt: 1600,
      }),
      ctx([]),
    );
    expect(adjustments.length).toBeGreaterThan(3);
    for (const a of adjustments) {
      expect(a.reason.length).toBeGreaterThan(10);
      expect(Number.isFinite(a.multiplier)).toBe(true);
    }
  });
});

describe('comparableWeight', () => {
  it('drops comparables beyond the distance cut-off', () => {
    expect(comparableWeight(comp({ distanceKm: 12 }), ctx([]))).toBe(0);
  });

  it('drops comparables beyond the age cut-off', () => {
    expect(comparableWeight(comp({ soldOrListedAt: '2023-01-01T00:00:00Z' }), ctx([]))).toBe(0);
  });

  it('prefers nearer, newer and more similar comparables', () => {
    const good = comparableWeight(
      comp({ distanceKm: 0.3, soldOrListedAt: '2026-05-20T00:00:00Z' }),
      ctx([]),
    );
    const poor = comparableWeight(
      comp({ distanceKm: 4, soldOrListedAt: '2025-01-01T00:00:00Z' }),
      ctx([]),
    );
    expect(good).toBeGreaterThan(poor);
  });

  it('discounts asking prices relative to transactions', () => {
    expect(comparableWeight(comp({ isTransaction: false }), ctx([]))).toBeLessThan(
      comparableWeight(comp({ isTransaction: true }), ctx([])),
    );
  });
});

describe('valueProperty', () => {
  it('refuses to publish a value below the minimum comparable count', () => {
    const v = valueProperty(ctx([comp()]));
    expect(v.insufficientEvidence).toBe(true);
    expect(v.mid).toBe(0);
    expect(v.confidence).toBe(0);
    expect(v.adjustmentNotes.join(' ')).toContain(String(MIN_COMPARABLES));
  });

  it('produces an ordered low/mid/high band', () => {
    const v = valueProperty(
      ctx([comp(), comp({ pricePerSqFt: 14_500 }), comp({ pricePerSqFt: 13_600 })]),
    );
    expect(v.insufficientEvidence).toBe(false);
    expect(v.low).toBeLessThan(v.mid);
    expect(v.mid).toBeLessThan(v.high);
  });

  it('computes asking deviation against the central estimate', () => {
    const v = valueProperty(ctx([comp(), comp({ pricePerSqFt: 14_000 })]));
    const expected = ((16_000_000 - v.mid) / v.mid) * 100;
    expect(v.askingDeviationPercent).toBeCloseTo(expected, 1);
  });

  it('gives a wider band for a dispersed comparable set', () => {
    const tight = valueProperty(
      ctx([
        comp({ pricePerSqFt: 14_000 }),
        comp({ pricePerSqFt: 14_050 }),
        comp({ pricePerSqFt: 13_980 }),
      ]),
    );
    const spread = valueProperty(
      ctx([
        comp({ pricePerSqFt: 11_000 }),
        comp({ pricePerSqFt: 17_000 }),
        comp({ pricePerSqFt: 14_000 }),
      ]),
    );
    expect(spread.high - spread.low).toBeGreaterThan(tight.high - tight.low);
    expect(spread.confidence).toBeLessThan(tight.confidence);
  });

  it('propagates demo status from its comparables', () => {
    const v = valueProperty(ctx([comp({ dataStatus: 'demo' }), comp({ dataStatus: 'demo' })]));
    expect(v.dataStatus).toBe('demo');
  });

  it('marks an all-real comparable set as estimated, never verified', () => {
    const v = valueProperty(ctx([comp(), comp()]));
    expect(v.dataStatus).toBe('estimated');
  });

  it('normalises comparable weights to sum to 1', () => {
    const v = valueProperty(ctx([comp(), comp({ pricePerSqFt: 15_000 }), comp({ distanceKm: 3 })]));
    const total = v.comparables.reduce((a, c) => a + (c.weight ?? 0), 0);
    expect(total).toBeCloseTo(1, 3);
  });
});

describe('negotiationGuidance', () => {
  it('returns nothing when there is no usable valuation', () => {
    expect(negotiationGuidance(valueProperty(ctx([comp()])))).toBeUndefined();
  });

  it('orders opening offer below target below walk-away', () => {
    const g = negotiationGuidance(
      valueProperty(ctx([comp(), comp({ pricePerSqFt: 14_400 }), comp({ pricePerSqFt: 13_700 })])),
    );
    expect(g).toBeDefined();
    expect(g!.openingOffer).toBeLessThan(g!.targetPrice);
    expect(g!.targetPrice).toBeLessThan(g!.walkAwayPrice);
  });

  it('raises the overpricing lever when asking is above fair value', () => {
    const g = negotiationGuidance(
      valueProperty(ctx([comp({ pricePerSqFt: 11_000 }), comp({ pricePerSqFt: 11_200 })])),
    );
    expect(g!.leverPoints.join(' ')).toContain('above our central estimate');
  });
});

describe('negotiationGuidance never suggests paying above asking', () => {
  /** Comparables well above the asking price, so fair value exceeds it. */
  const underpriced = () =>
    valueProperty(
      ctx([
        comp({ pricePerSqFt: 17_000 }),
        comp({ pricePerSqFt: 17_400 }),
        comp({ pricePerSqFt: 16_800 }),
      ]),
    );

  it('confirms the fixture is genuinely priced below fair value', () => {
    const v = underpriced();
    expect(v.askingDeviationPercent).toBeLessThan(0);
    expect(v.mid).toBeGreaterThan(v.askingPrice);
  });

  it('caps the target below the asking price', () => {
    const g = negotiationGuidance(underpriced())!;
    expect(g.targetPrice).toBeLessThan(g.askingPrice);
  });

  it('caps the walk-away at the asking price', () => {
    const g = negotiationGuidance(underpriced())!;
    expect(g.walkAwayPrice).toBeLessThanOrEqual(g.askingPrice);
  });

  it('keeps opening below target below walk-away even when underpriced', () => {
    const g = negotiationGuidance(underpriced())!;
    expect(g.openingOffer).toBeLessThan(g.targetPrice);
    expect(g.targetPrice).toBeLessThanOrEqual(g.walkAwayPrice);
  });

  it('still leaves room to negotiate rather than conceding the asking price', () => {
    const g = negotiationGuidance(underpriced())!;
    expect(g.expectedConcessionPercent).toBeGreaterThan(0);
  });

  it('reports a positive expected concession for an overpriced property too', () => {
    const g = negotiationGuidance(
      valueProperty(ctx([comp({ pricePerSqFt: 11_000 }), comp({ pricePerSqFt: 11_200 })])),
    )!;
    expect(g.targetPrice).toBeLessThan(g.askingPrice);
    expect(g.expectedConcessionPercent).toBeGreaterThan(0);
  });
});
