import * as fs from 'node:fs';
import * as path from 'node:path';
import { inspectLandingIntent } from './landing-safety';
import { inspectSafetyLatch, withActiveMilestoneOwner, type MilestoneLandingDescriptor } from './milestone-block';
import { acquireDurableOwnerLock, releaseDurableOwnerLock } from './durable-owner-lock';
import { durableAtomicWrite } from './durable-atomic-write';

type Lane = 'docs_ux' | 'single_repo_code' | 'cross_repo_contract';
type Sample = { safety: 'pass' | 'fail' | 'unknown'; durationMs: number | null };
type CanaryClass = 'passed' | 'safety_regressed' | 'efficiency_inconclusive' | 'efficiency_regressed';
type TokenEffect = 'improved' | 'equal' | 'regressed' | 'unknown';
type CanaryPhase = 'pending' | 'aggregate_ready' | 'activation_landing_intent' | 'activation_checkpointed' | 'pending_superseded' | 'safety_stop_required';

export interface CanaryComparison {
  comparison_id: string;
  ordinal: number;
  subject_head: string;
  host_fingerprint: string;
  class: CanaryClass;
  focused_duration_ms: number | null;
  legacy_duration_ms: number | null;
  focused_context_bytes: number | null;
  legacy_context_bytes: number | null;
  focused_spawns: number | null;
  legacy_spawns: number | null;
  focused_tokens: number | null;
  legacy_tokens: number | null;
  token_provenance: 'host_reported' | 'offline_estimate' | 'unknown';
  source_block_id?: string;
  subject_tree?: string;
  focused_run_id?: string;
  legacy_control_run_id?: string;
  policy_hash?: string;
  focused_outcome?: CanaryControlMeasurement['outcome'];
  legacy_control_outcome?: CanaryControlMeasurement['outcome'];
}

export type CanaryComparisonInput = Omit<CanaryComparison, 'comparison_id' | 'ordinal'>;

export type CanaryFocusedPhase = 'focused_reserved' | 'control_prepared' | 'control_started' | 'control_terminal' | 'comparison_appended' | 'superseded';
export interface CanaryControlMeasurement {
  outcome: 'pass' | 'fail' | 'unavailable' | 'ambiguous';
  durationMs: number | null;
  contextBytes: number | null;
  helperSpawns: number | null;
  modelSpawns: number | null;
  unauthorizedEffects: number;
  tokens: { total: number | null; provenance: 'host_reported' | 'offline_estimate' | 'unknown' };
}
export interface CanaryFocusedSlot {
  block_id: string;
  participant: 'portfolioops';
  lane: Lane;
  profile_hash: string;
  promotion_proof_id: string;
  policy_hash: string;
  subject_head: string;
  subject_tree: string;
  host_fingerprint: string;
  focused_run_id: string;
  control_run_id: string;
  phase: CanaryFocusedPhase;
  control_measurement: CanaryControlMeasurement | null;
  comparison_id: string | null;
}

interface CanaryState {
  schema: 'ecpe.canary-activation-state.v1';
  state_id: string;
  repo_id: string;
  lane: Lane;
  profile_hash: string;
  promotion_proof_id: string;
  promotion_record_id: string;
  promotion_landing_intent_id: string;
  promotion_checkpoint_id: string;
  promotion_receipt_id: string;
  window_id: string;
  phase: CanaryPhase;
  comparisons: CanaryComparison[];
  focused_slots?: CanaryFocusedSlot[];
  activation_proof_id: string | null;
  activation_landing_intent_id: string | null;
  activation_checkpoint_id: string | null;
  activation_receipt_id: string | null;
  activation_landing: CanaryActivationLanding | null;
  activation_provider_checkpoint: CanaryProviderCheckpoint | null;
  sample_landings?: CanarySampleLanding[];
  revision: string;
}

interface CanaryActivationLanding {
  block_id: string;
  receipt_id: string;
  pr: number;
  repository_node_id: string;
  expected_head: string;
  expected_base: string;
  target_ref: string;
  proof_comparison_id: string;
  proof_subject_tree: string;
  policy_hash: string;
}

interface CanaryProviderCheckpoint {
  raw_intent_id: string;
  merge_sha: string;
  intent_root: string;
}

interface CanarySampleLanding {
  sample_landing_intent_id: string;
  sample_checkpoint_id: string | null;
  comparison_id: string;
  block_id: string;
  receipt_id: string;
  pr: number;
  repository_node_id: string;
  expected_head: string;
  expected_base: string;
  target_ref: string;
  subject_tree: string;
  focused_run_id: string;
  policy_hash: string;
  provider_checkpoint: CanaryProviderCheckpoint | null;
}

const ID = /^[a-z][a-z0-9-]*-[0-9a-f]{32}$/;
const HASH = /^[0-9a-f]{64}$/;
const HEAD = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const digest = (value: unknown) => new Bun.CryptoHasher('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');

function stateBody(state: CanaryState): Omit<CanaryState, 'revision'> {
  const { revision: _revision, ...body } = state;
  return body;
}

function revision(state: Omit<CanaryState, 'revision'> | CanaryState): string {
  const body = 'revision' in state ? stateBody(state as CanaryState) : state;
  return digest(`ecpe.canary-activation-state.v1\0${canonical(body)}`);
}

function identityBody(state: Pick<CanaryState, 'repo_id' | 'lane' | 'profile_hash' | 'promotion_proof_id' | 'promotion_record_id' | 'promotion_landing_intent_id' | 'promotion_checkpoint_id' | 'promotion_receipt_id'>) {
  return { repo_id: state.repo_id, lane: state.lane, profile_hash: state.profile_hash, promotion_proof_id: state.promotion_proof_id, promotion_record_id: state.promotion_record_id, promotion_landing_intent_id: state.promotion_landing_intent_id, promotion_checkpoint_id: state.promotion_checkpoint_id, promotion_receipt_id: state.promotion_receipt_id };
}

function statePath(stateRoot: string, repoId: string, lane: Lane, profileHash: string): string {
  if (!REPO.test(repoId) || !['docs_ux', 'single_repo_code', 'cross_repo_contract'].includes(lane) || !HASH.test(profileHash)) throw new Error('canary_lineage_invalid');
  return path.join(path.resolve(stateRoot), 'ecpe', 'lane-canary', repoId, lane, `${profileHash}.json`);
}

function durableWrite(target: string, value: CanaryState): void {
  durableAtomicWrite(target, `${canonical(value)}\n`);
}

function withLock<T>(target: string, callback: () => T): T {
  const owned = acquireDurableOwnerLock(target, 'canary_owner_busy');
  try { return callback(); } finally { releaseDurableOwnerLock(owned); }
}

async function withAsyncLock<T>(target: string, callback: () => Promise<T>): Promise<T> {
  const owned = acquireDurableOwnerLock(target, 'canary_owner_busy');
  try { return await callback(); } finally { releaseDurableOwnerLock(owned); }
}

function readState(target: string): CanaryState {
  let value: CanaryState;
  try {
    const info=fs.lstatSync(target);
    if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw new Error('canary_state_corrupt');
    value = JSON.parse(fs.readFileSync(target, 'utf8'));
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('canary_lineage_missing');
    throw new Error('canary_state_corrupt');
  }
  if (value.schema !== 'ecpe.canary-activation-state.v1' || value.revision !== revision(value) || value.state_id !== `canary-state-${digest(identityBody(value)).slice(0, 32)}` || value.window_id !== `canary-window-${digest(identityBody(value)).slice(0, 32)}`) throw new Error('canary_state_corrupt');
  return value;
}

