import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareLandingIntent, reconcileLandingIntent } from '../lib/landing-safety';
import {
  appendCanaryComparison,
  bindCanaryFocusedComparison,
  claimCanaryFocusedRun,
  createCanaryPending,
  inspectCanarySampleCandidate,
  inspectCanaryWindow,
  prepareCanaryControl,
  reconcileCanarySampleLanding,
  resolveCanaryExecutionGate,
  startCanaryControl,
  terminalCanaryControl,
} from '../lib/lane-canary';
import { startMilestoneBlock, stopMilestoneBlock } from '../lib/milestone-block';

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

const lane = 'single_repo_code' as const;
const repoId = 'portfolioops';
const profileHash = 'a'.repeat(64);
const repositoryNodeId = 'R_repo_1';
const base = '2'.repeat(40);
const head = '3'.repeat(40);
const tree = '4'.repeat(40);
const receiptId = `evidence-${'5'.repeat(32)}`;

function pendingSample(stateRoot: string, legacyControlOutcome: 'pass' | 'ambiguous' = 'pass') {
  const started = startMilestoneBlock({ stateRoot, roots: { code_root_id: 'code', workspace_root_id: 'workspace', state_root_id: 'state' }, codeRootHead: 'b'.repeat(40), registryHash: 'c'.repeat(64), duration: 'P30D', participants: ['harness-governance', 'portfolioops', 'cdo-os'], lanes: ['docs_ux', 'single_repo_code', 'cross_repo_contract'] });
  const blockId = started.block.block_id;
  const policyHash = started.block.policy_hash;
  createCanaryPending({ stateRoot, repoId, lane, profileHash, promotionProofId: `promotion-${'6'.repeat(32)}`, promotionRecordId: `promotion-write-${'7'.repeat(32)}`, promotionLandingIntentId: `landing-${'8'.repeat(32)}`, promotionCheckpointId: `checkpoint-${'9'.repeat(32)}`, promotionReceiptId: `evidence-${'a'.repeat(32)}` });
  const binding = { stateRoot, repoId, lane, profileHash, blockId, participant: 'portfolioops' as const, subjectHead: head, subjectTree: tree, hostFingerprint: 'host-a', policyHash };
  const claim = claimCanaryFocusedRun(binding);
  const focusedRunId = claim.focused_run_id!;
  prepareCanaryControl({ ...binding, focusedRunId });
  startCanaryControl({ ...binding, focusedRunId });
  terminalCanaryControl({ ...binding, focusedRunId, measurement: { outcome: 'pass', durationMs: 100, contextBytes: 100, helperSpawns: 1, modelSpawns: 0, unauthorizedEffects: 0, tokens: { total: null, provenance: 'unknown' } } });
  const appended = appendCanaryComparison({ stateRoot, repoId, lane, profileHash, comparison: { source_block_id: blockId, subject_head: head, subject_tree: tree, focused_run_id: focusedRunId, legacy_control_run_id: `control-${'d'.repeat(32)}`, policy_hash: policyHash, host_fingerprint: 'host-a', class: 'efficiency_inconclusive', focused_duration_ms: null, legacy_duration_ms: 100, focused_context_bytes: null, legacy_context_bytes: 100, focused_spawns: null, legacy_spawns: 1, focused_tokens: null, legacy_tokens: null, token_provenance: 'unknown', focused_outcome: 'pass', legacy_control_outcome: legacyControlOutcome } });
  const sampleId = appended.comparison_ids[0];
  bindCanaryFocusedComparison({ ...binding, focusedRunId, comparisonId: sampleId });
  return { blockId, policyHash, focusedRunId, sampleId };
}

function handoff(sample: ReturnType<typeof pendingSample>) {
  return { current: true as const, receipt_run_id: receiptId, repo_id: repoId, pr: 17, base_ref: 'origin/main', base_sha: base, remote_pr_head_sha: head, remote_pr_head_tree: tree, profile_hash: profileHash, canary_subject: { block_id: sample.blockId, lane, focused_run_id: sample.focusedRunId, profile_hash: profileHash, promotion_proof_id: `promotion-${'6'.repeat(32)}`, subject_head: head, subject_tree: tree, policy_hash: sample.policyHash } };
}

function checkpointedProvider(providerIntentRoot: string) {
  let mutations = 0;
  let intentId = '';
  const descriptor = { repoId: 'github.com/example/portfolioops', repositoryNodeId, prNumber: 17, expectedHeadOid: head, expectedBaseOid: base, targetRef: 'origin/main' as const, mode: 'direct_observed' as const, providerOperationId: 'github.com:direct-pr:17' };
  return { mutations: () => mutations, intentId: () => intentId, run: async () => { const intent = prepareLandingIntent(providerIntentRoot, descriptor); intentId = intent.intentId; if (intent.phase !== 'checkpointed') { mutations += 1; reconcileLandingIntent(providerIntentRoot, intent.intentId, { terminal: false, providerState: 'merged', headOid: head, baseOid: base, mergeSha: 'd'.repeat(40), mergeTreeMatches: true }); } return { status: 'merged' as const, mergeSha: 'd'.repeat(40), expectedHeadOid: head, expectedBaseOid: base, intentId: intent.intentId, baseAtomicity: 'verified' as const }; } };
}

