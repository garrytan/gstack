/**
 * Row → domain mappers.
 *
 * Kept separate from the repository so the shape of the database can change
 * without the query logic changing with it, and so the mapping rules are
 * testable on plain objects.
 *
 * The recurring rule: a missing column becomes `undefined`, never a default.
 * `?? 0` on a price would turn "we don't know" into "it's free".
 */

import { asId } from '@/domain/shared/types';
import type {
  CityId,
  DeveloperId,
  EvidenceId,
  LocalityId,
  MicroMarketId,
  PhaseId,
  ProjectId,
  PropertyId,
  UnitTypeId,
} from '@/domain/shared/types';
import type { AreaBasis } from '@/domain/shared/types';
import type { DataStatus, Evidence, ReviewState, SourceType } from '@/domain/evidence/types';
import { DATA_STATUSES, REVIEW_STATES, SOURCE_TYPES } from '@/domain/evidence/types';
import type {
  ConstructionStatus,
  Developer,
  Facing,
  Phase,
  Project,
  Property,
  PropertyKind,
} from '@/domain/property/types';
import { CONSTRUCTION_STATUSES, FACINGS, PROPERTY_KINDS } from '@/domain/property/types';
import type { Locality } from '@/domain/locality/types';
import type { Comparable } from '@/domain/valuation/types';

/** Supabase returns `unknown`-shaped JSON; this is the narrow accessor for it. */
export type Row = Record<string, unknown>;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;
const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  // Postgres numerics arrive as strings over the wire.
  if (typeof v === 'string' && v.trim() !== '') {
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};
const bool = (v: unknown): boolean => v === true;
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Narrow an arbitrary value to a member of a literal union, or fall back. */
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

const optionalOneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;

export const mapEvidenceRow = (row: Row): Evidence => ({
  id: asId<EvidenceId>(String(row.id)),
  field: String(row.field ?? ''),
  value: row.value,
  source: {
    id: String(row.source_id ?? ''),
    name: str(row.source_name) ?? 'Unnamed source',
    type: oneOf<SourceType>(row.source_type, SOURCE_TYPES, 'partner'),
    reference: str(row.source_reference),
    trust: num(row.source_trust) ?? 0.5,
  },
  observedAt: String(row.observed_at),
  effectiveAt: str(row.effective_at),
  lastVerifiedAt: str(row.last_verified_at),
  dataStatus: oneOf<DataStatus>(row.data_status, DATA_STATUSES, 'estimated'),
  confidence: num(row.confidence) ?? 0.5,
  methodologyVersion: str(row.methodology_version),
  reviewState: oneOf<ReviewState>(row.review_state, REVIEW_STATES, 'unreviewed'),
  disputed: bool(row.disputed),
  note: str(row.note),
});

export const mapPropertyRow = (row: Row): Property => ({
  id: asId<PropertyId>(String(row.id)),
  unitTypeId: asId<UnitTypeId>(String(row.unit_type_id ?? row.id)),
  projectId: asId<ProjectId>(String(row.project_id)),
  title: String(row.title ?? 'Untitled property'),
  kind: oneOf<PropertyKind>(row.kind, PROPERTY_KINDS, 'apartment'),
  constructionStatus: oneOf<ConstructionStatus>(
    row.construction_status,
    CONSTRUCTION_STATUSES,
    'readyToMove',
  ),
  bedrooms: num(row.bedrooms) ?? 0,
  bathrooms: num(row.bathrooms) ?? 0,
  areaSqFt: num(row.area_sqft) ?? 0,
  areaBasis: oneOf<AreaBasis>(
    row.area_basis,
    ['carpet', 'builtUp', 'superBuiltUp'],
    'superBuiltUp',
  ),
  carpetAreaSqFt: num(row.carpet_area_sqft),
  floor: num(row.floor),
  totalFloors: num(row.total_floors),
  facing: optionalOneOf<Facing>(row.facing, FACINGS),
  askingPrice: num(row.asking_price) ?? 0,
  maintenancePerSqFtMonth: num(row.maintenance_per_sqft_month),
  expectedRentPerMonth: num(row.expected_rent_per_month),
  localityId: asId<LocalityId>(String(row.locality_id)),
  cityId: asId<CityId>(String(row.city_id)),
  location: { lat: num(row.lat) ?? 0, lng: num(row.lng) ?? 0 },
  listedAt: str(row.listed_at),
  images: strArray(row.images),
  dataStatus: oneOf<DataStatus>(row.data_status, DATA_STATUSES, 'estimated'),
  evidence: rows(row.evidence).map(mapEvidenceRow),
  commercial: {
    developerRelationship: bool(row.commercial_developer_relationship),
    paidPlacement: bool(row.commercial_paid_placement),
    commissionPossible: bool(row.commercial_commission_possible),
    note: str(row.commercial_note),
  },
});

