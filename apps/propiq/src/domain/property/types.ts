/**
 * The canonical property hierarchy.
 *
 *   City → MicroMarket → Locality → (Developer) → Project → Phase → Tower
 *        → UnitType → Unit
 *
 * India-specific realities this model has to carry:
 *  - Area is quoted three ways (carpet / built-up / super built-up) and the
 *    difference is the whole negotiation. We always store the basis.
 *  - RERA registration is per project *phase*, not per project.
 *  - Possession dates slip; we keep both the promised and the current date.
 */

import type {
  AreaBasis,
  CityId,
  DeveloperId,
  GeoPoint,
  INR,
  Instant,
  LocalityId,
  MicroMarketId,
  PhaseId,
  ProjectId,
  PropertyId,
  SqFt,
  TowerId,
  UnitId,
  UnitTypeId,
} from '../shared/types';
import type { DataStatus, Evidence } from '../evidence/types';

export const PROPERTY_KINDS = [
  'apartment',
  'villa',
  'plot',
  'rowHouse',
  'studio',
  'penthouse',
] as const;
export type PropertyKind = (typeof PROPERTY_KINDS)[number];

export const CONSTRUCTION_STATUSES = [
  'preLaunch',
  'underConstruction',
  'nearingPossession',
  'readyToMove',
  'resale',
] as const;
export type ConstructionStatus = (typeof CONSTRUCTION_STATUSES)[number];

export const FACINGS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export type Facing = (typeof FACINGS)[number];

export interface City {
  readonly id: CityId;
  readonly name: string;
  readonly slug: string;
  readonly state: string;
  readonly center: GeoPoint;
  /** Market coverage flag: only cities with real evidence coverage go live. */
  readonly coverage: 'live' | 'preview' | 'planned';
}

export interface MicroMarket {
  readonly id: MicroMarketId;
  readonly cityId: CityId;
  readonly name: string;
  readonly slug: string;
}

export interface Developer {
  readonly id: DeveloperId;
  readonly name: string;
  readonly slug: string;
  readonly incorporatedYear?: number;
  readonly headquarters?: string;
  readonly projectsDelivered?: number;
  readonly unitsDelivered?: number;
  /** Mean delay across delivered projects, in months. Negative = early. */
  readonly averageDelayMonths?: number;
  readonly ongoingLitigationCount?: number;
  readonly reraComplaintsCount?: number;
}

export interface ReraRegistration {
  readonly number: string;
  readonly state: string;
  readonly registeredAt?: Instant;
  readonly validUntil?: Instant;
  readonly status: 'registered' | 'expired' | 'lapsed' | 'notRegistered' | 'unknown';
  readonly portalUrl?: string;
}

export interface Phase {
  readonly id: PhaseId;
  readonly projectId: ProjectId;
  readonly name: string;
  readonly rera?: ReraRegistration;
  readonly promisedPossession?: Instant;
  readonly currentPossession?: Instant;
  readonly constructionStatus: ConstructionStatus;
  /** 0..100 completion as last observed. */
  readonly completionPercent?: number;
}

export interface Tower {
  readonly id: TowerId;
  readonly phaseId: PhaseId;
  readonly name: string;
  readonly floors: number;
  readonly unitsPerFloor?: number;
}

export interface Project {
  readonly id: ProjectId;
  readonly name: string;
  readonly slug: string;
  readonly developerId: DeveloperId;
  readonly localityId: LocalityId;
  readonly microMarketId: MicroMarketId;
  readonly cityId: CityId;
  readonly location: GeoPoint;
  readonly kinds: readonly PropertyKind[];
  readonly totalUnits?: number;
  readonly landAreaAcres?: number;
  readonly openSpacePercent?: number;
  readonly launchedAt?: Instant;
  readonly amenities: readonly string[];
  readonly phases: readonly Phase[];
  readonly towers: readonly Tower[];
}

export interface FloorPlan {
  readonly rooms?: number;
  readonly balconies?: number;
  readonly bathrooms: number;
  /** Ratio of carpet to super built-up area. Below ~0.62 is poor value in most metros. */
  readonly efficiency?: number;
  /** 0..1 proxies produced by floor-plan intelligence; always carry confidence. */
  readonly ventilationProxy?: number;
  readonly daylightProxy?: number;
  readonly privacyProxy?: number;
  readonly planUrl?: string;
  readonly extractionConfidence?: number;
}

export interface UnitType {
  readonly id: UnitTypeId;
  readonly projectId: ProjectId;
  readonly label: string; // e.g. "3BHK + 3T"
  readonly bedrooms: number;
  readonly carpetAreaSqFt: SqFt;
  readonly builtUpAreaSqFt?: SqFt;
  readonly superBuiltUpAreaSqFt?: SqFt;
  readonly floorPlan?: FloorPlan;
}

export interface PricingBreakdown {
  readonly basePrice: INR;
  readonly floorRisePremium?: INR;
  readonly plcPremium?: INR; // preferential location charge
  readonly parking?: INR;
  readonly clubhouse?: INR;
  readonly maintenanceAdvance?: INR;
  readonly gst?: INR;
  readonly stampDutyAndRegistration?: INR;
  readonly otherCharges?: INR;
}

/**
 * A `Property` is the thing a buyer actually evaluates: a specific unit, or a
 * unit type within a project when a specific unit has not been chosen yet.
 * It is the aggregate root the Property Intelligence Page renders.
 */
export interface Property {
  readonly id: PropertyId;
  readonly unitId?: UnitId;
  readonly unitTypeId: UnitTypeId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly kind: PropertyKind;
  readonly constructionStatus: ConstructionStatus;
  readonly bedrooms: number;
  readonly bathrooms: number;
  readonly areaSqFt: SqFt;
  readonly areaBasis: AreaBasis;
  readonly carpetAreaSqFt?: SqFt;
  readonly floor?: number;
  readonly totalFloors?: number;
  readonly facing?: Facing;
  readonly askingPrice: INR;
  readonly pricing?: PricingBreakdown;
  readonly maintenancePerSqFtMonth?: INR;
  readonly expectedRentPerMonth?: INR;
  readonly localityId: LocalityId;
  readonly cityId: CityId;
  readonly location: GeoPoint;
  readonly listedAt?: Instant;
  readonly images: readonly string[];
  /** Aggregate status of the record: demo fixtures can never claim anything else. */
  readonly dataStatus: DataStatus;
  readonly evidence: readonly Evidence[];
  /** Commercial disclosure — must never influence the organic score. */
  readonly commercial: CommercialRelationship;
}

export interface CommercialRelationship {
  readonly developerRelationship: boolean;
  readonly paidPlacement: boolean;
  readonly commissionPossible: boolean;
  readonly note?: string;
}

export const NO_COMMERCIAL_RELATIONSHIP: CommercialRelationship = {
  developerRelationship: false,
  paidPlacement: false,
  commissionPossible: false,
};

export const pricePerSqFt = (property: Property): INR =>
  property.areaSqFt > 0 ? Math.round(property.askingPrice / property.areaSqFt) : 0;

/** Carpet-area price is the only cross-project comparable figure in Indian markets. */
export const carpetPricePerSqFt = (property: Property): INR | undefined => {
  const carpet =
    property.carpetAreaSqFt ?? (property.areaBasis === 'carpet' ? property.areaSqFt : undefined);
  if (!carpet || carpet <= 0) return undefined;
  return Math.round(property.askingPrice / carpet);
};

export const carpetEfficiency = (property: Property): number | undefined => {
  const carpet = property.carpetAreaSqFt;
  if (!carpet || property.areaSqFt <= 0) return undefined;
  return carpet / property.areaSqFt;
};
