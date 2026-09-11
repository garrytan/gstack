import {
  inspectMilestoneBlockOwned,
  readMilestoneBlock,
  updateMilestoneBlock,
  type DurableMilestoneBlock,
  type DurableProofPosition,
} from './milestone-block';
import {
  findHarnessAbortResourceHandoff,
  prepareHarnessAbortResourceHandoffAlreadyGated,
} from './milestone-harness-terminal-handoff';

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

interface HarnessCleanupSealBase {
  schema: 'ecpe.t4-lineage-tombstone.v1';
  claim_id: string;
  resource_lineage_id: string;
  handle: string;
  cleanup_authority_id: string;
  tombstone_id: string;
  covered_generations: Array<0 | 1>;
  parent_device_id: string;
  parent_inode_id: string;
  tombstone_sha256: string;
  owner_cleanup_event_sha256: string;
}
export type HarnessCleanupSeal = HarnessCleanupSealBase & (
  | {
      root_state?: never;
      root_device_id: string;
      root_inode_id: string;
      owner_marker_sha256: string;
    }
  | {
      root_state: 'never_created';
      root_device_id: null;
      root_inode_id: null;
      owner_marker_sha256: null;
    }
);
type HarnessCleanupContext = Pick<
  HarnessCleanupSeal,
  'claim_id' | 'resource_lineage_id' | 'handle' | 'cleanup_authority_id' |
  'covered_generations'
>;

function existingCleanupAck(
  block: DurableMilestoneBlock,
  input: HarnessCleanupContext,
) {
  const matches = (block.resource_cleanup_acks ?? []).filter((event) =>
    event.participant === 'harness-governance' &&
    event.claim_id === input.claim_id &&
    event.resource_lineage_id === input.resource_lineage_id &&
    event.verification_resource_handle === input.handle &&
    event.cleanup_authority_id === input.cleanup_authority_id &&
    stable(event.covered_generations) === stable(input.covered_generations));
  if (matches.length > 1) throw new Error('harness_cleanup_conflict');
  return matches[0] ?? null;
}

function assertExistingAckMatchesSeal(
  existing: NonNullable<DurableMilestoneBlock['resource_cleanup_acks']>[number],
  seal: HarnessCleanupSeal,
): void {
  if (
    existing.tombstone_id !== seal.tombstone_id ||
    existing.root_state !== seal.root_state ||
    existing.root_device_id !== seal.root_device_id ||
    existing.root_inode_id !== seal.root_inode_id ||
    existing.parent_device_id !== seal.parent_device_id ||
    existing.parent_inode_id !== seal.parent_inode_id ||
    existing.owner_marker_sha256 !== seal.owner_marker_sha256 ||
    existing.tombstone_sha256 !== seal.tombstone_sha256 ||
    existing.owner_cleanup_event_sha256 !== seal.owner_cleanup_event_sha256
  ) throw new Error('harness_cleanup_conflict');
}

function harnessPosition(block: DurableMilestoneBlock): DurableProofPosition {
  const position = block.slot?.positions.find(
    (item) => item.participant === 'harness-governance',
  );
  if (!position) throw new Error('harness_cleanup_invalid');
  return position;
}

function assertCleanupAuthority(
  block: DurableMilestoneBlock,
  input: HarnessCleanupContext,
): DurableProofPosition {
  const position = harnessPosition(block);
  const expectedCoverage = position.generation === 0 ? [0] : [0, 1];
  const abortHandoff = findHarnessAbortResourceHandoff(block, input);
  const terminalOwnerAuthority =
    position.state === 'terminalized' &&
    position.terminal_kind === 'participant_unavailable' &&
    Boolean(position.verification_terminal_receipt_id) &&
    position.verification_cleanup_authorization_id === input.cleanup_authority_id &&
    block.phase === 'terminal_unreported' &&
    block.terminal_reason === 'participant_unavailable';
  const consumedAuthority =
    position.state === 'attached' &&
    position.verification_consumption_id === input.cleanup_authority_id &&
    position.verification_cleanup_authorization_id === input.cleanup_authority_id &&
    block.phase === 'closing_evaluation';
  const disposedAuthority =
    position.state === 'terminalized' &&
    Boolean(position.verification_disposition_id) &&
    position.verification_disposition_id === input.cleanup_authority_id &&
    position.verification_cleanup_authorization_id === input.cleanup_authority_id &&
    block.phase === 'closing_evaluation';
  if (
    !block.slot ||
    block.slot.slot_id.length === 0 ||
    position.producer_claim_id !== input.claim_id ||
    stable(input.covered_generations) !== stable(expectedCoverage) ||
    (!abortHandoff && (
      position.resource_lineage_id !== input.resource_lineage_id ||
      position.verification_resource_handle !== input.handle ||
      position.verification_covered_generations === null ||
      stable(position.verification_covered_generations) !== stable(expectedCoverage) ||
      !(terminalOwnerAuthority || consumedAuthority || disposedAuthority)
    ))
  ) throw new Error('harness_cleanup_invalid');
  return position;
}

