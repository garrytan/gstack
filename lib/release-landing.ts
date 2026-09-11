import { createHash } from 'node:crypto';
import { assertProviderHeadSnapshot, resolveDirectMergeLandingIntent, resolveProviderLandingIntentRoot, snapshotMergedProviderLanding, snapshotProviderHead, type ProviderHeadSnapshot, type ProviderMergedSnapshot } from './provider-access';
import { inspectExactMergedLandingCheckpoint, type ExactMergedLandingCheckpoint, type LandingIntentDescriptor } from './landing-safety';
import { inspectHistoricalRetiredReleaseLandingProof, inspectRetiredReleaseLandReadinessProof, type RetiredReleaseLandingProof } from './release-metadata';
import { inspectAssertedShipHandoff } from './ship-handoff';
import type { Lane } from './work-profile';

const HASH40 = /^[0-9a-f]{40}$/;
const HASH64 = /^[0-9a-f]{64}$/;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex'); }

export interface ReleaseLandInput {
  cwd: string; pr: number; assertTargetRef: string; expectedBase: string; remotePrHead: string;
  stateRootId: string; repositoryNodeId: string; headRepositoryNodeId: string; headRefName: string; stateHome: string;
  expectedHeadTree: string; retirementId: string; receiptRunId: string; lane?: Lane; releaseRequested?: boolean;
}

export interface ReleaseLandDependencies {
  snapshotOpenProvider?: (cwd: string, pr: number) => Promise<ProviderHeadSnapshot>;
  inspectCurrentRetiredProof?: () => RetiredReleaseLandingProof | Promise<RetiredReleaseLandingProof>;
  inspectHistoricalRetiredProof?: () => RetiredReleaseLandingProof;
  snapshotMergedProvider?: () => Promise<ProviderMergedSnapshot>;
  resolveLandingIntent?: () => Promise<{ descriptor: LandingIntentDescriptor; intentId: string }>;
  inspectMergedRaw?: (descriptor: LandingIntentDescriptor) => ExactMergedLandingCheckpoint;
}

function assertInput(input: ReleaseLandInput): void {
  if (!Number.isSafeInteger(input.pr) || input.pr <= 0 || ![input.expectedBase, input.remotePrHead, input.expectedHeadTree].every(value => HASH40.test(value)) ||
    !/^origin\/[A-Za-z0-9._/-]+$/.test(input.assertTargetRef) || input.assertTargetRef.includes('..') ||
    input.repositoryNodeId !== input.headRepositoryNodeId || !input.repositoryNodeId || !input.headRefName || input.headRefName.startsWith('refs/') || input.headRefName.includes('..') ||
    !/^state_[0-9a-f]{32}$/.test(input.stateRootId) || !/^release-retirement-[0-9a-f]{32}$/.test(input.retirementId) ||
    !/^evidence-[0-9a-f]{32}$/.test(input.receiptRunId)) throw new Error('release_land_assertion_invalid');
}

function assertProof(input: ReleaseLandInput, proof: RetiredReleaseLandingProof): void {
  if (proof.schema !== 'ecpe.retired-release-landing-proof.v1' || !/^release-land-proof-[0-9a-f]{32}$/.test(proof.proof_id) ||
    !HASH64.test(proof.binding_sha256) || proof.state_root_id !== input.stateRootId || proof.retirement_id !== input.retirementId ||
    proof.receipt_run_id !== input.receiptRunId || proof.reservation_retained !== true ||
    proof.current_pr_identity.number !== input.pr || proof.current_pr_identity.base_oid !== input.expectedBase ||
    proof.current_pr_identity.head_oid !== input.remotePrHead || proof.current_pr_identity.head_repository_node_id !== input.headRepositoryNodeId ||
    proof.current_pr_identity.head_ref !== input.headRefName || proof.release_write.after_wtree !== input.expectedHeadTree ||
    proof.release_write.allocation_id !== proof.allocation_id || proof.release_write.release_write_record_id !== proof.release_write_record_id ||
    proof.release_write.release_write_result_hash !== proof.release_write_result_hash || !proof.release_write.version) throw new Error('release_land_projection_drift');
}

