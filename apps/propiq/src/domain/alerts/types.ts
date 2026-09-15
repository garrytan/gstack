/**
 * Alerts.
 *
 * An alert is a *material* change between two snapshots of a property's
 * intelligence. "Material" is doing the work: an alert that fires on every
 * one-point score wobble trains people to ignore alerts, which is worse than
 * having none. Every rule below carries an explicit threshold.
 */

import type { INR, Instant } from '../shared/types';
import type { Decision } from '../decision/engine';
import type { RiskBand, RiskDimension } from '../risk/types';

export const ALERT_KINDS = [
  'priceChange',
  'fairValueChange',
  'verdictChange',
  'scoreChange',
  'possessionSlip',
  'reraChange',
  'riskBandChange',
  'evidenceStale',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_LABELS: Readonly<Record<AlertKind, string>> = {
  priceChange: 'Asking price changed',
  fairValueChange: 'Fair value estimate moved',
  verdictChange: 'Verdict changed',
  scoreChange: 'PropIQ Score moved',
  possessionSlip: 'Possession date moved',
  reraChange: 'RERA status changed',
  riskBandChange: 'Risk band changed',
  evidenceStale: 'Evidence has gone stale',
};

export type AlertSeverity = 'info' | 'attention' | 'urgent';

export interface Alert {
  readonly kind: AlertKind;
  readonly label: string;
  readonly severity: AlertSeverity;
  readonly propertyId: string;
  readonly headline: string;
  readonly detail: string;
  readonly before: string;
  readonly after: string;
  readonly detectedAt: Instant;
  /** Which rule fired, so an alert can always be traced to its threshold. */
  readonly rule: string;
}

/**
 * The comparable slice of a property's intelligence.
 *
 * Deliberately a flat, small shape rather than the whole payload: snapshots are
 * stored per evaluation, and storing a full intelligence payload per property
 * per day would grow without bound for no added signal.
 */
export interface PropertySnapshot {
  readonly propertyId: string;
  readonly capturedAt: Instant;
  readonly askingPrice: INR;
  readonly fairValueMid: INR | undefined;
  readonly score: number | undefined;
  readonly decision: Decision;
  readonly reraStatus: string | undefined;
  readonly possessionDate: string | undefined;
  readonly compositeRiskBand: RiskBand;
  readonly materialRiskDimensions: readonly RiskDimension[];
  readonly stalePercentage: number;
}

/** Published thresholds. An alert below any of these is noise, and is not sent. */
export const ALERT_THRESHOLDS = {
  /** Percent change in asking price worth telling someone about. */
  priceChangePercent: 1.5,
  /** Percent move in the central fair-value estimate. */
  fairValueChangePercent: 3,
  /** Score points. Smaller moves are inside the confidence band anyway. */
  scorePoints: 4,
  /** Days of possession slip. */
  possessionSlipDays: 30,
  /** Share of evidence stale before we say the record needs refreshing. */
  stalePercentage: 40,
} as const;
