/**
 * Comparable-based fair value.
 *
 * Method (v0.1, published):
 *  1. Take candidate comparables in the same locality.
 *  2. Adjust each one's ₹/sqft for the ways it differs from the subject:
 *     time (market drift since it transacted), floor, age, and size.
 *  3. Weight each comparable by recency, proximity, size similarity, and
 *     whether it is a completed transaction or merely an asking price.
 *  4. Take the weighted mean as the central estimate, and set the band from
 *     the weighted dispersion of the adjusted set — so a tight, deep comparable
 *     set gives a tight range and a thin one gives an honestly wide one.
 *
 * We refuse to value rather than guess: fewer than two usable comparables
 * returns `insufficientEvidence`.
 */

import type { Instant, PropertyId } from '../shared/types';
import { clamp01, round } from '../shared/types';
import type { DataStatus } from '../evidence/types';
import { daysBetween } from '../evidence/freshness';
import type { Property } from '../property/types';
import type { Comparable, ComparableAdjustment, NegotiationGuidance, Valuation } from './types';

export const VALUATION_METHODOLOGY_VERSION = '0.1.0';

/** Minimum usable comparables before we are willing to publish a number. */
export const MIN_COMPARABLES = 2;

export interface ValuationContext {
  readonly property: Property;
  readonly comparables: readonly Comparable[];
  /** Annual market drift for the locality, percent. Used for time adjustment. */
  readonly marketDriftPercentPerYear: number;
  readonly now: Instant;
}

interface Weighted {
  readonly comparable: Comparable;
  readonly adjustedPsf: number;
  readonly weight: number;
  readonly adjustments: ComparableAdjustment[];
}

/** Comparables older than this contribute nothing; the market has moved on. */
const MAX_COMPARABLE_AGE_DAYS = 730;
const MAX_COMPARABLE_DISTANCE_KM = 6;

const subjectCarpet = (p: Property): number =>
  p.carpetAreaSqFt ?? (p.areaBasis === 'carpet' ? p.areaSqFt : p.areaSqFt * 0.7);

/**
 * Adjust one comparable onto the subject's terms.
 * Each adjustment is a multiplier recorded with its reason so the whole
 * derivation can be shown in the evidence drawer.
 */
export const adjustComparable = (
  comp: Comparable,
  ctx: ValuationContext,
): { adjustedPsf: number; adjustments: ComparableAdjustment[] } => {
  const adjustments: ComparableAdjustment[] = [];
  let psf = comp.pricePerSqFt;

  const ageDays = Math.max(0, daysBetween(comp.soldOrListedAt, ctx.now));
  const years = ageDays / 365;
  const timeMultiplier = Math.pow(1 + ctx.marketDriftPercentPerYear / 100, years);
  if (Math.abs(timeMultiplier - 1) > 0.001) {
    adjustments.push({
      factor: 'time',
      multiplier: round(timeMultiplier, 4),
      reason: `Carried forward ${round(years, 2)} years at ${ctx.marketDriftPercentPerYear}% annual market drift.`,
    });
    psf *= timeMultiplier;
  }

  // Asking prices in India sit above clearing prices; discount them so they do
  // not drag the estimate upward.
  if (!comp.isTransaction) {
    const multiplier = 0.96;
    adjustments.push({
      factor: 'listingDiscount',
      multiplier,
      reason: 'Asking price, not a completed transaction. Discounted 4% to clearing level.',
    });
    psf *= multiplier;
  }

  const subjectFloor = ctx.property.floor;
  if (subjectFloor !== undefined && comp.floor !== undefined) {
    // Floor-rise is roughly 0.4% per floor in Indian metro towers.
    const diff = subjectFloor - comp.floor;
    const multiplier = 1 + diff * 0.004;
    if (Math.abs(diff) >= 1) {
      adjustments.push({
        factor: 'floor',
        multiplier: round(multiplier, 4),
        reason: `Subject is ${Math.abs(diff)} floor(s) ${diff > 0 ? 'above' : 'below'} the comparable, at 0.4%/floor.`,
      });
      psf *= multiplier;
    }
  }

  if (comp.ageYears !== undefined && comp.ageYears > 0) {
    // Depreciation on the built portion, ~0.8%/year, capped at 20 years.
    const multiplier = 1 + Math.min(comp.ageYears, 20) * 0.008;
    adjustments.push({
      factor: 'age',
      multiplier: round(multiplier, 4),
      reason: `Comparable is ${comp.ageYears} years old; adjusted up to a new-build basis at 0.8%/year.`,
    });
    psf *= multiplier;
  }

  // Larger units carry a lower ₹/sqft. Adjust toward the subject's size.
  const subject = subjectCarpet(ctx.property);
  if (subject > 0 && comp.carpetAreaSqFt > 0) {
    const ratio = comp.carpetAreaSqFt / subject;
    const multiplier = 1 + (ratio - 1) * 0.06;
    if (Math.abs(ratio - 1) > 0.1) {
      adjustments.push({
        factor: 'size',
        multiplier: round(multiplier, 4),
        reason: `Comparable is ${round((ratio - 1) * 100, 1)}% ${ratio > 1 ? 'larger' : 'smaller'}; size-price gradient applied at 6%.`,
      });
      psf *= multiplier;
    }
  }

  return { adjustedPsf: round(psf, 2), adjustments };
};

