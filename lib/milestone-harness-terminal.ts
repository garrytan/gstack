import {
  inspectMilestoneBlockOwned,
  updateMilestoneBlock,
  type DurableHarnessProducerEvent,
  type DurableProofPosition,
} from './milestone-block';
import { withHarnessProducerGate } from './milestone-harness-producer-gate';

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

interface HarnessUnavailableTerminalOutcomeBase {
  schema: 'ecpe.t4-terminal-outcome.v1';
  block_id?: string;
  evaluation_slot_id?: string;
  claim_id: string;
  generation: 0 | 1;
  resource_lineage_id: string;
  handle: string;
  covered_generations: [0] | [0, 1];
  recorded_at: string;
  terminal_evidence_sha256: string;
  owner_outcome_sha256: string;
}
export type HarnessUnavailableTerminalOutcome = HarnessUnavailableTerminalOutcomeBase & (
  | {
      source: 'aborted_before_start';
      producer_kind: 'harness_verification';
      allocation_phase: 'allocation_started' | 'allocation_complete';
      root_state: 'never_created' | 'complete';
      allocation_child_started: boolean;
      verification_child_started: false;
    }
  | {
      source: 'allocation_failed' | 'retry_deadline_reached' | 'second_ambiguity' |
        'evaluation_aborted';
      producer_kind?: never;
      allocation_phase?: never;
      root_state?: never;
      allocation_child_started?: never;
      verification_child_started?: never;
    }
);

