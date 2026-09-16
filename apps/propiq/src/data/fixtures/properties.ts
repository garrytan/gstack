/**
 * DEVELOPMENT FIXTURE DATA — see `sources.ts`.
 *
 * Developers, projects and units here are invented. The set is tuned so the
 * demo reaches every decision outcome: strong-and-fairly-priced (BUY), strong
 * but overpriced (NEGOTIATE), mid-band (WATCH), legally compromised (AVOID),
 * and a deliberately thin record (INSUFFICIENT EVIDENCE).
 */

import { asId } from '@/domain/shared/types';
import type {
  DeveloperId,
  LocalityId,
  PhaseId,
  ProjectId,
  PropertyId,
  UnitTypeId,
} from '@/domain/shared/types';
import type {
  ConstructionStatus,
  Developer,
  Facing,
  Project,
  Property,
  ReraRegistration,
} from '@/domain/property/types';
import { NO_COMMERCIAL_RELATIONSHIP } from '@/domain/property/types';
import type { Comparable } from '@/domain/valuation/types';
import { BENGALURU } from './localities';
import { demoEvidence } from './sources';

// ---------------------------------------------------------------------------
// Developers (invented)
// ---------------------------------------------------------------------------

interface DevSeed {
  id: string;
  name: string;
  slug: string;
  year: number;
  delivered: number;
  units: number;
  delay: number;
  litigation: number;
  complaints: number;
}

const DEV_SEEDS: readonly DevSeed[] = [
  {
    id: 'dev-northwind',
    name: 'Northwind Estates',
    slug: 'northwind-estates',
    year: 1996,
    delivered: 41,
    units: 12_400,
    delay: 2,
    litigation: 0,
    complaints: 3,
  },
  {
    id: 'dev-verdant',
    name: 'Verdant Realty',
    slug: 'verdant-realty',
    year: 2004,
    delivered: 23,
    units: 6_800,
    delay: 5,
    litigation: 1,
    complaints: 8,
  },
  {
    id: 'dev-cobalt',
    name: 'Cobalt Developers',
    slug: 'cobalt-developers',
    year: 2011,
    delivered: 9,
    units: 2_100,
    delay: 11,
    litigation: 3,
    complaints: 17,
  },
  {
    id: 'dev-tamarind',
    name: 'Tamarind Group',
    slug: 'tamarind-group',
    year: 1988,
    delivered: 58,
    units: 19_600,
    delay: 1,
    litigation: 0,
    complaints: 2,
  },
  {
    id: 'dev-silverline',
    name: 'Silverline Infra',
    slug: 'silverline-infra',
    year: 2017,
    delivered: 3,
    units: 640,
    delay: 19,
    litigation: 7,
    complaints: 31,
  },
  {
    id: 'dev-kadamba',
    name: 'Kadamba Habitat',
    slug: 'kadamba-habitat',
    year: 2008,
    delivered: 16,
    units: 4_300,
    delay: 7,
    litigation: 1,
    complaints: 11,
  },
];

export const DEMO_DEVELOPERS: readonly Developer[] = DEV_SEEDS.map((d) => ({
  id: asId<DeveloperId>(d.id),
  name: d.name,
  slug: d.slug,
  incorporatedYear: d.year,
  headquarters: 'Bengaluru',
  projectsDelivered: d.delivered,
  unitsDelivered: d.units,
  averageDelayMonths: d.delay,
  ongoingLitigationCount: d.litigation,
  reraComplaintsCount: d.complaints,
}));

// ---------------------------------------------------------------------------
// Projects (invented)
// ---------------------------------------------------------------------------

const rera = (
  status: ReraRegistration['status'],
  n: string,
  validUntil?: string,
): ReraRegistration => ({
  number: status === 'notRegistered' ? '' : `PRM/KA/RERA/1251/446/PR/${n}`,
  state: 'Karnataka',
  status,
  registeredAt: status === 'notRegistered' ? undefined : '2023-08-14T00:00:00.000Z',
  validUntil,
  portalUrl: status === 'notRegistered' ? undefined : 'https://rera.karnataka.gov.in/',
});

