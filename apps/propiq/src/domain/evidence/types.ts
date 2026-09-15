/**
 * The evidence model is the spine of PropIQ's truthfulness rule.
 *
 * Every material fact the product shows must be attached to an `Evidence`
 * record that says where it came from, when it was observed, how confident we
 * are, and — critically — whether it is real. A value with no evidence is not
 * displayed as intelligence; it is displayed as unknown.
 *
 * `dataStatus` is the load-bearing field:
 *   verified  — observed directly from an authoritative source we trust
 *   derived   — computed from verified inputs by a documented method
 *   estimated — modelled, with a confidence band; never presented as fact
 *   demo      — development fixture. MUST be visibly labelled in the UI and
 *               MUST never be produced by a production adapter.
 */

import type { EvidenceId, Instant, Unit01 } from '../shared/types';

export const DATA_STATUSES = ['verified', 'derived', 'estimated', 'demo'] as const;
export type DataStatus = (typeof DATA_STATUSES)[number];

export const SOURCE_TYPES = [
  'rera', // state RERA registry filing
  'registry', // sub-registrar / encumbrance records
  'developer', // developer-published material (brochure, price list)
  'listing', // marketplace or broker listing
  'transaction', // observed completed transaction
  'survey', // PropIQ field survey / site visit capture
  'government', // municipal, census, transport authority
  'partner', // contracted data partner feed
  'user', // user-supplied (portfolio, documents)
  'model', // PropIQ-computed estimate
  'fixture', // development fixture
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const REVIEW_STATES = [
  'unreviewed',
  'machine_checked',
  'human_verified',
  'disputed',
] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export interface PropertySource {
  readonly id: string;
  readonly name: string;
  readonly type: SourceType;
  /** Public URL or an internal reference (e.g. a RERA registration number). */
  readonly reference?: string;
  /** How much we trust this source class, 0..1. Feeds evidence confidence. */
  readonly trust: Unit01;
}

export interface Evidence<T = unknown> {
  readonly id: EvidenceId;
  /** Dotted path of the fact this supports, e.g. "project.possessionDate". */
  readonly field: string;
  readonly value: T;
  readonly source: PropertySource;
  /** When the underlying fact was observed. */
  readonly observedAt: Instant;
  /** When the fact takes effect (a price list can be observed before it applies). */
  readonly effectiveAt?: Instant;
  /** Last time we re-checked the source. Drives staleness. */
  readonly lastVerifiedAt?: Instant;
  readonly dataStatus: DataStatus;
  readonly confidence: Unit01;
  /** Version of the method that produced a derived/estimated value. */
  readonly methodologyVersion?: string;
  readonly reviewState: ReviewState;
  readonly disputed?: boolean;
  readonly note?: string;
}

/** A value plus its provenance. The only shape the UI should render as a fact. */
export interface Attested<T> {
  readonly value: T;
  readonly evidence: Evidence<T>;
}

export const attest = <T>(value: T, evidence: Evidence<T>): Attested<T> => ({ value, evidence });

/** True when any part of the payload is demo data — the UI must then show the DEMO badge. */
export const containsDemoData = (evidence: readonly Evidence[]): boolean =>
  evidence.some((e) => e.dataStatus === 'demo');

export const isRealData = (status: DataStatus): boolean => status !== 'demo';