function assertOpen(input: ReleaseLandInput, snapshot: ProviderHeadSnapshot): void {
  try {
    assertProviderHeadSnapshot(snapshot, { prNumber: input.pr, expectedHeadOid: input.remotePrHead, expectedBaseOid: input.expectedBase,
      expectedTargetRef: input.assertTargetRef, expectedRepositoryNodeId: input.repositoryNodeId,
      expectedHeadRepositoryNodeId: input.headRepositoryNodeId, expectedHeadRefName: input.headRefName, requireAutomationNull: true });
  } catch { throw new Error('release_land_provider_drift'); }
  if (snapshot.repositoryNodeId !== snapshot.headRepositoryNodeId || snapshot.mergeable !== 'MERGEABLE' || snapshot.mergeStateStatus !== 'CLEAN') throw new Error('release_land_provider_drift');
}

function assertMerged(input: ReleaseLandInput, mergeSha: string, snapshot: ProviderMergedSnapshot): void {
  if (snapshot.providerState !== 'MERGED' || snapshot.repositoryNodeId !== input.repositoryNodeId || snapshot.headRepositoryNodeId !== input.headRepositoryNodeId ||
    snapshot.repositoryNodeId !== snapshot.headRepositoryNodeId || snapshot.headRefName !== input.headRefName || snapshot.targetRef !== input.assertTargetRef ||
    snapshot.expectedHeadOid !== input.remotePrHead || snapshot.expectedBaseOid !== input.expectedBase || snapshot.mergeSha !== mergeSha ||
    snapshot.mergeTree !== input.expectedHeadTree || snapshot.liveTargetOid !== mergeSha || snapshot.baseParentVerified !== true ||
    snapshot.headTreeVerified !== true || snapshot.liveTargetVerified !== true) throw new Error('merged_release_checkpoint_drift');
}

function defaultResolve(input: ReleaseLandInput) {
  return resolveDirectMergeLandingIntent(input.cwd, { prNumber: input.pr, expectedHeadOid: input.remotePrHead,
    expectedBaseOid: input.expectedBase, expectedTargetRef: input.assertTargetRef, expectedRepositoryNodeId: input.repositoryNodeId });
}

export async function inspectReleaseLandReadiness(input: ReleaseLandInput, dependencies: ReleaseLandDependencies = {}) {
  assertInput(input);
  const snapshotOpen = dependencies.snapshotOpenProvider ?? ((cwd: string, pr: number) => snapshotProviderHead(cwd, pr));
  const inspectProof = dependencies.inspectCurrentRetiredProof ?? (() => inspectRetiredReleaseLandReadinessProof({ cwd: input.cwd, lane: input.lane, releaseRequested: input.releaseRequested, assertTargetRef: input.assertTargetRef }, { inspectShipReceipt: inspectAssertedShipHandoff }));
  const resolveLanding = dependencies.resolveLandingIntent ?? (() => defaultResolve(input));
  const firstSnapshot = await snapshotOpen(input.cwd, input.pr); assertOpen(input, firstSnapshot);
  const firstProof = await inspectProof(); assertProof(input, firstProof);
  const resolved = await resolveLanding();
  if (resolved.intentId !== digest(resolved.descriptor) || resolved.descriptor.repoId.toLowerCase() === '' || resolved.descriptor.repositoryNodeId !== input.repositoryNodeId ||
    resolved.descriptor.prNumber !== input.pr || resolved.descriptor.expectedHeadOid !== input.remotePrHead || resolved.descriptor.expectedBaseOid !== input.expectedBase ||
    resolved.descriptor.targetRef !== input.assertTargetRef) throw new Error('release_land_intent_drift');
  const secondProof = await inspectProof(); assertProof(input, secondProof);
  if (stable(firstProof) !== stable(secondProof)) throw new Error('release_land_projection_drift');
  const secondSnapshot = await snapshotOpen(input.cwd, input.pr); assertOpen(input, secondSnapshot);
  if (stable(firstSnapshot) !== stable(secondSnapshot)) throw new Error('release_land_provider_drift');
  const finalProof = await inspectProof(); assertProof(input, finalProof);
  if (stable(firstProof) !== stable(finalProof)) throw new Error('release_land_projection_drift');
  const core = { raw_intent_id: resolved.intentId, repository_node_id: input.repositoryNodeId, pr_number: input.pr,
    expected_head_oid: input.remotePrHead, expected_base_oid: input.expectedBase, expected_head_tree: input.expectedHeadTree,
    target_ref: input.assertTargetRef, retirement_id: firstProof.retirement_id, receipt_run_id: firstProof.receipt_run_id,
    release_proof_id: firstProof.proof_id, release_proof_binding_sha256: firstProof.binding_sha256 };
  const binding = digest(core);
  return { schema: 'ecpe.release-land-readiness.v1' as const, readiness_id: `release-land-readiness-${binding.slice(0, 32)}`, ...core, binding_sha256: binding };
}