function validLineageId(value: string): boolean { return ID.test(value); }

function publicState(state: CanaryState, result: string) {
  const aggregate = aggregateCanaryWindow({ windowId: state.window_id, lane: state.lane, comparisons: state.comparisons });
  const landed = activationLanded(state);
  return {
    schema: 'ecpe.canary-activation-inspection.v1' as const,
    result,
    state_id: state.state_id,
    repo_id: state.repo_id,
    lane: state.lane,
    profile_hash: state.profile_hash,
    promotion_proof_id: state.promotion_proof_id,
    promotion_record_id: state.promotion_record_id,
    window_id: state.window_id,
    phase: state.phase,
    comparison_ids: state.comparisons.map((item) => item.comparison_id),
    comparison_bindings: state.comparisons.map((item) => ({ comparison_id: item.comparison_id, source_block_id: item.source_block_id ?? null, focused_run_id: item.focused_run_id ?? null, subject_head: item.subject_head, subject_tree: item.subject_tree ?? null, policy_hash: item.policy_hash ?? null, class: item.class, focused_outcome: item.focused_outcome ?? null, legacy_control_outcome: item.legacy_control_outcome ?? null })),
    sample_landing_checkpoints: (state.sample_landings ?? []).filter((item) => item.sample_checkpoint_id !== null).map((item) => ({ comparison_id: item.comparison_id, checkpoint_id: item.sample_checkpoint_id, receipt_id: item.receipt_id })),
    ordinals: state.comparisons.map((item) => item.ordinal),
    sample_count: state.comparisons.length,
    next_ordinal: state.comparisons.length < 5 && state.phase === 'pending' ? state.comparisons.length + 1 : null,
    host_fingerprint: state.comparisons[0]?.host_fingerprint ?? null,
    focused_run_phase: [...(state.focused_slots ?? [])].reverse().find((slot) => slot.phase !== 'superseded')?.phase ?? null,
    aggregate_result: aggregate.result,
    token_effect: aggregate.token_effect,
    activation_proof_id: state.activation_proof_id,
    activation_landing_intent_id: state.activation_landing_intent_id,
    activation_checkpoint_id: state.activation_checkpoint_id,
    activation_receipt_id: state.activation_receipt_id,
    execution_allowed: landed,
    next_operation: state.phase === 'pending' ? state.comparisons.length >= 5 ? 'lane_canary_cap_review' : 'lane_canary_collect' : state.phase === 'aggregate_ready' ? 'lane_canary_land_activation' : state.phase === 'activation_landing_intent' || state.phase === 'activation_checkpointed' ? 'lane_canary_reconcile_activation' : state.phase === 'safety_stop_required' ? 'safety_stop_evaluate_and_stop' : 'ordinary_profile_execution',
  };
}

function publicStateWithCanonicalSafety(stateRoot:string,state:CanaryState,result:string){const projected=publicState(state,result);const latch=inspectSafetyLatch({stateRoot,participant:'portfolioops',lane:state.lane});if(latch.result!=='latched')return projected;const comparison=latch.cause_comparison as CanaryComparison|null;const comparisonIds=comparison&&!projected.comparison_ids.includes(comparison.comparison_id)?[...projected.comparison_ids,comparison.comparison_id]:projected.comparison_ids;const comparisonBindings=comparison&&!projected.comparison_ids.includes(comparison.comparison_id)?[...projected.comparison_bindings,{comparison_id:comparison.comparison_id,source_block_id:comparison.source_block_id??null,focused_run_id:comparison.focused_run_id??null,subject_head:comparison.subject_head,subject_tree:comparison.subject_tree??null,policy_hash:comparison.policy_hash??null,class:comparison.class,focused_outcome:comparison.focused_outcome??null,legacy_control_outcome:comparison.legacy_control_outcome??null}]:projected.comparison_bindings;return{...projected,phase:'safety_latched' as const,comparison_ids:comparisonIds,comparison_bindings:comparisonBindings,canonical_stop_comparison:comparison,execution_allowed:false,next_operation:'profile_downgrade_required',safety_latch_id:latch.latch_id}}

function assertCanaryNotLatched(stateRoot:string,lane:Lane):void{if(inspectSafetyLatch({stateRoot,participant:'portfolioops',lane}).result==='latched')throw new Error('canary_safety_latched')}

function activationLanded(state: CanaryState): boolean {
  const structurallyLanded = state.phase === 'pending_superseded'
    && state.activation_landing !== null && state.activation_landing !== undefined
    && state.activation_provider_checkpoint !== null && state.activation_provider_checkpoint !== undefined
    && state.activation_landing_intent_id !== null
    && state.activation_checkpoint_id !== null
    && state.activation_receipt_id === state.activation_landing.receipt_id;
  if (!structurallyLanded) return false;
  try {
    const record = inspectLandingIntent(state.activation_provider_checkpoint!.intent_root, state.activation_provider_checkpoint!.raw_intent_id);
    return record.phase === 'checkpointed' && record.result?.status === 'checkpointed'
      && record.result.mergeSha === state.activation_provider_checkpoint!.merge_sha
      && record.repositoryNodeId === state.activation_landing!.repository_node_id
      && record.prNumber === state.activation_landing!.pr
      && record.expectedHeadOid === state.activation_landing!.expected_head
      && record.expectedBaseOid === state.activation_landing!.expected_base
      && record.targetRef === state.activation_landing!.target_ref;
  } catch { return false; }
}

export function evaluateCanaryPair(input: { legacy: Sample; profile: Sample }) {
  let result: 'qualified' | 'safety_regressed' | 'inconclusive' | 'efficiency_inconclusive';
  if (input.legacy.safety === 'pass' && input.profile.safety === 'fail') result = 'safety_regressed';
  else if (input.legacy.safety !== 'pass' || input.profile.safety !== 'pass') result = 'inconclusive';
  else if (input.legacy.durationMs === null || input.profile.durationMs === null) result = 'efficiency_inconclusive';
  else result = 'qualified';
  const body = { ...input, result };
  return { ...body, pair_id: `canary-${digest(body).slice(0, 24)}` };
}

