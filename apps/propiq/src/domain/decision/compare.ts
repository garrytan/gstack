/**
 * Comparison analysis for the Decision Room.
 *
 * A comparison table that just lists every field side by side makes the reader
 * do the work. This module does the work: it finds where the candidates
 * actually diverge, names a winner per dimension, and writes the trade-off in
 * the terms a buyer decides in (rupees, minutes, months of risk).
 */

import type { Instant } from '../shared/types';
import { round } from '../shared/types';

export const COMPARE_DIMENSIONS = [
  'price',
  'buyerFit',
  'unit',
  'developer',
  'legal',
  'location',
  'investment',
  'risk',
] as const;
export type CompareDimension = (typeof COMPARE_DIMENSIONS)[number];

export const COMPARE_LABELS: Readonly<Record<CompareDimension, string>> = {
  price: 'Price',
  buyerFit: 'Fit for you',
  unit: 'Unit',
  developer: 'Developer',
  legal: 'Legal',
  location: 'Location',
  investment: 'Investment',
  risk: 'Risk',
};

/** One candidate's comparable measurements, extracted from its intelligence payload. */
export interface CompareCandidate {
  readonly id: string;
  readonly label: string;
  readonly askingPrice: number;
  readonly carpetPricePerSqFt?: number;
  readonly score?: number;
  readonly pillarScores: Readonly<Partial<Record<string, number | undefined>>>;
  readonly riskSeverity?: number;
  readonly peakCommuteMinutes?: number;
  readonly possessionMonths?: number;
  readonly grossYieldPercent?: number;
  readonly fairValueDeviationPercent?: number;
}

export interface DimensionVerdict {
  readonly dimension: CompareDimension;
  readonly label: string;
  /** Winning candidate id, or undefined when nothing separates them. */
  readonly winnerId?: string;
  readonly reason: string;
  /** True when every candidate lacked the data to judge this dimension. */
  readonly undecidable: boolean;
}

export interface Difference {
  readonly label: string;
  readonly detail: string;
  /** How much this difference should weigh on the reader's attention, 0..1. */
  readonly magnitude: number;
}

export interface ComparisonResult {
  readonly comparedAt: Instant;
  readonly candidates: readonly CompareCandidate[];
  readonly verdicts: readonly DimensionVerdict[];
  readonly biggestDifferences: readonly Difference[];
  readonly tradeOffs: readonly string[];
}

const higherWins = (
  candidates: readonly CompareCandidate[],
  pick: (c: CompareCandidate) => number | undefined,
): { winner?: CompareCandidate; spread: number; undecidable: boolean } => {
  const withValue = candidates.filter((c) => pick(c) !== undefined);
  if (withValue.length < 2) return { spread: 0, undecidable: true };
  const sorted = [...withValue].sort((a, b) => (pick(b) ?? 0) - (pick(a) ?? 0));
  const best = pick(sorted[0]!) ?? 0;
  const worst = pick(sorted[sorted.length - 1]!) ?? 0;
  return { winner: sorted[0], spread: best - worst, undecidable: false };
};

const lowerWins = (
  candidates: readonly CompareCandidate[],
  pick: (c: CompareCandidate) => number | undefined,
) =>
  higherWins(candidates, (c) => {
    const v = pick(c);
    return v === undefined ? undefined : -v;
  });

/**
 * A dimension is only called for one candidate when the gap is material.
 * Declaring a winner on a 0.4-point score difference would be noise dressed
 * up as insight, so each dimension carries its own minimum meaningful spread.
 */
const MIN_SPREAD: Readonly<Record<CompareDimension, number>> = {
  price: 3, // percent of fair-value deviation
  buyerFit: 5, // score points
  unit: 5,
  developer: 5,
  legal: 5,
  location: 5,
  investment: 0.4, // percentage points of gross yield
  risk: 0.08, // severity points
};