interface ProjSeed {
  id: string;
  name: string;
  slug: string;
  dev: string;
  locality: string;
  lat: number;
  lng: number;
  units: number;
  acres: number;
  openSpace: number;
  status: ConstructionStatus;
  completion: number;
  promised?: string;
  current?: string;
  rera: ReraRegistration;
  amenities: string[];
}

const PROJ_SEEDS: readonly ProjSeed[] = [
  {
    id: 'proj-northwind-meadows',
    name: 'Northwind Meadows',
    slug: 'northwind-meadows',
    dev: 'dev-northwind',
    locality: 'loc-whitefield',
    lat: 12.9712,
    lng: 77.7488,
    units: 620,
    acres: 14,
    openSpace: 68,
    status: 'nearingPossession',
    completion: 88,
    promised: '2026-12-01T00:00:00.000Z',
    current: '2027-03-01T00:00:00.000Z',
    rera: rera('registered', '000121/000121', '2028-06-30T00:00:00.000Z'),
    amenities: [
      'Swimming pool',
      'Gymnasium',
      'Clubhouse',
      'Amphitheatre',
      'Jogging track',
      'Creche',
      'Indoor games',
      'Landscaped park',
      'EV charging',
      'Rainwater harvesting',
    ],
  },
  {
    id: 'proj-tamarind-heights',
    name: 'Tamarind Heights',
    slug: 'tamarind-heights',
    dev: 'dev-tamarind',
    locality: 'loc-hebbal',
    lat: 13.0371,
    lng: 77.5948,
    units: 310,
    acres: 6,
    openSpace: 55,
    status: 'readyToMove',
    completion: 100,
    promised: '2025-06-01T00:00:00.000Z',
    current: '2025-06-01T00:00:00.000Z',
    rera: rera('registered', '000208/000208', '2029-01-31T00:00:00.000Z'),
    amenities: [
      'Swimming pool',
      'Gymnasium',
      'Clubhouse',
      'Sky lounge',
      'Concierge',
      'Landscaped deck',
      'EV charging',
      'Solar hot water',
    ],
  },
  {
    id: 'proj-verdant-canopy',
    name: 'Verdant Canopy',
    slug: 'verdant-canopy',
    dev: 'dev-verdant',
    locality: 'loc-sarjapur',
    lat: 12.9025,
    lng: 77.6901,
    units: 880,
    acres: 11,
    openSpace: 42,
    status: 'underConstruction',
    completion: 54,
    promised: '2027-06-01T00:00:00.000Z',
    current: '2027-12-01T00:00:00.000Z',
    rera: rera('registered', '000317/000317', '2028-12-31T00:00:00.000Z'),
    amenities: [
      'Swimming pool',
      'Gymnasium',
      'Clubhouse',
      'Co-working lounge',
      'Pet park',
      'Jogging track',
      'Creche',
    ],
  },
  {
    id: 'proj-cobalt-crest',
    name: 'Cobalt Crest',
    slug: 'cobalt-crest',
    dev: 'dev-cobalt',
    locality: 'loc-sarjapur',
    lat: 12.8971,
    lng: 77.6952,
    units: 540,
    acres: 4.5,
    openSpace: 28,
    status: 'underConstruction',
    completion: 31,
    promised: '2026-09-01T00:00:00.000Z',
    current: '2028-03-01T00:00:00.000Z',
    rera: rera('expired', '000422/000422', '2026-02-28T00:00:00.000Z'),
    amenities: ['Swimming pool', 'Gymnasium', 'Clubhouse', 'Indoor games'],
  },
  {
    id: 'proj-silverline-vista',
    name: 'Silverline Vista',
    slug: 'silverline-vista',
    dev: 'dev-silverline',
    locality: 'loc-kanakapura',
    lat: 12.8878,
    lng: 77.5571,
    units: 420,
    acres: 3.2,
    openSpace: 22,
    status: 'underConstruction',
    completion: 18,
    promised: '2026-06-01T00:00:00.000Z',
    current: '2028-09-01T00:00:00.000Z',
    rera: rera('notRegistered', ''),
    amenities: ['Gymnasium', 'Clubhouse'],
  },
  {
    id: 'proj-kadamba-grove',
    name: 'Kadamba Grove',
    slug: 'kadamba-grove',
    dev: 'dev-kadamba',
    locality: 'loc-electronic-city',
    lat: 12.8471,
    lng: 77.6618,
    units: 460,
    acres: 8,
    openSpace: 58,
    status: 'readyToMove',
    completion: 100,
    promised: '2025-03-01T00:00:00.000Z',
    current: '2025-05-01T00:00:00.000Z',
    rera: rera('registered', '000509/000509', '2028-03-31T00:00:00.000Z'),
    amenities: [
      'Swimming pool',
      'Gymnasium',
      'Clubhouse',
      'Jogging track',
      'Park',
      'Creche',
      'Badminton court',
    ],
  },
  {
    id: 'proj-northwind-arbour',
    name: 'Northwind Arbour',
    slug: 'northwind-arbour',
    dev: 'dev-northwind',
    locality: 'loc-yelahanka',
    lat: 13.1021,
    lng: 77.5941,
    units: 280,
    acres: 9,
    openSpace: 72,
    status: 'underConstruction',
    completion: 61,
    promised: '2027-03-01T00:00:00.000Z',
    current: '2027-06-01T00:00:00.000Z',
    rera: rera('registered', '000614/000614', '2029-06-30T00:00:00.000Z'),
    amenities: [
      'Swimming pool',
      'Gymnasium',
      'Clubhouse',
      'Organic farm',
      'Jogging track',
      'Park',
      'Creche',
      'Amphitheatre',
    ],
  },
  {
    id: 'proj-verdant-quarter',
    name: 'Verdant Quarter',
    slug: 'verdant-quarter',
    dev: 'dev-verdant',
    locality: 'loc-whitefield',
    lat: 12.9655,
    lng: 77.7521,
    units: 390,
    acres: 5,
    openSpace: 38,
    status: 'resale',
    completion: 100,
    promised: '2021-09-01T00:00:00.000Z',
    current: '2022-02-01T00:00:00.000Z',
    rera: rera('registered', '000703/000703', '2027-09-30T00:00:00.000Z'),
    amenities: ['Swimming pool', 'Gymnasium', 'Clubhouse', 'Park'],
  },
];

