/**
 * Data ports.
 *
 * The domain and the application talk to these interfaces, never to Supabase
 * or to a fixture file. That is what lets the same Property Intelligence Page
 * run against the labelled demo dataset today and a real feed tomorrow, and
 * it is where the contract for any future production source is written down.
 *
 * Contract every adapter must honour:
 *  1. Never invent a field. Absent data is `undefined`, never a plausible guess.
 *  2. Every returned record carries an accurate `dataStatus`.
 *  3. A production adapter must never return `dataStatus: 'demo'`.
 */

import type {
  CityId,
  DeveloperId,
  LocalityId,
  ProjectId,
  PropertyId,
  UserId,
} from '@/domain/shared/types';
import type { Developer, Project, Property } from '@/domain/property/types';
import type { Locality } from '@/domain/locality/types';
import type { Comparable } from '@/domain/valuation/types';
import type { AlertDigest } from '@/domain/alerts/digest';

export interface PropertySearchQuery {
  readonly text?: string;
  readonly cityId?: CityId;
  readonly localityIds?: readonly LocalityId[];
  readonly priceMin?: number;
  readonly priceMax?: number;
  readonly bedroomsMin?: number;
  readonly bedroomsMax?: number;
  readonly kinds?: readonly string[];
  readonly constructionStatus?: readonly string[];
  readonly sort?: 'relevance' | 'priceAsc' | 'priceDesc' | 'scoreDesc' | 'newest';
  readonly page?: number;
  readonly pageSize?: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly hasMore: boolean;
}

export interface PropertyRepository {
  /** Identifies the backing source so the UI can disclose it. */
  readonly adapterName: string;
  /** True when this adapter serves development fixtures. */
  readonly servesDemoData: boolean;
  /**
   * True when no property source is connected at all. Distinguishes "your
   * filters matched nothing" from "this deployment has no data", which are
   * different sentences to show a buyer.
   */
  readonly servesNoData: boolean;

  search(query: PropertySearchQuery): Promise<Page<Property>>;
  getById(id: PropertyId): Promise<Property | undefined>;
  getManyByIds(ids: readonly PropertyId[]): Promise<readonly Property[]>;
  getProject(id: ProjectId): Promise<Project | undefined>;
  getDeveloper(id: DeveloperId): Promise<Developer | undefined>;
  getLocality(id: LocalityId): Promise<Locality | undefined>;
  getLocalityBySlug(slug: string): Promise<Locality | undefined>;
  listLocalities(cityId?: CityId): Promise<readonly Locality[]>;
  /** Comparable sales/listings used by the valuation engine. */
  getComparables(id: PropertyId): Promise<readonly Comparable[]>;
  /** Alternatives the Decision Room can offer against a subject property. */
  getAlternatives(id: PropertyId, limit?: number): Promise<readonly Property[]>;
}

export interface WatchlistEntry {
  readonly id: string;
  readonly userId: UserId;
  readonly propertyId: PropertyId;
  readonly note?: string;
  readonly createdAt: string;
}

export interface WatchlistRepository {
  list(userId: UserId): Promise<readonly WatchlistEntry[]>;
  add(userId: UserId, propertyId: PropertyId, note?: string): Promise<WatchlistEntry>;
  remove(userId: UserId, propertyId: PropertyId): Promise<void>;
  has(userId: UserId, propertyId: PropertyId): Promise<boolean>;
}

export interface PortfolioAsset {
  readonly id: string;
  readonly userId: UserId;
  readonly label: string;
  readonly propertyId?: PropertyId;
  readonly purchasePrice: number;
  readonly purchaseDate: string;
  readonly costBasis: number;
  readonly outstandingLoan: number;
  readonly monthlyRent: number;
  readonly monthlyExpenses: number;
  readonly currentEstimate?: number;
  /** Which parts of this record the user supplied versus what we estimated. */
  readonly valuationSource: 'userProvided' | 'estimated' | 'verified';
  readonly createdAt: string;
}

export interface PortfolioRepository {
  list(userId: UserId): Promise<readonly PortfolioAsset[]>;
  add(
    userId: UserId,
    asset: Omit<PortfolioAsset, 'id' | 'userId' | 'createdAt'>,
  ): Promise<PortfolioAsset>;
  remove(userId: UserId, assetId: string): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Notifications and alert delivery                                            */
/* -------------------------------------------------------------------------- */

/**
 * Where a digest can go. `inApp` is always available because it needs nothing
 * but the database; the other two are configuration, and their absence is
 * reported rather than hidden.
 */
export const DELIVERY_CHANNELS = ['inApp', 'webhook', 'email'] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

export const DELIVERY_CHANNEL_LABELS: Readonly<Record<DeliveryChannel, string>> = {
  inApp: 'In-app inbox',
  webhook: 'Webhook',
  email: 'Email',
};

/** One row in a user's notification inbox. Mirrors an `Alert`, plus read state. */
export interface NotificationRecord {
  readonly id: string;
  readonly userId: UserId;
  readonly propertyId: PropertyId | undefined;
  readonly kind: string;
  readonly severity: 'info' | 'attention' | 'urgent';
  readonly headline: string;
  readonly detail: string;
  /** Which published threshold fired, so a notification is always traceable. */
  readonly rule: string;
  readonly createdAt: string;
  readonly readAt: string | undefined;
}

export type NewNotification = Omit<NotificationRecord, 'id' | 'userId' | 'createdAt' | 'readAt'>;

export interface NotificationRepository {
  list(userId: UserId, limit?: number): Promise<readonly NotificationRecord[]>;
  /**
   * Append notifications. Adapters must be idempotent on
   * (user, propertyId, kind, rule, createdAt-day) so a scheduler that
   * double-fires does not double-notify.
   */
  add(userId: UserId, records: readonly NewNotification[]): Promise<readonly NotificationRecord[]>;
  markAllRead(userId: UserId, now: string): Promise<number>;
  unreadCount(userId: UserId): Promise<number>;
}

/**
 * `notConfigured` is a first-class outcome, not a failure. A channel with no
 * credentials reports itself honestly instead of pretending to have sent
 * something — the same rule the rest of the product follows for missing data.
 */
export type DeliveryOutcome = 'delivered' | 'skipped' | 'failed' | 'notConfigured';

export interface DeliveryReceipt {
  readonly channel: DeliveryChannel;
  readonly outcome: DeliveryOutcome;
  /** Human-readable reason. For `notConfigured`, the integration requirement. */
  readonly detail: string;
  readonly attemptedAt: string;
}

export interface AlertNotifier {
  readonly channel: DeliveryChannel;
  /** False means the channel will report `notConfigured` rather than send. */
  isConfigured(): boolean;
  send(userId: UserId, digest: AlertDigest): Promise<DeliveryReceipt>;
}
