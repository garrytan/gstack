import { hasHarnessVerificationCleanupAck, milestoneBlockReportKey, milestoneNextProducer, readMilestoneBlock, updateMilestoneBlock, type DurableMilestoneBlock, type ProofTerminalKind } from './milestone-block';
export interface CloseRootTuple { code_root_id: string; workspace_root_id: string; state_root_id: string }
type Participant = 'portfolioops' | 'cdo-os' | 'harness-governance';
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') { const row = value as Record<string, unknown>; return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`; } return JSON.stringify(value); }
const digest = (domain: string, value: unknown) => new Bun.CryptoHasher('sha256').update(`${domain}\0${canonical(value)}`).digest('hex');
export function buildPilotReadiness(input: { blockJournalRevision: string; compiledPolicyHash: string; roster: readonly Participant[]; sourceRegistryHash: string; sourceCursorHash: string; participantSubjectHashes: Record<Participant, string>; roots: CloseRootTuple }) {
  const expected: Participant[] = ['portfolioops', 'cdo-os', 'harness-governance']; const blockers = expected.filter((participant) => !input.roster.includes(participant)).map((participant) => `participant_missing:${participant}`); for (const participant of expected) if (!input.participantSubjectHashes[participant]) blockers.push(`participant_subject_missing:${participant}`);
  const payload = { schema_version: 'ecpe.pilot_evaluation.readiness.v1' as const, ready: blockers.length === 0, block_journal_revision: input.blockJournalRevision, compiled_policy_hash: input.compiledPolicyHash, roster_hash: digest('roster', [...input.roster].sort()), source_registry_hash: input.sourceRegistryHash, source_cursor_hash: input.sourceCursorHash, participant_subject_hashes: { ...input.participantSubjectHashes }, root_identity_hash: digest('close-roots', input.roots), retry_policy: { max_ambiguous_replays: 1 as const, retry_window: 'PT30M' as const }, blocker_codes: blockers.sort() }; return { ...payload, readiness_id: digest('pilot-readiness', payload) };
}
export function reservePilotEvaluation(input: { stateRoot: string; blockId: string; readiness: ReturnType<typeof buildPilotReadiness>; assertReadiness: string; cdoRunId: string; now?: Date }) {
  if (!input.readiness.ready || input.readiness.readiness_id !== input.assertReadiness || !/^candidate-[0-9a-f]{32}$/.test(input.cdoRunId)) throw new Error('readiness_changed');
  return updateMilestoneBlock(input.stateRoot, input.blockId, (block) => {
    if (block.slot) { if (block.slot.readiness_id !== input.assertReadiness || block.slot.cdo_run_id !== input.cdoRunId) throw new Error('evaluation_slot_conflict'); return evaluationProjection(block, 'reused'); }
    const now = input.now ?? new Date(); if (block.phase !== 'active' || block.revision !== input.readiness.block_journal_revision || now.toISOString() >= block.expires_at) throw new Error('readiness_changed');
    const cutoff = now.toISOString(); const slotId = `evaluation-${digest('slot', { block_id: block.block_id, readiness_id: input.assertReadiness, cutoff }).slice(0, 32)}`;
    block.phase = 'closing_evaluation'; block.slot = { slot_id: slotId, state: 'collecting_proofs', readiness_id: input.assertReadiness, cutoff_at: cutoff, cdo_run_id: input.cdoRunId, participant_subject_hashes: { ...input.readiness.participant_subject_hashes }, retry_policy:{...input.readiness.retry_policy}, positions: (['portfolioops', 'cdo-os', 'harness-governance'] as Participant[]).map((participant) => ({ participant, state: 'empty' as const, proof_id: null, terminal_kind: null })), evaluation_proof_id: null };
    return evaluationProjection(block, 'reserved');
  });
}
export function attachPilotParticipant(input: { stateRoot: string; blockId: string; slotId: string; participant: Participant; proofId?: string; terminalKind?: ProofTerminalKind }) {
  return updateMilestoneBlock(input.stateRoot, input.blockId, (block) => {
    if (block.phase !== 'closing_evaluation' || !block.slot || block.slot.slot_id !== input.slotId || block.slot.state !== 'collecting_proofs') throw new Error('evaluation_slot_invalid'); const position = block.slot.positions.find((item) => item.participant === input.participant); if (!position) throw new Error('participant_position_missing');
    if(input.participant==='harness-governance'&&position.producer_claim_id)throw new Error('harness_checkpoint_required');
    if (position.state === 'attached') { if (input.proofId !== position.proof_id || input.terminalKind) throw new Error('participant_proof_already_resolved'); return evaluationProjection(block, 'reused'); }
    if (position.state === 'terminalized') { if (input.terminalKind !== position.terminal_kind || input.proofId) throw new Error('participant_proof_already_resolved'); return evaluationProjection(block, 'reused'); }
    if ((Boolean(input.proofId) ? 1 : 0) + (Boolean(input.terminalKind) ? 1 : 0) !== 1) throw new Error('participant_result_invalid');
    if (input.proofId) { if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(input.proofId)) throw new Error('participant_proof_invalid'); position.state = 'attached'; position.proof_id = input.proofId; position.terminal_kind = null; } else { position.state = 'terminalized'; position.proof_id = null; position.terminal_kind = input.terminalKind!; }
    return evaluationProjection(block, input.proofId ? 'attached' : 'terminalized');
  });
}
export function buildPilotEvaluation(input: { stateRoot: string; blockId: string; slotId: string }) {
  return updateMilestoneBlock(input.stateRoot, input.blockId, (block) => {
    if (!block.slot || block.slot.slot_id !== input.slotId || block.phase !== 'closing_evaluation') throw new Error('evaluation_slot_invalid'); const slot = block.slot;
    if (slot.positions.some((position) => !['attached', 'terminalized'].includes(position.state))) throw new Error('evaluation_proofs_incomplete');
    if(!hasHarnessVerificationCleanupAck(block))throw new Error('verification_lineage_finalize_required');
    if (['complete', 'partial', 'terminalized'].includes(slot.state)) return evaluationProjection(block, 'reused');
    const terminals = slot.positions.map((position) => position.terminal_kind).filter((value): value is ProofTerminalKind => Boolean(value));
    if (terminals.length) { const kind = terminals.includes('safety_failure') ? 'safety_failure' : terminals.includes('scope_drift') ? 'scope_drift' : 'participant_unavailable'; slot.state = 'terminalized'; block.phase = 'terminal_unreported'; block.terminal_kind = kind; block.terminal_reason = kind; block.terminal_at = slot.cutoff_at; }
    else { slot.state = 'complete'; slot.evaluation_proof_id = `pilot-proof-${digest('evaluation-proof', { block_id: block.block_id, slot_id: slot.slot_id, cutoff: slot.cutoff_at, proof_ids: slot.positions.map((position) => position.proof_id) }).slice(0, 32)}`; block.phase = 'terminal_unreported'; block.terminal_kind = null; block.terminal_reason = null; block.terminal_at = slot.cutoff_at; }
    return evaluationProjection(block, slot.state);
  });
}
export function inspectPilotEvaluation(input: { stateRoot: string; blockId: string }) { const block = readMilestoneBlock(input.stateRoot, input.blockId); if (!block.slot) throw new Error('evaluation_slot_missing'); return evaluationProjection(block, 'inspected'); }
function evaluationProjection(block: DurableMilestoneBlock, result: string) { const slot = block.slot; const successful=slot&&['complete','partial'].includes(slot.state);const completionDate=successful?new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(slot.cutoff_at)):null;const reportPath=successful?`docs/reports/${completionDate}-ecpe-v3-pilot-${milestoneBlockReportKey('harness-governance',block.block_id)}-result.md`:null;return { schema: 'ecpe.close-state.v1', result, block: { block_id: block.block_id, phase: block.phase, terminal_reason: block.terminal_reason, terminal_kind: block.terminal_kind, revision: block.revision }, evaluation_slot: slot, payload: slot ? { schema_version: slot.state === 'terminalized' ? 'ecpe.pilot_evaluation.terminalized.v1' : 'ecpe.pilot_evaluation.slot.v1', evaluation_slot_id: slot.slot_id, state: slot.state, cutoff_at: slot.cutoff_at, cdo_run_id: slot.cdo_run_id, positions: slot.positions, evaluation_proof_id: slot.evaluation_proof_id,completion_date:completionDate,expected_report_path:reportPath } : null, next_operation: milestoneNextProducer(block), error: null }; }