export function inspectHarnessVerificationCleanup(input: {
  stateRoot: string;
  blockId: string;
  slotId: string;
  claimId: string;
  resourceLineageId: string;
  handle: string;
  cleanupAuthorityId: string;
  coveredGenerations: Array<0 | 1>;
  generation: 0 | 1;
  ownerRecordKind: 'proof_consumed' | 'purpose_disposed' | 'terminal_outcome' | null;
  ownerRecordId: string | null;
  ownerRecordSha256: string | null;
}) {
  const observed = readMilestoneBlock(input.stateRoot, input.blockId);
  if (observed.slot?.slot_id !== input.slotId) throw new Error('harness_cleanup_invalid');
  const existing = existingCleanupAck(observed, {
    claim_id: input.claimId,
    resource_lineage_id: input.resourceLineageId,
    handle: input.handle,
    cleanup_authority_id: input.cleanupAuthorityId,
    covered_generations: input.coveredGenerations,
  });
  if (existing) {
    return {
      result: 'ready' as const,
      block_id: observed.block_id,
      evaluation_slot_id: observed.slot.slot_id,
      claim_id: input.claimId,
      resource_lineage_id: input.resourceLineageId,
      handle: input.handle,
      cleanup_authority_id: input.cleanupAuthorityId,
      covered_generations: input.coveredGenerations,
      generation: input.generation,
      owner_record_kind: input.ownerRecordKind,
      owner_record_id: input.ownerRecordId,
      owner_record_sha256: input.ownerRecordSha256,
      next_operation: observed.phase === 'closing_evaluation'
        ? 'pilot_evaluation_build' as const
        : 'milestone_block_inspect_for_partial' as const,
    };
  }
  if (observed.phase === 'terminal_unreported' && observed.terminal_reason === 'aborted') {
    if (!input.ownerRecordKind || !input.ownerRecordSha256) {
      throw new Error('harness_terminal_handoff_invalid');
    }
    prepareHarnessAbortResourceHandoffAlreadyGated({
      stateRoot: input.stateRoot,
      blockId: input.blockId,
      slotId: input.slotId,
      claimId: input.claimId,
      generation: input.generation,
      resourceLineageId: input.resourceLineageId,
      handle: input.handle,
      cleanupAuthorityId: input.cleanupAuthorityId,
      coveredGenerations: input.coveredGenerations,
      ownerRecordKind: input.ownerRecordKind,
      ownerRecordId: input.ownerRecordId ?? undefined,
      ownerRecordSha256: input.ownerRecordSha256,
    });
  }
  return inspectMilestoneBlockOwned(input.stateRoot, input.blockId, (block) => {
    if (block.slot?.slot_id !== input.slotId) throw new Error('harness_cleanup_invalid');
    assertCleanupAuthority(block, {
      claim_id: input.claimId,
      resource_lineage_id: input.resourceLineageId,
      handle: input.handle,
      cleanup_authority_id: input.cleanupAuthorityId,
      covered_generations: input.coveredGenerations,
    });
    return {
      result: 'ready' as const,
      block_id: block.block_id,
      evaluation_slot_id: block.slot.slot_id,
      claim_id: input.claimId,
      resource_lineage_id: input.resourceLineageId,
      handle: input.handle,
      cleanup_authority_id: input.cleanupAuthorityId,
      covered_generations: input.coveredGenerations,
      generation: input.generation,
      owner_record_kind: input.ownerRecordKind,
      owner_record_id: input.ownerRecordId,
      owner_record_sha256: input.ownerRecordSha256,
      next_operation: block.phase === 'terminal_unreported'
        ? 'milestone_block_inspect_for_partial' as const
        : 'pilot_evaluation_build' as const,
    };
  });
}

