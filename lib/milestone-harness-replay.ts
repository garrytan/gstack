import {
  inspectMilestoneBlockOwned,
  updateMilestoneBlock,
  type DurableHarnessProducerEvent,
  type DurableProofPosition,
} from './milestone-block';
import { withHarnessProducerGate } from './milestone-harness-producer-gate';

const RETRY_WINDOW_MS = 30 * 60_000;

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

export interface HarnessAmbiguousAttempt {
  schema: 'ecpe.t4-ambiguous-attempt.v1';
  claim_id: string;
  generation: 0 | 1;
  resource_lineage_id: string;
  handle: string;
  recorded_at: string;
  ambiguity_sha256: string;
}

function validIso(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function assertSeal(seal: HarnessAmbiguousAttempt): void {
  if (
    seal.schema !== 'ecpe.t4-ambiguous-attempt.v1' ||
    !/^claim-[0-9a-f]{32}$/.test(seal.claim_id) ||
    (seal.generation !== 0 && seal.generation !== 1) ||
    !/^lineage-[0-9a-f]{24}$/.test(seal.resource_lineage_id) ||
    !/^verify-[0-9a-f]{24}$/.test(seal.handle) ||
    !validIso(seal.recorded_at) ||
    !/^[0-9a-f]{64}$/.test(seal.ambiguity_sha256)
  ) throw new Error('harness_ambiguity_invalid');
}

function lastEvent(position: DurableProofPosition): DurableHarnessProducerEvent {
  const events = position.producer_events;
  if (!events?.length) throw new Error('harness_producer_journal_invalid');
  const event = events[events.length - 1];
  const core = {
    kind: event.kind,
    generation: event.generation,
    claim_id: event.claim_id,
    parent_event_hash: event.parent_event_hash,
    ambiguity_sha256: event.ambiguity_sha256,
    recorded_at: event.recorded_at,
  };
  if (event.event_hash !== digest(`ecpe.harness-producer-event.v1\0${stable(core)}`)) {
    throw new Error('harness_producer_journal_invalid');
  }
  return event;
}

function appendEvent(
  position: DurableProofPosition,
  event: Omit<DurableHarnessProducerEvent, 'event_hash' | 'parent_event_hash'>,
): DurableHarnessProducerEvent {
  const previous = lastEvent(position);
  const core = { ...event, parent_event_hash: previous.event_hash };
  const complete = {
    ...core,
    event_hash: digest(`ecpe.harness-producer-event.v1\0${stable(core)}`),
  };
  position.producer_events!.push(complete);
  return complete;
}

function assertPosition(
  position: DurableProofPosition,
  expectedBase: string,
  expectedHead: string,
): void {
  if (
    position.participant !== 'harness-governance' ||
    position.descriptor_id !== 'harness.t4' ||
    position.expected_base_sha !== expectedBase ||
    position.expected_head_sha !== expectedHead ||
    !position.origin_producer_claim_id ||
    position.replays_used !== 0
  ) throw new Error('harness_checkpoint_claim_invalid');
}

export function recordHarnessVerificationAmbiguity(input: {
  stateRoot: string;
  blockId: string;
  slotId: string;
  expectedBase: string;
  expectedHead: string;
  ambiguity: HarnessAmbiguousAttempt;
}) {
  assertSeal(input.ambiguity);
  return withHarnessProducerGate(input.stateRoot, () =>
    updateMilestoneBlock(input.stateRoot, input.blockId, (block) => {
      if (
        block.phase !== 'closing_evaluation' ||
        block.terminal_reason ||
        !block.slot ||
        block.slot.slot_id !== input.slotId ||
        block.slot.state !== 'collecting_proofs'
      ) throw new Error('harness_checkpoint_phase_invalid');
      const position = block.slot.positions.find((item) => item.participant === 'harness-governance');
      if (!position) throw new Error('participant_position_missing');
      if (
        position.state === 'producer_reserved' &&
        position.generation === 1 &&
        position.replays_used === 1 &&
        position.origin_producer_claim_id === input.ambiguity.claim_id &&
        position.resource_lineage_id === input.ambiguity.resource_lineage_id &&
        position.verification_resource_handle === input.ambiguity.handle &&
        position.consumed_ambiguous_sha256 === input.ambiguity.ambiguity_sha256 &&
        position.retry_started_at === input.ambiguity.recorded_at
      ) return ambiguityProjection(position, 'reused');
      if (position.state === 'retryable_ambiguous') {
        if (
          position.producer_claim_id !== input.ambiguity.claim_id ||
          position.generation !== 0 ||
          position.resource_lineage_id !== input.ambiguity.resource_lineage_id ||
          position.verification_resource_handle !== input.ambiguity.handle ||
          position.consumed_ambiguous_sha256 !== input.ambiguity.ambiguity_sha256 ||
          position.retry_started_at !== input.ambiguity.recorded_at
        ) throw new Error('harness_ambiguity_conflict');
        return ambiguityProjection(position, 'reused');
      }
      if (position.state !== 'producer_reserved' || position.generation !== 0) {
        throw new Error('harness_ambiguity_invalid');
      }
      assertPosition(position, input.expectedBase, input.expectedHead);
      if (position.producer_claim_id !== input.ambiguity.claim_id) {
        throw new Error('harness_ambiguity_conflict');
      }
      const deadline = new Date(new Date(input.ambiguity.recorded_at).getTime() + RETRY_WINDOW_MS).toISOString();
      appendEvent(position, {
        kind: 'producer_ambiguous',
        generation: 0,
        claim_id: input.ambiguity.claim_id,
        ambiguity_sha256: input.ambiguity.ambiguity_sha256,
        recorded_at: input.ambiguity.recorded_at,
      });
      position.state = 'retryable_ambiguous';
      position.resource_lineage_id = input.ambiguity.resource_lineage_id;
      position.verification_resource_handle = input.ambiguity.handle;
      position.consumed_ambiguous_sha256 = input.ambiguity.ambiguity_sha256;
      position.retry_started_at = input.ambiguity.recorded_at;
      position.retry_deadline_at = deadline;
      return ambiguityProjection(position, 'retryable');
    }),
  );
}

function ambiguityProjection(position: DurableProofPosition, result: 'retryable' | 'reused') {
  const event=position.producer_events?.find(item=>item.kind==='producer_ambiguous');
  if(!event)throw new Error('harness_producer_journal_invalid');
  return {
    schema:'ecpe.t4-ambiguity-publication.v1' as const,
    result,
    disposition: 'retryable' as const,
    claim_id: position.origin_producer_claim_id,
    generation: position.generation,
    replays_used: position.replays_used,
    retry_started_at: position.retry_started_at,
    retry_deadline_at: position.retry_deadline_at,
    resource_lineage_id: position.resource_lineage_id,
    verification_resource_handle: position.verification_resource_handle,
    ambiguity_sha256: position.consumed_ambiguous_sha256,
    producer_ambiguous_event_hash: event.event_hash,
    next_operation: 'verification_workspace_run',
  };
}

export function claimHarnessVerificationReplay(input: {
  stateRoot: string;
  blockId: string;
  slotId: string;
  now?: Date;
}) {
  return withHarnessProducerGate(input.stateRoot, () => {
    const refusal=inspectMilestoneBlockOwned(input.stateRoot,input.blockId,(block)=>{
      const position=block.slot?.positions.find(item=>item.participant==='harness-governance');
      const observedNow=input.now??new Date();
      if(position?.state==='retryable_ambiguous'&&position.generation===0&&position.replays_used===0&&position.retry_deadline_at&&validIso(position.retry_deadline_at)&&observedNow.toISOString()>=position.retry_deadline_at)return{result:'checkpoint_required' as const,disposition:'retained' as const,generation:0 as const,replays_used:0 as const,resource_lineage_id:position.resource_lineage_id,verification_resource_handle:position.verification_resource_handle,next_operation:'milestone_block_checkpoint' as const};
      return null;
    });
    if(refusal)return refusal;
    try{return updateMilestoneBlock(input.stateRoot, input.blockId, (block) => {
      if (
        block.phase !== 'closing_evaluation' ||
        block.terminal_reason ||
        !block.slot ||
        block.slot.slot_id !== input.slotId ||
        block.slot.state !== 'collecting_proofs'
      ) throw new Error('harness_checkpoint_phase_invalid');
      const position = block.slot.positions.find((item) => item.participant === 'harness-governance');
      if (!position) throw new Error('participant_position_missing');
      if (
        position.state === 'producer_reserved' &&
        position.generation === 1 &&
        position.replays_used === 1
      ) return replayProjection(block, position, 'reused');
      if (
        position.state !== 'retryable_ambiguous' ||
        position.generation !== 0 ||
        position.replays_used !== 0 ||
        !position.retry_deadline_at ||
        !validIso(position.retry_deadline_at) ||
        !position.resource_lineage_id ||
        !position.verification_resource_handle ||
        !position.consumed_ambiguous_sha256 ||
        !position.origin_producer_claim_id
      ) throw new Error('harness_replay_invalid');
      const now=input.now??new Date();
      if (now.toISOString() >= position.retry_deadline_at) throw new Error('harness_replay_deadline_race');
      const parentClaimId = position.origin_producer_claim_id;
      const claimBody = {
        block_id: block.block_id,
        slot_id: block.slot.slot_id,
        participant: 'harness-governance',
        generation: 1,
        descriptor_id: 'harness.t4',
        expected_base_sha: position.expected_base_sha,
        expected_head_sha: position.expected_head_sha,
        subject_hash: block.slot.participant_subject_hashes['harness-governance'],
        roots: block.roots,
        parent_claim_id: parentClaimId,
        resource_lineage_id: position.resource_lineage_id,
        consumed_ambiguous_sha256: position.consumed_ambiguous_sha256,
        retry_started_at: position.retry_started_at,
        retry_deadline_at: position.retry_deadline_at,
      };
      const claimId = `claim-${digest(stable(claimBody)).slice(0, 32)}`;
      const event = appendEvent(position, {
        kind: 'producer_replayed',
        generation: 1,
        claim_id: claimId,
        ambiguity_sha256: position.consumed_ambiguous_sha256,
        recorded_at: now.toISOString(),
      });
      position.state = 'producer_reserved';
      position.producer_claim_id = claimId;
      position.generation = 1;
      position.replays_used = 1;
      return replayProjection(block, position, 'producer_replayed', event.event_hash);
    });}catch(error:any){if(error?.message!=='harness_replay_deadline_race')throw error;return inspectMilestoneBlockOwned(input.stateRoot,input.blockId,(block)=>{const position=block.slot?.positions.find(item=>item.participant==='harness-governance');if(!position||position.state!=='retryable_ambiguous'||position.generation!==0)throw new Error('harness_replay_invalid');return{result:'checkpoint_required' as const,disposition:'retained' as const,generation:0 as const,replays_used:0 as const,resource_lineage_id:position.resource_lineage_id,verification_resource_handle:position.verification_resource_handle,next_operation:'milestone_block_checkpoint' as const}})}
  });
}

export function admitHarnessVerificationReplayStart(input:{
  stateRoot:string;
  blockId:string;
  slotId:string;
  claimId:string;
  assertClaim?:Record<string,unknown>;
  now?:Date;
}){
  return inspectMilestoneBlockOwned(input.stateRoot,input.blockId,(block)=>{
    if(block.phase!=='closing_evaluation'||block.terminal_reason||!block.slot||block.slot.slot_id!==input.slotId||block.slot.state!=='collecting_proofs')throw new Error('harness_checkpoint_phase_invalid');
    const position=block.slot.positions.find(item=>item.participant==='harness-governance');
    if(!position||position.state!=='producer_reserved'||position.generation!==1||position.replays_used!==1||position.producer_claim_id!==input.claimId||!position.retry_deadline_at||!validIso(position.retry_deadline_at)||!position.resource_lineage_id||!position.verification_resource_handle)throw new Error('harness_replay_admission_invalid');
    if(input.assertClaim){const projection=replayProjection(block,position,'reused');const{result:_result,next_operation:_next,...canonical}=projection;if(stable(canonical)!==stable(input.assertClaim))throw new Error('harness_replay_admission_invalid')}
    if((input.now??new Date()).toISOString()>=position.retry_deadline_at)return{result:'checkpoint_required' as const,disposition:'retained' as const,claim_id:input.claimId,generation:1 as const,resource_lineage_id:position.resource_lineage_id,verification_resource_handle:position.verification_resource_handle,next_operation:'milestone_block_checkpoint' as const};
    return{result:'admitted' as const,disposition:'retained' as const,claim_id:input.claimId,generation:1 as const,resource_lineage_id:position.resource_lineage_id,verification_resource_handle:position.verification_resource_handle,next_operation:'verification_workspace_spawn' as const};
  });
}

function replayProjection(
  block: Parameters<Parameters<typeof updateMilestoneBlock>[2]>[0],
  position: DurableProofPosition,
  result: 'producer_replayed' | 'reused',
  replayEventHash?: string,
) {
  const event = position.producer_events?.find((item) => item.kind === 'producer_replayed');
  if (!event || (replayEventHash && event.event_hash !== replayEventHash)) {
    throw new Error('harness_producer_journal_invalid');
  }
  return {
    result,
    claim_id: position.producer_claim_id!,
    parent_claim_id: position.origin_producer_claim_id!,
    block_id: block.block_id,
    evaluation_slot_id: block.slot!.slot_id,
    participant: 'harness-governance' as const,
    descriptor_id: 'harness.t4' as const,
    generation: 1 as const,
    resource_lineage_id: position.resource_lineage_id!,
    verification_resource_handle: position.verification_resource_handle!,
    consumed_ambiguous_sha256: position.consumed_ambiguous_sha256!,
    replays_used: 1 as const,
    retry_started_at: position.retry_started_at!,
    retry_deadline_at: position.retry_deadline_at!,
    expected_base_sha: position.expected_base_sha!,
    expected_head_sha: position.expected_head_sha!,
    participant_subject_hash: block.slot!.participant_subject_hashes['harness-governance'],
    roots: block.roots,
    registry_hash: block.registry_hash,
    replay_event_hash: event.event_hash,
    next_operation: 'verification_workspace_run' as const,
  };
}
