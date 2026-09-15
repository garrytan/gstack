/**
 * Projection: engine output to marketing shapes.
 *
 * The homepage does not hold a second copy of any number. Every score,
 * verdict, valuation, risk band and yield on it is projected from the same
 * `PropertyIntelligence` the Property Intelligence Page renders, so a figure
 * in the hero and the same figure on a detail page cannot disagree.
 *
 * What this module is allowed to author is presentation: which badge a card
 * wears, how a risk is phrased, which of several true things to lead with.
 * It may not author a figure.
 */

import 'server-only';
import type { PropertyIntelligence } from '@/server/intelligence';
import type { Locality } from '@/domain/locality/types';
import { priceCagrPercent } from '@/domain/locality/types';
import type { Developer } from '@/domain/property/types';
import { carpetPricePerSqFt, pricePerSqFt } from '@/domain/property/types';
import { PILLAR_LABELS } from '@/domain/scoring/types';
import { formatPercent } from '@/lib/utils';
import type { DeveloperProfile, SiteLocality, SiteProperty } from '@/site/types';

/**
 * The badge a card wears.
 *
 * Ordered by what a buyer would want told first, and every branch is a
 * statement the underlying payload supports. A property with nothing
 * distinguishing gets a neutral label rather than an invented superlative.
 */
const signalFor = (intel: PropertyIntelligence): string => {
  const deviation = intel.valuation.askingDeviationPercent;
  if (intel.decision.decision === 'INSUFFICIENT_EVIDENCE') return 'Evidence too thin to score';
  if (intel.decision.decision === 'AVOID') return 'Fails on the fundamentals';
  if (deviation <= -10) return 'Priced well under fair value';
  if (intel.decision.decision === 'BUY' && intel.risk.compositeBand === 'low') {
    return 'Low-risk shortlist';
  }
  if (intel.decision.decision === 'BUY') return 'Strong investment signal';
  if (intel.decision.decision === 'NEGOTIATE') return 'Worth negotiating';
  return 'Watch for now';
};

export const toSiteProperty = (intel: PropertyIntelligence): SiteProperty => {
  const { property, score, decision, valuation, risk, locality, investment } = intel;

  return {
    id: property.id,
    slug: property.id,
    name: property.title,
    locality: locality?.name ?? 'Unmapped',
    localitySlug: locality?.slug,
    city: 'Bengaluru',
    latitude: property.location.lat,
    longitude: property.location.lng,
    price: property.askingPrice,
    pricePerSqFt: pricePerSqFt(property),
    carpetPricePerSqFt: carpetPricePerSqFt(property),
    bhk: property.bedrooms,
    sizeSqFt: property.areaSqFt,
    carpetSqFt: property.carpetAreaSqFt,
    status: property.constructionStatus,
    developer: intel.developer?.name,
    project: intel.project?.name,

    propiqScore: score.score,
    scoreBand: score.band,
    scoreConfidence: score.confidence,
    coverage: score.coverage,
    breakdown: score.pillars.map((p) => ({
      key: p.pillar,
      label: PILLAR_LABELS[p.pillar],
      score: p.score,
      weight: score.weights[p.pillar],
    })),

    decision: decision.decision,
    verdictHeadline: decision.headline,
    verdictConfidence: decision.confidence,
    strengths: decision.positives.map((p) => `${p.label} — ${p.detail}`),
    watchItems: decision.negatives.map((n) => `${n.label} — ${n.detail}`),
    unknowns: decision.unknowns.map((u) => `${u.label} — ${u.detail}`),

    fairValueMid: valuation.insufficientEvidence ? undefined : valuation.mid,
    fairValueLow: valuation.insufficientEvidence ? undefined : valuation.low,
    fairValueHigh: valuation.insufficientEvidence ? undefined : valuation.high,
    priceDeviationPercent: valuation.askingDeviationPercent,

    riskBand: risk.compositeBand,
    materialRisks: risk.materialRisks.map((d) => d.label),

    rentalYieldPercent: investment.base?.grossYieldPercent,
    monthlyRent: property.expectedRentPerMonth,

    dataStatus: property.dataStatus,
    signal: signalFor(intel),
  };
};