export function aggregateCanaryWindow(input: { windowId: string; lane: Lane; comparisons: CanaryComparison[] }) {
  if (input.comparisons.length > 5) throw new Error('canary_sample_cap_exceeded');
  const ordered = [...input.comparisons].sort((a, b) => a.ordinal - b.ordinal);
  if (ordered.some((item, index) => item.ordinal !== index + 1) || new Set(ordered.map((item) => item.subject_head)).size !== ordered.length || new Set(ordered.map((item) => item.host_fingerprint)).size > 1) throw new Error('canary_window_invalid');
  const safety = ordered.some((item) => item.class === 'safety_regressed');
  const comparable = ordered.every((item) => item.focused_duration_ms !== null && item.legacy_duration_ms !== null && item.focused_context_bytes !== null && item.legacy_context_bytes !== null && item.focused_spawns !== null && item.legacy_spawns !== null);
  const mechanicallyNoWorse = comparable && ordered.every((item) => item.class === 'passed' && item.focused_duration_ms! <= item.legacy_duration_ms! && item.focused_context_bytes! <= item.legacy_context_bytes! && item.focused_spawns! <= item.legacy_spawns!);
  const tokensComparable = ordered.length > 0 && ordered.every((item) => item.token_provenance !== 'unknown' && item.focused_tokens !== null && item.legacy_tokens !== null) && new Set(ordered.map((item) => item.token_provenance)).size === 1;
  const tokenEffect: TokenEffect = !tokensComparable ? 'unknown' : ordered.every((item) => item.focused_tokens! < item.legacy_tokens!) ? 'improved' : ordered.every((item) => item.focused_tokens === item.legacy_tokens) ? 'equal' : 'regressed';
  let result: CanaryClass;
  if (safety) result = 'safety_regressed';
  else if (ordered.length < 3) result = 'efficiency_inconclusive';
  else if (!comparable) result = ordered.length === 5 ? 'efficiency_regressed' : 'efficiency_inconclusive';
  else if (!mechanicallyNoWorse || tokenEffect === 'regressed') result = 'efficiency_regressed';
  else result = 'passed';
  const body = { schema: 'ecpe.canary-window.v1' as const, window_id: input.windowId, lane: input.lane, comparison_ids: ordered.map((item) => item.comparison_id), sample_count: ordered.length, next_ordinal: ordered.length < 5 ? ordered.length + 1 : null, result, token_effect: tokenEffect };
  return { ...body, activation_proof_id: result === 'passed' ? `canary-ready-${digest(body).slice(0, 32)}` : null };
}

export function createCanaryPending(input: { stateRoot: string; repoId: string; lane: Lane; profileHash: string; promotionProofId: string; promotionRecordId: string; promotionLandingIntentId: string; promotionCheckpointId: string; promotionReceiptId: string }) {
  const target = statePath(input.stateRoot, input.repoId, input.lane, input.profileHash);
  for (const value of [input.promotionProofId, input.promotionRecordId, input.promotionLandingIntentId, input.promotionCheckpointId, input.promotionReceiptId]) if (!validLineageId(value)) throw new Error('canary_lineage_invalid');
  return withLock(target, () => {
    if (fs.existsSync(target)) {
      const existing = readState(target);
      if (existing.promotion_proof_id !== input.promotionProofId || existing.promotion_record_id !== input.promotionRecordId || existing.promotion_landing_intent_id !== input.promotionLandingIntentId || existing.promotion_checkpoint_id !== input.promotionCheckpointId || existing.promotion_receipt_id !== input.promotionReceiptId) throw new Error('canary_lineage_conflict');
      return publicState(existing, 'reused');
    }
    const lineage = { repo_id: input.repoId, lane: input.lane, profile_hash: input.profileHash, promotion_proof_id: input.promotionProofId, promotion_record_id: input.promotionRecordId, promotion_landing_intent_id: input.promotionLandingIntentId, promotion_checkpoint_id: input.promotionCheckpointId, promotion_receipt_id: input.promotionReceiptId };
    const body: Omit<CanaryState, 'state_id' | 'revision'> = { schema: 'ecpe.canary-activation-state.v1', ...lineage, window_id: `canary-window-${digest(lineage).slice(0, 32)}`, phase: 'pending', comparisons: [], focused_slots: [], activation_proof_id: null, activation_landing_intent_id: null, activation_checkpoint_id: null, activation_receipt_id: null, activation_landing: null, activation_provider_checkpoint: null, sample_landings: [] };
    const stateWithoutRevision = { ...body, state_id: `canary-state-${digest(lineage).slice(0, 32)}` } as Omit<CanaryState, 'revision'>;
    const state: CanaryState = { ...stateWithoutRevision, revision: revision(stateWithoutRevision) };
    durableWrite(target, state);
    return publicState(state, 'created');
  });
}

function validateComparison(input: CanaryComparisonInput): void {
  if (!HEAD.test(input.subject_head) || !HOST.test(input.host_fingerprint) || !['passed', 'safety_regressed', 'efficiency_inconclusive', 'efficiency_regressed'].includes(input.class)) throw new Error('canary_comparison_invalid');
  for (const value of [input.focused_duration_ms, input.legacy_duration_ms, input.focused_context_bytes, input.legacy_context_bytes, input.focused_spawns, input.legacy_spawns, input.focused_tokens, input.legacy_tokens]) if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new Error('canary_comparison_invalid');
  if (!['host_reported', 'offline_estimate', 'unknown'].includes(input.token_provenance)) throw new Error('canary_comparison_invalid');
  if (input.token_provenance === 'unknown' && (input.focused_tokens !== null || input.legacy_tokens !== null)) throw new Error('canary_comparison_invalid');
  if (input.source_block_id !== undefined && !/^block-[0-9a-f]{32}$/.test(input.source_block_id)) throw new Error('canary_comparison_invalid');
  if (input.subject_tree !== undefined && !HEAD.test(input.subject_tree)) throw new Error('canary_comparison_invalid');
  if (input.focused_run_id !== undefined && !/^focused-[0-9a-f]{32}$/.test(input.focused_run_id)) throw new Error('canary_comparison_invalid');
  if (input.legacy_control_run_id !== undefined && !/^control-[0-9a-f]{32}$/.test(input.legacy_control_run_id)) throw new Error('canary_comparison_invalid');
  if (input.policy_hash !== undefined && !HASH.test(input.policy_hash)) throw new Error('canary_comparison_invalid');
  for (const outcome of [input.focused_outcome, input.legacy_control_outcome]) if (outcome !== undefined && !['pass', 'fail', 'unavailable', 'ambiguous'].includes(outcome)) throw new Error('canary_comparison_invalid');
}

export function appendCanaryComparison(input: { stateRoot: string; repoId: string; lane: Lane; profileHash: string; comparison: CanaryComparisonInput }) {
  validateComparison(input.comparison);
  const target = statePath(input.stateRoot, input.repoId, input.lane, input.profileHash);
  return withLock(target, () => {
    const state = readState(target);
    const previous = state.comparisons.find((item) => item.subject_head === input.comparison.subject_head);
    if (previous) {
      const expected = { ...input.comparison, comparison_id: previous.comparison_id, ordinal: previous.ordinal };
      if (canonical(previous) !== canonical(expected)) throw new Error('canary_subject_reused');
      if (!['pending', 'aggregate_ready', 'safety_stop_required'].includes(state.phase)) throw new Error('canary_window_terminal');
      return publicStateWithCanonicalSafety(input.stateRoot,state, 'reused');
    }
    if (state.phase !== 'pending') throw new Error(state.phase === 'aggregate_ready' ? 'canary_aggregate_ready' : 'canary_window_terminal');
    if (state.comparisons.length >= 5) throw new Error('canary_sample_cap_exceeded');
    const establishedHost = state.comparisons[0]?.host_fingerprint;
    if (establishedHost && establishedHost !== input.comparison.host_fingerprint) throw new Error('canary_host_moved');
    const ordinal = state.comparisons.length + 1;
    const comparisonBase = { ...input.comparison, ordinal, window_id: state.window_id, lane: state.lane, profile_hash: state.profile_hash, promotion_proof_id: state.promotion_proof_id };
    const comparison: CanaryComparison = { ...input.comparison, ordinal, comparison_id: `comparison-${digest(comparisonBase).slice(0, 32)}` };
    state.comparisons.push(comparison);
    const aggregate = aggregateCanaryWindow({ windowId: state.window_id, lane: state.lane, comparisons: state.comparisons });
    state.activation_proof_id = aggregate.activation_proof_id;
    if (aggregate.result === 'passed') state.phase = 'aggregate_ready';
    else if (aggregate.result === 'safety_regressed') state.phase = 'safety_stop_required';
    else state.phase = 'pending';
    state.revision = revision(state);
    durableWrite(target, state);
    return publicStateWithCanonicalSafety(input.stateRoot,state, 'comparison_appended');
  });
}

