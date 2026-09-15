/**
 * Signal builders — one function per pillar.
 *
 * Each builder returns a list of `Signal`s. A signal whose `normalized` is
 * undefined means "we did not have the data", which is materially different
 * from "we had the data and it was bad". The aggregator renormalizes weights
 * over the signals that do have data and reports the resulting coverage, so a
 * thin record produces a low-confidence score rather than a confidently wrong one.
 */

import type { Instant, Unit01 } from '../shared/types';
import { clamp01 } from '../shared/types';
import type { Evidence } from '../evidence/types';
import { effectiveConfidence, isStale } from '../evidence/freshness';
import type { Developer, Project, Property } from '../property/types';
import { carpetEfficiency, carpetPricePerSqFt } from '../property/types';
import type { Locality } from '../locality/types';
import { bestCommute, priceCagrPercent, supplyOverhangMonths } from '../locality/types';
import type { BuyerProfile } from '../buyer/types';
import type { RiskAssessment } from '../risk/types';
import type { Valuation } from '../valuation/types';
import type { InvestmentMetrics } from '../investment/types';
import type { Signal } from './types';
import { bandedIdeal, fromTable, higherIsBetter, logistic, lowerIsBetter } from './normalize';

export interface ScoringInput {
  readonly property: Property;
  readonly project?: Project;
  readonly developer?: Developer;
  readonly locality?: Locality;
  readonly valuation?: Valuation;
  readonly investment?: InvestmentMetrics;
  readonly risk?: RiskAssessment;
  readonly buyer?: BuyerProfile;
  readonly now: Instant;
}

/** Confidence for a signal, taken from the evidence backing its fields. */
export const confidenceFor = (
  evidence: readonly Evidence[],
  fields: readonly string[],
  now: Instant,
): Unit01 => {
  const matched = evidence.filter((e) => fields.includes(e.field));
  if (matched.length === 0) return 0.3; // structural data present but unattested
  const scores = matched.map((e) => effectiveConfidence(e, now));
  return clamp01(scores.reduce((a, b) => a + b, 0) / scores.length);
};

const sig = (
  s: Omit<Signal, 'confidence'> & { confidence?: Unit01 },
  input: ScoringInput,
): Signal => ({
  ...s,
  confidence: s.confidence ?? confidenceFor(input.property.evidence, s.evidenceFields, input.now),
});

// ---------------------------------------------------------------------------
// Value
// ---------------------------------------------------------------------------

export const valueSignals = (input: ScoringInput): Signal[] => {
  const { property, valuation, locality } = input;
  const carpetPsf = carpetPricePerSqFt(property);
  const localityPsf = locality?.currentMedianPricePerSqFt;
  const out: Signal[] = [];

  // Deviation from our own fair-value estimate. Negative deviation = underpriced.
  out.push(
    sig(
      {
        key: 'value.fairValueDeviation',
        label: 'Asking price vs fair value',
        raw: valuation ? valuation.askingDeviationPercent : undefined,
        unit: '%',
        // -12% is about as good as it gets before the discount signals a problem;
        // +20% over fair value scores zero.
        normalized:
          valuation === undefined
            ? undefined
            : bandedIdeal(valuation.askingDeviationPercent, -12, 32),
        weight: 0.45,
        evidenceFields: ['property.askingPrice'],
        methodology:
          'bandedIdeal(deviation%, ideal=-12, tolerance=32) over valuation v' +
          (valuation?.methodologyVersion ?? 'n/a'),
      },
      input,
    ),
  );

  // Price against the locality median on a carpet-area basis.
  const psfRatio = carpetPsf && localityPsf ? carpetPsf / localityPsf : undefined;
  out.push(
    sig(
      {
        key: 'value.vsLocalityMedian',
        label: 'Carpet ₹/sqft vs locality median',
        raw: psfRatio === undefined ? undefined : Number(psfRatio.toFixed(3)),
        unit: '×',
        normalized: psfRatio === undefined ? undefined : lowerIsBetter(psfRatio, 0.85, 1.45),
        weight: 0.3,
        evidenceFields: ['property.askingPrice', 'locality.medianPricePerSqFt'],
        methodology: 'lowerIsBetter(carpetPsf / localityMedianPsf, best=0.85, worst=1.45)',
      },
      input,
    ),
  );

  // Carpet efficiency: how much of what you pay for is actually usable floor.
  const efficiency = carpetEfficiency(property);
  out.push(
    sig(
      {
        key: 'value.carpetEfficiency',
        label: 'Carpet-to-quoted area efficiency',
        raw: efficiency === undefined ? undefined : Number((efficiency * 100).toFixed(1)),
        unit: '%',
        normalized: efficiency === undefined ? undefined : higherIsBetter(efficiency, 0.55, 0.82),
        weight: 0.25,
        evidenceFields: ['property.carpetAreaSqFt', 'property.areaSqFt'],
        methodology: 'higherIsBetter(carpet / quoted area, min=0.55, max=0.82)',
      },
      input,
    ),
  );

  return out;
};