export const DEMO_PROJECTS: readonly Project[] = PROJ_SEEDS.map((p) => ({
  id: asId<ProjectId>(p.id),
  name: p.name,
  slug: p.slug,
  developerId: asId<DeveloperId>(p.dev),
  localityId: asId<LocalityId>(p.locality),
  microMarketId: asId(`mm-${p.locality.replace('loc-', '')}`),
  cityId: BENGALURU,
  location: { lat: p.lat, lng: p.lng },
  kinds: ['apartment'],
  totalUnits: p.units,
  landAreaAcres: p.acres,
  openSpacePercent: p.openSpace,
  launchedAt: '2023-07-01T00:00:00.000Z',
  amenities: p.amenities,
  towers: [],
  phases: [
    {
      id: asId<PhaseId>(`${p.id}-phase-1`),
      projectId: asId<ProjectId>(p.id),
      name: 'Phase 1',
      rera: p.rera,
      promisedPossession: p.promised,
      currentPossession: p.current,
      constructionStatus: p.status,
      completionPercent: p.completion,
    },
  ],
}));

// ---------------------------------------------------------------------------
// Properties (invented units within the above projects)
// ---------------------------------------------------------------------------

interface PropSeed {
  id: string;
  project: string;
  title: string;
  beds: number;
  baths: number;
  sba: number;
  carpet: number;
  floor: number;
  totalFloors: number;
  facing: Facing;
  price: number;
  rent: number;
  maintenance: number;
  /** When true, evidence is deliberately sparse to exercise the evidence gate. */
  thin?: boolean;
}