export function previewCanaryComparison(input:{stateRoot:string;repoId:string;lane:Lane;profileHash:string;comparison:CanaryComparisonInput}):CanaryComparison{validateComparison(input.comparison);const state=readState(statePath(input.stateRoot,input.repoId,input.lane,input.profileHash));const previous=state.comparisons.find(item=>item.subject_head===input.comparison.subject_head);if(previous){const expected={...input.comparison,comparison_id:previous.comparison_id,ordinal:previous.ordinal};if(canonical(previous)!==canonical(expected))throw new Error('canary_subject_reused');return previous}if(state.phase!=='pending'||state.comparisons.length>=5)throw new Error('canary_window_terminal');const ordinal=state.comparisons.length+1;const comparisonBase={...input.comparison,ordinal,window_id:state.window_id,lane:state.lane,profile_hash:state.profile_hash,promotion_proof_id:state.promotion_proof_id};return{...input.comparison,ordinal,comparison_id:`comparison-${digest(comparisonBase).slice(0,32)}`}}

export function inspectCanaryWindow(input: { stateRoot: string; repoId: string; lane: Lane; profileHash: string }) {
  return publicStateWithCanonicalSafety(input.stateRoot,readState(statePath(input.stateRoot, input.repoId, input.lane, input.profileHash)), 'inspected');
}

export function inspectCanaryActivationCandidate(input: { stateRoot: string; repoId: string; lane: Lane; profileHash: string; blockId?: string; subjectHead: string; subjectTree: string; reconcileOnly?:boolean }) {
  if ((input.blockId !== undefined && !/^block-[0-9a-f]{32}$/.test(input.blockId)) || !HEAD.test(input.subjectHead) || !HEAD.test(input.subjectTree)) throw new Error('canary_activation_candidate_invalid');
  if(!input.reconcileOnly)assertCanaryNotLatched(input.stateRoot,input.lane);
  const state = readState(statePath(input.stateRoot, input.repoId, input.lane, input.profileHash));
  if (!state.activation_proof_id) throw new Error('canary_activation_not_ready');
  if(input.reconcileOnly){const landing=state.activation_landing;if(!landing||!state.activation_landing_intent_id||!['activation_landing_intent','activation_checkpointed','pending_superseded'].includes(state.phase)||landing.block_id!==input.blockId||landing.expected_head!==input.subjectHead||landing.proof_subject_tree!==input.subjectTree)throw new Error('canary_activation_not_ready')}
  else if(!['aggregate_ready', 'activation_landing_intent', 'activation_checkpointed', 'pending_superseded'].includes(state.phase))throw new Error('canary_activation_not_ready');
  const comparison = input.reconcileOnly&&state.activation_landing?state.comparisons.find(item=>item.comparison_id===state.activation_landing!.proof_comparison_id):state.comparisons.at(-1);
  if (!comparison || (input.blockId !== undefined && comparison.source_block_id !== input.blockId) || comparison.subject_head !== input.subjectHead || comparison.subject_tree !== input.subjectTree
    || !comparison.policy_hash || !comparison.focused_run_id) throw new Error('canary_activation_subject_mismatch');
  if (!comparison.source_block_id) throw new Error('canary_activation_subject_mismatch');
  return {
    block_id: comparison.source_block_id,
    lane: state.lane,
    state_id: state.state_id,
    window_id: state.window_id,
    proof_id: state.activation_proof_id,
    comparison_id: comparison.comparison_id,
    focused_run_id: comparison.focused_run_id,
    profile_hash: state.profile_hash,
    promotion_proof_id: state.promotion_proof_id,
    subject_head: comparison.subject_head,
    subject_tree: comparison.subject_tree,
    policy_hash: comparison.policy_hash,
  };
}

export function inspectCanaryShipCandidate(input: { stateRoot: string; repoId: string; lane: Lane; profileHash: string; blockId: string; subjectHead: string; subjectTree: string }) {
  if (!/^block-[0-9a-f]{32}$/.test(input.blockId) || !HEAD.test(input.subjectHead) || !HEAD.test(input.subjectTree)) throw new Error('canary_ship_candidate_invalid');
  assertCanaryNotLatched(input.stateRoot,input.lane);
  const state = readState(statePath(input.stateRoot, input.repoId, input.lane, input.profileHash));
  if (state.phase !== 'pending') throw new Error('canary_ship_candidate_not_pending');
  const matches = (state.focused_slots ?? []).filter((slot) => slot.block_id === input.blockId && slot.subject_head === input.subjectHead && slot.subject_tree === input.subjectTree && slot.phase !== 'superseded');
  if (matches.length !== 1) throw new Error(matches.length ? 'canary_ship_candidate_ambiguous' : 'canary_ship_candidate_missing');
  const slot = matches[0];
  return { block_id: slot.block_id, lane: slot.lane, focused_run_id: slot.focused_run_id, profile_hash: slot.profile_hash, promotion_proof_id: slot.promotion_proof_id, subject_head: slot.subject_head, subject_tree: slot.subject_tree, policy_hash: slot.policy_hash };
}

export function inspectCanarySampleCandidate(input: { stateRoot: string; repoId: string; lane: Lane; profileHash: string; blockId?: string; subjectHead: string; subjectTree: string; reconcileOnly?:boolean }) {
  if ((input.blockId !== undefined && !/^block-[0-9a-f]{32}$/.test(input.blockId)) || !HEAD.test(input.subjectHead) || !HEAD.test(input.subjectTree)) throw new Error('canary_sample_candidate_invalid');
  if(!input.reconcileOnly)assertCanaryNotLatched(input.stateRoot,input.lane);
  const state = readState(statePath(input.stateRoot, input.repoId, input.lane, input.profileHash));
  if (!input.reconcileOnly&&(state.phase !== 'pending' || aggregateCanaryWindow({ windowId: state.window_id, lane: state.lane, comparisons: state.comparisons }).result === 'passed')) throw new Error('canary_sample_not_pending');
  const recoveryIds=input.reconcileOnly?new Set((state.sample_landings??[]).filter(landing=>landing.block_id===input.blockId&&landing.expected_head===input.subjectHead&&landing.subject_tree===input.subjectTree).map(landing=>landing.comparison_id)):null;
  if(input.reconcileOnly&&recoveryIds!.size!==1)throw new Error(recoveryIds!.size?'canary_sample_candidate_ambiguous':'canary_sample_candidate_missing');
  const matches = state.comparisons.filter((comparison) => comparison.source_block_id
    && (input.blockId === undefined || comparison.source_block_id === input.blockId)
    && comparison.subject_head === input.subjectHead && comparison.subject_tree === input.subjectTree
    && (!recoveryIds||recoveryIds.has(comparison.comparison_id))
    && comparison.focused_run_id && comparison.policy_hash && comparison.class !== 'safety_regressed'
    && comparison.focused_outcome === 'pass' && comparison.legacy_control_outcome === 'pass');
  if (matches.length !== 1) throw new Error(matches.length ? 'canary_sample_candidate_ambiguous' : 'canary_sample_candidate_missing');
  const comparison = matches[0];
  const slots = (state.focused_slots ?? []).filter((slot) => slot.focused_run_id === comparison.focused_run_id && slot.comparison_id === comparison.comparison_id && slot.phase === 'comparison_appended');
  if (slots.length !== 1) throw new Error(slots.length ? 'canary_sample_candidate_ambiguous' : 'canary_sample_candidate_missing');
  return {
    block_id: comparison.source_block_id!, lane: state.lane, state_id: state.state_id, window_id: state.window_id,
    sample_id: comparison.comparison_id, focused_run_id: comparison.focused_run_id!, profile_hash: state.profile_hash,
    promotion_proof_id: state.promotion_proof_id, subject_head: comparison.subject_head, subject_tree: comparison.subject_tree!,
    policy_hash: comparison.policy_hash!, class: comparison.class,
  };
}