// ---------------------------------------------------------------------------
// Legal
// ---------------------------------------------------------------------------

export const legalSignals = (input: ScoringInput): Signal[] => {
  const { project, property } = input;
  const phase =
    project?.phases.find((p) => p.constructionStatus === property.constructionStatus) ??
    project?.phases[0];
  const rera = phase?.rera;

  return [
    sig(
      {
        key: 'legal.reraStatus',
        label: 'RERA registration',
        raw: rera?.status,
        normalized:
          rera === undefined
            ? undefined
            : fromTable(rera.status, {
                registered: 1,
                expired: 0.35,
                lapsed: 0.2,
                notRegistered: 0,
                unknown: 0.4,
              }),
        weight: 0.5,
        evidenceFields: ['phase.rera.status', 'phase.rera.number'],
        methodology: 'Lookup table over RERA registration status for the relevant phase.',
      },
      input,
    ),
    sig(
      {
        key: 'legal.reraValidity',
        label: 'RERA validity vs possession date',
        raw: rera?.validUntil,
        // A registration that expires before the promised possession date is a
        // standing red flag in Indian under-construction sales.
        normalized:
          rera?.validUntil && phase?.currentPossession
            ? Date.parse(rera.validUntil) >= Date.parse(phase.currentPossession)
              ? 1
              : 0.15
            : undefined,
        weight: 0.2,
        evidenceFields: ['phase.rera.validUntil', 'phase.currentPossession'],
        methodology: 'Binary: RERA validity must outlast the current possession commitment.',
      },
      input,
    ),
    sig(
      {
        key: 'legal.developerLitigation',
        label: 'Developer litigation exposure',
        raw: input.developer?.ongoingLitigationCount,
        normalized:
          input.developer?.ongoingLitigationCount === undefined
            ? undefined
            : lowerIsBetter(input.developer.ongoingLitigationCount, 0, 12),
        weight: 0.3,
        evidenceFields: ['developer.ongoingLitigationCount'],
        methodology: 'lowerIsBetter(ongoing litigation count, best=0, worst=12)',
      },
      input,
    ),
  ];
};

// ---------------------------------------------------------------------------
// Developer
// ---------------------------------------------------------------------------