describe('canary sample landing reconciler', () => {
  test('checkpoints a safety-clean non-activating sample without opening profile execution', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'canary-sample-state-')); roots.push(stateRoot);
    const providerIntentRoot = mkdtempSync(join(tmpdir(), 'canary-sample-provider-')); roots.push(providerIntentRoot);
    const sample = pendingSample(stateRoot);
    expect(inspectCanarySampleCandidate({ stateRoot, repoId, lane, profileHash, blockId: sample.blockId, subjectHead: head, subjectTree: tree })).toMatchObject({ sample_id: sample.sampleId, focused_run_id: sample.focusedRunId });
    const provider = checkpointedProvider(providerIntentRoot);
    const result = await reconcileCanarySampleLanding({ stateRoot, providerIntentRoot, repoId, lane, profileHash, blockId: sample.blockId, sampleId: sample.sampleId, handoff: handoff(sample), expectedRepositoryNodeId: repositoryNodeId, mergeProvider: provider.run });
    expect(result).toMatchObject({ result: 'checkpointed', phase: 'pending', sample_id: sample.sampleId, execution_allowed: false });
    expect(result.sample_checkpoint_id).toMatch(/^sample-checkpoint-[0-9a-f]{32}$/);
    expect(inspectCanaryWindow({ stateRoot, repoId, lane, profileHash })).toMatchObject({ phase: 'pending', sample_count: 1, execution_allowed: false, sample_landing_checkpoints: [{ comparison_id: sample.sampleId, checkpoint_id: result.sample_checkpoint_id, receipt_id: receiptId }] });
    expect(resolveCanaryExecutionGate({ stateRoot, repoId, lane, profileHash })).toMatchObject({ execution_allowed: false, reason: 'canary_pending' });
    expect(provider.mutations()).toBe(1);
    expect(await reconcileCanarySampleLanding({ stateRoot, providerIntentRoot, repoId, lane, profileHash, blockId: sample.blockId, sampleId: sample.sampleId, handoff: handoff(sample), expectedRepositoryNodeId: repositoryNodeId, mergeProvider: provider.run })).toMatchObject({ result: 'reused', sample_checkpoint_id: result.sample_checkpoint_id });
    expect(provider.mutations()).toBe(1);
  });

  for (const boundary of ['sample_landing_intent', 'provider_merge', 'sample_checkpointed', 'response'] as const) {
    test(`recovers after ${boundary} without a second provider mutation`, async () => {
      const stateRoot = mkdtempSync(join(tmpdir(), 'canary-sample-state-')); roots.push(stateRoot);
      const providerIntentRoot = mkdtempSync(join(tmpdir(), 'canary-sample-provider-')); roots.push(providerIntentRoot);
      const sample = pendingSample(stateRoot); const provider = checkpointedProvider(providerIntentRoot); let crashed = false;
      const input = { stateRoot, providerIntentRoot, repoId, lane, profileHash, blockId: sample.blockId, sampleId: sample.sampleId, handoff: handoff(sample), expectedRepositoryNodeId: repositoryNodeId, mergeProvider: provider.run };
      await expect(reconcileCanarySampleLanding({ ...input, fault: (phase) => { if (!crashed && phase === boundary) { crashed = true; throw new Error(`crash:${phase}`); } } })).rejects.toThrow(`crash:${boundary}`);
      const recovered = await reconcileCanarySampleLanding(input);
      expect(recovered).toMatchObject({ phase: 'pending', sample_id: sample.sampleId, execution_allowed: false });
      expect(provider.mutations()).toBe(1);
    });
  }

  test('wrong sample lineage and inactive block fail before provider mutation', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'canary-sample-state-')); roots.push(stateRoot);
    const providerIntentRoot = mkdtempSync(join(tmpdir(), 'canary-sample-provider-')); roots.push(providerIntentRoot);
    const sample = pendingSample(stateRoot); const provider = checkpointedProvider(providerIntentRoot);
    const input = { stateRoot, providerIntentRoot, repoId, lane, profileHash, blockId: sample.blockId, sampleId: sample.sampleId, handoff: handoff(sample), expectedRepositoryNodeId: repositoryNodeId, mergeProvider: provider.run };
    await expect(reconcileCanarySampleLanding({ ...input, sampleId: `comparison-${'f'.repeat(32)}` })).rejects.toThrow('canary_sample_not_pending');
    stopMilestoneBlock({ stateRoot, roots: { code_root_id: 'code', workspace_root_id: 'workspace', state_root_id: 'state' }, blockId: sample.blockId, reason: 'aborted' });
    await expect(reconcileCanarySampleLanding(input)).rejects.toThrow('milestone_activation_block_invalid');
    expect(provider.mutations()).toBe(0);
  });

  test('an ambiguous control can never become a canary-based landing assertion', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'canary-sample-state-')); roots.push(stateRoot);
    const sample = pendingSample(stateRoot, 'ambiguous');
    expect(() => inspectCanarySampleCandidate({ stateRoot, repoId, lane, profileHash, blockId: sample.blockId, subjectHead: head, subjectTree: tree })).toThrow('canary_sample_candidate_missing');
  });

  test('a missing canonical provider checkpoint fails closed without another merge call', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'canary-sample-state-')); roots.push(stateRoot);
    const providerIntentRoot = mkdtempSync(join(tmpdir(), 'canary-sample-provider-')); roots.push(providerIntentRoot);
    const sample = pendingSample(stateRoot); const provider = checkpointedProvider(providerIntentRoot); let calls = 0;
    const input = { stateRoot, providerIntentRoot, repoId, lane, profileHash, blockId: sample.blockId, sampleId: sample.sampleId, handoff: handoff(sample), expectedRepositoryNodeId: repositoryNodeId, mergeProvider: async () => { calls += 1; return provider.run(); } };
    await reconcileCanarySampleLanding(input);
    expect(calls).toBe(1); expect(provider.mutations()).toBe(1);
    rmSync(join(providerIntentRoot, `${provider.intentId()}.json`));
    await expect(reconcileCanarySampleLanding(input)).rejects.toThrow('canary_provider_checkpoint_invalid');
    expect(calls).toBe(1); expect(provider.mutations()).toBe(1);
  });
});