export const mapPhaseRow = (row: Row, projectId: ProjectId): Phase => ({
  id: asId<PhaseId>(String(row.id)),
  projectId,
  name: String(row.name ?? 'Phase'),
  rera:
    str(row.rera_number) || str(row.rera_status)
      ? {
          number: str(row.rera_number) ?? '',
          state: str(row.rera_state) ?? '',
          registeredAt: str(row.rera_registered_at),
          validUntil: str(row.rera_valid_until),
          status: oneOf(
            row.rera_status,
            ['registered', 'expired', 'lapsed', 'notRegistered', 'unknown'] as const,
            'unknown',
          ),
          portalUrl: str(row.rera_portal_url),
        }
      : undefined,
  promisedPossession: str(row.promised_possession),
  currentPossession: str(row.current_possession),
  constructionStatus: oneOf<ConstructionStatus>(
    row.construction_status,
    CONSTRUCTION_STATUSES,
    'underConstruction',
  ),
  completionPercent: num(row.completion_percent),
});

export const mapProjectRow = (row: Row): Project => {
  const id = asId<ProjectId>(String(row.id));
  return {
    id,
    name: String(row.name ?? ''),
    slug: String(row.slug ?? ''),
    developerId: asId<DeveloperId>(String(row.developer_id)),
    localityId: asId<LocalityId>(String(row.locality_id)),
    microMarketId: asId<MicroMarketId>(String(row.micro_market_id ?? '')),
    cityId: asId<CityId>(String(row.city_id)),
    location: { lat: num(row.lat) ?? 0, lng: num(row.lng) ?? 0 },
    kinds: strArray(row.kinds).filter((k): k is PropertyKind =>
      (PROPERTY_KINDS as readonly string[]).includes(k),
    ),
    totalUnits: num(row.total_units),
    landAreaAcres: num(row.land_area_acres),
    openSpacePercent: num(row.open_space_percent),
    launchedAt: str(row.launched_at),
    amenities: strArray(row.amenities),
    phases: rows(row.phases).map((p) => mapPhaseRow(p, id)),
    towers: rows(row.towers).map((t) => ({
      id: asId(String(t.id)),
      phaseId: asId<PhaseId>(String(t.phase_id)),
      name: String(t.name ?? ''),
      floors: num(t.floors) ?? 0,
      unitsPerFloor: num(t.units_per_floor),
    })),
  };
};

export const mapDeveloperRow = (row: Row): Developer => ({
  id: asId<DeveloperId>(String(row.id)),
  name: String(row.name ?? ''),
  slug: String(row.slug ?? ''),
  incorporatedYear: num(row.incorporated_year),
  headquarters: str(row.headquarters),
  projectsDelivered: num(row.projects_delivered),
  unitsDelivered: num(row.units_delivered),
  averageDelayMonths: num(row.average_delay_months),
  ongoingLitigationCount: num(row.ongoing_litigation_count),
  reraComplaintsCount: num(row.rera_complaints_count),
});

