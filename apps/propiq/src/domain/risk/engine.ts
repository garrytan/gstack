/**
 * Risk assessment.
 *
 * Each dimension is computed from named inputs and carries its own drivers, so
 * the Property Intelligence Page can always answer "why is this elevated?".
 * A dimension with no data returns `hasData: false` and a neutral severity that
 * is excluded from the composite rather than silently scored as safe.
 */

import type { Instant } from '../shared/types';
import { clamp01, round } from '../shared/types';
import { daysBetween } from '../evidence/freshness';
import type { Developer, Project, Property } from '../property/types';
import type { Locality } from '../locality/types';
import { supplyOverhangMonths } from '../locality/types';
import type { Valuation } from '../valuation/types';
import type { RiskAssessment, RiskDimension, RiskSignalDetail } from './types';
import { RISK_LABELS, bandFor, isMaterial } from './types';

export const RISK_METHODOLOGY_VERSION = '0.1.0';

export interface RiskInput {
  readonly property: Property;
  readonly project?: Project;
  readonly developer?: Developer;
  readonly locality?: Locality;
  readonly valuation?: Valuation;
  readonly now: Instant;
}

const DIMENSION_WEIGHTS: Readonly<Record<RiskDimension, number>> = {
  legal: 0.2,
  construction: 0.16,
  developer: 0.14,
  market: 0.12,
  valuation: 0.1,
  liquidity: 0.1,
  water: 0.07,
  flood: 0.07,
  infrastructure: 0.04,
};

const detail = (
  dimension: RiskDimension,
  severity: number | undefined,
  drivers: readonly string[],
  evidenceFields: readonly string[],
  methodology: string,
  confidence: number,
): RiskSignalDetail => {
  const hasData = severity !== undefined;
  const value = clamp01(severity ?? 0.5);
  return {
    dimension,
    label: RISK_LABELS[dimension],
    severity: round(value, 3),
    band: hasData ? bandFor(value) : 'unknown',
    weight: DIMENSION_WEIGHTS[dimension],
    confidence: clamp01(hasData ? confidence : 0),
    drivers,
    evidenceFields,
    methodology,
    hasData,
  };
};

const legalRisk = (input: RiskInput): RiskSignalDetail => {
  const phase = input.project?.phases[0];
  const rera = phase?.rera;
  const drivers: string[] = [];
  if (!rera) {
    return detail(
      'legal',
      undefined,
      ['No RERA registration record found for this phase.'],
      ['phase.rera'],
      'Severity from RERA status, validity window and developer litigation count.',
      0,
    );
  }
  let severity = 0;
  switch (rera.status) {
    case 'registered':
      severity += 0.05;
      drivers.push(`RERA registered (${rera.number}).`);
      break;
    case 'expired':
      severity += 0.5;
      drivers.push('RERA registration has expired.');
      break;
    case 'lapsed':
      severity += 0.65;
      drivers.push('RERA registration has lapsed.');
      break;
    case 'notRegistered':
      severity += 0.9;
      drivers.push('Project phase is not RERA registered.');
      break;
    case 'unknown':
      severity += 0.45;
      drivers.push('RERA status could not be confirmed.');
      break;
  }
  if (rera.validUntil && phase?.currentPossession) {
    if (Date.parse(rera.validUntil) < Date.parse(phase.currentPossession)) {
      severity += 0.25;
      drivers.push('RERA validity expires before the committed possession date.');
    }
  }
  const litigation = input.developer?.ongoingLitigationCount ?? 0;
  if (litigation > 0) {
    severity += clamp01(litigation / 20) * 0.3;
    drivers.push(`${litigation} ongoing litigation matter(s) against the developer.`);
  }
  return detail(
    'legal',
    severity,
    drivers,
    ['phase.rera.status', 'phase.rera.validUntil', 'developer.ongoingLitigationCount'],
    'Severity from RERA status, validity window and developer litigation count.',
    0.8,
  );
};