export function acknowledgeHarnessVerificationCleanupAlreadyGated(input: {
  stateRoot: string;
  blockId: string;
  slotId: string;
  seal: HarnessCleanupSeal;
  now?: Date;
}) {
  const seal = input.seal;
  if (
    seal.schema !== 'ecpe.t4-lineage-tombstone.v1' ||
    !/^claim-[0-9a-f]{32}$/.test(seal.claim_id) ||
    !/^lineage-[0-9a-f]{24}$/.test(seal.resource_lineage_id) ||
    !/^verify-[0-9a-f]{24}$/.test(seal.handle) ||
    !/^tombstone-[0-9a-f]{24}$/.test(seal.tombstone_id) ||
    ![seal.parent_device_id, seal.parent_inode_id]
      .every((value) => typeof value === 'string' && value.length > 0) ||
    ![seal.tombstone_sha256, seal.owner_cleanup_event_sha256]
      .every((value) => /^[0-9a-f]{64}$/.test(value)) ||
    !(seal.root_state === undefined &&
      typeof seal.root_device_id === 'string' && seal.root_device_id.length > 0 &&
      typeof seal.root_inode_id === 'string' && seal.root_inode_id.length > 0 &&
      /^[0-9a-f]{64}$/.test(seal.owner_marker_sha256) ||
      seal.root_state === 'never_created' && seal.root_device_id === null &&
      seal.root_inode_id === null && seal.owner_marker_sha256 === null) ||
    !seal.cleanup_authority_id
  ) throw new Error('harness_cleanup_invalid');
  const observed = readMilestoneBlock(input.stateRoot, input.blockId);
  if (observed.slot?.slot_id !== input.slotId) throw new Error('harness_cleanup_invalid');
  const durable = existingCleanupAck(observed, seal);
  if (durable) {
    assertExistingAckMatchesSeal(durable, seal);
    return projection(durable, observed.phase);
  }
  return updateMilestoneBlock(input.stateRoot, input.blockId, (block) => {
    if (block.slot?.slot_id !== input.slotId) throw new Error('harness_cleanup_invalid');
    assertCleanupAuthority(block, seal);
    const abortHandoff = findHarnessAbortResourceHandoff(block, seal);
    const existing = (block.resource_cleanup_acks ?? []).find(
      (event) => event.participant === 'harness-governance' &&
        event.resource_lineage_id === seal.resource_lineage_id,
    );
    if (existing) {
      if (
        existing.claim_id !== seal.claim_id ||
        existing.verification_resource_handle !== seal.handle ||
        existing.cleanup_authority_id !== seal.cleanup_authority_id ||
        existing.authority_kind !== (abortHandoff ? 'abort_handoff' : 'position') ||
        existing.terminal_handoff_id !== (abortHandoff?.handoff_id ?? null) ||
        existing.abort_receipt_id !== (abortHandoff?.abort_receipt_id ?? null) ||
        existing.owner_record_sha256 !== (abortHandoff?.owner_record_sha256 ?? null) ||
        existing.tombstone_id !== seal.tombstone_id ||
        stable(existing.covered_generations) !== stable(seal.covered_generations) ||
        existing.root_state !== seal.root_state ||
        existing.root_device_id !== seal.root_device_id ||
        existing.root_inode_id !== seal.root_inode_id ||
        existing.parent_device_id !== seal.parent_device_id ||
        existing.parent_inode_id !== seal.parent_inode_id ||
        existing.owner_marker_sha256 !== seal.owner_marker_sha256 ||
        existing.tombstone_sha256 !== seal.tombstone_sha256 ||
        existing.owner_cleanup_event_sha256 !== seal.owner_cleanup_event_sha256
      ) throw new Error('harness_cleanup_conflict');
      return projection(existing, block.phase);
    }
    const recordedAt = (input.now ?? new Date()).toISOString();
    const core = {
      kind: 'resource_cleanup_acknowledged' as const,
      participant: 'harness-governance' as const,
      claim_id: seal.claim_id,
      resource_lineage_id: seal.resource_lineage_id,
      verification_resource_handle: seal.handle,
      cleanup_authority_id: seal.cleanup_authority_id,
      authority_kind: abortHandoff ? 'abort_handoff' as const : 'position' as const,
      terminal_handoff_id: abortHandoff?.handoff_id ?? null,
      abort_receipt_id: abortHandoff?.abort_receipt_id ?? null,
      owner_record_sha256: abortHandoff?.owner_record_sha256 ?? null,
      tombstone_id: seal.tombstone_id,
      covered_generations: [...seal.covered_generations],
      ...(seal.root_state === 'never_created'
        ? { root_state: 'never_created' as const }
        : {}),
      root_device_id: seal.root_device_id,
      root_inode_id: seal.root_inode_id,
      parent_device_id: seal.parent_device_id,
      parent_inode_id: seal.parent_inode_id,
      owner_marker_sha256: seal.owner_marker_sha256,
      tombstone_sha256: seal.tombstone_sha256,
      owner_cleanup_event_sha256: seal.owner_cleanup_event_sha256,
      recorded_at: recordedAt,
    };
    const event = {
      ...core,
      event_hash: digest(`recording.resource_cleanup_acknowledged\0${stable({
        block_id: block.block_id,
        ...core,
      })}`),
    };
    block.resource_cleanup_acks = [...(block.resource_cleanup_acks ?? []), event];
    return projection(event, block.phase);
  });
}

function projection(
  event: NonNullable<DurableMilestoneBlock['resource_cleanup_acks']>[number],
  phase: DurableMilestoneBlock['phase'],
) {
  return {
    schema: 'ecpe.t4-resource-cleanup-ack.v1' as const,
    result: 'acknowledged' as const,
    claim_id: event.claim_id,
    resource_lineage_id: event.resource_lineage_id,
    verification_resource_handle: event.verification_resource_handle,
    cleanup_authority_id: event.cleanup_authority_id,
    tombstone_id: event.tombstone_id,
    covered_generations: event.covered_generations,
    cleanup_ack_sha256: event.event_hash,
    next_operation: phase === 'closing_evaluation'
      ? 'pilot_evaluation_build' as const
      : 'milestone_block_inspect_for_partial' as const,
  };
}
