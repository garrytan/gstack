import { describe, expect, it } from 'vitest';
import { biggestDifferences, compareProperties, tradeOffs } from '@/domain/decision/compare';
import type { CompareCandidate } from '@/domain/decision/compare';

const NOW = '2026-06-01T00:00:00.000Z';

const candidate = (overrides: Partial<CompareCandidate> = {}): CompareCandidate => ({
  id: 'a',
  label: 'Project A',
  askingPrice: 15_000_000,
  score: 72,
  pillarScores: { unit: 70, legal: 80, developer: 75, location: 68, buyerFit: 70 },
  riskSeverity: 0.25,
  peakCommuteMinutes: 35,
  possessionMonths: 12,
  grossYieldPercent: 3.4,
  fairValueDeviationPercent: 2,
  ...overrides,
});

describe('compareProperties', () => {
  it('declares a winner only when the gap clears the minimum spread', () => {
    const result = compareProperties(
      [
        candidate({ id: 'a', label: 'A', pillarScores: { unit: 70 } }),
        candidate({ id: 'b', label: 'B', pillarScores: { unit: 72 } }),
      ],
      NOW,
    );
    const unit = result.verdicts.find((v) => v.dimension === 'unit')!;
    expect(unit.winnerId).toBeUndefined();
    expect(unit.reason).toContain('too close to call');
  });

  it('names a winner on a material gap', () => {
    const result = compareProperties(
      [
        candidate({ id: 'a', label: 'A', pillarScores: { unit: 58 } }),
        candidate({ id: 'b', label: 'B', pillarScores: { unit: 84 } }),
      ],
      NOW,
    );
    expect(result.verdicts.find((v) => v.dimension === 'unit')!.winnerId).toBe('b');
  });

  it('marks a dimension undecidable when fewer than two candidates have data', () => {
    const result = compareProperties(
      [
        candidate({ id: 'a', grossYieldPercent: 3.4 }),
        candidate({ id: 'b', grossYieldPercent: undefined }),
      ],
      NOW,
    );
    const inv = result.verdicts.find((v) => v.dimension === 'investment')!;
    expect(inv.undecidable).toBe(true);
    expect(inv.winnerId).toBeUndefined();
  });

  it('judges price on distance from fair value, not on the sticker', () => {
    const result = compareProperties(
      [
        // Cheaper in absolute terms but further above what it is worth.
        candidate({
          id: 'cheap',
          label: 'Cheap',
          askingPrice: 10_000_000,
          fairValueDeviationPercent: 14,
        }),
        candidate({
          id: 'dear',
          label: 'Dear',
          askingPrice: 20_000_000,
          fairValueDeviationPercent: -4,
        }),
      ],
      NOW,
    );
    expect(result.verdicts.find((v) => v.dimension === 'price')!.winnerId).toBe('dear');
  });

  it('prefers the lower-risk candidate on the risk dimension', () => {
    const result = compareProperties(
      [candidate({ id: 'a', riskSeverity: 0.2 }), candidate({ id: 'b', riskSeverity: 0.6 })],
      NOW,
    );
    expect(result.verdicts.find((v) => v.dimension === 'risk')!.winnerId).toBe('a');
  });

  it('covers every declared dimension', () => {
    const result = compareProperties([candidate({ id: 'a' }), candidate({ id: 'b' })], NOW);
    expect(result.verdicts).toHaveLength(8);
  });
});

describe('biggestDifferences', () => {
  it('returns nothing for a single candidate', () => {
    expect(biggestDifferences([candidate()])).toHaveLength(0);
  });

  it('leads with the largest-magnitude difference', () => {
    const diffs = biggestDifferences([
      candidate({ id: 'a', label: 'A', askingPrice: 10_000_000, peakCommuteMinutes: 30 }),
      candidate({ id: 'b', label: 'B', askingPrice: 25_000_000, peakCommuteMinutes: 55 }),
    ]);
    expect(diffs.length).toBeGreaterThan(1);
    expect(diffs[0]!.magnitude).toBeGreaterThanOrEqual(diffs[1]!.magnitude);
  });

  it('ignores a commute gap too small to matter', () => {
    const diffs = biggestDifferences([
      candidate({ id: 'a', peakCommuteMinutes: 30 }),
      candidate({ id: 'b', peakCommuteMinutes: 32 }),
    ]);
    expect(diffs.find((d) => d.label === 'Commute')).toBeUndefined();
  });

  it('reports a possession gap in months', () => {
    const diffs = biggestDifferences([
      candidate({ id: 'a', label: 'A', possessionMonths: 3 }),
      candidate({ id: 'b', label: 'B', possessionMonths: 30 }),
    ]);
    expect(diffs.find((d) => d.label === 'Possession')?.detail).toContain('27 months earlier');
  });
});

describe('tradeOffs', () => {
  it('says what the extra money buys when the evidence shows it', () => {
    const [sentence] = tradeOffs([
      candidate({
        id: 'a',
        label: 'Cheaper',
        askingPrice: 14_000_000,
        peakCommuteMinutes: 55,
        riskSeverity: 0.5,
      }),
      candidate({
        id: 'b',
        label: 'Dearer',
        askingPrice: 15_400_000,
        peakCommuteMinutes: 30,
        riskSeverity: 0.2,
      }),
    ]);
    expect(sentence).toContain('₹14.0 lakh more');
    expect(sentence).toContain('25 minutes');
    expect(sentence).toContain('lower delivery and legal risk');
  });

  it('says so plainly when the extra money buys nothing measurable', () => {
    const [sentence] = tradeOffs([
      candidate({ id: 'a', label: 'A', askingPrice: 14_000_000 }),
      candidate({ id: 'b', label: 'B', askingPrice: 16_000_000 }),
    ]);
    expect(sentence).toContain('does not show what that buys');
  });

  it('returns nothing when there is no price gap to explain', () => {
    expect(tradeOffs([candidate({ id: 'a' }), candidate({ id: 'b' })])).toHaveLength(0);
  });
});

describe('trade-off sentence grammar', () => {
  it('joins three gains with commas and a single trailing "and"', () => {
    const [sentence] = tradeOffs([
      candidate({
        id: 'a',
        label: 'Cheaper',
        askingPrice: 14_000_000,
        peakCommuteMinutes: 55,
        riskSeverity: 0.5,
        pillarScores: { unit: 60 },
      }),
      candidate({
        id: 'b',
        label: 'Dearer',
        askingPrice: 16_000_000,
        peakCommuteMinutes: 30,
        riskSeverity: 0.2,
        pillarScores: { unit: 80 },
      }),
    ]);
    expect(sentence).toBeDefined();
    // The bug this pins: joining with ', and ' produced "saves X, and carries
    // Y, and is Z". Only the final clause takes an "and".
    expect(sentence!).not.toContain(', and carries');
    expect(sentence!).toContain('minutes of peak commute, carries');
    expect(sentence!).toContain(', and is a materially better unit');
  });
});