export const developerSignals = (input: ScoringInput): Signal[] => {
  const d = input.developer;
  return [
    sig(
      {
        key: 'developer.deliveryVolume',
        label: 'Units delivered',
        raw: d?.unitsDelivered,
        normalized:
          d?.unitsDelivered === undefined ? undefined : logistic(d.unitsDelivered, 2500, 0.0009),
        weight: 0.3,
        evidenceFields: ['developer.unitsDelivered'],
        methodology: 'logistic(unitsDelivered, midpoint=2500, steepness=0.0009)',
      },
      input,
    ),
    sig(
      {
        key: 'developer.delayRecord',
        label: 'Average handover delay',
        raw: d?.averageDelayMonths,
        unit: 'months',
        normalized:
          d?.averageDelayMonths === undefined
            ? undefined
            : lowerIsBetter(d.averageDelayMonths, 0, 30),
        weight: 0.45,
        evidenceFields: ['developer.averageDelayMonths'],
        methodology: 'lowerIsBetter(mean delay months, best=0, worst=30)',
      },
      input,
    ),
    sig(
      {
        key: 'developer.reraComplaints',
        label: 'RERA complaints filed',
        raw: d?.reraComplaintsCount,
        normalized:
          d?.reraComplaintsCount === undefined
            ? undefined
            : lowerIsBetter(d.reraComplaintsCount, 0, 40),
        weight: 0.25,
        evidenceFields: ['developer.reraComplaintsCount'],
        methodology: 'lowerIsBetter(RERA complaints, best=0, worst=40)',
      },
      input,
    ),
  ];
};

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export const projectSignals = (input: ScoringInput): Signal[] => {
  const p = input.project;
  const phase = p?.phases[0];
  return [
    sig(
      {
        key: 'project.openSpace',
        label: 'Open space',
        raw: p?.openSpacePercent,
        unit: '%',
        normalized:
          p?.openSpacePercent === undefined
            ? undefined
            : higherIsBetter(p.openSpacePercent, 20, 70),
        weight: 0.3,
        evidenceFields: ['project.openSpacePercent'],
        methodology: 'higherIsBetter(open space %, min=20, max=70)',
      },
      input,
    ),
    sig(
      {
        key: 'project.density',
        label: 'Units per acre',
        raw:
          p?.totalUnits && p?.landAreaAcres
            ? Number((p.totalUnits / p.landAreaAcres).toFixed(1))
            : undefined,
        unit: 'units/acre',
        // ~45 units/acre is comfortable in Indian metros; 160+ is tower-farm density.
        normalized:
          p?.totalUnits && p?.landAreaAcres
            ? lowerIsBetter(p.totalUnits / p.landAreaAcres, 45, 160)
            : undefined,
        weight: 0.35,
        evidenceFields: ['project.totalUnits', 'project.landAreaAcres'],
        methodology: 'lowerIsBetter(units per acre, best=45, worst=160)',
      },
      input,
    ),
    sig(
      {
        key: 'project.amenityDepth',
        label: 'Amenity count',
        raw: p?.amenities.length,
        normalized: p === undefined ? undefined : higherIsBetter(p.amenities.length, 3, 25),
        weight: 0.15,
        evidenceFields: ['project.amenities'],
        methodology: 'higherIsBetter(amenity count, min=3, max=25)',
      },
      input,
    ),
    sig(
      {
        key: 'project.constructionProgress',
        label: 'Construction progress',
        raw: phase?.completionPercent,
        unit: '%',
        normalized:
          phase?.completionPercent === undefined
            ? undefined
            : higherIsBetter(phase.completionPercent, 0, 100),
        weight: 0.2,
        evidenceFields: ['phase.completionPercent'],
        methodology: 'higherIsBetter(completion %, min=0, max=100)',
      },
      input,
    ),
  ];
};

// ---------------------------------------------------------------------------
// Unit
// ---------------------------------------------------------------------------