const PROP_SEEDS: readonly PropSeed[] = [
  {
    id: 'prop-nm-3a',
    project: 'proj-northwind-meadows',
    title: '3 BHK in Northwind Meadows',
    beds: 3,
    baths: 3,
    sba: 1685,
    carpet: 1210,
    floor: 9,
    totalFloors: 14,
    facing: 'NE',
    price: 15_900_000,
    rent: 52_000,
    maintenance: 4,
  },
  {
    id: 'prop-nm-2b',
    project: 'proj-northwind-meadows',
    title: '2 BHK in Northwind Meadows',
    beds: 2,
    baths: 2,
    sba: 1180,
    carpet: 845,
    floor: 6,
    totalFloors: 14,
    facing: 'E',
    price: 11_200_000,
    rent: 38_000,
    maintenance: 4,
  },
  {
    id: 'prop-th-3a',
    project: 'proj-tamarind-heights',
    title: '3 BHK in Tamarind Heights',
    beds: 3,
    baths: 3,
    sba: 1920,
    carpet: 1420,
    floor: 11,
    totalFloors: 18,
    facing: 'N',
    price: 26_800_000,
    rent: 78_000,
    maintenance: 5.5,
  },
  {
    id: 'prop-th-4a',
    project: 'proj-tamarind-heights',
    title: '4 BHK in Tamarind Heights',
    beds: 4,
    baths: 4,
    sba: 2640,
    carpet: 1980,
    floor: 15,
    totalFloors: 18,
    facing: 'NE',
    price: 38_500_000,
    rent: 105_000,
    maintenance: 5.5,
  },
  {
    id: 'prop-vc-3a',
    project: 'proj-verdant-canopy',
    title: '3 BHK in Verdant Canopy',
    beds: 3,
    baths: 3,
    sba: 1560,
    carpet: 1060,
    floor: 7,
    totalFloors: 21,
    facing: 'W',
    price: 17_400_000,
    rent: 48_000,
    maintenance: 4.2,
  },
  {
    id: 'prop-vc-2a',
    project: 'proj-verdant-canopy',
    title: '2 BHK in Verdant Canopy',
    beds: 2,
    baths: 2,
    sba: 1125,
    carpet: 762,
    floor: 14,
    totalFloors: 21,
    facing: 'S',
    price: 12_900_000,
    rent: 34_000,
    maintenance: 4.2,
  },
  {
    id: 'prop-cc-3a',
    project: 'proj-cobalt-crest',
    title: '3 BHK in Cobalt Crest',
    beds: 3,
    baths: 2,
    sba: 1480,
    carpet: 935,
    floor: 4,
    totalFloors: 19,
    facing: 'SW',
    price: 14_600_000,
    rent: 36_000,
    maintenance: 3.8,
  },
  {
    id: 'prop-sv-2a',
    project: 'proj-silverline-vista',
    title: '2 BHK in Silverline Vista',
    beds: 2,
    baths: 2,
    sba: 1040,
    carpet: 648,
    floor: 3,
    totalFloors: 12,
    facing: 'SW',
    price: 7_900_000,
    rent: 19_000,
    maintenance: 3.2,
    thin: true,
  },
  {
    id: 'prop-kg-3a',
    project: 'proj-kadamba-grove',
    title: '3 BHK in Kadamba Grove',
    beds: 3,
    baths: 3,
    sba: 1495,
    carpet: 1105,
    floor: 8,
    totalFloors: 12,
    facing: 'E',
    price: 10_400_000,
    rent: 33_000,
    maintenance: 3.5,
  },
  {
    id: 'prop-kg-2a',
    project: 'proj-kadamba-grove',
    title: '2 BHK in Kadamba Grove',
    beds: 2,
    baths: 2,
    sba: 1085,
    carpet: 790,
    floor: 5,
    totalFloors: 12,
    facing: 'N',
    price: 7_600_000,
    rent: 24_000,
    maintenance: 3.5,
  },
  {
    id: 'prop-na-3a',
    project: 'proj-northwind-arbour',
    title: '3 BHK in Northwind Arbour',
    beds: 3,
    baths: 3,
    sba: 1740,
    carpet: 1305,
    floor: 5,
    totalFloors: 8,
    facing: 'NE',
    price: 13_900_000,
    rent: 40_000,
    maintenance: 3.9,
  },
  {
    id: 'prop-vq-3a',
    project: 'proj-verdant-quarter',
    title: '3 BHK resale in Verdant Quarter',
    beds: 3,
    baths: 3,
    sba: 1610,
    carpet: 1140,
    floor: 10,
    totalFloors: 16,
    facing: 'E',
    price: 13_200_000,
    rent: 46_000,
    maintenance: 4.1,
  },
];

