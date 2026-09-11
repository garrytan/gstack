import {
  updateMilestoneBlock,
  type DurableMilestoneBlock,
  type DurableTerminalResourceHandoff,
} from './milestone-block';

const digest = (value: string | Uint8Array) =>
  new Bun.CryptoHasher('sha256').update(value).digest('hex');

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stable(row[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface HarnessAbortResourceHandoffInput {
  stateRoot: string;
  blockId: string;
  slotId: string;
  claimId: string;
  generation: 0 | 1;
  resourceLineageId: string;
  handle: string;
  cleanupAuthorityId: string;
  coveredGenerations: Array<0 | 1>;
  ownerRecordKind: 'proof_consumed' | 'purpose_disposed' | 'terminal_outcome';
  ownerRecordId?: string;
  ownerRecordSha256: string;
  now?: Date;
}

function sameHandoff(
  event: DurableTerminalResourceHandoff,
  input: HarnessAbortResourceHandoffInput,
): boolean {
  return event.evaluation_slot_id === input.slotId &&
    event.claim_id === input.claimId &&
    event.generation === input.generation &&
    event.resource_lineage_id === input.resourceLineageId &&
    event.verification_resource_handle === input.handle &&
    event.cleanup_authority_id === input.cleanupAuthorityId &&
    event.owner_record_id === (input.ownerRecordId ?? input.cleanupAuthorityId) &&
    event.owner_record_kind === input.ownerRecordKind &&
    event.owner_record_sha256 === input.ownerRecordSha256 &&
    stable(event.covered_generations) === stable(input.coveredGenerations);
}

export function findHarnessAbortResourceHandoff(
  block: DurableMilestoneBlock,
  input: {
    claim_id: string;
    resource_lineage_id: string;
    handle: string;
    cleanup_authority_id: string;
    covered_generations: Array<0 | 1>;
  },
): DurableTerminalResourceHandoff | null {
  const matches = (block.terminal_resource_handoffs ?? []).filter((event) =>
    event.claim_id === input.claim_id &&
    event.resource_lineage_id === input.resource_lineage_id &&
    event.verification_resource_handle === input.handle &&
    event.cleanup_authority_id === input.cleanup_authority_id &&
    stable(event.covered_generations) === stable(input.covered_generations));
  if (matches.length > 1) throw new Error('harness_terminal_handoff_ambiguous');
  return matches[0] ?? null;
}

export function prepareHarnessAbortResourceHandoffAlreadyGated(
  input: HarnessAbortResourceHandoffInput,
) {
  if (
    !/^claim-[0-9a-f]{32}$/.test(input.claimId) ||
    !/^lineage-[0-9a-f]{24}$/.test(input.resourceLineageId) ||
    !/^verify-[0-9a-f]{24}$/.test(input.handle) ||
    !/^[0-9a-f]{64}$/.test(input.ownerRecordSha256) ||
    !['proof_consumed', 'purpose_disposed', 'terminal_outcome'].includes(input.ownerRecordKind) ||
    !(input.ownerRecordId ?? input.cleanupAuthorityId) ||
    !input.cleanupAuthorityId ||
    stable(input.coveredGenerations) !== stable(input.generation === 0 ? [0] : [0, 1])
  ) throw new Error('harness_terminal_handoff_invalid');
  return updateMilestoneBlock(input.stateRoot, input.blockId, (block) => {
    const abort = block.evaluation_abort_event;
    const position = block.slot?.positions.find(
      (item) => item.participant === 'harness-governance',
    );
    if (
      block.phase !== 'terminal_unreported' ||
      block.terminal_reason !== 'aborted' ||
      !abort ||
      block.slot?.slot_id !== input.slotId ||
      position?.producer_claim_id !== input.claimId ||
      position.generation !== input.generation
    ) throw new Error('harness_terminal_handoff_invalid');
    const existing = block.terminal_resource_handoffs ?? [];
    if (existing.length) {
      if (existing.length !== 1 || !sameHandoff(existing[0], input)) {
        throw new Error('harness_terminal_handoff_conflict');
      }
      return projection(existing[0], true);
    }
    const identity = {
      block_id: block.block_id,
      evaluation_slot_id: input.slotId,
      abort_receipt_id: abort.stop_receipt_id,
      abort_event_hash: abort.event_hash,
      frozen_slot_hash: abort.frozen_slot_hash,
      claim_id: input.claimId,
      generation: input.generation,
      resource_lineage_id: input.resourceLineageId,
      verification_resource_handle: input.handle,
      owner_record_kind: input.ownerRecordKind,
      owner_record_id: input.ownerRecordId ?? input.cleanupAuthorityId,
      owner_record_sha256: input.ownerRecordSha256,
      covered_generations: [...input.coveredGenerations],
    };
    const handoffId = `handoff-${digest(stable(identity)).slice(0, 32)}`;
    const core = {
      kind: 'terminal_resource_handoff_disposed' as const,
      handoff_id: handoffId,
      participant: 'harness-governance' as const,
      evaluation_slot_id: input.slotId,
      abort_receipt_id: abort.stop_receipt_id,
      abort_event_hash: abort.event_hash,
      frozen_slot_hash: abort.frozen_slot_hash,
      claim_id: input.claimId,
      generation: input.generation,
      resource_lineage_id: input.resourceLineageId,
      verification_resource_handle: input.handle,
      owner_record_kind: input.ownerRecordKind,
      owner_record_id: input.ownerRecordId ?? input.cleanupAuthorityId,
      owner_record_sha256: input.ownerRecordSha256,
      covered_generations: [...input.coveredGenerations],
      cleanup_authority_id: input.cleanupAuthorityId,
      recorded_at: (input.now ?? new Date()).toISOString(),
    };
    const event = {
      ...core,
      event_hash: digest(`recording.terminal_resource_handoff_disposed\0${stable({
        block_id: block.block_id,
        ...core,
      })}`),
    };
    block.terminal_resource_handoffs = [event];
    return projection(event, false);
  });
}

function projection(event: DurableTerminalResourceHandoff, reused: boolean) {
  return {
    schema: 'ecpe.t4-terminal-resource-handoff.v1' as const,
    result: reused ? 'reused' as const : 'recorded' as const,
    handoff_id: event.handoff_id,
    handoff_sha256: event.event_hash,
    claim_id: event.claim_id,
    resource_lineage_id: event.resource_lineage_id,
    verification_resource_handle: event.verification_resource_handle,
    cleanup_authority_id: event.cleanup_authority_id,
    covered_generations: event.covered_generations,
    next_operation: 'verification_lineage_finalize' as const,
  };
}