export const unitSignals = (input: ScoringInput): Signal[] => {
  const { property } = input;
  const floorRatio =
    property.floor !== undefined && property.totalFloors
      ? property.floor / property.totalFloors
      : undefined;

  return [
    sig(
      {
        key: 'unit.floorPosition',
        label: 'Floor position',
        raw: property.floor,
        // Mid-to-upper floors trade best: away from street noise, below the
        // top-floor heat penalty that matters in most Indian cities.
        normalized: floorRatio === undefined ? undefined : bandedIdeal(floorRatio, 0.62, 0.55),
        weight: 0.25,
        evidenceFields: ['property.floor'],
        methodology: 'bandedIdeal(floor / totalFloors, ideal=0.62, tolerance=0.55)',
      },
      input,
    ),
    sig(
      {
        key: 'unit.facing',
        label: 'Facing',
        raw: property.facing,
        // Vastu preference and thermal load both favour N/E in most of India.
        normalized: fromTable(
          property.facing,
          { N: 0.9, NE: 1, E: 0.95, SE: 0.6, S: 0.45, SW: 0.3, W: 0.4, NW: 0.7 },
          0.5,
        ),
        weight: 0.2,
        evidenceFields: ['property.facing'],
        methodology: 'Lookup table over compass facing (thermal load + resale preference).',
      },
      input,
    ),
    sig(
      {
        key: 'unit.bathroomRatio',
        label: 'Bathrooms per bedroom',
        raw:
          property.bedrooms > 0
            ? Number((property.bathrooms / property.bedrooms).toFixed(2))
            : undefined,
        normalized:
          property.bedrooms > 0
            ? higherIsBetter(property.bathrooms / property.bedrooms, 0.5, 1.1)
            : undefined,
        weight: 0.2,
        evidenceFields: ['property.bathrooms', 'property.bedrooms'],
        methodology: 'higherIsBetter(bathrooms / bedrooms, min=0.5, max=1.1)',
      },
      input,
    ),
    sig(
      {
        key: 'unit.areaPerBedroom',
        label: 'Carpet area per bedroom',
        raw:
          property.carpetAreaSqFt && property.bedrooms > 0
            ? Math.round(property.carpetAreaSqFt / property.bedrooms)
            : undefined,
        unit: 'sqft',
        normalized:
          property.carpetAreaSqFt && property.bedrooms > 0
            ? higherIsBetter(property.carpetAreaSqFt / property.bedrooms, 230, 420)
            : undefined,
        weight: 0.35,
        evidenceFields: ['property.carpetAreaSqFt'],
        methodology: 'higherIsBetter(carpet sqft per bedroom, min=230, max=420)',
      },
      input,
    ),
  ];
};

// ---------------------------------------------------------------------------
// Location / infrastructure / livability
// ---------------------------------------------------------------------------

export const locationSignals = (input: ScoringInput): Signal[] => {
  const l = input.locality;
  const commute = l ? bestCommute(l) : undefined;
  return [
    sig(
      {
        key: 'location.peakCommute',
        label: 'Peak commute to nearest employment hub',
        raw: commute?.peakCommuteMinutes,
        unit: 'min',
        normalized:
          commute === undefined ? undefined : lowerIsBetter(commute.peakCommuteMinutes, 15, 90),
        weight: 0.4,
        evidenceFields: ['locality.employment'],
        methodology: 'lowerIsBetter(best peak commute minutes, best=15, worst=90)',
      },
      input,
    ),
    sig(
      {
        key: 'location.metroDistance',
        label: 'Distance to metro',
        raw: l?.transit.metroDistanceKm,
        unit: 'km',
        normalized:
          l?.transit.metroDistanceKm === undefined
            ? undefined
            : lowerIsBetter(l.transit.metroDistanceKm, 0.5, 8),
        weight: 0.35,
        evidenceFields: ['locality.transit.metroDistanceKm'],
        methodology: 'lowerIsBetter(km to nearest metro station, best=0.5, worst=8)',
      },
      input,
    ),
    sig(
      {
        key: 'location.socialInfra',
        label: 'Schools within 3 km',
        raw: l?.social.schoolsWithin3Km,
        normalized:
          l?.social.schoolsWithin3Km === undefined
            ? undefined
            : higherIsBetter(l.social.schoolsWithin3Km, 1, 18),
        weight: 0.25,
        evidenceFields: ['locality.social.schoolsWithin3Km'],
        methodology: 'higherIsBetter(schools within 3km, min=1, max=18)',
      },
      input,
    ),
  ];
};