function validIso(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function assertOutcome(outcome: HarnessUnavailableTerminalOutcome): void {
  const coverage = JSON.stringify(outcome.covered_generations);
  if (
    outcome.schema !== 'ecpe.t4-terminal-outcome.v1' ||
    !['allocation_failed', 'retry_deadline_reached', 'second_ambiguity', 'aborted_before_start', 'evaluation_aborted'].includes(outcome.source) ||
    (outcome.block_id !== undefined && !/^block-[0-9a-f]{32}$/.test(outcome.block_id)) ||
    (outcome.evaluation_slot_id !== undefined && !/^evaluation-[0-9a-f]{32}$/.test(outcome.evaluation_slot_id)) ||
    !/^claim-[0-9a-f]{32}$/.test(outcome.claim_id) ||
    (outcome.generation !== 0 && outcome.generation !== 1) ||
    !/^lineage-[0-9a-f]{24}$/.test(outcome.resource_lineage_id) ||
    !/^verify-[0-9a-f]{24}$/.test(outcome.handle) ||
    !validIso(outcome.recorded_at) ||
    !/^[0-9a-f]{64}$/.test(outcome.terminal_evidence_sha256) ||
    !/^[0-9a-f]{64}$/.test(outcome.owner_outcome_sha256) ||
    coverage !== (outcome.generation === 0 ? '[0]' : '[0,1]') ||
    (outcome.source === 'allocation_failed' && outcome.generation !== 0) ||
    (outcome.source === 'second_ambiguity' && outcome.generation !== 1) ||
    (outcome.source === 'aborted_before_start' && (
      outcome.producer_kind !== 'harness_verification' ||
      outcome.verification_child_started !== false || !(
        outcome.generation === 0 && coverage === '[0]' &&
        outcome.allocation_phase === 'allocation_started' &&
        outcome.root_state === 'never_created' &&
        outcome.allocation_child_started === false ||
        (outcome.generation === 0 || outcome.generation === 1) &&
        outcome.allocation_phase === 'allocation_complete' &&
        outcome.root_state === 'complete' &&
        outcome.allocation_child_started === true
      )
    ))
  ) throw new Error('harness_terminal_outcome_invalid');
}

function lastEvent(position: DurableProofPosition): DurableHarnessProducerEvent {
  const event = position.producer_events?.at(-1);
  if (!event) throw new Error('harness_producer_journal_invalid');
  return event;
}

function identifiers(
  blockId: string,
  slotId: string,
  outcome: HarnessUnavailableTerminalOutcome,
) {
  const terminalReceiptId = `terminal-${digest(stable({
    block_id: blockId,
    slot_id: slotId,
    participant: 'harness-governance',
    terminal_kind: 'participant_unavailable',
    source: outcome.source,
    owner_outcome_sha256: outcome.owner_outcome_sha256,
  })).slice(0, 32)}`;
  return {
    terminalReceiptId,
    cleanupAuthorizationId: `cleanup-auth-${digest(stable({
      terminal_receipt_id: terminalReceiptId,
      resource_lineage_id: outcome.resource_lineage_id,
      handle: outcome.handle,
      covered_generations: outcome.covered_generations,
    })).slice(0, 32)}`,
  };
}

function projection(
  position: DurableProofPosition,
  terminalReceiptId: string,
  cleanupAuthorizationId: string,
) {
  return {
    schema: 'ecpe.t4-terminal-verification.v1' as const,
    result: 'terminalized' as const,
    disposition: 'terminalized' as const,
    terminal_kind: 'participant_unavailable' as const,
    proof_id: null,
    result_id: null,
    ambiguity_id: null,
    claim_id: position.producer_claim_id!,
    generation: position.generation as 0 | 1,
    resource_lineage_id: position.resource_lineage_id!,
    verification_resource_handle: position.verification_resource_handle!,
    terminal_receipt_id: terminalReceiptId,
    cleanup_authorization_id: cleanupAuthorizationId,
    covered_generations: position.verification_covered_generations!,
    next_operation: 'verification_lineage_finalize' as const,
  };
}

export function inspectHarnessVerificationUnavailableContext(input: {
  stateRoot: string;
  blockId: string;
  slotId: string;
  source: HarnessUnavailableTerminalOutcome['source'];
  resourceLineageId?: string;
  handle?: string;
  allowNotAborted?: boolean;
  now?: Date;
}) {
  return inspectMilestoneBlockOwned(input.stateRoot, input.blockId, (block) => {
    const position = block.slot?.positions.find(
      (item) => item.participant === 'harness-governance',
    );
    if (
      block.phase === 'terminal_unreported' &&
      block.terminal_reason === 'aborted' &&
      block.terminal_kind === null &&
      block.evaluation_abort_event &&
      block.slot?.slot_id === input.slotId &&
      position?.producer_claim_id &&
      position.generation !== undefined
    ) {
      const callerOwnedIdentity = input.source === 'allocation_failed' ||
        input.source === 'aborted_before_start' ||
        input.source === 'evaluation_aborted';
      if (input.source === 'aborted_before_start' && (
        position.state !== 'producer_reserved' ||
        position.generation !== 0 && position.generation !== 1
      )) throw new Error('harness_terminal_outcome_invalid');
      const resourceLineageId = callerOwnedIdentity
        ? input.resourceLineageId : position.resource_lineage_id;
      const handle = callerOwnedIdentity
        ? input.handle : position.verification_resource_handle;
      if (!/^lineage-[0-9a-f]{24}$/.test(resourceLineageId ?? '') ||
          !/^verify-[0-9a-f]{24}$/.test(handle ?? '')) {
        throw new Error('harness_terminal_outcome_invalid');
      }
      if (
        position.resource_lineage_id !== null &&
        position.resource_lineage_id !== resourceLineageId ||
        position.verification_resource_handle !== null &&
        position.verification_resource_handle !== handle
      ) throw new Error('harness_terminal_outcome_invalid');
      return {
        result: 'ready' as const,
        block_id: block.block_id,
        evaluation_slot_id: block.slot.slot_id,
        source: input.source,
        claim_id: position.producer_claim_id,
        generation: position.generation as 0 | 1,
        resource_lineage_id: resourceLineageId!,
        handle: handle!,
        covered_generations: (position.generation === 0 ? [0] : [0, 1]) as [0] | [0, 1],
      };
    }
    if (
      input.allowNotAborted &&
      (input.source === 'aborted_before_start' || input.source === 'evaluation_aborted') &&
      block.phase === 'closing_evaluation' &&
      block.terminal_reason === null &&
      block.slot?.slot_id === input.slotId &&
      block.slot.state === 'collecting_proofs' &&
      position?.producer_claim_id &&
      position.generation !== undefined &&
      ['producer_reserved', 'retryable_ambiguous', 'result_captured'].includes(position.state) &&
      (position.resource_lineage_id === null ||
        position.resource_lineage_id === input.resourceLineageId) &&
      (position.verification_resource_handle === null ||
        position.verification_resource_handle === input.handle)
    ) return { result: 'not_aborted' as const };
    const terminalEvent = position?.producer_events?.at(-1);
    if (
      block.phase === 'terminal_unreported' &&
      block.terminal_reason === 'participant_unavailable' &&
      block.terminal_kind === 'participant_unavailable' &&
      block.slot?.slot_id === input.slotId &&
      block.slot.state === 'terminalized' &&
      position?.state === 'terminalized' &&
      terminalEvent?.kind === 'producer_unavailable' &&
      terminalEvent.terminal_source === input.source &&
      position.producer_claim_id &&
      position.resource_lineage_id &&
      position.verification_resource_handle &&
      position.verification_covered_generations
    ) return {
      result: 'ready' as const,
      block_id: block.block_id,
      evaluation_slot_id: block.slot.slot_id,
      source: input.source,
      claim_id: position.producer_claim_id,
      generation: position.generation as 0 | 1,
      resource_lineage_id: position.resource_lineage_id,
      handle: position.verification_resource_handle,
      covered_generations: position.verification_covered_generations as [0] | [0, 1],
    };
    if (
      input.source === 'aborted_before_start' ||
      input.source === 'evaluation_aborted' ||
      block.phase !== 'closing_evaluation' ||
      block.terminal_reason !== null ||
      !block.slot ||
      block.slot.slot_id !== input.slotId ||
      block.slot.state !== 'collecting_proofs' ||
      !position ||
      !position.producer_claim_id ||
      position.proof_id !== null ||
      Boolean(position.verification_result_id)
    ) throw new Error('harness_terminal_outcome_invalid');
    let resourceLineageId = position.resource_lineage_id;
    let handle = position.verification_resource_handle;
    if (input.source === 'allocation_failed') {
      if (
        position.state !== 'producer_reserved' ||
        position.generation !== 0 ||
        position.resource_lineage_id !== null ||
        position.verification_resource_handle !== null ||
        !/^lineage-[0-9a-f]{24}$/.test(input.resourceLineageId ?? '') ||
        !/^verify-[0-9a-f]{24}$/.test(input.handle ?? '')
      ) throw new Error('harness_terminal_outcome_invalid');
      resourceLineageId = input.resourceLineageId!;
      handle = input.handle!;
    } else if (!resourceLineageId || !handle) {
      throw new Error('harness_terminal_outcome_invalid');
    } else if (input.source === 'retry_deadline_reached') {
      if (
        !position.retry_deadline_at ||
        !validIso(position.retry_deadline_at) ||
        (input.now ?? new Date()).toISOString() < position.retry_deadline_at ||
        !(
          position.state === 'retryable_ambiguous' && position.generation === 0 ||
          position.state === 'producer_reserved' && position.generation === 1
        )
      ) throw new Error('harness_terminal_outcome_invalid');
    } else if (
      position.state !== 'producer_reserved' ||
      position.generation !== 1 ||
      position.replays_used !== 1
    ) throw new Error('harness_terminal_outcome_invalid');
    return {
      result: 'ready' as const,
      block_id: block.block_id,
      evaluation_slot_id: block.slot.slot_id,
      source: input.source,
      claim_id: position.producer_claim_id,
      generation: position.generation as 0 | 1,
      resource_lineage_id: resourceLineageId,
      handle,
      covered_generations: (position.generation === 0 ? [0] : [0, 1]) as [0] | [0, 1],
    };
  });
}

export function terminalizeHarnessVerificationUnavailableAlreadyGated(input: {
  stateRoot: string;
  blockId: string;
  slotId: string;
  terminalOutcome: HarnessUnavailableTerminalOutcome;
  now?: Date;
}) {
  assertOutcome(input.terminalOutcome);
  if (
    input.terminalOutcome.source === 'aborted_before_start' ||
    input.terminalOutcome.source === 'evaluation_aborted'
  ) {
    throw new Error('harness_terminal_outcome_invalid');
  }
  if (
    input.terminalOutcome.block_id !== undefined &&
    input.terminalOutcome.block_id !== input.blockId ||
    input.terminalOutcome.evaluation_slot_id !== undefined &&
    input.terminalOutcome.evaluation_slot_id !== input.slotId
  ) throw new Error('harness_terminal_outcome_invalid');
  return updateMilestoneBlock(input.stateRoot, input.blockId, (block) => {
      const position = block.slot?.positions.find(
        (item) => item.participant === 'harness-governance',
      );
      if (!block.slot || block.slot.slot_id !== input.slotId || !position) {
        throw new Error('harness_checkpoint_phase_invalid');
      }
      const ids = identifiers(block.block_id, block.slot.slot_id, input.terminalOutcome);
      if (
        block.phase === 'terminal_unreported' &&
        block.slot.state === 'terminalized' &&
        block.terminal_kind === 'participant_unavailable' &&
        block.terminal_reason === 'participant_unavailable' &&
        block.stop_receipt_id === ids.terminalReceiptId &&
        position.state === 'terminalized' &&
        position.terminal_kind === 'participant_unavailable' &&
        position.verification_terminal_outcome_sha256 === input.terminalOutcome.owner_outcome_sha256 &&
        position.verification_terminal_receipt_id === ids.terminalReceiptId &&
        position.verification_cleanup_authorization_id === ids.cleanupAuthorizationId &&
        stable(position.verification_covered_generations) === stable(input.terminalOutcome.covered_generations)
      ) return projection(position, ids.terminalReceiptId, ids.cleanupAuthorizationId);
      if (
        block.phase !== 'closing_evaluation' ||
        block.terminal_reason !== null ||
        block.slot.state !== 'collecting_proofs' ||
        position.producer_claim_id !== input.terminalOutcome.claim_id ||
        position.generation !== input.terminalOutcome.generation ||
        position.proof_id !== null ||
        Boolean(position.verification_result_id)
      ) throw new Error('harness_terminal_outcome_invalid');
      if (input.terminalOutcome.source === 'allocation_failed') {
        if (
          position.state !== 'producer_reserved' ||
          position.generation !== 0 ||
          position.resource_lineage_id !== null ||
          position.verification_resource_handle !== null
        ) throw new Error('harness_terminal_outcome_invalid');
      } else if (
        position.resource_lineage_id !== input.terminalOutcome.resource_lineage_id ||
        position.verification_resource_handle !== input.terminalOutcome.handle
      ) throw new Error('harness_terminal_outcome_invalid');
      if (input.terminalOutcome.source === 'retry_deadline_reached') {
        if (
          !position.retry_deadline_at ||
          !validIso(position.retry_deadline_at) ||
          (input.now ?? new Date()).toISOString() < position.retry_deadline_at ||
          !(
            position.state === 'retryable_ambiguous' && position.generation === 0 ||
            position.state === 'producer_reserved' && position.generation === 1
          )
        ) throw new Error('harness_terminal_outcome_invalid');
      } else if (input.terminalOutcome.source === 'second_ambiguity' && (
        position.state !== 'producer_reserved' ||
        position.generation !== 1 ||
        position.replays_used !== 1
      )) throw new Error('harness_terminal_outcome_invalid');

      const previous = lastEvent(position);
      const core = {
        kind: 'producer_unavailable' as const,
        generation: input.terminalOutcome.generation,
        claim_id: input.terminalOutcome.claim_id,
        parent_event_hash: previous.event_hash,
        ambiguity_sha256: position.consumed_ambiguous_sha256 ?? null,
        terminal_source: input.terminalOutcome.source,
        terminal_evidence_sha256: input.terminalOutcome.terminal_evidence_sha256,
        terminal_outcome_sha256: input.terminalOutcome.owner_outcome_sha256,
        recorded_at: input.terminalOutcome.recorded_at,
      };
      position.producer_events!.push({
        ...core,
        event_hash: digest(`ecpe.harness-producer-event.v1\0${stable(core)}`),
      });
      position.state = 'terminalized';
      position.proof_id = null;
      position.terminal_kind = 'participant_unavailable';
      position.resource_lineage_id = input.terminalOutcome.resource_lineage_id;
      position.verification_resource_handle = input.terminalOutcome.handle;
      position.verification_result_id = null;
      position.verification_terminal_outcome_sha256 = input.terminalOutcome.owner_outcome_sha256;
      position.verification_terminal_receipt_id = ids.terminalReceiptId;
      position.verification_cleanup_authorization_id = ids.cleanupAuthorizationId;
      position.verification_covered_generations = [...input.terminalOutcome.covered_generations];
      block.slot.state = 'terminalized';
      block.phase = 'terminal_unreported';
      block.terminal_kind = 'participant_unavailable';
      block.terminal_reason = 'participant_unavailable';
      block.terminal_at = input.terminalOutcome.recorded_at;
      block.stop_receipt_id = ids.terminalReceiptId;
      return projection(position, ids.terminalReceiptId, ids.cleanupAuthorizationId);
    });
}

export function terminalizeHarnessVerificationUnavailable(input: {
  stateRoot: string;
  blockId: string;
  slotId: string;
  terminalOutcome: HarnessUnavailableTerminalOutcome;
  now?: Date;
}) {
  return withHarnessProducerGate(input.stateRoot, () =>
    terminalizeHarnessVerificationUnavailableAlreadyGated(input),
  );
}
