/**
 * Minimal synthetic builders for unit tests.
 *
 * These are deliberately separate from `src/data/fixtures` (the demo dataset):
 * unit tests need small, hand-tuned inputs where every field is chosen to
 * exercise one rule, not a realistic property record.
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
import type { Evidence, PropertySource } from '@/domain/evidence/types';
import type { Developer, Project, Property } from '@/domain/property/types';
import { NO_COMMERCIAL_RELATIONSHIP } from '@/domain/property/types';
import type { Locality } from '@/domain/locality/types';

export const NOW = '2026-06-01T00:00:00.000Z';

export const testSource = (overrides: Partial<PropertySource> = {}): PropertySource => ({
  id: 'src-test',
  name: 'Test source',
  type: 'rera',
  trust: 1,
  ...overrides,
});

export const testEvidence = (overrides: Partial<Evidence> = {}): Evidence => ({
  id: asId<EvidenceId>('ev-1'),
  field: 'property.askingPrice',
  value: 1,
  source: testSource(),
  observedAt: '2026-05-25T00:00:00.000Z',
  lastVerifiedAt: '2026-05-25T00:00:00.000Z',
  dataStatus: 'verified',
  confidence: 0.9,
  reviewState: 'human_verified',
  ...overrides,
});

export const testProperty = (overrides: Partial<Property> = {}): Property => ({
  id: asId<PropertyId>('prop-1'),
  unitTypeId: asId<UnitTypeId>('ut-1'),
  projectId: asId<ProjectId>('proj-1'),
  title: 'Test 3BHK',
  kind: 'apartment',
  constructionStatus: 'underConstruction',
  bedrooms: 3,
  bathrooms: 3,
  areaSqFt: 1600,
  areaBasis: 'superBuiltUp',
  carpetAreaSqFt: 1120,
  floor: 8,
  totalFloors: 14,
  facing: 'NE',
  askingPrice: 16_000_000,
  localityId: asId<LocalityId>('loc-1'),
  cityId: asId<CityId>('city-1'),
  location: { lat: 12.93, lng: 77.69 },
  images: [],
  dataStatus: 'verified',
  evidence: [testEvidence()],
  commercial: NO_COMMERCIAL_RELATIONSHIP,
  ...overrides,
});

export const testDeveloper = (overrides: Partial<Developer> = {}): Developer => ({
  id: asId<DeveloperId>('dev-1'),
  name: 'Test Developer',
  slug: 'test-developer',
  unitsDelivered: 4000,
  averageDelayMonths: 3,
  ongoingLitigationCount: 0,
  reraComplaintsCount: 2,
  ...overrides,
});

export const testProject = (overrides: Partial<Project> = {}): Project => ({
  id: asId<ProjectId>('proj-1'),
  name: 'Test Project',
  slug: 'test-project',
  developerId: asId<DeveloperId>('dev-1'),
  localityId: asId<LocalityId>('loc-1'),
  microMarketId: asId<MicroMarketId>('mm-1'),
  cityId: asId<CityId>('city-1'),
  location: { lat: 12.93, lng: 77.69 },
  kinds: ['apartment'],
  totalUnits: 600,
  landAreaAcres: 12,
  openSpacePercent: 60,
  amenities: ['Pool', 'Gym', 'Clubhouse', 'Park', 'Creche'],
  towers: [],
  phases: [
    {
      id: asId<PhaseId>('phase-1'),
      projectId: asId<ProjectId>('proj-1'),
      name: 'Phase 1',
      constructionStatus: 'underConstruction',
      completionPercent: 65,
      promisedPossession: '2027-06-01T00:00:00.000Z',
      currentPossession: '2027-12-01T00:00:00.000Z',
      rera: {
        number: 'PRM/KA/RERA/1251/446/PR/000000/000000',
        state: 'Karnataka',
        status: 'registered',
        validUntil: '2028-12-31T00:00:00.000Z',
      },
    },
  ],
  ...overrides,
});

export const testLocality = (overrides: Partial<Locality> = {}): Locality => ({
  id: asId<LocalityId>('loc-1'),
  name: 'Test Locality',
  slug: 'test-locality',
  cityId: asId<CityId>('city-1'),
  microMarketId: asId<MicroMarketId>('mm-1'),
  center: { lat: 12.93, lng: 77.69 },
  currentMedianPricePerSqFt: 9500,
  priceHistory: [
    { period: '2023-06', medianPricePerSqFt: 7600, transactionCount: 60 },
    { period: '2024-06', medianPricePerSqFt: 8300, transactionCount: 72 },
    { period: '2025-06', medianPricePerSqFt: 8900, transactionCount: 81 },
    { period: '2026-05', medianPricePerSqFt: 9500, transactionCount: 88 },
  ],
  rentHistory: [{ period: '2026-05', medianRentPerSqFtMonth: 28 }],
  activeSupplyUnits: 1800,
  annualAbsorptionUnits: 1500,
  transit: { metroDistanceKm: 1.4, metroEtaMonths: 0, arterialRoadDistanceKm: 0.8 },
  employment: [{ hubName: 'Outer Ring Road', distanceKm: 6, peakCommuteMinutes: 35 }],
  social: { schoolsWithin3Km: 9, hospitalsWithin5Km: 6, parksWithin2Km: 4 },
  environment: { pm25Annual: 38, floodRisk: 0.2, waterStress: 0.35, averagePeakTrafficIndex: 1.7 },
  pipeline: [
    {
      name: 'Blue Line extension',
      type: 'metro',
      status: 'underConstruction',
      expectedCompletion: '2027-06-01T00:00:00.000Z',
    },
  ],
  dataStatus: 'verified',
  evidence: [],
  ...overrides,
});