export const infrastructureSignals = (input: ScoringInput): Signal[] => {
  const l = input.locality;
  // Only funded-or-later pipeline items count. Announcements are not infrastructure.
  const committed = l?.pipeline.filter((i) =>
    ['funded', 'underConstruction', 'commissioned'].includes(i.status),
  );
  return [
    sig(
      {
        key: 'infrastructure.committedPipeline',
        label: 'Committed infrastructure projects',
        raw: committed?.length,
        normalized: committed === undefined ? undefined : higherIsBetter(committed.length, 0, 5),
        weight: 0.55,
        evidenceFields: ['locality.pipeline'],
        methodology:
          'higherIsBetter(count of pipeline items at funded/underConstruction/commissioned, min=0, max=5). ' +
          'Announced and approved items are deliberately excluded.',
      },
      input,
    ),
    sig(
      {
        key: 'infrastructure.metroEta',
        label: 'Metro arrival horizon',
        raw: l?.transit.metroEtaMonths,
        unit: 'months',
        normalized:
          l?.transit.metroEtaMonths === undefined
            ? undefined
            : lowerIsBetter(l.transit.metroEtaMonths, 0, 72),
        weight: 0.45,
        evidenceFields: ['locality.transit.metroEtaMonths'],
        methodology: 'lowerIsBetter(months until metro opens, best=0, worst=72)',
      },
      input,
    ),
  ];
};

export const livabilitySignals = (input: ScoringInput): Signal[] => {
  const env = input.locality?.environment;
  return [
    sig(
      {
        key: 'livability.airQuality',
        label: 'Annual mean PM2.5',
        raw: env?.pm25Annual,
        unit: 'µg/m³',
        // WHO guideline is 5; 100+ is among the worst urban air in the country.
        normalized:
          env?.pm25Annual === undefined ? undefined : lowerIsBetter(env.pm25Annual, 15, 100),
        weight: 0.3,
        evidenceFields: ['locality.environment.pm25Annual'],
        methodology: 'lowerIsBetter(annual mean PM2.5, best=15, worst=100)',
      },
      input,
    ),
    sig(
      {
        key: 'livability.waterStress',
        label: 'Water supply stress',
        raw: env?.waterStress,
        normalized: env?.waterStress === undefined ? undefined : 1 - clamp01(env.waterStress),
        weight: 0.35,
        evidenceFields: ['locality.environment.waterStress'],
        methodology: '1 - waterStress (0..1 modelled supply stress index)',
      },
      input,
    ),
    sig(
      {
        key: 'livability.traffic',
        label: 'Peak traffic congestion index',
        raw: env?.averagePeakTrafficIndex,
        normalized:
          env?.averagePeakTrafficIndex === undefined
            ? undefined
            : lowerIsBetter(env.averagePeakTrafficIndex, 1.1, 2.6),
        weight: 0.2,
        evidenceFields: ['locality.environment.averagePeakTrafficIndex'],
        methodology: 'lowerIsBetter(peak travel-time index, best=1.1, worst=2.6)',
      },
      input,
    ),
    sig(
      {
        key: 'livability.parks',
        label: 'Parks within 2 km',
        raw: input.locality?.social.parksWithin2Km,
        normalized:
          input.locality?.social.parksWithin2Km === undefined
            ? undefined
            : higherIsBetter(input.locality.social.parksWithin2Km, 0, 8),
        weight: 0.15,
        evidenceFields: ['locality.social.parksWithin2Km'],
        methodology: 'higherIsBetter(parks within 2km, min=0, max=8)',
      },
      input,
    ),
  ];
};

// ---------------------------------------------------------------------------
// Investment / liquidity
// ---------------------------------------------------------------------------

