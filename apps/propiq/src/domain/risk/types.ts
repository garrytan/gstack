/**
 * Risk is reported as separate named dimensions, never as one unexplained badge.
 *
 * A buyer who sees "medium risk" learns nothing. A buyer who sees "construction
 * risk high because the phase is 38% complete with 11 months to promised
 * possession and this developer averages 14 months of delay" can act.
 */

import type { Instant, Unit01 } from '../shared/types';

export const RISK_DIMENSIONS = [
  'legal',
  'market',
  'liquidity',
  'water',
  'flood',
  'construction',
  'developer',
  'infrastructure',
  'valuation',
] as const;
export type RiskDimension = (typeof RISK_DIMENSIONS)[number];

export const RISK_LABELS: Readonly<Record<RiskDimension, string>> = {
  legal: 'Legal & title risk',
  market: 'Market risk',
  liquidity: 'Liquidity risk',
  water: 'Water security risk',
  flood: 'Flood risk',
  construction: 'Construction & delivery risk',
  developer: 'Developer counterparty risk',
  infrastructure: 'Infrastructure dependency risk',
  valuation: 'Valuation risk',
};

export type RiskBand = 'low' | 'moderate' | 'elevated' | 'high' | 'unknown';

export interface RiskSignalDetail {
  readonly dimension: RiskDimension;
  readonly label: string;
  /** 0 = no concern, 1 = severe. Undefined severity is represented by coverage 0. */
  readonly severity: Unit01;
  readonly band: RiskBand;
  readonly weight: number;
  readonly confidence: Unit01;
  /** Human-readable reasons, each traceable to an input. */
  readonly drivers: readonly string[];
  readonly evidenceFields: readonly string[];
  readonly methodology: string;
  /** False when we had no data and defaulted to a neutral severity. */
  readonly hasData: boolean;
}

export interface RiskAssessment {
  readonly computedAt: Instant;
  readonly methodologyVersion: string;
  readonly dimensions: readonly RiskSignalDetail[];
  /** Weighted mean severity across dimensions with data, 0..1. */
  readonly compositeSeverity: Unit01;
  readonly compositeBand: RiskBand;
  readonly coverage: Unit01;
  /** Dimensions at `elevated` or worse — the ones the verdict must mention. */
  readonly materialRisks: readonly RiskSignalDetail[];
}

export const bandFor = (severity: Unit01): RiskBand =>
  severity < 0.2 ? 'low' : severity < 0.4 ? 'moderate' : severity < 0.65 ? 'elevated' : 'high';

export const isMaterial = (d: RiskSignalDetail): boolean =>
  d.hasData && (d.band === 'elevated' || d.band === 'high');