export function resolveCanaryExecutionGate(input: { stateRoot: string; repoId: string; lane: Lane; profileHash: string }) {
  try {
    const state = readState(statePath(input.stateRoot, input.repoId, input.lane, input.profileHash));
    const landed = activationLanded(state);
    const latch=inspectSafetyLatch({stateRoot:input.stateRoot,participant:'portfolioops',lane:input.lane});if(latch.result==='latched')return{state_id:state.state_id,phase:'safety_latched' as const,execution_allowed:false,reason:'safety_latched' as const,latch_id:latch.latch_id};
    return { state_id: state.state_id, phase: state.phase, execution_allowed: landed, reason: landed ? null : state.phase === 'safety_stop_required' ? 'safety_stop_required' : 'canary_pending' } as const;
  } catch (error) {
    if (error instanceof Error && error.message === 'canary_lineage_missing') return { state_id: null, phase: 'missing' as const, execution_allowed: false, reason: 'enforce_lineage_unresolved' as const };
    throw error;
  }
}

export interface CanaryActivationHandoff {
  current: true;
  receipt_run_id: string;
  repo_id: string;
  pr: number;
  base_ref: string;
  base_sha: string;
  remote_pr_head_sha: string;
  remote_pr_head_tree: string;
  profile_hash: string;
  canary_subject: {
    block_id: string;
    lane: Lane;
    focused_run_id: string;
    profile_hash: string;
    promotion_proof_id: string;
    subject_head: string;
    subject_tree: string;
    policy_hash: string;
  };
}

export interface CanaryActivationMerge {
  status: 'merged';
  mergeSha: string;
  expectedHeadOid: string;
  expectedBaseOid: string;
  intentId: string;
  baseAtomicity: 'verified';
}

export type CanaryActivationFaultPhase = 'activation_landing_intent' | 'provider_merge' | 'activation_checkpointed' | 'pending_superseded' | 'response';

function assertActivationHandoff(state: CanaryState, input: {
  blockId: string;
  activationProofId: string;
  expectedRepositoryNodeId: string;
  handoff: CanaryActivationHandoff;
}): CanaryActivationLanding {
  if (state.activation_proof_id !== input.activationProofId) throw new Error('canary_activation_not_ready');
  const handoff = input.handoff;
  const claim = handoff.canary_subject;
  const proofComparison = state.comparisons.at(-1);
  if (!handoff.current || !/^evidence-[0-9a-f]{32}$/.test(handoff.receipt_run_id) || handoff.repo_id !== state.repo_id
    || !Number.isSafeInteger(handoff.pr) || handoff.pr <= 0 || !/^origin\/[A-Za-z0-9._/-]+$/.test(handoff.base_ref)
    || !HEAD.test(handoff.base_sha) || !HEAD.test(handoff.remote_pr_head_sha) || !/^[A-Za-z0-9._:-]+$/.test(input.expectedRepositoryNodeId)
    || handoff.remote_pr_head_tree !== claim?.subject_tree || handoff.profile_hash !== state.profile_hash
    || !claim || claim.block_id !== input.blockId || claim.lane !== state.lane || claim.profile_hash !== state.profile_hash
    || claim.promotion_proof_id !== state.promotion_proof_id || claim.focused_run_id !== proofComparison?.focused_run_id
    || claim.subject_head !== proofComparison?.subject_head || claim.subject_tree !== proofComparison?.subject_tree
    || claim.policy_hash !== proofComparison?.policy_hash || handoff.remote_pr_head_sha !== claim.subject_head) throw new Error('canary_activation_lineage_mismatch');
  return {
    block_id: input.blockId,
    receipt_id: handoff.receipt_run_id,
    pr: handoff.pr,
    repository_node_id: input.expectedRepositoryNodeId,
    expected_head: handoff.remote_pr_head_sha,
    expected_base: handoff.base_sha,
    target_ref: handoff.base_ref,
    proof_comparison_id: proofComparison.comparison_id,
    proof_subject_tree: claim.subject_tree,
    policy_hash: claim.policy_hash,
  };
}

function assertSameActivationLanding(left: CanaryActivationLanding | null | undefined, right: CanaryActivationLanding): void {
  if (!left || canonical(left) !== canonical(right)) throw new Error('canary_activation_conflict');
}

type ProviderLandingBinding = Pick<CanaryActivationLanding, 'repository_node_id' | 'pr' | 'expected_head' | 'expected_base' | 'target_ref'>;

function verifyProviderCheckpoint(root: string, landing: ProviderLandingBinding, merge: CanaryActivationMerge): CanaryProviderCheckpoint {
  if (merge.status !== 'merged' || merge.baseAtomicity !== 'verified' || !HEAD.test(merge.mergeSha)
    || merge.expectedHeadOid !== landing.expected_head || merge.expectedBaseOid !== landing.expected_base
    || !/^[0-9a-f]{64}$/.test(merge.intentId)) throw new Error('canary_provider_checkpoint_invalid');
  let record: ReturnType<typeof inspectLandingIntent>;
  try { record = inspectLandingIntent(root, merge.intentId); }
  catch { throw new Error('canary_provider_checkpoint_invalid'); }
  if (record.phase !== 'checkpointed' || record.result?.status !== 'checkpointed' || record.result.mergeSha !== merge.mergeSha
    || record.repositoryNodeId !== landing.repository_node_id || record.prNumber !== landing.pr
    || record.expectedHeadOid !== landing.expected_head || record.expectedBaseOid !== landing.expected_base
    || record.targetRef !== landing.target_ref) throw new Error('canary_provider_checkpoint_invalid');
  return { raw_intent_id: merge.intentId, merge_sha: merge.mergeSha, intent_root: path.resolve(root) };
}

export type CanarySampleLandingFaultPhase = 'sample_landing_intent' | 'provider_merge' | 'sample_checkpointed' | 'response';