export const investmentSignals = (input: ScoringInput): Signal[] => {
  const inv = input.investment;
  const cagr = input.locality ? priceCagrPercent(input.locality.priceHistory) : undefined;
  return [
    sig(
      {
        key: 'investment.grossYield',
        label: 'Gross rental yield',
        raw: inv?.grossYieldPercent,
        unit: '%',
        // Indian residential rarely clears 4.5%; 1.8% is the floor of viability.
        normalized:
          inv?.grossYieldPercent === undefined
            ? undefined
            : higherIsBetter(inv.grossYieldPercent, 1.8, 4.5),
        weight: 0.4,
        evidenceFields: ['property.expectedRentPerMonth', 'property.askingPrice'],
        methodology: 'higherIsBetter(gross yield %, min=1.8, max=4.5)',
      },
      input,
    ),
    sig(
      {
        key: 'investment.localityCagr',
        label: 'Locality price CAGR',
        raw: cagr === undefined ? undefined : Number(cagr.toFixed(2)),
        unit: '%',
        normalized: cagr === undefined ? undefined : higherIsBetter(cagr, 0, 14),
        weight: 0.35,
        evidenceFields: ['locality.priceHistory'],
        methodology: 'higherIsBetter(price CAGR over available history, min=0, max=14)',
      },
      input,
    ),
    sig(
      {
        key: 'investment.projectedIrr',
        label: 'Projected IRR (base case)',
        raw: inv?.irrPercent === undefined ? undefined : Number(inv.irrPercent.toFixed(2)),
        unit: '%',
        normalized:
          inv?.irrPercent === undefined ? undefined : higherIsBetter(inv.irrPercent, 2, 18),
        weight: 0.25,
        evidenceFields: ['investment.assumptions'],
        methodology: 'higherIsBetter(levered IRR %, min=2, max=18)',
      },
      input,
    ),
  ];
};

export const liquiditySignals = (input: ScoringInput): Signal[] => {
  const l = input.locality;
  const overhang = l ? supplyOverhangMonths(l) : undefined;
  return [
    sig(
      {
        key: 'liquidity.supplyOverhang',
        label: 'Unsold supply overhang',
        raw: overhang === undefined ? undefined : Number(overhang.toFixed(1)),
        unit: 'months',
        normalized: overhang === undefined ? undefined : lowerIsBetter(overhang, 6, 42),
        weight: 0.5,
        evidenceFields: ['locality.activeSupplyUnits', 'locality.annualAbsorptionUnits'],
        methodology: 'lowerIsBetter(months of unsold inventory, best=6, worst=42)',
      },
      input,
    ),
    sig(
      {
        key: 'liquidity.transactionDepth',
        label: 'Recent transaction depth',
        raw: l?.priceHistory.at(-1)?.transactionCount,
        normalized: (() => {
          const count = l?.priceHistory.at(-1)?.transactionCount;
          return count === undefined ? undefined : higherIsBetter(count, 5, 120);
        })(),
        weight: 0.5,
        evidenceFields: ['locality.priceHistory'],
        methodology: 'higherIsBetter(transactions in latest period, min=5, max=120)',
      },
      input,
    ),
  ];
};

// ---------------------------------------------------------------------------
// Risk / buyer fit
// ---------------------------------------------------------------------------

export const riskSignals = (input: ScoringInput): Signal[] => {
  const r = input.risk;
  if (!r) {
    return [
      sig(
        {
          key: 'risk.composite',
          label: 'Composite risk',
          raw: undefined,
          normalized: undefined,
          weight: 1,
          evidenceFields: [],
          methodology: '1 - composite risk severity across all risk dimensions.',
        },
        input,
      ),
    ];
  }
  return r.dimensions.map((d) =>
    sig(
      {
        key: `risk.${d.dimension}`,
        label: d.label,
        raw: Number(d.severity.toFixed(2)),
        normalized: 1 - clamp01(d.severity),
        weight: d.weight,
        confidence: d.confidence,
        evidenceFields: d.evidenceFields,
        methodology: `1 - severity of ${d.dimension} risk. ${d.methodology}`,
      },
      input,
    ),
  );
};