const constructionRisk = (input: RiskInput): RiskSignalDetail => {
  const { property, project, developer } = input;
  if (property.constructionStatus === 'readyToMove' || property.constructionStatus === 'resale') {
    return detail(
      'construction',
      0.02,
      ['Property is complete; no delivery risk remains.'],
      ['property.constructionStatus'],
      'Completed stock carries near-zero construction risk by definition.',
      0.95,
    );
  }
  const phase = project?.phases[0];
  if (!phase) {
    return detail(
      'construction',
      undefined,
      ['No construction progress data available.'],
      ['phase.completionPercent'],
      'Severity from remaining work versus remaining time, adjusted for the developer delay record.',
      0,
    );
  }
  const drivers: string[] = [];
  const completion = phase.completionPercent ?? 0;
  const remainingWork = clamp01((100 - completion) / 100);
  drivers.push(`Phase is ${completion}% complete.`);

  let severity = remainingWork * 0.6;

  if (phase.currentPossession) {
    const monthsToPossession = daysBetween(input.now, phase.currentPossession) / 30.44;
    drivers.push(`${round(monthsToPossession, 1)} months to committed possession.`);
    // Lots of work left and little time is the classic pre-delay signature.
    if (monthsToPossession > 0 && remainingWork > 0.4 && monthsToPossession < 12) {
      severity += 0.2;
      drivers.push('Remaining work looks large relative to the time left.');
    }
    if (monthsToPossession < 0) {
      severity += 0.3;
      drivers.push('Committed possession date has already passed.');
    }
  }

  if (phase.promisedPossession && phase.currentPossession) {
    const slipMonths = daysBetween(phase.promisedPossession, phase.currentPossession) / 30.44;
    if (slipMonths > 1) {
      severity += clamp01(slipMonths / 24) * 0.25;
      drivers.push(
        `Possession has already slipped ${round(slipMonths, 1)} months from the original date.`,
      );
    }
  }

  const delay = developer?.averageDelayMonths;
  if (delay !== undefined && delay > 0) {
    severity += clamp01(delay / 24) * 0.25;
    drivers.push(`Developer averages ${delay} months of delay across delivered projects.`);
  }

  return detail(
    'construction',
    severity,
    drivers,
    ['phase.completionPercent', 'phase.currentPossession', 'developer.averageDelayMonths'],
    'Severity from remaining work versus remaining time, adjusted for the developer delay record.',
    0.75,
  );
};

const developerRisk = (input: RiskInput): RiskSignalDetail => {
  const d = input.developer;
  if (!d) {
    return detail(
      'developer',
      undefined,
      ['No developer record available.'],
      ['developer'],
      'Severity from delivery volume, delay record and complaint count.',
      0,
    );
  }
  const drivers: string[] = [];
  let severity = 0;
  const delivered = d.unitsDelivered ?? 0;
  // A developer with little delivered history is a counterparty risk regardless
  // of how good the brochure is.
  severity += clamp01(1 - delivered / 4000) * 0.4;
  drivers.push(`${delivered.toLocaleString('en-IN')} units delivered to date.`);

  if (d.averageDelayMonths !== undefined) {
    severity += clamp01(d.averageDelayMonths / 24) * 0.35;
    drivers.push(`Average handover delay of ${d.averageDelayMonths} months.`);
  }
  if (d.reraComplaintsCount !== undefined) {
    severity += clamp01(d.reraComplaintsCount / 40) * 0.25;
    drivers.push(`${d.reraComplaintsCount} RERA complaint(s) on record.`);
  }
  return detail(
    'developer',
    severity,
    drivers,
    ['developer.unitsDelivered', 'developer.averageDelayMonths', 'developer.reraComplaintsCount'],
    'Severity from delivery volume, delay record and complaint count.',
    0.7,
  );
};

const marketRisk = (input: RiskInput): RiskSignalDetail => {
  const l = input.locality;
  if (!l) {
    return detail(
      'market',
      undefined,
      ['No locality market data.'],
      ['locality'],
      'Severity from supply overhang and price-history depth.',
      0,
    );
  }
  const drivers: string[] = [];
  let severity = 0.15;
  const overhang = supplyOverhangMonths(l);
  if (overhang !== undefined) {
    severity += clamp01((overhang - 12) / 36) * 0.5;
    drivers.push(`${round(overhang, 1)} months of unsold inventory at current absorption.`);
  }
  if (l.priceHistory.length < 6) {
    severity += 0.15;
    drivers.push('Short price history limits confidence in the local trend.');
  }
  return detail(
    'market',
    severity,
    drivers,
    ['locality.activeSupplyUnits', 'locality.annualAbsorptionUnits', 'locality.priceHistory'],
    'Severity from supply overhang and price-history depth.',
    0.65,
  );
};

const liquidityRisk = (input: RiskInput): RiskSignalDetail => {
  const l = input.locality;
  const txCount = l?.priceHistory.at(-1)?.transactionCount;
  if (!l || txCount === undefined) {
    return detail(
      'liquidity',
      undefined,
      ['No transaction-depth data for this locality.'],
      ['locality.priceHistory'],
      'Severity from recent transaction depth and ticket size.',
      0,
    );
  }
  const drivers = [`${txCount} recorded transactions in the latest period.`];
  let severity = clamp01(1 - txCount / 100) * 0.7;
  // Large tickets are structurally harder to exit in Indian resale markets.
  if (input.property.askingPrice > 30_000_000) {
    severity += 0.15;
    drivers.push('Ticket size above ₹3 crore narrows the resale buyer pool.');
  }
  return detail(
    'liquidity',
    severity,
    drivers,
    ['locality.priceHistory', 'property.askingPrice'],
    'Severity from recent transaction depth and ticket size.',
    0.6,
  );
};