/** Recency × proximity × size-similarity × transaction-quality, all in 0..1. */
export const comparableWeight = (comp: Comparable, ctx: ValuationContext): number => {
  const ageDays = Math.max(0, daysBetween(comp.soldOrListedAt, ctx.now));
  if (ageDays > MAX_COMPARABLE_AGE_DAYS || comp.distanceKm > MAX_COMPARABLE_DISTANCE_KM) return 0;

  const recency = clamp01(1 - ageDays / MAX_COMPARABLE_AGE_DAYS);
  const proximity = clamp01(1 - comp.distanceKm / MAX_COMPARABLE_DISTANCE_KM);
  const subject = subjectCarpet(ctx.property);
  const sizeSimilarity =
    subject > 0 && comp.carpetAreaSqFt > 0
      ? clamp01(1 - Math.abs(comp.carpetAreaSqFt - subject) / subject)
      : 0.5;
  const quality = comp.isTransaction ? 1 : 0.7;

  return round(recency * proximity * sizeSimilarity * quality, 5);
};

export const valueProperty = (ctx: ValuationContext): Valuation => {
  const weighted: Weighted[] = ctx.comparables
    .map((comparable) => {
      const { adjustedPsf, adjustments } = adjustComparable(comparable, ctx);
      return { comparable, adjustedPsf, adjustments, weight: comparableWeight(comparable, ctx) };
    })
    .filter((w) => w.weight > 0);

  const subject = subjectCarpet(ctx.property);
  const dataStatus: DataStatus = ctx.comparables.some((c) => c.dataStatus === 'demo')
    ? 'demo'
    : 'estimated';

  if (weighted.length < MIN_COMPARABLES || subject <= 0) {
    return {
      propertyId: ctx.property.id as PropertyId,
      computedAt: ctx.now,
      methodologyVersion: VALUATION_METHODOLOGY_VERSION,
      low: 0,
      mid: 0,
      high: 0,
      perSqFtMid: 0,
      askingPrice: ctx.property.askingPrice,
      askingDeviationPercent: 0,
      confidence: 0,
      comparables: ctx.comparables,
      adjustmentNotes: [
        `Only ${weighted.length} usable comparable(s) within ${MAX_COMPARABLE_DISTANCE_KM} km and ` +
          `${MAX_COMPARABLE_AGE_DAYS} days. PropIQ needs at least ${MIN_COMPARABLES} before publishing a value.`,
      ],
      dataStatus,
      freshnessDays: 0,
      insufficientEvidence: true,
    };
  }

  const totalWeight = weighted.reduce((a, w) => a + w.weight, 0);
  const meanPsf = weighted.reduce((a, w) => a + w.adjustedPsf * w.weight, 0) / totalWeight;

  // Weighted standard deviation of the adjusted set drives the band width.
  const variance =
    weighted.reduce((a, w) => a + w.weight * (w.adjustedPsf - meanPsf) ** 2, 0) / totalWeight;
  const stdDev = Math.sqrt(variance);

  // Thin evidence widens the band: a two-comparable set should never look as
  // certain as a ten-comparable one, even if those two happen to agree.
  const depthPenalty = clamp01(1 - weighted.length / 8);
  const relativeSpread = clamp01(stdDev / Math.max(meanPsf, 1) + depthPenalty * 0.06);
  const halfBand = Math.max(meanPsf * 0.04, meanPsf * relativeSpread);

  const midPsf = round(meanPsf, 0);
  const mid = Math.round(midPsf * subject);
  const low = Math.round((midPsf - halfBand) * subject);
  const high = Math.round((midPsf + halfBand) * subject);

  const freshnessDays = Math.round(
    Math.min(
      ...weighted.map((w) => Math.max(0, daysBetween(w.comparable.soldOrListedAt, ctx.now))),
    ),
  );

  // Confidence rises with comparable depth and transaction share, falls with spread.
  const transactionShare =
    weighted.filter((w) => w.comparable.isTransaction).length / weighted.length;
  const confidence = clamp01(
    round(
      0.35 * clamp01(weighted.length / 8) +
        0.3 * transactionShare +
        0.35 * clamp01(1 - relativeSpread * 4),
      3,
    ),
  );

  return {
    propertyId: ctx.property.id as PropertyId,
    computedAt: ctx.now,
    methodologyVersion: VALUATION_METHODOLOGY_VERSION,
    low,
    mid,
    high,
    perSqFtMid: midPsf,
    askingPrice: ctx.property.askingPrice,
    askingDeviationPercent: mid > 0 ? round(((ctx.property.askingPrice - mid) / mid) * 100, 2) : 0,
    confidence,
    comparables: weighted.map((w) => ({
      ...w.comparable,
      weight: round(w.weight / totalWeight, 4),
      adjustments: w.adjustments,
    })),
    adjustmentNotes: [
      `${weighted.length} comparables used; ${Math.round(transactionShare * 100)}% completed transactions.`,
      `Adjusted on a carpet-area basis of ${Math.round(subject)} sqft.`,
      `Market drift applied at ${ctx.marketDriftPercentPerYear}% per year.`,
    ],
    dataStatus,
    freshnessDays,
    insufficientEvidence: false,
  };
};

/**
 * Negotiation guidance derived from the valuation band.
 *
 * The opening offer sits just under the low end of fair value, the target at
 * the low-to-mid midpoint, and the walk-away at the point where the buyer is
 * paying above the top of the range for no stated reason.
 */
export const negotiationGuidance = (
  valuation: Valuation,
  leverPoints: readonly string[] = [],
): NegotiationGuidance | undefined => {
  if (valuation.insufficientEvidence || valuation.mid <= 0) return undefined;
  const asking = valuation.askingPrice;
  const openingOffer = Math.round(valuation.low * 0.97);
  const targetPrice = Math.round((valuation.low + valuation.mid) / 2);
  const walkAwayPrice = valuation.high;
  return {
    askingPrice: asking,
    openingOffer,
    targetPrice,
    walkAwayPrice,
    expectedConcessionPercent: asking > 0 ? round(((asking - targetPrice) / asking) * 100, 2) : 0,
    leverPoints: [
      ...leverPoints,
      ...(valuation.askingDeviationPercent > 5
        ? [`Asking is ${valuation.askingDeviationPercent}% above our central estimate.`]
        : []),
    ],
    confidence: valuation.confidence,
  };
};
