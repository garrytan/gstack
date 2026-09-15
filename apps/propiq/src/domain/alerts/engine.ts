/**
 * Alert evaluation.
 *
 * Pure: two snapshots in, alerts out. Scheduling and delivery live outside the
 * domain, so the same rules can back a nightly job, a webhook, or the manual
 * "check now" button on the dashboard without being reimplemented.
 */

import type { Instant } from '../shared/types';
import { round } from '../shared/types';
import { daysBetween } from '../evidence/freshness';
import { DECISION_LABELS } from '../decision/engine';
import { RISK_LABELS } from '../risk/types';
import type { Alert, AlertSeverity, PropertySnapshot } from './types';
import { ALERT_LABELS, ALERT_THRESHOLDS } from './types';

const pctChange = (before: number, after: number): number =>
  before === 0 ? 0 : ((after - before) / Math.abs(before)) * 100;

/** Verdict moves that matter more than others, so severity is not uniform. */
const verdictSeverity = (before: string, after: string): AlertSeverity => {
  if (after === 'AVOID') return 'urgent';
  if (before === 'BUY' && after !== 'BUY') return 'urgent';
  if (after === 'BUY') return 'attention';
  return 'attention';
};

export const evaluateAlerts = (
  before: PropertySnapshot,
  after: PropertySnapshot,
  now: Instant,
): readonly Alert[] => {
  const alerts: Alert[] = [];
  const base = { propertyId: after.propertyId, detectedAt: now };

  // --- Price -------------------------------------------------------------
  const priceDelta = pctChange(before.askingPrice, after.askingPrice);
  if (Math.abs(priceDelta) >= ALERT_THRESHOLDS.priceChangePercent) {
    const down = priceDelta < 0;
    alerts.push({
      ...base,
      kind: 'priceChange',
      label: ALERT_LABELS.priceChange,
      severity: 'attention',
      headline: `Asking price ${down ? 'dropped' : 'rose'} ${Math.abs(round(priceDelta, 1))}%`,
      detail: down
        ? 'A price cut on a property you are tracking. Worth re-checking the fair-value gap.'
        : 'The asking price went up. Your earlier negotiation position may no longer hold.',
      before: `₹${before.askingPrice.toLocaleString('en-IN')}`,
      after: `₹${after.askingPrice.toLocaleString('en-IN')}`,
      rule: `price.change>=${ALERT_THRESHOLDS.priceChangePercent}%`,
    });
  }

  // --- Fair value --------------------------------------------------------
  if (before.fairValueMid !== undefined && after.fairValueMid !== undefined) {
    const fvDelta = pctChange(before.fairValueMid, after.fairValueMid);
    if (Math.abs(fvDelta) >= ALERT_THRESHOLDS.fairValueChangePercent) {
      alerts.push({
        ...base,
        kind: 'fairValueChange',
        label: ALERT_LABELS.fairValueChange,
        severity: 'info',
        headline: `Fair value estimate moved ${round(fvDelta, 1)}%`,
        detail:
          'New comparable evidence changed what we think this is worth. The asking price has not ' +
          'necessarily moved with it.',
        before: `₹${before.fairValueMid.toLocaleString('en-IN')}`,
        after: `₹${after.fairValueMid.toLocaleString('en-IN')}`,
        rule: `fairValue.change>=${ALERT_THRESHOLDS.fairValueChangePercent}%`,
      });
    }
  }

  // --- Verdict -----------------------------------------------------------
  if (before.decision !== after.decision) {
    alerts.push({
      ...base,
      kind: 'verdictChange',
      label: ALERT_LABELS.verdictChange,
      severity: verdictSeverity(before.decision, after.decision),
      headline: `Verdict changed from ${DECISION_LABELS[before.decision]} to ${DECISION_LABELS[after.decision]}`,
      detail: 'The evidence moved enough to change the recommendation on this property.',
      before: DECISION_LABELS[before.decision],
      after: DECISION_LABELS[after.decision],
      rule: 'verdict.changed',
    });
  }

  // --- Score -------------------------------------------------------------
  if (before.score !== undefined && after.score !== undefined) {
    const delta = after.score - before.score;
    if (Math.abs(delta) >= ALERT_THRESHOLDS.scorePoints) {
      alerts.push({
        ...base,
        kind: 'scoreChange',
        label: ALERT_LABELS.scoreChange,
        severity: 'info',
        headline: `PropIQ Score moved ${delta > 0 ? '+' : ''}${round(delta, 1)} points`,
        detail: 'A move this size is larger than the usual confidence band, so something changed.',
        before: String(round(before.score, 1)),
        after: String(round(after.score, 1)),
        rule: `score.change>=${ALERT_THRESHOLDS.scorePoints}pts`,
      });
    }
  } else if (before.score !== undefined && after.score === undefined) {
    // Losing a score is a real event: the evidence thinned below the floor.
    alerts.push({
      ...base,
      kind: 'scoreChange',
      label: ALERT_LABELS.scoreChange,
      severity: 'attention',
      headline: 'PropIQ no longer publishes a score for this property',
      detail:
        'Evidence fell below the reporting floor, so the score was withdrawn rather than shown at ' +
        'low confidence.',
      before: String(round(before.score, 1)),
      after: 'not published',
      rule: 'score.withdrawn',
    });
  }

  // --- Possession --------------------------------------------------------
  if (
    before.possessionDate &&
    after.possessionDate &&
    before.possessionDate !== after.possessionDate
  ) {
    const slipDays = daysBetween(before.possessionDate, after.possessionDate);
    if (Math.abs(slipDays) >= ALERT_THRESHOLDS.possessionSlipDays) {
      const slipped = slipDays > 0;
      alerts.push({
        ...base,
        kind: 'possessionSlip',
        label: ALERT_LABELS.possessionSlip,
        severity: slipped ? 'urgent' : 'info',
        headline: `Possession moved ${Math.abs(Math.round(slipDays))} days ${slipped ? 'later' : 'earlier'}`,
        detail: slipped
          ? 'A slip on a committed possession date usually predicts further slips, and it feeds ' +
            'construction risk directly.'
          : 'The committed possession date was brought forward.',
        before: before.possessionDate.slice(0, 10),
        after: after.possessionDate.slice(0, 10),
        rule: `possession.slip>=${ALERT_THRESHOLDS.possessionSlipDays}d`,
      });
    }
  }

  // --- RERA --------------------------------------------------------------
  if (before.reraStatus !== after.reraStatus) {
    const worse = after.reraStatus !== 'registered';
    alerts.push({
      ...base,
      kind: 'reraChange',
      label: ALERT_LABELS.reraChange,
      severity: worse ? 'urgent' : 'attention',
      headline: `RERA status changed to ${after.reraStatus ?? 'unknown'}`,
      detail: worse
        ? 'A registration that is no longer active is a standing legal risk on an under-construction sale.'
        : 'The registration status improved.',
      before: before.reraStatus ?? 'unknown',
      after: after.reraStatus ?? 'unknown',
      rule: 'rera.statusChanged',
    });
  }

  // --- Risk --------------------------------------------------------------
  if (before.compositeRiskBand !== after.compositeRiskBand) {
    const order = ['low', 'moderate', 'elevated', 'high', 'unknown'];
    const worse = order.indexOf(after.compositeRiskBand) > order.indexOf(before.compositeRiskBand);
    alerts.push({
      ...base,
      kind: 'riskBandChange',
      label: ALERT_LABELS.riskBandChange,
      severity: worse ? 'urgent' : 'info',
      headline: `Composite risk moved from ${before.compositeRiskBand} to ${after.compositeRiskBand}`,
      detail: worse
        ? 'The risk profile deteriorated. Open the property to see which dimension moved.'
        : 'The risk profile improved.',
      before: before.compositeRiskBand,
      after: after.compositeRiskBand,
      rule: 'risk.bandChanged',
    });
  }

  // New material risk dimensions that were not material before.
  const newRisks = after.materialRiskDimensions.filter(
    (d) => !before.materialRiskDimensions.includes(d),
  );
  for (const dimension of newRisks) {
    alerts.push({
      ...base,
      kind: 'riskBandChange',
      label: RISK_LABELS[dimension],
      severity: 'attention',
      headline: `${RISK_LABELS[dimension]} became material`,
      detail: 'This dimension crossed into elevated territory and now affects the verdict.',
      before: 'not material',
      after: 'material',
      rule: `risk.${dimension}.becameMaterial`,
    });
  }

  // --- Evidence freshness ------------------------------------------------
  if (
    after.stalePercentage >= ALERT_THRESHOLDS.stalePercentage &&
    before.stalePercentage < ALERT_THRESHOLDS.stalePercentage
  ) {
    alerts.push({
      ...base,
      kind: 'evidenceStale',
      label: ALERT_LABELS.evidenceStale,
      severity: 'info',
      headline: `${Math.round(after.stalePercentage)}% of the evidence on this property is now stale`,
      detail:
        'Confidence decays with age, so the score on this property is being reported less ' +
        'confidently than it was.',
      before: `${Math.round(before.stalePercentage)}%`,
      after: `${Math.round(after.stalePercentage)}%`,
      rule: `evidence.stale>=${ALERT_THRESHOLDS.stalePercentage}%`,
    });
  }

  // Urgent first — the list is read top-down and rarely to the bottom.
  const rank: Readonly<Record<AlertSeverity, number>> = { urgent: 0, attention: 1, info: 2 };
  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);
};
