import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspectMergedReleaseCheckpoint, inspectReleaseLandReadiness } from '../lib/release-landing';
import { inspectExactMergedLandingCheckpoint, landingIntentIdForDescriptor, prepareLandingIntent, reconcileLandingIntent } from '../lib/landing-safety';
import type { ProviderHeadSnapshot, ProviderMergedSnapshot } from '../lib/provider-access';
import type { RetiredReleaseLandingProof } from '../lib/release-metadata';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const oid = (char: string) => char.repeat(40);
const hash = (char: string) => char.repeat(64);

function fixture() {
  const landingIntentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-release-land-')); roots.push(landingIntentRoot);
  const descriptor = { repoId: 'github.com/owner/repo', repositoryNodeId: 'R_repo', prNumber: 7,
    expectedHeadOid: oid('2'), expectedBaseOid: oid('1'), targetRef: 'origin/main', mode: 'direct_observed' as const,
    providerOperationId: 'github.com:direct-pr:7' };
  const releaseWrite = { allocation_id: 'release-11111111-1111-4111-8111-111111111111', release_write_record_id: 'release-write-22222222-2222-4222-8222-222222222222',
    release_write_result_hash: hash('3'), version: '1.0.1', before_wtree: oid('0'), after_wtree: oid('4'), product_manifest_hash_before_release: hash('5'),
    release_projection_hash: hash('6'), changelog_proposal_sha256: hash('7'), changelog_insertion_sha256: hash('8'), planned_targets: [],
    changelog_projection: null, mutated_projections: [], files: [] };
  const currentPrIdentity = { number: 7, base_oid: oid('1'), head_oid: oid('2'), head_repository_node_id: 'R_repo', head_ref: 'feature' };
  const proof: RetiredReleaseLandingProof = { schema: 'ecpe.retired-release-landing-proof.v1', proof_id: `release-land-proof-${'9'.repeat(32)}`,
    binding_sha256: hash('a'), state_root_id: `state_${'b'.repeat(32)}`, repository_key: hash('c'), allocation_id: releaseWrite.allocation_id,
    release_write_record_id: releaseWrite.release_write_record_id, release_write_result_hash: releaseWrite.release_write_result_hash,
    retirement_id: `release-retirement-${'d'.repeat(32)}`, receipt_run_id: `evidence-${'e'.repeat(32)}`, current_pr_identity: currentPrIdentity,
    release_write: releaseWrite, reservation_retained: true };
  const open: ProviderHeadSnapshot = { repositoryNameWithOwner: 'owner/repo', repositoryNodeId: 'R_repo', viewerPermission: 'ADMIN', prNumber: 7,
    prState: 'OPEN', repositorySelector: 'owner/repo', headRepositoryNameWithOwner: 'owner/repo', headRepositoryNodeId: 'R_repo', targetRef: 'origin/main',
    baseRefName: 'main', baseRefOid: oid('1'), headRefName: 'feature', headRefOid: oid('2'), mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    autoMergeRequest: null, mergeQueueEntry: null };
  const merged: ProviderMergedSnapshot = { providerState: 'MERGED', repositoryNameWithOwner: 'owner/repo', repositoryNodeId: 'R_repo',
    headRepositoryNameWithOwner: 'owner/repo', headRepositoryNodeId: 'R_repo', headRefName: 'feature', targetRef: 'origin/main',
    expectedHeadOid: oid('2'), expectedBaseOid: oid('1'), mergeSha: oid('f'), mergeTree: oid('4'), liveTargetOid: oid('f'),
    baseParentVerified: true, headTreeVerified: true, liveTargetVerified: true };
  const input = { cwd: '/fixture/repo', pr: 7, assertTargetRef: 'origin/main', expectedBase: oid('1'), remotePrHead: oid('2'),
    stateRootId: proof.state_root_id, repositoryNodeId: 'R_repo', headRepositoryNodeId: 'R_repo', headRefName: 'feature', stateHome: '/fixture/state',
    expectedHeadTree: oid('4'), retirementId: proof.retirement_id, receiptRunId: proof.receipt_run_id, lane: 'single_repo_code' as const, releaseRequested: true };
  return { landingIntentRoot, descriptor, proof, open, merged, input };
}

