/**
 * Property snapshots.
 *
 * A snapshot is the small comparable slice of an intelligence payload that
 * alerts diff against. Kept deliberately narrow: storing a full payload per
 * property per evaluation would grow without bound and add no signal, since
 * only these fields can produce an alert.
 *
 * The in-memory store is a development stand-in. Production persistence lands
 * with the scheduler — the `scores` table already carries the payload history
 * this would be derived from.
 */

import 'server-only';
import type { PropertySnapshot } from '@/domain/alerts/types';
import type { PropertyIntelligence } from '@/server/intelligence';

export const toSnapshot = (intel: PropertyIntelligence): PropertySnapshot => ({
  propertyId: intel.property.id,
  capturedAt: intel.computedAt,
  askingPrice: intel.property.askingPrice,
  fairValueMid: intel.valuation.insufficientEvidence ? undefined : intel.valuation.mid,
  score: intel.score.score,
  decision: intel.decision.decision,
  reraStatus: intel.project?.phases[0]?.rera?.status,
  possessionDate: intel.project?.phases[0]?.currentPossession,
  compositeRiskBand: intel.risk.compositeBand,
  materialRiskDimensions: intel.risk.materialRisks.map((r) => r.dimension),
  stalePercentage: intel.freshness.stalePercentage,
});

export interface SnapshotStore {
  latest(userId: string, propertyId: string): Promise<PropertySnapshot | undefined>;
  put(userId: string, snapshot: PropertySnapshot): Promise<void>;
}

class MemorySnapshotStore implements SnapshotStore {
  private readonly rows = new Map<string, PropertySnapshot>();
  private key(userId: string, propertyId: string) {
    return `${userId}::${propertyId}`;
  }
  async latest(userId: string, propertyId: string) {
    return this.rows.get(this.key(userId, propertyId));
  }
  async put(userId: string, snapshot: PropertySnapshot) {
    this.rows.set(this.key(userId, snapshot.propertyId), snapshot);
  }
}

const store: SnapshotStore = new MemorySnapshotStore();

export const getSnapshotStore = (): SnapshotStore => store;