function assertSampleHandoff(state: CanaryState, input: {
  blockId: string;
  sampleId: string;
  expectedRepositoryNodeId: string;
  handoff: CanaryActivationHandoff;
}): Omit<CanarySampleLanding, 'sample_landing_intent_id' | 'sample_checkpoint_id' | 'provider_checkpoint'> {
  const handoff = input.handoff;
  const claim = handoff.canary_subject;
  const matches = state.comparisons.filter((comparison) => comparison.comparison_id === input.sampleId);
  if (state.phase !== 'pending' || matches.length !== 1) throw new Error('canary_sample_not_pending');
  const comparison = matches[0];
  if (!handoff.current || !/^evidence-[0-9a-f]{32}$/.test(handoff.receipt_run_id) || handoff.repo_id !== state.repo_id
    || !Number.isSafeInteger(handoff.pr) || handoff.pr <= 0 || !/^origin\/[A-Za-z0-9._/-]+$/.test(handoff.base_ref)
    || !HEAD.test(handoff.base_sha) || !HEAD.test(handoff.remote_pr_head_sha) || !/^[A-Za-z0-9._:-]+$/.test(input.expectedRepositoryNodeId)
    || !claim || claim.block_id !== input.blockId || claim.lane !== state.lane || claim.profile_hash !== state.profile_hash
    || claim.promotion_proof_id !== state.promotion_proof_id || claim.focused_run_id !== comparison.focused_run_id
    || claim.subject_head !== comparison.subject_head || claim.subject_tree !== comparison.subject_tree
    || claim.policy_hash !== comparison.policy_hash || handoff.remote_pr_head_sha !== claim.subject_head
    || handoff.remote_pr_head_tree !== claim.subject_tree || handoff.profile_hash !== state.profile_hash
    || comparison.class === 'safety_regressed' || comparison.focused_outcome !== 'pass' || comparison.legacy_control_outcome !== 'pass') throw new Error('canary_sample_lineage_mismatch');
  return {
    comparison_id: comparison.comparison_id, block_id: input.blockId, receipt_id: handoff.receipt_run_id, pr: handoff.pr,
    repository_node_id: input.expectedRepositoryNodeId, expected_head: handoff.remote_pr_head_sha, expected_base: handoff.base_sha,
    target_ref: handoff.base_ref, subject_tree: claim.subject_tree, focused_run_id: claim.focused_run_id, policy_hash: claim.policy_hash,
  };
}

function sampleLandingBody(value: CanarySampleLanding | Omit<CanarySampleLanding, 'sample_landing_intent_id' | 'sample_checkpoint_id' | 'provider_checkpoint'>) {
  const { comparison_id, block_id, receipt_id, pr, repository_node_id, expected_head, expected_base, target_ref, subject_tree, focused_run_id, policy_hash } = value;
  return { comparison_id, block_id, receipt_id, pr, repository_node_id, expected_head, expected_base, target_ref, subject_tree, focused_run_id, policy_hash };
}

export async function reconcileCanarySampleLanding(input: {
  stateRoot: string;
  providerIntentRoot: string;
  repoId: string;
  lane: Lane;
  profileHash: string;
  blockId: string;
  sampleId: string;
  handoff: CanaryActivationHandoff;
  expectedRepositoryNodeId: string;
  mergeProvider: () => Promise<CanaryActivationMerge>;
  milestoneLanding?: MilestoneLandingDescriptor;
  reconcileOnly?: boolean;
  fault?: (phase: CanarySampleLandingFaultPhase) => void;
}) {
  if (!/^block-[0-9a-f]{32}$/.test(input.blockId) || !/^comparison-[0-9a-f]{32}$/.test(input.sampleId)
    || typeof input.mergeProvider !== 'function' || !path.isAbsolute(input.providerIntentRoot)) throw new Error('canary_sample_invalid');
  const target = statePath(input.stateRoot, input.repoId, input.lane, input.profileHash);
  return withActiveMilestoneOwner({ stateRoot: input.stateRoot, blockId: input.blockId, participant: 'portfolioops', lane: input.lane, policyHash: input.handoff.canary_subject.policy_hash, reconcileOnly: input.reconcileOnly, milestoneLanding: input.milestoneLanding }, async (_block,journal) => withAsyncLock(target, async () => {
    const state = readState(target);
    const landingBody = assertSampleHandoff(state, input);
    const existing = (state.sample_landings ??= []).filter((item) => item.comparison_id === input.sampleId);
    if (existing.length > 1) throw new Error('canary_sample_landing_ambiguous');
    let landing = existing[0];
    if (!landing) {
      landing = {
        ...landingBody,
        sample_landing_intent_id: `sample-landing-${digest({ state_id: state.state_id, ...landingBody }).slice(0, 32)}`,
        sample_checkpoint_id: null,
        provider_checkpoint: null,
      };
      state.sample_landings.push(landing);
      state.revision = revision(state);
      durableWrite(target, state);
      input.fault?.('sample_landing_intent');
    } else if (canonical(sampleLandingBody(landing)) !== canonical(landingBody)) {
      throw new Error('canary_sample_landing_conflict');
    }
    if (landing.provider_checkpoint && landing.sample_checkpoint_id) {
      verifyProviderCheckpoint(input.providerIntentRoot, landing, {
        status: 'merged', mergeSha: landing.provider_checkpoint.merge_sha, expectedHeadOid: landing.expected_head,
        expectedBaseOid: landing.expected_base, intentId: landing.provider_checkpoint.raw_intent_id, baseAtomicity: 'verified',
      });
      input.fault?.('response');
      return { schema: 'ecpe.canary-sample-landing.v1' as const, result: 'reused' as const, state_id: state.state_id, phase: state.phase, sample_id: landing.comparison_id, sample_landing_intent_id: landing.sample_landing_intent_id, sample_checkpoint_id: landing.sample_checkpoint_id, execution_allowed: false };
    }
    const merge = input.milestoneLanding ? await journal.merge(input.milestoneLanding,input.mergeProvider) : await input.mergeProvider();
    input.fault?.('provider_merge');
    landing.provider_checkpoint = verifyProviderCheckpoint(input.providerIntentRoot, landing, merge);
    landing.sample_checkpoint_id = `sample-checkpoint-${digest({ state_id: state.state_id, sample_landing_intent_id: landing.sample_landing_intent_id, ...landing.provider_checkpoint }).slice(0, 32)}`;
    state.revision = revision(state);
    durableWrite(target, state);
    input.fault?.('sample_checkpointed');
    const result = { schema: 'ecpe.canary-sample-landing.v1' as const, result: 'checkpointed' as const, state_id: state.state_id, phase: state.phase, sample_id: landing.comparison_id, sample_landing_intent_id: landing.sample_landing_intent_id, sample_checkpoint_id: landing.sample_checkpoint_id, execution_allowed: false };
    input.fault?.('response');
    return result;
  }));
}