export async function inspectMergedReleaseCheckpoint(input: ReleaseLandInput & { mergeSha: string }, dependencies: ReleaseLandDependencies = {}) {
  assertInput(input);
  if (!HASH40.test(input.mergeSha)) throw new Error('merged_release_checkpoint_invalid');
  const inspectProof = dependencies.inspectHistoricalRetiredProof ?? (() => inspectHistoricalRetiredReleaseLandingProof(input, { inspectShipReceipt: inspectAssertedShipHandoff }));
  const snapshotMerged = dependencies.snapshotMergedProvider ?? (() => snapshotMergedProviderLanding(input.cwd, { prNumber: input.pr,
    expectedHeadOid: input.remotePrHead, expectedBaseOid: input.expectedBase, expectedTargetRef: input.assertTargetRef,
    expectedRepositoryNodeId: input.repositoryNodeId, expectedHeadRepositoryNodeId: input.headRepositoryNodeId,
    expectedHeadRefName: input.headRefName, expectedHeadTree: input.expectedHeadTree, mergeSha: input.mergeSha }));
  const resolveLanding = dependencies.resolveLandingIntent ?? (() => defaultResolve(input));
  const resolved = await resolveLanding();
  if (resolved.intentId !== digest(resolved.descriptor)) throw new Error('merged_release_checkpoint_invalid');
  const inspectRaw = dependencies.inspectMergedRaw
    ? () => dependencies.inspectMergedRaw!(resolved.descriptor)
    : () => inspectExactMergedLandingCheckpoint(resolveProviderLandingIntentRoot(), { descriptor: resolved.descriptor,
      mergeSha: input.mergeSha, mergeTree: input.expectedHeadTree, mergeParents: [input.expectedBase] });
  const firstRaw = inspectRaw(); const firstProof = inspectProof(); assertProof(input, firstProof);
  const firstProvider = await snapshotMerged(); assertMerged(input, input.mergeSha, firstProvider);
  const secondProof = inspectProof(); assertProof(input, secondProof); const secondRaw = inspectRaw();
  const secondProvider = await snapshotMerged(); assertMerged(input, input.mergeSha, secondProvider);
  if (stable(firstProof) !== stable(secondProof) || stable(firstRaw) !== stable(secondRaw) || stable(firstProvider) !== stable(secondProvider)) throw new Error('merged_release_checkpoint_drift');
  const finalProof = inspectProof(); assertProof(input, finalProof); const finalRaw = inspectRaw();
  if (stable(firstProof) !== stable(finalProof) || stable(firstRaw) !== stable(finalRaw)) throw new Error('merged_release_checkpoint_drift');
  const core = { raw_intent_id: firstRaw.raw_intent_id, raw_checkpoint_id: firstRaw.checkpoint_id,
    repository_node_id: input.repositoryNodeId, pr_number: input.pr, expected_head_oid: input.remotePrHead,
    expected_base_oid: input.expectedBase, expected_head_tree: input.expectedHeadTree, target_ref: input.assertTargetRef,
    merge_sha: input.mergeSha, merge_tree: firstProvider.mergeTree, live_target_oid: firstProvider.liveTargetOid,
    retirement_id: firstProof.retirement_id, receipt_run_id: firstProof.receipt_run_id, release_proof_id: firstProof.proof_id,
    release_proof_binding_sha256: firstProof.binding_sha256, base_parent_verified: true as const,
    head_tree_verified: true as const, live_target_verified: true as const, reservation_retained: true as const };
  const binding = digest(core);
  return { schema: 'ecpe.merged-release-checkpoint.v1' as const, checkpoint_id: `merged-release-${binding.slice(0, 32)}`, ...core, binding_sha256: binding };
}
