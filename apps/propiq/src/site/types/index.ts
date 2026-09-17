/**
 * Marketing-surface domain types.
 *
 * These describe what the homepage renders. Most of it is projected from the
 * real engine — a `SiteProperty` is assembled from `PropertyIntelligence`, so
 * the score, verdict, valuation and risk on a card are computed rather than
 * written down. The exceptions are the three shapes the engine has no concept
 * of yet (`DeveloperProfile`, `ResearchArticle`, `CommandCentreSnapshot`) and
 * those carry `dataStatus` like everything else.
 *
 * Nothing here is a second source of truth for a score. If a field can be
 * derived, it is derived.
 */

import type { DataStatus } from '@/domain/evidence/types';
import type { Decision } from '@/domain/decision/engine';
import type { RiskBand } from '@/domain/risk/types';
import type { InfrastructurePipelineItem, PricePoint } from '@/domain/locality/types';

export type { DataStatus };

/** Where a figure on the marketing surface came from. */
export interface Sourced<T> {
  readonly value: T;
  readonly dataStatus: DataStatus;
}

export interface SiteScoreBreakdown {
  readonly key: string;
  readonly label: string;
  /** `undefined` when the pillar had no evidence. Never zero for want of data. */
  readonly score: number | undefined;
  readonly weight: number | undefined;
  /** Share of this pillar's weight that had usable evidence, 0..1. */
  readonly coverage: number;
  readonly confidence: number;
  /** How many signals fed it, and how many of those actually had a value. */
  readonly signalCount: number;
  readonly signalsWithData: number;
  /** The signals that moved it most, already phrased for a reader. */
  readonly drivers: readonly string[];
}

export interface SiteProperty {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly locality: string;
  readonly localitySlug: string | undefined;
  readonly city: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly price: number;
  readonly pricePerSqFt: number;
  readonly carpetPricePerSqFt: number | undefined;
  readonly bhk: number;
  readonly sizeSqFt: number;
  readonly carpetSqFt: number | undefined;
  readonly status: string;
  readonly developer: string | undefined;
  readonly project: string | undefined;

  /** Computed by the scoring engine, not authored. */
  readonly propiqScore: number | undefined;
  readonly scoreBand: { readonly low: number; readonly high: number } | undefined;
  readonly scoreConfidence: number;
  readonly coverage: number;
  readonly breakdown: readonly SiteScoreBreakdown[];

  readonly decision: Decision;
  readonly verdictHeadline: string;
  readonly verdictConfidence: number;
  readonly strengths: readonly string[];
  readonly watchItems: readonly string[];
  readonly unknowns: readonly string[];

  readonly fairValueMid: number | undefined;
  readonly fairValueLow: number | undefined;
  readonly fairValueHigh: number | undefined;
  readonly priceDeviationPercent: number;

  readonly riskBand: RiskBand;
  readonly materialRisks: readonly string[];

  readonly rentalYieldPercent: number | undefined;
  readonly monthlyRent: number | undefined;

  readonly dataStatus: DataStatus;
  /** First image on the record, when it has one. */
  readonly image: string | undefined;
  /**
   * True when `image` is the generated stand-in rather than a photograph of
   * the property. A record that carries its own image keeps it; this only
   * marks the fallback, so the caption never mislabels a real photo.
   */
  readonly imageIsGenerated: boolean;
  /** Short badge for a card: "Strong investment signal", "Low-risk shortlist". */
  readonly signal: string;
}

/**
 * A fixed point the locality is measured against.
 *
 * The record stores distances, not coordinates, so this is a radius and not a
 * position. Anything that draws it must say so rather than implying a bearing.
 */
export interface LocalityAnchor {
  readonly label: string;
  readonly kind: 'employment' | 'metro' | 'road' | 'airport';
  readonly distanceKm: number;
  readonly peakCommuteMinutes: number | undefined;
}

export interface SiteLocality {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly city: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly medianPricePerSqFt: number | undefined;
  readonly grossYieldPercent: number | undefined;
  readonly priceCagrPercent: number | undefined;
  readonly supplyMonths: number | undefined;
  readonly summary: string;
  /** Straight from the record, so the chart is not fed a second copy. */
  readonly priceHistory: readonly PricePoint[];
  /** Only funded, under construction or commissioned. An announcement is not infrastructure. */
  readonly catalysts: readonly InfrastructurePipelineItem[];
  /** Employment hubs and transit anchors, by distance. Never a bearing. */
  readonly anchors: readonly LocalityAnchor[];
  readonly indicators: ReadonlyArray<{
    readonly label: string;
    readonly value: string;
    readonly detail: string | undefined;
  }>;
  readonly dataStatus: DataStatus;
}

/**
 * Developer trust.
 *
 * The engine holds delivery counts and complaint counts but does not compute a
 * trust score, so this shape is assembled here from the record it does hold.
 * Company names come from the fixture set and are invented; no real developer
 * is described.
 */
export interface DeveloperProfile {
  readonly id: string;
  readonly name: string;
  readonly incorporatedYear: number | undefined;
  readonly headquarters: string | undefined;
  readonly projectsDelivered: number | undefined;
  readonly unitsDelivered: number | undefined;
  readonly averageDelayMonths: number | undefined;
  readonly ongoingLitigationCount: number | undefined;
  readonly reraComplaintsCount: number | undefined;
  readonly dataStatus: DataStatus;
}

export interface ResearchArticle {
  readonly slug: string;
  readonly kicker: string;
  readonly title: string;
  readonly standfirst: string;
  readonly readMinutes: number;
  readonly published: string;
  readonly href: string;
  readonly dataStatus: DataStatus;
}

export interface CommandCentreSnapshot {
  readonly meanScore: number | undefined;
  readonly tracked: number;
  readonly opportunities: number;
  readonly materialRisks: number;
  readonly verdictCounts: ReadonlyArray<{ readonly decision: Decision; readonly count: number }>;
  readonly alerts: ReadonlyArray<{ readonly label: string; readonly detail: string }>;
  readonly dataStatus: DataStatus;
}

export interface ComparisonRow {
  readonly label: string;
  readonly values: readonly string[];
  /** Index of the column that wins this row, when one clearly does. */
  readonly winner: number | undefined;
}