export const mapLocalityRow = (row: Row): Locality => ({
  id: asId<LocalityId>(String(row.id)),
  name: String(row.name ?? ''),
  slug: String(row.slug ?? ''),
  cityId: asId<CityId>(String(row.city_id)),
  microMarketId: asId<MicroMarketId>(String(row.micro_market_id ?? '')),
  center: { lat: num(row.lat) ?? 0, lng: num(row.lng) ?? 0 },
  summary: str(row.summary),
  currentMedianPricePerSqFt: num(row.current_median_price_per_sqft),
  priceHistory: rows(row.price_history)
    .map((p) => ({
      period: String(p.period),
      medianPricePerSqFt: num(p.median_price_per_sqft) ?? 0,
      transactionCount: num(p.transaction_count),
    }))
    .sort((a, b) => a.period.localeCompare(b.period)),
  rentHistory: rows(row.rent_history).map((r) => ({
    period: String(r.period),
    medianRentPerSqFtMonth: num(r.median_rent_per_sqft_month) ?? 0,
  })),
  grossRentalYieldPercent: num(row.gross_rental_yield_percent),
  activeSupplyUnits: num(row.active_supply_units),
  annualAbsorptionUnits: num(row.annual_absorption_units),
  transit: {
    nearestMetroStation: str(row.nearest_metro_station),
    metroDistanceKm: num(row.metro_distance_km),
    metroEtaMonths: num(row.metro_eta_months),
    arterialRoadDistanceKm: num(row.arterial_road_distance_km),
    airportDistanceKm: num(row.airport_distance_km),
  },
  employment: rows(row.employment).map((e) => ({
    hubName: String(e.hub_name ?? ''),
    distanceKm: num(e.distance_km) ?? 0,
    peakCommuteMinutes: num(e.peak_commute_minutes) ?? 0,
    offPeakCommuteMinutes: num(e.off_peak_commute_minutes),
  })),
  social: {
    schoolsWithin3Km: num(row.schools_within_3km),
    hospitalsWithin5Km: num(row.hospitals_within_5km),
    mallsWithin5Km: num(row.malls_within_5km),
    parksWithin2Km: num(row.parks_within_2km),
  },
  environment: {
    pm25Annual: num(row.pm25_annual),
    floodRisk: num(row.flood_risk),
    waterStress: num(row.water_stress),
    averagePeakTrafficIndex: num(row.average_peak_traffic_index),
  },
  pipeline: rows(row.pipeline).map((p) => ({
    name: String(p.name ?? ''),
    type: oneOf(p.type, ['metro', 'road', 'airport', 'sez', 'utility', 'other'] as const, 'other'),
    status: oneOf(
      p.status,
      ['announced', 'approved', 'funded', 'underConstruction', 'commissioned'] as const,
      'announced',
    ),
    expectedCompletion: str(p.expected_completion),
    sourceReference: str(p.source_reference),
  })),
  dataStatus: oneOf<DataStatus>(row.data_status, DATA_STATUSES, 'estimated'),
  evidence: rows(row.evidence).map(mapEvidenceRow),
});

export const mapComparableRow = (row: Row): Comparable => ({
  propertyId: str(row.comparable_property_id)
    ? asId<PropertyId>(String(row.comparable_property_id))
    : undefined,
  label: String(row.label ?? 'Comparable'),
  soldOrListedAt: String(row.observed_at),
  isTransaction: bool(row.is_transaction),
  carpetAreaSqFt: num(row.carpet_area_sqft) ?? 0,
  pricePerSqFt: num(row.price_per_sqft) ?? 0,
  distanceKm: num(row.distance_km) ?? 0,
  floor: num(row.floor),
  ageYears: num(row.age_years),
  dataStatus: oneOf<DataStatus>(row.data_status, DATA_STATUSES, 'estimated'),
});