export const compareProperties = (
  candidates: readonly CompareCandidate[],
  now: Instant,
): ComparisonResult => {
  const verdicts: DimensionVerdict[] = [];

  const pillarVerdict = (dimension: CompareDimension, pillarKey: string, unit = 'points') => {
    const { winner, spread, undecidable } = higherWins(
      candidates,
      (c) => c.pillarScores[pillarKey],
    );
    const decisive = !undecidable && spread >= MIN_SPREAD[dimension];
    verdicts.push({
      dimension,
      label: COMPARE_LABELS[dimension],
      winnerId: decisive ? winner?.id : undefined,
      reason: undecidable
        ? 'Not enough evidence on at least two candidates to compare.'
        : decisive
          ? `${winner?.label} leads by ${round(spread, 1)} ${unit}.`
          : `Within ${round(spread, 1)} ${unit} — too close to call.`,
      undecidable,
    });
  };

  // Price is judged on value, not on the sticker: the cheapest property is not
  // the best-priced one if it is still above what it is worth.
  {
    const { winner, spread, undecidable } = lowerWins(
      candidates,
      (c) => c.fairValueDeviationPercent,
    );
    const decisive = !undecidable && spread >= MIN_SPREAD.price;
    verdicts.push({
      dimension: 'price',
      label: COMPARE_LABELS.price,
      winnerId: decisive ? winner?.id : undefined,
      reason: undecidable
        ? 'We could not value at least two of these, so price cannot be judged against worth.'
        : decisive
          ? `${winner?.label} is priced best against its own fair value, by ${round(spread, 1)} percentage points.`
          : 'All candidates sit at a similar distance from their fair value.',
      undecidable,
    });
  }

  pillarVerdict('buyerFit', 'buyerFit');
  pillarVerdict('unit', 'unit');
  pillarVerdict('developer', 'developer');
  pillarVerdict('legal', 'legal');
  pillarVerdict('location', 'location');

  {
    const { winner, spread, undecidable } = higherWins(candidates, (c) => c.grossYieldPercent);
    const decisive = !undecidable && spread >= MIN_SPREAD.investment;
    verdicts.push({
      dimension: 'investment',
      label: COMPARE_LABELS.investment,
      winnerId: decisive ? winner?.id : undefined,
      reason: undecidable
        ? 'No rent estimate on at least two candidates, so yield cannot be compared.'
        : decisive
          ? `${winner?.label} yields ${round(spread, 2)} percentage points more.`
          : 'Yields are within a rounding error of each other.',
      undecidable,
    });
  }

  {
    const { winner, spread, undecidable } = lowerWins(candidates, (c) => c.riskSeverity);
    const decisive = !undecidable && spread >= MIN_SPREAD.risk;
    verdicts.push({
      dimension: 'risk',
      label: COMPARE_LABELS.risk,
      winnerId: decisive ? winner?.id : undefined,
      reason: undecidable
        ? 'Risk could not be assessed on at least two candidates.'
        : decisive
          ? `${winner?.label} carries materially less risk.`
          : 'Risk profiles are comparable.',
      undecidable,
    });
  }

  return {
    comparedAt: now,
    candidates,
    verdicts,
    biggestDifferences: biggestDifferences(candidates),
    tradeOffs: tradeOffs(candidates),
  };
};