function inspectExact(f: ReturnType<typeof fixture>) {
  return inspectExactMergedLandingCheckpoint(f.landingIntentRoot, { descriptor: f.descriptor, mergeSha: oid('f'), mergeTree: oid('4'), mergeParents: [oid('1')] });
}

describe('release land drift and merged checkpoint', () => {
  test('freezes a readiness result across two exact provider and retired-proof observations', async () => {
    const f = fixture(); let providerReads = 0; let proofReads = 0;
    const ready = await inspectReleaseLandReadiness(f.input, {
      snapshotOpenProvider: async () => { providerReads++; return structuredClone(f.open); },
      inspectCurrentRetiredProof: () => { proofReads++; return structuredClone(f.proof); },
      resolveLandingIntent: async () => ({ descriptor: f.descriptor, intentId: landingIntentIdForDescriptor(f.descriptor) }),
    });
    expect(ready).toMatchObject({ schema: 'ecpe.release-land-readiness.v1', raw_intent_id: landingIntentIdForDescriptor(f.descriptor),
      retirement_id: f.proof.retirement_id, receipt_run_id: f.proof.receipt_run_id, expected_head_tree: oid('4') });
    expect(ready.readiness_id).toMatch(/^release-land-readiness-[0-9a-f]{32}$/);
    expect([providerReads, proofReads]).toEqual([2, 3]);
  });

  test('blocks readiness when the final remote head or release projection moves', async () => {
    const f = fixture(); let providerReads = 0;
    await expect(inspectReleaseLandReadiness(f.input, {
      snapshotOpenProvider: async () => ({ ...structuredClone(f.open), headRefOid: ++providerReads === 2 ? oid('9') : oid('2') }),
      inspectCurrentRetiredProof: () => structuredClone(f.proof),
      resolveLandingIntent: async () => ({ descriptor: f.descriptor, intentId: landingIntentIdForDescriptor(f.descriptor) }),
    })).rejects.toThrow('release_land_provider_drift');
    let proofReads = 0;
    await expect(inspectReleaseLandReadiness(f.input, {
      snapshotOpenProvider: async () => structuredClone(f.open),
      inspectCurrentRetiredProof: () => ({ ...structuredClone(f.proof), binding_sha256: ++proofReads === 2 ? hash('0') : f.proof.binding_sha256 }),
      resolveLandingIntent: async () => ({ descriptor: f.descriptor, intentId: landingIntentIdForDescriptor(f.descriptor) }),
    })).rejects.toThrow('release_land_projection_drift');

    proofReads = 0;
    await expect(inspectReleaseLandReadiness(f.input, {
      snapshotOpenProvider: async () => structuredClone(f.open),
      inspectCurrentRetiredProof: () => ({ ...structuredClone(f.proof), binding_sha256: ++proofReads === 3 ? hash('0') : f.proof.binding_sha256 }),
      resolveLandingIntent: async () => ({ descriptor: f.descriptor, intentId: landingIntentIdForDescriptor(f.descriptor) }),
    })).rejects.toThrow('release_land_projection_drift');
  });

  test('reconstructs one typed merged checkpoint from raw intent, historical release proof, and fresh live target', async () => {
    const f = fixture(); const intent = prepareLandingIntent(f.landingIntentRoot, f.descriptor);
    reconcileLandingIntent(f.landingIntentRoot, intent.intentId, { terminal: false, providerState: 'merged', headOid: oid('2'), baseOid: oid('1'),
      mergeSha: oid('f'), mergeTreeMatches: true, mergeTree: oid('4'), mergeParents: [oid('1')] });
    let providerReads = 0; let proofReads = 0;
    const checkpoint = await inspectMergedReleaseCheckpoint({ ...f.input, mergeSha: oid('f') }, {
      snapshotMergedProvider: async () => { providerReads++; return structuredClone(f.merged); },
      inspectHistoricalRetiredProof: () => { proofReads++; return structuredClone(f.proof); },
      inspectMergedRaw: () => inspectExact(f),
      resolveLandingIntent: async () => ({ descriptor: f.descriptor, intentId: intent.intentId }),
    });
    expect(checkpoint).toMatchObject({ schema: 'ecpe.merged-release-checkpoint.v1', raw_intent_id: intent.intentId,
      merge_sha: oid('f'), merge_tree: oid('4'), retirement_id: f.proof.retirement_id, receipt_run_id: f.proof.receipt_run_id,
      live_target_verified: true, reservation_retained: true });
    expect(checkpoint.checkpoint_id).toMatch(/^merged-release-[0-9a-f]{32}$/);
    expect([providerReads, proofReads]).toEqual([2, 3]);
  });

  test('rejects raw-only legacy checkpoint and post-merge target movement', async () => {
    const f = fixture(); const intent = prepareLandingIntent(f.landingIntentRoot, f.descriptor);
    reconcileLandingIntent(f.landingIntentRoot, intent.intentId, { terminal: false, providerState: 'merged', headOid: oid('2'), baseOid: oid('1'),
      mergeSha: oid('f'), mergeTreeMatches: true });
    await expect(inspectMergedReleaseCheckpoint({ ...f.input, mergeSha: oid('f') }, {
      snapshotMergedProvider: async () => structuredClone(f.merged), inspectHistoricalRetiredProof: () => structuredClone(f.proof),
      inspectMergedRaw: () => inspectExact(f),
      resolveLandingIntent: async () => ({ descriptor: f.descriptor, intentId: intent.intentId }),
    })).rejects.toThrow('landing_checkpoint_invalid');

    const other = fixture(); const exact = prepareLandingIntent(other.landingIntentRoot, other.descriptor);
    reconcileLandingIntent(other.landingIntentRoot, exact.intentId, { terminal: false, providerState: 'merged', headOid: oid('2'), baseOid: oid('1'),
      mergeSha: oid('f'), mergeTreeMatches: true, mergeTree: oid('4'), mergeParents: [oid('1')] });
    let reads = 0;
    await expect(inspectMergedReleaseCheckpoint({ ...other.input, mergeSha: oid('f') }, {
      snapshotMergedProvider: async () => ({ ...structuredClone(other.merged), liveTargetOid: ++reads === 2 ? oid('6') : oid('f') }),
      inspectHistoricalRetiredProof: () => structuredClone(other.proof),
      inspectMergedRaw: () => inspectExact(other),
      resolveLandingIntent: async () => ({ descriptor: other.descriptor, intentId: exact.intentId }),
    })).rejects.toThrow('merged_release_checkpoint_drift');
  });

  test('rechecks local proof and raw checkpoint after the final merged provider observation', async () => {
    const f = fixture(); const intent = prepareLandingIntent(f.landingIntentRoot, f.descriptor);
    reconcileLandingIntent(f.landingIntentRoot, intent.intentId, { terminal: false, providerState: 'merged', headOid: oid('2'), baseOid: oid('1'),
      mergeSha: oid('f'), mergeTreeMatches: true, mergeTree: oid('4'), mergeParents: [oid('1')] });
    let proofReads = 0;
    await expect(inspectMergedReleaseCheckpoint({ ...f.input, mergeSha: oid('f') }, {
      snapshotMergedProvider: async () => structuredClone(f.merged),
      inspectHistoricalRetiredProof: () => ({ ...structuredClone(f.proof), binding_sha256: ++proofReads === 3 ? hash('0') : f.proof.binding_sha256 }),
      inspectMergedRaw: () => inspectExact(f),
      resolveLandingIntent: async () => ({ descriptor: f.descriptor, intentId: intent.intentId }),
    })).rejects.toThrow('merged_release_checkpoint_drift');

    let rawReads = 0;
    await expect(inspectMergedReleaseCheckpoint({ ...f.input, mergeSha: oid('f') }, {
      snapshotMergedProvider: async () => structuredClone(f.merged),
      inspectHistoricalRetiredProof: () => structuredClone(f.proof),
      inspectMergedRaw: () => ({ ...inspectExact(f), binding_sha256: ++rawReads === 3 ? hash('0') : inspectExact(f).binding_sha256 }),
      resolveLandingIntent: async () => ({ descriptor: f.descriptor, intentId: intent.intentId }),
    })).rejects.toThrow('merged_release_checkpoint_drift');
  });
});
