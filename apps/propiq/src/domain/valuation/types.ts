/**
 * Fair value.
 *
 * The output is a *range* with a confidence, never a single confident number.
 * Indian residential comparables are sparse and heterogeneous; pretending to
 * two-decimal precision would be the fastest way to lose a buyer's trust.
 */

import type { INR, Instant, PropertyId, Unit01 } from '../shared/types';
import type { DataStatus } from '../evidence/types';

export interface Comparable {
  readonly propertyId?: PropertyId;
  readonly label: string;
  readonly soldOrListedAt: Instant;
  readonly isTransaction: boolean;
  readonly carpetAreaSqFt: number;
  readonly pricePerSqFt: INR;
  readonly distanceKm: number;
  readonly floor?: number;
  readonly ageYears?: number;
  readonly dataStatus: DataStatus;
  /** Weight this comparable received after distance/recency/similarity adjustment. */
  readonly weight?: number;
  readonly adjustments?: readonly ComparableAdjustment[];
}

export interface ComparableAdjustment {
  readonly factor: string;
  /** Multiplicative adjustment applied to the comparable's ₹/sqft. */
  readonly multiplier: number;
  readonly reason: string;
}

export interface Valuation {
  readonly propertyId: PropertyId;
  readonly computedAt: Instant;
  readonly methodologyVersion: string;
  /** Fair value range for the whole unit, in rupees. */
  readonly low: INR;
  readonly mid: INR;
  readonly high: INR;
  readonly perSqFtMid: INR;
  readonly askingPrice: INR;
  /** (asking - mid) / mid, as a percentage. Positive = asking above fair value. */
  readonly askingDeviationPercent: number;
  readonly confidence: Unit01;
  readonly comparables: readonly Comparable[];
  readonly adjustmentNotes: readonly string[];
  readonly dataStatus: DataStatus;
  /** Days since the newest comparable was observed. */
  readonly freshnessDays: number;
  /** Set when we could not value the property; `low/mid/high` are then 0. */
  readonly insufficientEvidence: boolean;
}

export interface NegotiationGuidance {
  readonly askingPrice: INR;
  /** Opening offer we would put on the table. */
  readonly openingOffer: INR;
  /** Price at which the deal stops being good value. */
  readonly walkAwayPrice: INR;
  /** Realistic landing zone given the evidence. */
  readonly targetPrice: INR;
  readonly expectedConcessionPercent: number;
  readonly leverPoints: readonly string[];
  readonly confidence: Unit01;
}