const indicator = (label: string, value: string | undefined, detail?: string) =>
  value === undefined ? undefined : { label, value, detail };

export const toSiteLocality = (locality: Locality): SiteLocality => {
  const cagr = priceCagrPercent(locality.priceHistory ?? []);
  const supplyMonths =
    locality.activeSupplyUnits !== undefined &&
    locality.annualAbsorptionUnits !== undefined &&
    locality.annualAbsorptionUnits > 0
      ? (locality.activeSupplyUnits / locality.annualAbsorptionUnits) * 12
      : undefined;

  return {
    id: locality.id,
    name: locality.name,
    slug: locality.slug,
    city: 'Bengaluru',
    latitude: locality.center.lat,
    longitude: locality.center.lng,
    medianPricePerSqFt: locality.currentMedianPricePerSqFt,
    grossYieldPercent: locality.grossRentalYieldPercent,
    priceCagrPercent: cagr,
    supplyMonths,
    summary: locality.summary ?? 'No written summary recorded for this locality.',
    // Only indicators the record actually carries. A locality missing a figure
    // shows one fewer tile rather than a tile reading zero.
    indicators: [
      indicator(
        'Peak commute',
        locality.employment?.[0]
          ? `${locality.employment[0].peakCommuteMinutes} min`
          : undefined,
        locality.employment?.[0]?.hubName,
      ),
      indicator(
        'Metro',
        locality.transit?.metroDistanceKm !== undefined
          ? `${locality.transit.metroDistanceKm} km`
          : undefined,
        locality.transit?.nearestMetroStation,
      ),
      indicator(
        'Schools within 3 km',
        locality.social?.schoolsWithin3Km !== undefined
          ? String(locality.social.schoolsWithin3Km)
          : undefined,
      ),
      indicator(
        'Hospitals within 5 km',
        locality.social?.hospitalsWithin5Km !== undefined
          ? String(locality.social.hospitalsWithin5Km)
          : undefined,
      ),
      indicator(
        'Gross yield',
        locality.grossRentalYieldPercent !== undefined
          ? formatPercent(locality.grossRentalYieldPercent, 1)
          : undefined,
      ),
      indicator(
        'Supply overhang',
        supplyMonths !== undefined ? `${supplyMonths.toFixed(0)} months` : undefined,
        'at current absorption',
      ),
      indicator(
        'Infrastructure pipeline',
        locality.pipeline && locality.pipeline.length > 0
          ? `${locality.pipeline.length} funded or under way`
          : undefined,
      ),
      indicator(
        'Price CAGR',
        cagr !== undefined ? formatPercent(cagr, 1) : undefined,
        'from the recorded trend',
      ),
    ].filter((i): i is { label: string; value: string; detail: string | undefined } => Boolean(i)),
    dataStatus: locality.dataStatus,
  };
};

/**
 * Developer profile.
 *
 * Deliberately no composite "trust score". The engine scores developer track
 * record inside the PropIQ Score, where its weight is published; inventing a
 * second, differently-computed number for a marketing panel would give the
 * page two answers to the same question. The record's own counts are shown
 * instead, which is what a reader can actually check.
 */
export const toDeveloperProfile = (
  developer: Developer,
  dataStatus: DeveloperProfile['dataStatus'],
): DeveloperProfile => ({
  id: developer.id,
  name: developer.name,
  incorporatedYear: developer.incorporatedYear,
  headquarters: developer.headquarters,
  projectsDelivered: developer.projectsDelivered,
  unitsDelivered: developer.unitsDelivered,
  averageDelayMonths: developer.averageDelayMonths,
  ongoingLitigationCount: developer.ongoingLitigationCount,
  reraComplaintsCount: developer.reraComplaintsCount,
  dataStatus,
});