const waterRisk = (input: RiskInput): RiskSignalDetail => {
  const stress = input.locality?.environment.waterStress;
  if (stress === undefined) {
    return detail(
      'water',
      undefined,
      ['No water-stress data for this locality.'],
      ['locality.environment.waterStress'],
      'Severity is the modelled water-stress index.',
      0,
    );
  }
  return detail(
    'water',
    stress,
    [`Modelled water-stress index of ${round(stress, 2)} for this locality.`],
    ['locality.environment.waterStress'],
    'Severity is the modelled water-stress index.',
    0.55,
  );
};

const floodRisk = (input: RiskInput): RiskSignalDetail => {
  const flood = input.locality?.environment.floodRisk;
  if (flood === undefined) {
    return detail(
      'flood',
      undefined,
      ['No flood-exposure model for this locality.'],
      ['locality.environment.floodRisk'],
      'Severity is modelled 1-in-50-year flood exposure.',
      0,
    );
  }
  return detail(
    'flood',
    flood,
    [`Modelled 1-in-50-year flood exposure of ${round(flood, 2)}.`],
    ['locality.environment.floodRisk'],
    'Severity is modelled 1-in-50-year flood exposure.',
    0.55,
  );
};

const infrastructureRisk = (input: RiskInput): RiskSignalDetail => {
  const l = input.locality;
  if (!l) {
    return detail(
      'infrastructure',
      undefined,
      ['No infrastructure pipeline data.'],
      ['locality.pipeline'],
      'Severity rises when locality value depends on uncommitted projects.',
      0,
    );
  }
  const uncommitted = l.pipeline.filter((p) => p.status === 'announced' || p.status === 'approved');
  const committed = l.pipeline.filter(
    (p) => p.status === 'funded' || p.status === 'underConstruction' || p.status === 'commissioned',
  );
  const drivers: string[] = [];
  let severity = 0.1;
  if (uncommitted.length > 0 && committed.length === 0) {
    severity += 0.55;
    drivers.push(
      `${uncommitted.length} infrastructure project(s) are announced or approved but not funded. ` +
        'Locality upside depends on work that has not been committed.',
    );
  } else if (committed.length > 0) {
    drivers.push(`${committed.length} infrastructure project(s) funded or under construction.`);
  }
  return detail(
    'infrastructure',
    severity,
    drivers,
    ['locality.pipeline'],
    'Severity rises when locality value depends on uncommitted projects.',
    0.6,
  );
};

const valuationRisk = (input: RiskInput): RiskSignalDetail => {
  const v = input.valuation;
  if (!v || v.insufficientEvidence) {
    return detail(
      'valuation',
      undefined,
      ['Not enough comparables to form a fair-value view.'],
      ['valuation'],
      'Severity from asking-price deviation above fair value and valuation confidence.',
      0,
    );
  }
  const drivers: string[] = [];
  let severity = 0.1;
  if (v.askingDeviationPercent > 0) {
    severity += clamp01(v.askingDeviationPercent / 25) * 0.6;
    drivers.push(`Asking price is ${v.askingDeviationPercent}% above the central estimate.`);
  } else {
    drivers.push(
      `Asking price is ${Math.abs(v.askingDeviationPercent)}% below the central estimate.`,
    );
  }
  severity += (1 - v.confidence) * 0.3;
  if (v.confidence < 0.5)
    drivers.push('Comparable set is thin, so the estimate itself is uncertain.');
  return detail(
    'valuation',
    severity,
    drivers,
    ['valuation'],
    'Severity from asking-price deviation above fair value and valuation confidence.',
    v.confidence,
  );
};

export const assessRisk = (input: RiskInput): RiskAssessment => {
  const dimensions: RiskSignalDetail[] = [
    legalRisk(input),
    constructionRisk(input),
    developerRisk(input),
    marketRisk(input),
    valuationRisk(input),
    liquidityRisk(input),
    waterRisk(input),
    floodRisk(input),
    infrastructureRisk(input),
  ];

  const withData = dimensions.filter((d) => d.hasData);
  const totalWeight = withData.reduce((a, d) => a + d.weight, 0);
  const compositeSeverity =
    totalWeight > 0
      ? round(withData.reduce((a, d) => a + d.severity * d.weight, 0) / totalWeight, 3)
      : 0;
  const coverage = round(totalWeight / dimensions.reduce((a, d) => a + d.weight, 0), 3);

  return {
    computedAt: input.now,
    methodologyVersion: RISK_METHODOLOGY_VERSION,
    dimensions,
    compositeSeverity,
    compositeBand: totalWeight > 0 ? bandFor(compositeSeverity) : 'unknown',
    coverage,
    materialRisks: dimensions.filter(isMaterial),
  };
};
