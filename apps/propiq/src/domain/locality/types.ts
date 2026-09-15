/**
 * Locality intelligence.
 *
 * Every subjective locality score must be reducible to a named methodology and
 * an observable input. We therefore store the raw indicator alongside the
 * score, so "livability 72" can always be expanded into the numbers behind it.
 */

import type {
  CityId,
  GeoPoint,
  INR,
  Instant,
  LocalityId,
  MicroMarketId,
  Unit01,
} from '../shared/types';
import type { DataStatus, Evidence } from '../evidence/types';

export interface PricePoint {
  readonly period: string; // YYYY-MM
  readonly medianPricePerSqFt: INR;
  readonly transactionCount?: number;
}

export interface RentPoint {
  readonly period: string; // YYYY-MM
  readonly medianRentPerSqFtMonth: number;
}

export interface TransitAccess {
  readonly nearestMetroStation?: string;
  readonly metroDistanceKm?: number;
  /** Months until a funded-but-unopened line reaches the locality. */
  readonly metroEtaMonths?: number;
  readonly arterialRoadDistanceKm?: number;
  readonly airportDistanceKm?: number;
}

export interface EmploymentAccess {
  readonly hubName: string;
  readonly distanceKm: number;
  readonly peakCommuteMinutes: number;
  readonly offPeakCommuteMinutes?: number;
}

export interface SocialInfrastructure {
  readonly schoolsWithin3Km?: number;
  readonly hospitalsWithin5Km?: number;
  readonly mallsWithin5Km?: number;
  readonly parksWithin2Km?: number;
}

export interface EnvironmentalIndicators {
  /** Annual mean PM2.5, µg/m³. */
  readonly pm25Annual?: number;
  /** 0..1 modelled flood exposure for a 1-in-50-year event. */
  readonly floodRisk?: Unit01;
  /** 0..1 stress on piped/borewell water supply. */
  readonly waterStress?: Unit01;
  readonly averagePeakTrafficIndex?: number;
}

export interface InfrastructurePipelineItem {
  readonly name: string;
  readonly type: 'metro' | 'road' | 'airport' | 'sez' | 'utility' | 'other';
  readonly status: 'announced' | 'approved' | 'funded' | 'underConstruction' | 'commissioned';
  readonly expectedCompletion?: Instant;
  readonly sourceReference?: string;
}

export interface Locality {
  readonly id: LocalityId;
  readonly name: string;
  readonly slug: string;
  readonly cityId: CityId;
  readonly microMarketId: MicroMarketId;
  readonly center: GeoPoint;
  readonly summary?: string;

  readonly currentMedianPricePerSqFt?: INR;
  readonly priceHistory: readonly PricePoint[];
  readonly rentHistory: readonly RentPoint[];
  readonly grossRentalYieldPercent?: number;

  /** Active listings vs 12-month absorption — the supply overhang signal. */
  readonly activeSupplyUnits?: number;
  readonly annualAbsorptionUnits?: number;

  readonly transit: TransitAccess;
  readonly employment: readonly EmploymentAccess[];
  readonly social: SocialInfrastructure;
  readonly environment: EnvironmentalIndicators;
  readonly pipeline: readonly InfrastructurePipelineItem[];

  readonly dataStatus: DataStatus;
  readonly evidence: readonly Evidence[];
}

/** Compound annual growth rate over the price history, as a percentage. */
export const priceCagrPercent = (history: readonly PricePoint[]): number | undefined => {
  if (history.length < 2) return undefined;
  const sorted = [...history].sort((a, b) => a.period.localeCompare(b.period));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last || first.medianPricePerSqFt <= 0) return undefined;
  const months = monthsBetweenPeriods(first.period, last.period);
  if (months <= 0) return undefined;
  const years = months / 12;
  return (Math.pow(last.medianPricePerSqFt / first.medianPricePerSqFt, 1 / years) - 1) * 100;
};

export const monthsBetweenPeriods = (a: string, b: string): number => {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  if (!ay || !am || !by || !bm) return 0;
  return (by - ay) * 12 + (bm - am);
};

/** Supply overhang in months of absorption. Above ~24 months is a buyer's market. */
export const supplyOverhangMonths = (locality: Locality): number | undefined => {
  const { activeSupplyUnits, annualAbsorptionUnits } = locality;
  if (!activeSupplyUnits || !annualAbsorptionUnits || annualAbsorptionUnits <= 0) return undefined;
  return (activeSupplyUnits / annualAbsorptionUnits) * 12;
};

export const bestCommute = (locality: Locality): EmploymentAccess | undefined =>
  locality.employment.length === 0
    ? undefined
    : locality.employment.reduce((best, cur) =>
        cur.peakCommuteMinutes < best.peakCommuteMinutes ? cur : best,
      );