const projectFor = (id: string): Project => {
  const found = DEMO_PROJECTS.find((p) => p.id === id);
  if (!found) throw new Error(`Fixture integrity error: unknown project ${id}`);
  return found;
};

export const DEMO_PROPERTIES: readonly Property[] = PROP_SEEDS.map((s) => {
  const project = projectFor(s.project);
  const phase = project.phases[0]!;
  const evidence = s.thin
    ? [demoEvidence('property.askingPrice', s.price, '2025-11-01T00:00:00.000Z', 0.35)]
    : [
        demoEvidence('property.askingPrice', s.price, '2026-05-20T00:00:00.000Z', 0.8),
        demoEvidence('property.carpetAreaSqFt', s.carpet, '2026-05-20T00:00:00.000Z', 0.85),
        demoEvidence('property.areaSqFt', s.sba, '2026-05-20T00:00:00.000Z', 0.85),
        demoEvidence('property.floor', s.floor, '2026-05-20T00:00:00.000Z', 0.9),
        demoEvidence('property.facing', 'documented', '2026-05-20T00:00:00.000Z', 0.7),
        demoEvidence('property.bedrooms', s.beds, '2026-05-20T00:00:00.000Z', 0.95),
        demoEvidence('property.bathrooms', s.baths, '2026-05-20T00:00:00.000Z', 0.95),
        demoEvidence(
          'property.constructionStatus',
          phase.constructionStatus,
          '2026-05-15T00:00:00.000Z',
          0.8,
        ),
        demoEvidence('property.expectedRentPerMonth', s.rent, '2026-05-01T00:00:00.000Z', 0.55),
        demoEvidence('phase.rera.status', phase.rera?.status, '2026-04-20T00:00:00.000Z', 0.9),
        demoEvidence('phase.rera.number', phase.rera?.number, '2026-04-20T00:00:00.000Z', 0.9),
        demoEvidence(
          'phase.rera.validUntil',
          phase.rera?.validUntil,
          '2026-04-20T00:00:00.000Z',
          0.85,
        ),
        demoEvidence(
          'phase.completionPercent',
          phase.completionPercent,
          '2026-05-10T00:00:00.000Z',
          0.7,
        ),
        demoEvidence(
          'phase.currentPossession',
          phase.currentPossession,
          '2026-05-10T00:00:00.000Z',
          0.7,
        ),
        demoEvidence('developer.unitsDelivered', undefined, '2026-02-01T00:00:00.000Z', 0.75),
        demoEvidence('developer.averageDelayMonths', undefined, '2026-02-01T00:00:00.000Z', 0.6),
        demoEvidence(
          'developer.ongoingLitigationCount',
          undefined,
          '2026-02-01T00:00:00.000Z',
          0.6,
        ),
        demoEvidence('developer.reraComplaintsCount', undefined, '2026-02-01T00:00:00.000Z', 0.6),
        demoEvidence('project.openSpacePercent', undefined, '2026-01-15T00:00:00.000Z', 0.7),
        demoEvidence('project.totalUnits', undefined, '2026-01-15T00:00:00.000Z', 0.8),
        demoEvidence('project.landAreaAcres', undefined, '2026-01-15T00:00:00.000Z', 0.8),
        demoEvidence('project.amenities', undefined, '2026-01-15T00:00:00.000Z', 0.7),
      ];

  return {
    id: asId<PropertyId>(s.id),
    unitTypeId: asId<UnitTypeId>(`${s.id}-ut`),
    projectId: project.id,
    title: s.title,
    kind: 'apartment',
    constructionStatus: phase.constructionStatus,
    bedrooms: s.beds,
    bathrooms: s.baths,
    areaSqFt: s.sba,
    areaBasis: 'superBuiltUp',
    carpetAreaSqFt: s.carpet,
    floor: s.floor,
    totalFloors: s.totalFloors,
    facing: s.facing,
    askingPrice: s.price,
    maintenancePerSqFtMonth: s.maintenance,
    expectedRentPerMonth: s.rent,
    localityId: project.localityId,
    cityId: BENGALURU,
    location: project.location,
    listedAt: '2026-04-28T00:00:00.000Z',
    // A generated architectural illustration, not a photograph — these
    // properties are invented, and a stock photo of a real building attached to
    // one would be a fabricated fact with a picture frame around it. The file
    // says so inside the image. Generated by scripts/generate-property-art.ts.
    images: [`/property-art/${s.id}.svg`],
    dataStatus: 'demo',
    evidence,
    commercial: NO_COMMERCIAL_RELATIONSHIP,
  };
});