/** The differences worth leading with, ordered by how much they should matter. */
export const biggestDifferences = (candidates: readonly CompareCandidate[]): Difference[] => {
  if (candidates.length < 2) return [];
  const out: Difference[] = [];

  const prices = candidates.map((c) => c.askingPrice);
  const priceSpread = Math.max(...prices) - Math.min(...prices);
  const cheapest = candidates.find((c) => c.askingPrice === Math.min(...prices))!;
  const dearest = candidates.find((c) => c.askingPrice === Math.max(...prices))!;
  if (priceSpread > 0) {
    out.push({
      label: 'Price',
      detail: `${dearest.label} costs ₹${(priceSpread / 100_000).toFixed(1)} lakh more than ${cheapest.label}.`,
      magnitude: Math.min(1, priceSpread / Math.max(1, Math.min(...prices))),
    });
  }

  const commutes = candidates.filter((c) => c.peakCommuteMinutes !== undefined);
  if (commutes.length >= 2) {
    const fastest = commutes.reduce((a, b) =>
      (a.peakCommuteMinutes ?? 0) < (b.peakCommuteMinutes ?? 0) ? a : b,
    );
    const slowest = commutes.reduce((a, b) =>
      (a.peakCommuteMinutes ?? 0) > (b.peakCommuteMinutes ?? 0) ? a : b,
    );
    const gap = (slowest.peakCommuteMinutes ?? 0) - (fastest.peakCommuteMinutes ?? 0);
    if (gap >= 5) {
      out.push({
        label: 'Commute',
        detail: `${fastest.label} saves about ${gap} minutes each way at peak against ${slowest.label}.`,
        magnitude: Math.min(1, gap / 45),
      });
    }
  }

  const risky = candidates.filter((c) => c.riskSeverity !== undefined);
  if (risky.length >= 2) {
    const safest = risky.reduce((a, b) => ((a.riskSeverity ?? 1) < (b.riskSeverity ?? 1) ? a : b));
    const riskiest = risky.reduce((a, b) =>
      (a.riskSeverity ?? 0) > (b.riskSeverity ?? 0) ? a : b,
    );
    const gap = (riskiest.riskSeverity ?? 0) - (safest.riskSeverity ?? 0);
    if (gap >= 0.1) {
      out.push({
        label: 'Risk',
        detail: `${riskiest.label} carries a materially heavier risk load than ${safest.label}.`,
        magnitude: Math.min(1, gap * 2),
      });
    }
  }

  const possession = candidates.filter((c) => c.possessionMonths !== undefined);
  if (possession.length >= 2) {
    const soonest = possession.reduce((a, b) =>
      (a.possessionMonths ?? 0) < (b.possessionMonths ?? 0) ? a : b,
    );
    const latest = possession.reduce((a, b) =>
      (a.possessionMonths ?? 0) > (b.possessionMonths ?? 0) ? a : b,
    );
    const gap = Math.round((latest.possessionMonths ?? 0) - (soonest.possessionMonths ?? 0));
    if (gap >= 6) {
      out.push({
        label: 'Possession',
        detail: `${soonest.label} hands over about ${gap} months earlier than ${latest.label}.`,
        magnitude: Math.min(1, gap / 36),
      });
    }
  }

  return out.sort((a, b) => b.magnitude - a.magnitude);
};

/** Oxford-comma list join. "a", "a and b", "a, b, and c". */
const joinClauses = (clauses: readonly string[]): string => {
  if (clauses.length <= 1) return clauses[0] ?? '';
  if (clauses.length === 2) return `${clauses[0]} and ${clauses[1]}`;
  return `${clauses.slice(0, -1).join(', ')}, and ${clauses[clauses.length - 1]}`;
};

/**
 * Trade-off sentences: what the extra money actually buys.
 * Only written when there is a real price gap to explain.
 */
export const tradeOffs = (candidates: readonly CompareCandidate[]): string[] => {
  if (candidates.length < 2) return [];
  const sorted = [...candidates].sort((a, b) => a.askingPrice - b.askingPrice);
  const cheaper = sorted[0]!;
  const dearer = sorted[sorted.length - 1]!;
  const delta = dearer.askingPrice - cheaper.askingPrice;
  if (delta <= 0) return [];

  const gains: string[] = [];
  if (
    cheaper.peakCommuteMinutes !== undefined &&
    dearer.peakCommuteMinutes !== undefined &&
    cheaper.peakCommuteMinutes - dearer.peakCommuteMinutes >= 5
  ) {
    gains.push(
      `saves roughly ${Math.round(cheaper.peakCommuteMinutes - dearer.peakCommuteMinutes)} minutes of peak commute`,
    );
  }
  if (
    cheaper.riskSeverity !== undefined &&
    dearer.riskSeverity !== undefined &&
    cheaper.riskSeverity - dearer.riskSeverity >= 0.1
  ) {
    gains.push('carries materially lower delivery and legal risk');
  }
  if (
    cheaper.pillarScores.unit !== undefined &&
    dearer.pillarScores.unit !== undefined &&
    (dearer.pillarScores.unit ?? 0) - (cheaper.pillarScores.unit ?? 0) >= 6
  ) {
    gains.push('is a materially better unit on floor, facing and layout');
  }

  const lakh = (delta / 100_000).toFixed(1);
  if (gains.length === 0) {
    return [
      `${dearer.label} costs ₹${lakh} lakh more than ${cheaper.label} and the evidence does not show what that buys.`,
    ];
  }
  return [
    `${dearer.label} costs ₹${lakh} lakh more than ${cheaper.label}, and in exchange it ${joinClauses(gains)}.`,
  ];
};
