/**
 * DEVELOPMENT FIXTURE DATA — see `sources.ts`.
 *
 * Six Bengaluru localities with synthetic market indicators, chosen to span the
 * decision space: an established IT corridor, a growth corridor, a premium
 * north pocket, an affordability pocket, a transit-led pocket, and one with a
 * deliberately weak profile so AVOID verdicts are reachable in the demo.
 */

import { asId } from '@/domain/shared/types';
import type { CityId, LocalityId, MicroMarketId } from '@/domain/shared/types';
import type { Locality, PricePoint } from '@/domain/locality/types';
import { demoEvidence } from './sources';

export const BENGALURU: CityId = asId<CityId>('city-blr');

/** Generates a monthly price series ending at `endPsf` with the given CAGR. */
const priceSeries = (endPsf: number, cagrPercent: number, points = 13): PricePoint[] => {
  const series: PricePoint[] = [];
  for (let i = points - 1; i >= 0; i -= 1) {
    const monthsBack = i * 3;
    const years = monthsBack / 12;
    const psf = Math.round(endPsf / Math.pow(1 + cagrPercent / 100, years));
    const date = new Date(Date.UTC(2026, 4 - monthsBack, 1));
    series.push({
      period: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`,
      medianPricePerSqFt: psf,
      // Deterministic pseudo-variation so charts look alive without randomness.
      transactionCount: 40 + ((i * 17) % 55),
    });
  }
  return series;
};

interface LocalitySeed {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly microMarket: string;
  readonly center: { lat: number; lng: number };
  readonly psf: number;
  readonly cagr: number;
  readonly rentPsf: number;
  readonly supply: number;
  readonly absorption: number;
  readonly metroKm: number;
  readonly metroEta: number;
  readonly hub: string;
  readonly hubKm: number;
  readonly commute: number;
  readonly schools: number;
  readonly hospitals: number;
  readonly parks: number;
  readonly pm25: number;
  readonly flood: number;
  readonly water: number;
  readonly traffic: number;
  readonly summary: string;
  readonly pipeline: Locality['pipeline'];
}

const SEEDS: readonly LocalitySeed[] = [
  {
    id: 'loc-whitefield',
    name: 'Whitefield',
    slug: 'whitefield',
    microMarket: 'East Bengaluru',
    center: { lat: 12.9698, lng: 77.75 },
    psf: 9800,
    cagr: 8.2,
    rentPsf: 32,
    supply: 4200,
    absorption: 3600,
    metroKm: 1.2,
    metroEta: 0,
    hub: 'ITPL',
    hubKm: 3.5,
    commute: 28,
    schools: 14,
    hospitals: 9,
    parks: 5,
    pm25: 42,
    flood: 0.18,
    water: 0.45,
    traffic: 1.9,
    summary:
      'Mature IT corridor with deep rental demand and the widest resale market in east Bengaluru.',
    pipeline: [
      { name: 'Purple Line east extension', type: 'metro', status: 'commissioned' },
      {
        name: 'Whitefield–Hoskote road widening',
        type: 'road',
        status: 'underConstruction',
        expectedCompletion: '2027-03-01T00:00:00.000Z',
      },
    ],
  },
  {
    id: 'loc-sarjapur',
    name: 'Sarjapur Road',
    slug: 'sarjapur-road',
    microMarket: 'South East Bengaluru',
    center: { lat: 12.901, lng: 77.687 },
    psf: 10400,
    cagr: 10.1,
    rentPsf: 34,
    supply: 5600,
    absorption: 3900,
    metroKm: 4.8,
    metroEta: 42,
    hub: 'Outer Ring Road',
    hubKm: 6.0,
    commute: 46,
    schools: 18,
    hospitals: 7,
    parks: 3,
    pm25: 46,
    flood: 0.34,
    water: 0.62,
    traffic: 2.2,
    summary:
      'Highest-demand growth corridor. Strong appreciation, but road capacity and water supply lag the building.',
    pipeline: [
      {
        name: 'Blue Line (Central Silk Board–Sarjapur)',
        type: 'metro',
        status: 'funded',
        expectedCompletion: '2029-12-01T00:00:00.000Z',
      },
      { name: 'Sarjapur elevated corridor', type: 'road', status: 'approved' },
    ],
  },
  {
    id: 'loc-hebbal',
    name: 'Hebbal',
    slug: 'hebbal',
    microMarket: 'North Bengaluru',
    center: { lat: 13.0358, lng: 77.597 },
    psf: 12600,
    cagr: 7.4,
    rentPsf: 36,
    supply: 1900,
    absorption: 2100,
    metroKm: 2.1,
    metroEta: 18,
    hub: 'Manyata Tech Park',
    hubKm: 4.2,
    commute: 26,
    schools: 11,
    hospitals: 12,
    parks: 6,
    pm25: 48,
    flood: 0.22,
    water: 0.3,
    traffic: 2.0,
    summary:
      'Premium north pocket with airport access and constrained new supply. Entry prices are the highest in this dataset.',
    pipeline: [
      {
        name: 'Blue Line (airport corridor)',
        type: 'metro',
        status: 'underConstruction',
        expectedCompletion: '2027-12-01T00:00:00.000Z',
      },
      {
        name: 'Hebbal flyover decongestion',
        type: 'road',
        status: 'funded',
        expectedCompletion: '2028-06-01T00:00:00.000Z',
      },
    ],
  },
  {
    id: 'loc-electronic-city',
    name: 'Electronic City',
    slug: 'electronic-city',
    microMarket: 'South Bengaluru',
    center: { lat: 12.8452, lng: 77.6602 },
    psf: 7200,
    cagr: 6.1,
    rentPsf: 24,
    supply: 3800,
    absorption: 2600,
    metroKm: 1.6,
    metroEta: 0,
    hub: 'Electronic City Phase 1',
    hubKm: 2.0,
    commute: 22,
    schools: 10,
    hospitals: 6,
    parks: 4,
    pm25: 39,
    flood: 0.15,
    water: 0.4,
    traffic: 1.6,
    summary:
      'Affordability pocket with a short commute to its own employment base and completed metro access.',
    pipeline: [{ name: 'Yellow Line', type: 'metro', status: 'commissioned' }],
  },
  {
    id: 'loc-yelahanka',
    name: 'Yelahanka',
    slug: 'yelahanka',
    microMarket: 'North Bengaluru',
    center: { lat: 13.1007, lng: 77.5963 },
    psf: 8100,
    cagr: 9.3,
    rentPsf: 25,
    supply: 2400,
    absorption: 2200,
    metroKm: 5.4,
    metroEta: 30,
    hub: 'Manyata Tech Park',
    hubKm: 12.0,
    commute: 52,
    schools: 9,
    hospitals: 5,
    parks: 7,
    pm25: 34,
    flood: 0.12,
    water: 0.28,
    traffic: 1.5,
    summary:
      'Low-density north pocket with the cleanest air and most open space in this dataset, at the cost of a long commute.',
    pipeline: [
      {
        name: 'Blue Line (airport corridor)',
        type: 'metro',
        status: 'underConstruction',
        expectedCompletion: '2027-12-01T00:00:00.000Z',
      },
    ],
  },
  {
    id: 'loc-kanakapura',
    name: 'Kanakapura Road',
    slug: 'kanakapura-road',
    microMarket: 'South Bengaluru',
    center: { lat: 12.889, lng: 77.556 },
    psf: 6600,
    cagr: 4.2,
    rentPsf: 19,
    supply: 5100,
    absorption: 1800,
    metroKm: 2.8,
    metroEta: 0,
    hub: 'Outer Ring Road South',
    hubKm: 11.0,
    commute: 58,
    schools: 6,
    hospitals: 4,
    parks: 3,
    pm25: 37,
    flood: 0.41,
    water: 0.68,
    traffic: 1.8,
    summary:
      'Heavy unsold inventory and weak absorption. Present in this dataset so weak-market verdicts are reachable in the demo.',
    pipeline: [{ name: 'Kanakapura ring road link', type: 'road', status: 'announced' }],
  },
];

export const DEMO_LOCALITIES: readonly Locality[] = SEEDS.map((s) => ({
  id: asId<LocalityId>(s.id),
  name: s.name,
  slug: s.slug,
  cityId: BENGALURU,
  microMarketId: asId<MicroMarketId>(`mm-${s.slug}`),
  center: s.center,
  summary: s.summary,
  currentMedianPricePerSqFt: s.psf,
  priceHistory: priceSeries(s.psf, s.cagr),
  rentHistory: [
    { period: '2025-05', medianRentPerSqFtMonth: Number((s.rentPsf * 0.94).toFixed(1)) },
    { period: '2026-05', medianRentPerSqFtMonth: s.rentPsf },
  ],
  grossRentalYieldPercent: Number((((s.rentPsf * 12) / s.psf) * 100).toFixed(2)),
  activeSupplyUnits: s.supply,
  annualAbsorptionUnits: s.absorption,
  transit: {
    metroDistanceKm: s.metroKm,
    metroEtaMonths: s.metroEta,
    arterialRoadDistanceKm: 1.0,
    airportDistanceKm: s.center.lat > 13 ? 18 : 42,
  },
  employment: [
    {
      hubName: s.hub,
      distanceKm: s.hubKm,
      peakCommuteMinutes: s.commute,
      offPeakCommuteMinutes: Math.round(s.commute * 0.6),
    },
  ],
  social: {
    schoolsWithin3Km: s.schools,
    hospitalsWithin5Km: s.hospitals,
    parksWithin2Km: s.parks,
    mallsWithin5Km: 2,
  },
  environment: {
    pm25Annual: s.pm25,
    floodRisk: s.flood,
    waterStress: s.water,
    averagePeakTrafficIndex: s.traffic,
  },
  pipeline: s.pipeline,
  dataStatus: 'demo',
  evidence: [
    demoEvidence('locality.medianPricePerSqFt', s.psf, '2026-05-01T00:00:00.000Z', 0.7),
    demoEvidence('locality.employment', s.commute, '2026-04-15T00:00:00.000Z', 0.6),
    demoEvidence('locality.environment.waterStress', s.water, '2026-03-01T00:00:00.000Z', 0.5),
    demoEvidence('locality.pipeline', s.pipeline.length, '2026-05-10T00:00:00.000Z', 0.65),
  ],
}));

export const localityBySlug = (slug: string): Locality | undefined =>
  DEMO_LOCALITIES.find((l) => l.slug === slug);

export const localityById = (id: string): Locality | undefined =>
  DEMO_LOCALITIES.find((l) => l.id === id);