/**
 * Synthetic comparables per locality.
 *
 * Derived from each property's own locality median with deterministic spread,
 * so the valuation engine has something coherent to work with in development.
 * Deliberately sparse for the thin fixture so INSUFFICIENT EVIDENCE is reachable.
 */
export const demoComparables = (
  propertyId: string,
  localityMedianPsf: number,
  carpet: number,
): readonly Comparable[] => {
  if (propertyId === 'prop-sv-2a') {
    return [
      {
        label: 'Nearby resale, 2 BHK',
        soldOrListedAt: '2025-08-12T00:00:00.000Z',
        isTransaction: false,
        carpetAreaSqFt: Math.round(carpet * 1.05),
        pricePerSqFt: Math.round(localityMedianPsf * 1.02),
        distanceKm: 2.4,
        dataStatus: 'demo',
      },
    ];
  }

  // Five comparables spread around the locality median on a carpet basis.
  const spreads = [
    { d: 0.6, psf: 1.0, tx: true, days: 24, size: 1.0 },
    { d: 1.2, psf: 1.06, tx: true, days: 61, size: 1.08 },
    { d: 1.9, psf: 0.95, tx: true, days: 96, size: 0.93 },
    { d: 2.6, psf: 1.11, tx: false, days: 14, size: 1.15 },
    { d: 3.4, psf: 0.92, tx: false, days: 132, size: 0.88 },
  ];
  // Locality medians are quoted on super built-up; convert to a carpet basis.
  const carpetBasisPsf = localityMedianPsf / 0.71;
  return spreads.map((s, i) => {
    const date = new Date(Date.UTC(2026, 5, 1) - s.days * 86_400_000);
    return {
      label: `Comparable ${String.fromCharCode(65 + i)} — ${s.tx ? 'registered sale' : 'active listing'}`,
      soldOrListedAt: date.toISOString(),
      isTransaction: s.tx,
      carpetAreaSqFt: Math.round(carpet * s.size),
      pricePerSqFt: Math.round(carpetBasisPsf * s.psf),
      distanceKm: s.d,
      ageYears: s.tx ? 0 : 1,
      dataStatus: 'demo' as const,
    };
  });
};