export const buyerFitSignals = (input: ScoringInput): Signal[] => {
  const { buyer, property, locality } = input;
  if (!buyer) return [];
  const commute = locality ? bestCommute(locality) : undefined;
  const efficiency = carpetEfficiency(property);

  return [
    sig(
      {
        key: 'fit.budget',
        label: 'Fits stated budget',
        raw: property.askingPrice,
        unit: '₹',
        // Inside the band scores 1; it decays over the 15% above the ceiling that
        // a motivated buyer might stretch to, and hits 0 past that.
        normalized:
          property.askingPrice <= buyer.budgetMax
            ? property.askingPrice >= buyer.budgetMin
              ? 1
              : 0.8
            : clamp01(1 - (property.askingPrice - buyer.budgetMax) / (buyer.budgetMax * 0.15)),
        weight: 0.35,
        evidenceFields: ['property.askingPrice'],
        methodology: 'In-band = 1; above budget decays linearly over a 15% stretch allowance.',
      },
      input,
    ),
    sig(
      {
        key: 'fit.commute',
        label: 'Commute within tolerance',
        raw: commute?.peakCommuteMinutes,
        unit: 'min',
        normalized:
          commute === undefined || buyer.workplace === undefined
            ? undefined
            : lowerIsBetter(
                commute.peakCommuteMinutes,
                buyer.workplace.maxPeakCommuteMinutes * 0.5,
                buyer.workplace.maxPeakCommuteMinutes * 1.6,
              ),
        weight: 0.25,
        evidenceFields: ['locality.employment'],
        methodology: 'lowerIsBetter(peak commute, best=50% of tolerance, worst=160% of tolerance)',
      },
      input,
    ),
    sig(
      {
        key: 'fit.bedrooms',
        label: 'Bedroom count matches',
        raw: property.bedrooms,
        normalized:
          buyer.bedroomsMin === undefined && buyer.bedroomsMax === undefined
            ? undefined
            : property.bedrooms >= (buyer.bedroomsMin ?? 0) &&
                property.bedrooms <= (buyer.bedroomsMax ?? Number.POSITIVE_INFINITY)
              ? 1
              : 0.25,
        weight: 0.2,
        evidenceFields: ['property.bedrooms'],
        methodology: 'Binary in-range check with a 0.25 floor for near misses.',
      },
      input,
    ),
    sig(
      {
        key: 'fit.readiness',
        label: 'Possession readiness matches',
        raw: property.constructionStatus,
        normalized: buyer.needsReadyToMove
          ? property.constructionStatus === 'readyToMove' ||
            property.constructionStatus === 'resale'
            ? 1
            : property.constructionStatus === 'nearingPossession'
              ? 0.5
              : 0.1
          : undefined,
        weight: 0.1,
        evidenceFields: ['property.constructionStatus'],
        methodology: 'Only scored when the buyer stated a ready-to-move requirement.',
      },
      input,
    ),
    sig(
      {
        key: 'fit.efficiency',
        label: 'Carpet efficiency meets minimum',
        raw: efficiency === undefined ? undefined : Number((efficiency * 100).toFixed(1)),
        unit: '%',
        normalized:
          efficiency === undefined || buyer.minCarpetEfficiency === undefined
            ? undefined
            : efficiency >= buyer.minCarpetEfficiency
              ? 1
              : clamp01(efficiency / buyer.minCarpetEfficiency),
        weight: 0.1,
        evidenceFields: ['property.carpetAreaSqFt'],
        methodology: 'Ratio of actual to required carpet efficiency, capped at 1.',
      },
      input,
    ),
  ];
};

/** Count of stale evidence records on the property, used for score annotations. */
export const staleEvidenceCount = (input: ScoringInput): number =>
  input.property.evidence.filter((e) => isStale(e, input.now)).length;
