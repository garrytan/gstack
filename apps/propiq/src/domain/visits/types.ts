/**
 * Site visits.
 *
 * A site visit is the one moment a buyer generates first-party evidence, and
 * it is the only evidence in the whole product that is not second-hand. That
 * makes it worth structuring: an observation captured against a named checklist
 * item becomes an `Evidence` record with source type `survey`, which then feeds
 * scoring exactly like any other evidence.
 *
 * The checklist is India-specific because the failures are: water source,
 * transformer capacity, monsoon waterlogging and what is going to be built on
 * the empty plot next door are the things that turn a good-looking flat into a
 * bad decision, and none of them appear in a brochure.
 */

import type { Instant, PropertyId, Unit01, UserId } from '../shared/types';

export const VISIT_CATEGORIES = [
  'water',
  'power',
  'construction',
  'unit',
  'surroundings',
  'access',
  'amenities',
  'legal',
] as const;
export type VisitCategory = (typeof VISIT_CATEGORIES)[number];

export const CATEGORY_LABELS: Readonly<Record<VisitCategory, string>> = {
  water: 'Water',
  power: 'Power',
  construction: 'Construction quality',
  unit: 'The unit itself',
  surroundings: 'Surroundings',
  access: 'Access and roads',
  amenities: 'Amenities',
  legal: 'Paperwork on site',
};

export type Answer = 'good' | 'acceptable' | 'concern' | 'unknown';

export interface ChecklistItem {
  readonly id: string;
  readonly category: VisitCategory;
  readonly question: string;
  /** Why it matters — shown inline, because a checklist nobody understands gets ticked. */
  readonly why: string;
  /** The evidence field this answer attaches to, when it maps onto one. */
  readonly evidenceField?: string;
  /** A `concern` here is serious enough to change the verdict. */
  readonly material: boolean;
}

export interface VisitObservation {
  readonly itemId: string;
  readonly answer: Answer;
  readonly note?: string;
}

export const VISIT_STATUSES = ['scheduled', 'completed', 'cancelled'] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];

export interface SiteVisit {
  readonly id: string;
  readonly userId: UserId;
  readonly propertyId: PropertyId;
  readonly scheduledFor: string;
  readonly status: VisitStatus;
  readonly completedAt?: Instant;
  readonly observations: readonly VisitObservation[];
  readonly overallNote?: string;
  readonly createdAt: Instant;
}

export interface VisitSummary {
  readonly visitId: string;
  readonly answered: number;
  readonly total: number;
  readonly concerns: readonly ChecklistItem[];
  readonly materialConcerns: readonly ChecklistItem[];
  readonly unknowns: readonly ChecklistItem[];
  /** 0..1 across answered items. Undefined when nothing was answered. */
  readonly score: Unit01 | undefined;
  readonly completeness: Unit01;
}