export async function reconcileCanaryActivationLanding(input: {
  stateRoot: string;
  providerIntentRoot: string;
  repoId: string;
  lane: Lane;
  profileHash: string;
  blockId: string;
  activationProofId: string;
  handoff: CanaryActivationHandoff;
  expectedRepositoryNodeId: string;
  mergeProvider: () => Promise<CanaryActivationMerge>;
  milestoneLanding?: MilestoneLandingDescriptor;
  reconcileOnly?: boolean;
  fault?: (phase: CanaryActivationFaultPhase) => void;
}) {
  if (!/^block-[0-9a-f]{32}$/.test(input.blockId) || !/^canary-ready-[0-9a-f]{32}$/.test(input.activationProofId)
    || typeof input.mergeProvider !== 'function' || !path.isAbsolute(input.providerIntentRoot)) throw new Error('canary_activation_invalid');
  const target = statePath(input.stateRoot, input.repoId, input.lane, input.profileHash);
  return withActiveMilestoneOwner({ stateRoot: input.stateRoot, blockId: input.blockId, participant: 'portfolioops', lane: input.lane, policyHash: input.handoff.canary_subject.policy_hash, reconcileOnly: input.reconcileOnly, milestoneLanding: input.milestoneLanding }, async (block,journal) => withAsyncLock(target, async () => {
    const state = readState(target);
    if (!['aggregate_ready', 'activation_landing_intent', 'activation_checkpointed', 'pending_superseded'].includes(state.phase)) throw new Error('canary_activation_not_ready');
    const landing = assertActivationHandoff(state, input);
    if (state.phase === 'pending_superseded') {
      assertSameActivationLanding(state.activation_landing, landing);
      if (!state.activation_provider_checkpoint || !activationLanded(state)) throw new Error('canary_activation_record_invalid');
      verifyProviderCheckpoint(input.providerIntentRoot, landing, {
        status: 'merged', mergeSha: state.activation_provider_checkpoint.merge_sha,
        expectedHeadOid: landing.expected_head, expectedBaseOid: landing.expected_base,
        intentId: state.activation_provider_checkpoint.raw_intent_id, baseAtomicity: 'verified',
      });
      const result = publicState(state, 'reused');
      input.fault?.('response');
      return result;
    }
    if (state.phase === 'aggregate_ready') {
      const intentBody = { state_id: state.state_id, window_id: state.window_id, proof_id: state.activation_proof_id, ...landing };
      state.activation_landing = landing;
      state.activation_landing_intent_id = `landing-${digest(intentBody).slice(0, 32)}`;
      state.activation_receipt_id = landing.receipt_id;
      state.phase = 'activation_landing_intent';
      state.revision = revision(state);
      durableWrite(target, state);
      input.fault?.('activation_landing_intent');
    } else {
      assertSameActivationLanding(state.activation_landing, landing);
    }
    if (state.phase === 'activation_landing_intent') {
      const merge = input.milestoneLanding ? await journal.merge(input.milestoneLanding,input.mergeProvider) : await input.mergeProvider();
      input.fault?.('provider_merge');
      const providerCheckpoint = verifyProviderCheckpoint(input.providerIntentRoot, landing, merge);
      state.activation_provider_checkpoint = providerCheckpoint;
      state.activation_checkpoint_id = `checkpoint-${digest({ state_id: state.state_id, activation_landing_intent_id: state.activation_landing_intent_id, activation_proof_id: state.activation_proof_id, receipt_id: state.activation_receipt_id, ...providerCheckpoint }).slice(0, 32)}`;
      state.phase = 'activation_checkpointed';
      state.revision = revision(state);
      durableWrite(target, state);
      input.fault?.('activation_checkpointed');
    }
    if (state.phase === 'activation_checkpointed') {
      if (!state.activation_provider_checkpoint) throw new Error('canary_activation_record_invalid');
      verifyProviderCheckpoint(input.providerIntentRoot, landing, {
        status: 'merged', mergeSha: state.activation_provider_checkpoint.merge_sha,
        expectedHeadOid: landing.expected_head, expectedBaseOid: landing.expected_base,
        intentId: state.activation_provider_checkpoint.raw_intent_id, baseAtomicity: 'verified',
      });
      if (block.phase !== 'active') return { ...publicStateWithCanonicalSafety(input.stateRoot,state, 'checkpointed_terminal'), execution_allowed: false };
      if (new Date().toISOString() >= block.expires_at) throw new Error('milestone_activation_block_expired');
      state.phase = 'pending_superseded';
      state.revision = revision(state);
      durableWrite(target, state);
      input.fault?.('pending_superseded');
    }
    const result = publicState(state, 'activated');
    input.fault?.('response');
    return result;
  }));
}

export interface CanaryFocusedBindingInput {
  stateRoot: string;
  repoId: string;
  lane: Lane;
  profileHash: string;
  blockId: string;
  participant: 'portfolioops';
  subjectHead: string;
  subjectTree: string;
  hostFingerprint: string;
  policyHash: string;
}

function validateFocusedBinding(input: CanaryFocusedBindingInput): void {
  if (!/^block-[0-9a-f]{32}$/.test(input.blockId) || input.participant !== 'portfolioops' || !HEAD.test(input.subjectHead) || !HEAD.test(input.subjectTree) || !HOST.test(input.hostFingerprint) || !HASH.test(input.policyHash)) throw new Error('canary_focused_binding_invalid');
}

function exactSlot(state: CanaryState, focusedRunId: string): CanaryFocusedSlot {
  const matches = (state.focused_slots ?? []).filter((slot) => slot.focused_run_id === focusedRunId);
  if (matches.length !== 1) throw new Error(matches.length ? 'canary_focused_run_ambiguous' : 'canary_focused_run_missing');
  return matches[0];
}

function assertSlotBinding(slot: CanaryFocusedSlot, state: CanaryState, input: CanaryFocusedBindingInput): void {
  if (slot.block_id !== input.blockId || slot.participant !== input.participant || slot.lane !== input.lane || slot.profile_hash !== input.profileHash || slot.promotion_proof_id !== state.promotion_proof_id || slot.policy_hash !== input.policyHash || slot.subject_head !== input.subjectHead || slot.subject_tree !== input.subjectTree || slot.host_fingerprint !== input.hostFingerprint) throw new Error('canary_focused_binding_mismatch');
}

export function claimCanaryFocusedRun(input: CanaryFocusedBindingInput) {
  validateFocusedBinding(input);
  const latch=inspectSafetyLatch({stateRoot:input.stateRoot,participant:'portfolioops',lane:input.lane});
  if(latch.result==='latched')return{block_id:input.blockId,participant:input.participant,lane:input.lane,result:'safety_latched' as const,execution:'legacy' as const,focused_run_id:null,reason:'safety_latched' as const};
  const target = statePath(input.stateRoot, input.repoId, input.lane, input.profileHash);
  return withLock(target, () => {
    const state = readState(target);
    const context={block_id:input.blockId,participant:input.participant,lane:input.lane};
    if (state.phase !== 'pending') return { ...context,result: 'canary_not_pending' as const, execution: 'legacy' as const, focused_run_id: null, reason: state.phase };
    if (state.comparisons.length >= 5) return { ...context,result:'sample_cap_reached' as const,execution:'legacy' as const,focused_run_id:null,reason:'canary_sample_cap_exceeded' };
    if (state.comparisons.some((item) => item.subject_head === input.subjectHead)) return { ...context,result: 'subject_already_sampled' as const, execution: 'legacy' as const, focused_run_id: null, reason: 'canary_subject_reused' };
    const establishedHost = state.comparisons[0]?.host_fingerprint;
    if (establishedHost && establishedHost !== input.hostFingerprint) return { ...context,result: 'host_moved' as const, execution: 'legacy' as const, focused_run_id: null, reason: 'canary_host_moved' };
    const active = [...(state.focused_slots ?? [])].reverse().find((slot) => !['superseded', 'comparison_appended'].includes(slot.phase));
    if (active) return { ...context,result: 'canary_in_progress' as const, execution: 'legacy' as const, focused_run_id: null, reason: active.subject_head === input.subjectHead ? 'canary_in_progress' : 'canary_slot_owned' };
    const base = { window_id: state.window_id, block_id: input.blockId, participant: input.participant, lane: input.lane, profile_hash: input.profileHash, promotion_proof_id: state.promotion_proof_id, policy_hash: input.policyHash, subject_head: input.subjectHead, subject_tree: input.subjectTree, host_fingerprint: input.hostFingerprint, ordinal: state.comparisons.length + 1 };
    const focusedRunId = `focused-${digest(base).slice(0, 32)}`;
    const slot: CanaryFocusedSlot = { block_id: input.blockId, participant: input.participant, lane: input.lane, profile_hash: input.profileHash, promotion_proof_id: state.promotion_proof_id, policy_hash: input.policyHash, subject_head: input.subjectHead, subject_tree: input.subjectTree, host_fingerprint: input.hostFingerprint, focused_run_id: focusedRunId, control_run_id: `control-${digest(`${focusedRunId}\0legacy`).slice(0, 32)}`, phase: 'focused_reserved', control_measurement: null, comparison_id: null };
    (state.focused_slots ??= []).push(slot);
    state.revision = revision(state); durableWrite(target, state);
    return { ...context,result: 'focused_reserved' as const, execution: 'profile_canary' as const, focused_run_id: focusedRunId, reason: null };
  });
}

