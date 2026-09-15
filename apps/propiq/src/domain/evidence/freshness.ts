/**
 * Staleness and confidence decay.
 *
 * Indian property data ages at very different rates: a RERA registration is
 * good for years, an asking price is stale in weeks. We express that as a
 * per-source-type half-life and decay evidence confidence against it, so a
 * two-year-old listing price cannot quietly carry the same weight as
 * yesterday's transaction.
 */

import type { Instant, Unit01 } from '../shared/types';
import { clamp01, round } from '../shared/types';
import type { Evidence, SourceType } from './types';

/** Days after which a fact from this source class is considered half as informative. */
export const SOURCE_HALF_LIFE_DAYS: Readonly<Record<SourceType, number>> = {
  rera: 540,
  registry: 720,
  developer: 120,
  listing: 45,
  transaction: 240,
  survey: 180,
  government: 365,
  partner: 90,
  user: 365,
  model: 60,
  fixture: 365,
};

export const STALE_AFTER_DAYS: Readonly<Record<SourceType, number>> = {
  rera: 365,
  registry: 545,
  developer: 90,
  listing: 30,
  transaction: 180,
  survey: 120,
  government: 270,
  partner: 60,
  user: 270,
  model: 45,
  fixture: 3650,
};

const MS_PER_DAY = 86_400_000;

export const daysBetween = (from: Instant, to: Instant): number => {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return (b - a) / MS_PER_DAY;
};

/** Age of the evidence in days, measured from the most recent verification we have. */
export const evidenceAgeDays = (evidence: Evidence, now: Instant): number =>
  daysBetween(evidence.lastVerifiedAt ?? evidence.observedAt, now);

export const isStale = (evidence: Evidence, now: Instant): boolean =>
  evidenceAgeDays(evidence, now) > STALE_AFTER_DAYS[evidence.source.type];

/**
 * Confidence after time decay: `confidence * 0.5 ^ (age / halfLife)`, then
 * multiplied by source trust. Disputed evidence is halved again — we keep
 * showing it, but it stops driving a verdict.
 */
export const effectiveConfidence = (evidence: Evidence, now: Instant): Unit01 => {
  const age = Math.max(0, evidenceAgeDays(evidence, now));
  const halfLife = SOURCE_HALF_LIFE_DAYS[evidence.source.type];
  const decay = halfLife > 0 ? 0.5 ** (age / halfLife) : 1;
  const disputePenalty = evidence.disputed ? 0.5 : 1;
  return clamp01(round(evidence.confidence * evidence.source.trust * decay * disputePenalty, 4));
};

export interface FreshnessSummary {
  readonly evaluatedAt: Instant;
  readonly oldestObservationDays: number;
  readonly newestObservationDays: number;
  readonly staleCount: number;
  readonly totalCount: number;
  readonly stalePercentage: number;
  /** Mean effective confidence across the evidence set, 0..1. */
  readonly meanConfidence: Unit01;
}

export const summarizeFreshness = (
  evidence: readonly Evidence[],
  now: Instant,
): FreshnessSummary => {
  if (evidence.length === 0) {
    return {
      evaluatedAt: now,
      oldestObservationDays: 0,
      newestObservationDays: 0,
      staleCount: 0,
      totalCount: 0,
      stalePercentage: 0,
      meanConfidence: 0,
    };
  }
  const ages = evidence.map((e) => Math.max(0, evidenceAgeDays(e, now)));
  const stale = evidence.filter((e) => isStale(e, now)).length;
  const confidences = evidence.map((e) => effectiveConfidence(e, now));
  const mean = confidences.reduce((a, b) => a + b, 0) / confidences.length;
  return {
    evaluatedAt: now,
    oldestObservationDays: round(Math.max(...ages), 1),
    newestObservationDays: round(Math.min(...ages), 1),
    staleCount: stale,
    totalCount: evidence.length,
    stalePercentage: round((stale / evidence.length) * 100, 1),
    meanConfidence: round(mean, 4),
  };
};
