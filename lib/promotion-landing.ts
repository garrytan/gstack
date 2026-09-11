import { createCanaryPending } from './lane-canary';
import type { ShipHandoffInspection } from './evidence-envelope';

const FULL_OID = /^[0-9a-f]{40}$/;
const RAW_INTENT = /^[0-9a-f]{64}$/;

function digest(value: unknown): string {
  return new Bun.CryptoHasher('sha256').update(JSON.stringify(value)).digest('hex');
}

export interface VerifiedDirectMerge {
  status: 'merged';
  mergeSha: string;
  expectedHeadOid: string;
  expectedBaseOid: string;
  intentId: string;
  baseAtomicity: 'verified';
}

export function createPromotionCanaryPending(input: {
  stateRoot: string;
  handoff: Pick<ShipHandoffInspection, 'promotion' | 'candidate_profile' | 'remote_pr_head_sha' | 'base_sha' | 'repo_id' | 'receipt_run_id'>;
  merge: VerifiedDirectMerge;
}) {
  const { handoff, merge } = input;
  if (!handoff.promotion || !handoff.candidate_profile) throw new Error('promotion_ship_receipt_required');
  if (!FULL_OID.test(merge.mergeSha) || !FULL_OID.test(merge.expectedHeadOid) || !FULL_OID.test(merge.expectedBaseOid)
    || !RAW_INTENT.test(merge.intentId) || merge.status !== 'merged' || merge.baseAtomicity !== 'verified') throw new Error('promotion_landing_checkpoint_invalid');
  if (handoff.remote_pr_head_sha !== merge.expectedHeadOid || handoff.base_sha !== merge.expectedBaseOid
    || handoff.candidate_profile.schema_validation_hash !== handoff.promotion.after_profile_hash) throw new Error('promotion_landing_lineage_mismatch');
  const landingBody = { raw_intent_id: merge.intentId, receipt_run_id: handoff.receipt_run_id, proof_id: handoff.promotion.proof_id, record_id: handoff.promotion.record_id };
  const promotionLandingIntentId = `landing-${digest(landingBody).slice(0, 32)}`;
  const promotionCheckpointId = `checkpoint-${digest({ ...landingBody, merge_sha: merge.mergeSha }).slice(0, 32)}`;
  const pending = createCanaryPending({
    stateRoot: input.stateRoot,
    repoId: handoff.repo_id,
    lane: handoff.promotion.lane,
    profileHash: handoff.promotion.after_profile_hash,
    promotionProofId: handoff.promotion.proof_id,
    promotionRecordId: handoff.promotion.record_id,
    promotionLandingIntentId,
    promotionCheckpointId,
    promotionReceiptId: handoff.receipt_run_id,
  });
  return { schema: 'ecpe.promotion-landing.v1' as const, ...pending, merge_sha: merge.mergeSha, raw_landing_intent_id: merge.intentId, promotion_landing_intent_id: promotionLandingIntentId, promotion_checkpoint_id: promotionCheckpointId, promotion_receipt_id: handoff.receipt_run_id };
}