export function supersedeCanaryFocusedReservation(input: CanaryFocusedBindingInput & { focusedRunId: string; currentSubjectHead: string; currentSubjectTree: string }) {
  validateFocusedBinding(input);
  if (!HEAD.test(input.currentSubjectHead) || !HEAD.test(input.currentSubjectTree) || (input.currentSubjectHead === input.subjectHead && input.currentSubjectTree === input.subjectTree)) throw new Error('canary_subject_not_moved');
  const target = statePath(input.stateRoot, input.repoId, input.lane, input.profileHash);
  return withLock(target, () => { const state = readState(target); const slot = exactSlot(state, input.focusedRunId); assertSlotBinding(slot, state, input); if (slot.phase === 'superseded') return { result: 'reused' as const }; if (slot.phase !== 'focused_reserved') throw new Error('canary_reservation_effect_started'); slot.phase = 'superseded'; state.revision = revision(state); durableWrite(target, state); return { result: 'reservation_superseded' as const }; });
}

export function inspectCanaryFocusedSlot(input: CanaryFocusedBindingInput & { focusedRunId: string }): CanaryFocusedSlot {
  validateFocusedBinding(input); const state = readState(statePath(input.stateRoot, input.repoId, input.lane, input.profileHash)); const slot = exactSlot(state, input.focusedRunId); assertSlotBinding(slot, state, input); return structuredClone(slot);
}
export function inspectCurrentCanaryFocusedSlot(input: CanaryFocusedBindingInput): CanaryFocusedSlot {
  validateFocusedBinding(input); const state=readState(statePath(input.stateRoot,input.repoId,input.lane,input.profileHash));const matches=(state.focused_slots??[]).filter(slot=>slot.phase!=='superseded'&&slot.block_id===input.blockId&&slot.participant===input.participant&&slot.lane===input.lane&&slot.profile_hash===input.profileHash&&slot.promotion_proof_id===state.promotion_proof_id&&slot.policy_hash===input.policyHash&&slot.subject_head===input.subjectHead&&slot.subject_tree===input.subjectTree&&slot.host_fingerprint===input.hostFingerprint);if(matches.length!==1)throw new Error(matches.length?'canary_focused_run_ambiguous':'canary_focused_run_missing');return structuredClone(matches[0]);
}

export function inspectCanarySafetyPredecessor(input:{stateRoot:string;repoId:string;lane:Lane;profileHash:string}){try{const state=readState(statePath(input.stateRoot,input.repoId,input.lane,input.profileHash));return{state_id:state.state_id,window_id:state.window_id,phase:state.phase,revision:state.revision}}catch(error){if(error instanceof Error&&error.message==='canary_lineage_missing')return{state_id:null,window_id:null,phase:'missing',revision:null};throw error}}
export function acquireCanarySafetyPredecessors(input:{stateRoot:string;repoId:string;profileHashes:Record<Lane,string>}){const owned:Array<ReturnType<typeof acquireDurableOwnerLock>>=[];try{for(const lane of [...(['docs_ux','single_repo_code','cross_repo_contract'] as Lane[])].sort())owned.push(acquireDurableOwnerLock(statePath(input.stateRoot,input.repoId,lane,input.profileHashes[lane]),'canary_owner_busy'));const predecessors=Object.fromEntries((['docs_ux','single_repo_code','cross_repo_contract'] as Lane[]).map(lane=>[lane,inspectCanarySafetyPredecessor({stateRoot:input.stateRoot,repoId:input.repoId,lane,profileHash:input.profileHashes[lane]})]));let released=false;return{predecessors,release:()=>{if(released)return;released=true;for(const lock of owned.reverse())releaseDurableOwnerLock(lock)}}}catch(error){for(const lock of owned.reverse())releaseDurableOwnerLock(lock);throw error}}

function advanceFocusedSlot(input: CanaryFocusedBindingInput & { focusedRunId: string }, mutate: (slot: CanaryFocusedSlot) => void): CanaryFocusedSlot {
  validateFocusedBinding(input); const target = statePath(input.stateRoot, input.repoId, input.lane, input.profileHash);
  return withLock(target, () => { const state = readState(target); const slot = exactSlot(state, input.focusedRunId); assertSlotBinding(slot, state, input); mutate(slot); state.revision = revision(state); durableWrite(target, state); return structuredClone(slot); });
}

export function prepareCanaryControl(input: CanaryFocusedBindingInput & { focusedRunId: string }) {
  return advanceFocusedSlot(input, (slot) => { if (slot.phase === 'focused_reserved') slot.phase = 'control_prepared'; else if (!['control_prepared', 'control_started', 'control_terminal', 'comparison_appended'].includes(slot.phase)) throw new Error('canary_control_phase_invalid'); });
}
export function startCanaryControl(input: CanaryFocusedBindingInput & { focusedRunId: string }) {
  return advanceFocusedSlot(input, (slot) => { if (slot.phase === 'control_prepared') slot.phase = 'control_started'; else if (slot.phase !== 'control_started') throw new Error('canary_control_phase_invalid'); });
}
export function terminalCanaryControl(input: CanaryFocusedBindingInput & { focusedRunId: string; measurement: CanaryControlMeasurement }) {
  return advanceFocusedSlot(input, (slot) => { if (slot.phase === 'control_terminal') { if (canonical(slot.control_measurement) !== canonical(input.measurement)) throw new Error('canary_control_terminal_conflict'); return; } if (slot.phase !== 'control_started') throw new Error('canary_control_phase_invalid'); slot.control_measurement = structuredClone(input.measurement); slot.phase = 'control_terminal'; });
}
export function bindCanaryFocusedComparison(input: CanaryFocusedBindingInput & { focusedRunId: string; comparisonId: string }) {
  return advanceFocusedSlot(input, (slot) => { if (!/^comparison-[0-9a-f]{32}$/.test(input.comparisonId)) throw new Error('canary_comparison_invalid'); if (slot.phase === 'comparison_appended') { if (slot.comparison_id !== input.comparisonId) throw new Error('canary_comparison_conflict'); return; } if (!['control_terminal', 'control_started'].includes(slot.phase)) throw new Error('canary_control_phase_invalid'); slot.comparison_id = input.comparisonId; slot.phase = 'comparison_appended'; });
}
