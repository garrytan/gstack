import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectExactMergedLandingCheckpoint, prepareLandingIntent, reconcileLandingIntent } from '../lib/landing-safety';
import { admitMergedDelivery } from '../lib/merged-delivery';
import {
  appendCanaryComparison,
  createCanaryPending,
  inspectCanaryWindow,
  inspectCanaryActivationCandidate,
  resolveCanaryExecutionGate,
} from '../lib/lane-canary';
import { reconcileCanaryActivationLanding } from '../lib/lane-canary-activation';
import { recordCanarySafetyStop, startMilestoneBlock, stopMilestoneBlock } from '../lib/milestone-block';

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
const stateRootId=`state_${'6'.repeat(32)}`;

function readyState(stateRoot: string) {
  const started = startMilestoneBlock({ stateRoot, roots: { code_root_id: 'code', workspace_root_id: 'workspace', state_root_id: stateRootId }, codeRootHead: 'b'.repeat(40), registryHash: 'c'.repeat(64), duration: 'P30D', participants: ['harness-governance', 'portfolioops', 'cdo-os'], lanes: ['docs_ux', 'single_repo_code', 'cross_repo_contract'] });
  const blockId = started.block.block_id; const policyHash = started.block.policy_hash;
  createCanaryPending({
    stateRoot, repoId, lane, profileHash,
    promotionProofId: `promotion-${'6'.repeat(32)}`,
    promotionRecordId: `promotion-write-${'7'.repeat(32)}`,
    promotionLandingIntentId: `landing-${'8'.repeat(32)}`,
    promotionCheckpointId: `checkpoint-${'9'.repeat(32)}`,
    promotionReceiptId: `evidence-${'a'.repeat(32)}`,
  });
  const sample = (subjectHead: string, subjectTree: string) => ({
    source_block_id: blockId,
    subject_head: subjectHead,
    subject_tree: subjectTree,
    focused_run_id: `focused-${subjectHead.slice(0, 32)}`,
    legacy_control_run_id: `control-${subjectHead.slice(0, 32)}`,
    policy_hash: policyHash,
    host_fingerprint: 'host-a',
    class: 'passed' as const,
    focused_duration_ms: 80,
    legacy_duration_ms: 100,
    focused_context_bytes: 80,
    legacy_context_bytes: 100,
    focused_spawns: 1,
    legacy_spawns: 1,
    focused_tokens: null,
    legacy_tokens: null,
    token_provenance: 'unknown' as const,
  });
  appendCanaryComparison({ stateRoot, repoId, lane, profileHash, comparison: sample('1'.repeat(40), 'd'.repeat(40)) });
  appendCanaryComparison({ stateRoot, repoId, lane, profileHash, comparison: sample('2'.repeat(40), 'e'.repeat(40)) });
  return { ...appendCanaryComparison({ stateRoot, repoId, lane, profileHash, comparison: sample(head, tree) }), test_block_id: blockId, test_policy_hash: policyHash };
}

function handoff(ready: ReturnType<typeof readyState>) {
  return {
    current: true as const,
    receipt_run_id: receiptId,
    repo_id: repoId,
    pr: 17,
    base_ref: 'origin/main',
    base_sha: base,
    remote_pr_head_sha: head,
    remote_pr_head_tree: tree,
    profile_hash: profileHash,
    manifest_hash: 'f'.repeat(64),
    review_run_ids: [],
    validation_run_ids: [],
    release_decision: { applicable: false, mode: 'none' as const, version: null, title_policy: 'free' as const },
    candidate_profile: null,
    promotion: null,
    canary_subject: {
      block_id: ready.test_block_id,
      lane,
      focused_run_id: `focused-${head.slice(0, 32)}`,
      profile_hash: profileHash,
      promotion_proof_id: `promotion-${'6'.repeat(32)}`,
      subject_head: head,
      subject_tree: tree,
      policy_hash: ready.test_policy_hash,
    },
  };
}

function checkpointedProvider(providerIntentRoot: string,stateRoot?:string) {
  let mutations = 0;
  let rawIntentId = '';
  const descriptor = {
    repoId: 'github.com/example/portfolioops', repositoryNodeId, prNumber: 17,
    expectedHeadOid: head, expectedBaseOid: base, targetRef: 'origin/main' as const,
    mode: 'direct_observed' as const, providerOperationId: 'github.com:direct-pr:17',
  };
  return {
    mutations: () => mutations,
    intentId: () => rawIntentId,
    run: async () => {
      const intent = prepareLandingIntent(providerIntentRoot, descriptor);
      rawIntentId = intent.intentId;
      if (intent.phase !== 'checkpointed') {
        mutations += 1;
        reconcileLandingIntent(providerIntentRoot, intent.intentId, {
          terminal: false, providerState: 'merged', headOid: head, baseOid: base,
          mergeSha: 'd'.repeat(40), mergeTreeMatches: true,mergeTree:tree,mergeParents:[base],
        });
      }
      const raw = {
        status: 'merged' as const, mergeSha: 'd'.repeat(40), expectedHeadOid: head,
        expectedBaseOid: base, intentId: intent.intentId, baseAtomicity: 'verified' as const,
        providerBaseAtomicity: 'observed_only' as const,
        deliveryReceiptId: `merged-delivery-${'6'.repeat(32)}`,
        deliveryReceiptBindingSha256: '7'.repeat(64),
        landingCheckpointId: '8'.repeat(64),
        landingCheckpointBindingSha256: '9'.repeat(64),
        releaseDriftStatus: 'not_applicable' as const,
        shipReceiptId: receiptId,
      };
      if(!stateRoot)return raw;
      const ship={...handoff({test_block_id:'block-placeholder',test_policy_hash:'policy'} as any),state_root_id:stateRootId,repo_id:descriptor.repoId,provider_identity:{repository_node_id:repositoryNodeId,repository_name_with_owner:'example/portfolioops',head_repository_node_id:repositoryNodeId,head_repository_name_with_owner:'example/portfolioops',head_ref_name:'feature'},release_write:null};
      const landing=inspectExactMergedLandingCheckpoint(providerIntentRoot,{descriptor,mergeSha:raw.mergeSha,mergeTree:tree,mergeParents:[base]});
      const provider={providerState:'MERGED' as const,repositoryNameWithOwner:'example/portfolioops',repositoryNodeId,headRepositoryNameWithOwner:'example/portfolioops',headRepositoryNodeId:repositoryNodeId,headRefName:'feature',targetRef:'origin/main',expectedHeadOid:head,expectedBaseOid:base,mergeSha:raw.mergeSha,mergeTree:tree,liveTargetOid:raw.mergeSha,baseParentVerified:true as const,headTreeVerified:true as const,liveTargetVerified:true as const};
      const receipt=await admitMergedDelivery({stateRoot,stateRootId,cwd:'/fixture',descriptor,shipReceiptId:receiptId,headRepositoryNodeId:repositoryNodeId,headRefName:'feature',expectedHeadTree:tree,mergeSha:raw.mergeSha},{inspectShip:()=>ship,inspectLanding:()=>landing,snapshotMerged:async()=>provider});
      return{...raw,deliveryReceiptId:receipt.receipt_id,deliveryReceiptBindingSha256:receipt.binding_sha256,landingCheckpointId:receipt.landing_checkpoint.checkpoint_id,landingCheckpointBindingSha256:receipt.landing_checkpoint.binding_sha256,releaseDriftStatus:receipt.release.drift_status};
    },
  };
}

describe('canary activation landing reconciler', () => {
  test('ready proof alone never permits focused execution or fabricated activation', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'canary-activation-state-')); roots.push(stateRoot);
    const providerIntentRoot = mkdtempSync(join(tmpdir(), 'canary-provider-intent-')); roots.push(providerIntentRoot);
    const ready = readyState(stateRoot);
    expect(ready).toMatchObject({ phase: 'aggregate_ready', execution_allowed: false });
    expect(resolveCanaryExecutionGate({ stateRoot, repoId, lane, profileHash })).toMatchObject({ execution_allowed: false });
    await expect(reconcileCanaryActivationLanding({
      stateRoot, providerIntentRoot, repoId, lane, profileHash, blockId: ready.test_block_id,
      activationProofId: ready.activation_proof_id!, handoff: handoff(ready),
      expectedRepositoryNodeId: repositoryNodeId,
      mergeProvider: async () => ({ status: 'merged' as const, mergeSha: 'd'.repeat(40), expectedHeadOid: head, expectedBaseOid: base, intentId: 'e'.repeat(64), baseAtomicity: 'verified' as const }),
    })).rejects.toThrow('canary_provider_checkpoint_invalid');
    expect(resolveCanaryExecutionGate({ stateRoot, repoId, lane, profileHash })).toMatchObject({ execution_allowed: false });
  });

  test('binds the exact proof-bearing receipt and canonical provider checkpoint before supersession', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'canary-activation-state-')); roots.push(stateRoot);
    const providerIntentRoot = mkdtempSync(join(tmpdir(), 'canary-provider-intent-')); roots.push(providerIntentRoot);
    const ready = readyState(stateRoot);
    const provider = checkpointedProvider(providerIntentRoot);
    const result = await reconcileCanaryActivationLanding({
      stateRoot, providerIntentRoot, repoId, lane, profileHash, blockId: ready.test_block_id,
      activationProofId: ready.activation_proof_id!, handoff: handoff(ready),
      expectedRepositoryNodeId: repositoryNodeId, mergeProvider: provider.run,
    });
    expect(result).toMatchObject({ phase: 'pending_superseded', execution_allowed: true, activation_proof_id: ready.activation_proof_id, activation_receipt_id: receiptId });
    expect(result.activation_landing_intent_id).toMatch(/^landing-[0-9a-f]{32}$/);
    expect(result.activation_checkpoint_id).toMatch(/^checkpoint-[0-9a-f]{32}$/);
    expect(provider.mutations()).toBe(1);
    expect(resolveCanaryExecutionGate({ stateRoot, repoId, lane, profileHash })).toMatchObject({ execution_allowed: true, reason: null });
    rmSync(join(providerIntentRoot, `${provider.intentId()}.json`));
    expect(resolveCanaryExecutionGate({ stateRoot, repoId, lane, profileHash })).toMatchObject({ execution_allowed: false, reason: 'canary_pending' });
    await expect(reconcileCanaryActivationLanding({
      stateRoot, providerIntentRoot, repoId, lane, profileHash, blockId: ready.test_block_id,
      activationProofId: ready.activation_proof_id!, handoff: handoff(ready), expectedRepositoryNodeId: repositoryNodeId,
      mergeProvider: async () => { throw new Error('must_not_merge'); },
    })).rejects.toThrow('canary_activation_record_invalid');
  });

  for (const boundary of ['activation_landing_intent', 'provider_merge', 'activation_checkpointed', 'pending_superseded', 'response'] as const) {
    test(`recovers after ${boundary} without a second provider mutation`, async () => {
      const stateRoot = mkdtempSync(join(tmpdir(), 'canary-activation-state-')); roots.push(stateRoot);
      const providerIntentRoot = mkdtempSync(join(tmpdir(), 'canary-provider-intent-')); roots.push(providerIntentRoot);
      const ready = readyState(stateRoot);
      const provider = checkpointedProvider(providerIntentRoot);
      let crashed = false;
      const input = {
        stateRoot, providerIntentRoot, repoId, lane, profileHash, blockId: ready.test_block_id,
        activationProofId: ready.activation_proof_id!, handoff: handoff(ready),
        expectedRepositoryNodeId: repositoryNodeId, mergeProvider: provider.run,
      };
      await expect(reconcileCanaryActivationLanding({ ...input, fault: (phase) => { if (!crashed && phase === boundary) { crashed = true; throw new Error(`crash:${phase}`); } } })).rejects.toThrow(`crash:${boundary}`);
      if (boundary === 'activation_landing_intent') expect(inspectCanaryWindow({ stateRoot, repoId, lane, profileHash }).phase).toBe('activation_landing_intent');
      if (boundary === 'activation_checkpointed') {
        expect(inspectCanaryWindow({ stateRoot, repoId, lane, profileHash })).toMatchObject({ phase: 'activation_checkpointed', execution_allowed: false });
      }
      expect(inspectCanaryActivationCandidate({ stateRoot, repoId, lane, profileHash, blockId: ready.test_block_id, subjectHead: head, subjectTree: tree })).toMatchObject({ proof_id: ready.activation_proof_id, block_id: ready.test_block_id });
      const recovered = await reconcileCanaryActivationLanding(input);
      expect(recovered).toMatchObject({ phase: 'pending_superseded', execution_allowed: true, activation_proof_id: ready.activation_proof_id });
      expect(provider.mutations()).toBe(1);
      expect(await reconcileCanaryActivationLanding(input)).toMatchObject({ result: 'reused', state_id: recovered.state_id, activation_checkpoint_id: recovered.activation_checkpoint_id });
      expect(provider.mutations()).toBe(1);
    });
  }

  test('wrong proof, wrong receipt lineage, and record-only merge state fail closed', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'canary-activation-state-')); roots.push(stateRoot);
    const providerIntentRoot = mkdtempSync(join(tmpdir(), 'canary-provider-intent-')); roots.push(providerIntentRoot);
    const ready = readyState(stateRoot);
    const provider = checkpointedProvider(providerIntentRoot);
    const baseInput = { stateRoot, providerIntentRoot, repoId, lane, profileHash, blockId: ready.test_block_id, activationProofId: ready.activation_proof_id!, expectedRepositoryNodeId: repositoryNodeId, mergeProvider: provider.run };
    await expect(reconcileCanaryActivationLanding({ ...baseInput, activationProofId: `canary-ready-${'f'.repeat(32)}`, handoff: handoff(ready) })).rejects.toThrow('canary_activation_not_ready');
    await expect(reconcileCanaryActivationLanding({ ...baseInput, handoff: { ...handoff(ready), remote_pr_head_sha: '0'.repeat(40) } })).rejects.toThrow('canary_activation_lineage_mismatch');
    expect(provider.mutations()).toBe(0);
    expect(resolveCanaryExecutionGate({ stateRoot, repoId, lane, profileHash })).toMatchObject({ execution_allowed: false });
    stopMilestoneBlock({ stateRoot, roots: { code_root_id: 'code', workspace_root_id: 'workspace', state_root_id: stateRootId }, blockId: ready.test_block_id, reason: 'aborted' });
    await expect(reconcileCanaryActivationLanding({ ...baseInput, handoff: handoff(ready) })).rejects.toThrow('milestone_activation_block_invalid');
    expect(provider.mutations()).toBe(0);
  });

  test('reconciles an exact accepted activation after a safety latch without enabling execution',async()=>{
    const stateRoot=mkdtempSync(join(tmpdir(),'canary-activation-state-'));roots.push(stateRoot);const providerIntentRoot=mkdtempSync(join(tmpdir(),'canary-provider-intent-'));roots.push(providerIntentRoot);const ready=readyState(stateRoot);const provider=checkpointedProvider(providerIntentRoot,stateRoot);const raw=prepareLandingIntent(providerIntentRoot,{repoId:'github.com/example/portfolioops',repositoryNodeId,prNumber:17,expectedHeadOid:head,expectedBaseOid:base,targetRef:'origin/main',mode:'direct_observed',providerOperationId:'github.com:direct-pr:17'});const milestoneLanding={kind:'canary_activation' as const,participant:'portfolioops' as const,repositoryNodeId,prNumber:17,expectedHeadOid:head,expectedBaseOid:base,targetRef:'origin/main',subjectTree:tree,rawProviderIntentId:raw.intentId,shipReceiptId:receiptId,lanes:[lane] as const};const input={stateRoot,providerIntentRoot,repoId,lane,profileHash,blockId:ready.test_block_id,activationProofId:ready.activation_proof_id!,handoff:handoff(ready),expectedRepositoryNodeId:repositoryNodeId,mergeProvider:provider.run,milestoneLanding};
    await expect(reconcileCanaryActivationLanding({...input,fault:phase=>{if(phase==='provider_merge')throw new Error('crash:provider_merge')}})).rejects.toThrow('crash:provider_merge');
    const comparison={comparison_id:`comparison-${'1'.repeat(32)}`,source_block_id:ready.test_block_id,focused_run_id:`focused-${'2'.repeat(32)}`,legacy_control_run_id:`control-${'3'.repeat(32)}`,subject_head:'4'.repeat(40),subject_tree:'5'.repeat(40),policy_hash:ready.test_policy_hash,class:'safety_regressed' as const,ordinal:1};const activations={docs_ux:{activation:'enforce' as const,profile_lineage_hash:'6'.repeat(64)},single_repo_code:{activation:'enforce' as const,profile_lineage_hash:'7'.repeat(64)},cross_repo_contract:{activation:'enforce' as const,profile_lineage_hash:'8'.repeat(64)}};recordCanarySafetyStop({stateRoot,blockId:ready.test_block_id,participant:'portfolioops',causeLane:'docs_ux',comparison,activations,profileBlobSha:'9'.repeat(40)});
    expect(()=>inspectCanaryActivationCandidate({stateRoot,repoId,lane,profileHash,blockId:ready.test_block_id,subjectHead:head,subjectTree:tree})).toThrow('canary_safety_latched');
    expect(inspectCanaryActivationCandidate({stateRoot,repoId,lane,profileHash,blockId:ready.test_block_id,subjectHead:head,subjectTree:tree,reconcileOnly:true})).toMatchObject({proof_id:ready.activation_proof_id});
    const recovered=await reconcileCanaryActivationLanding({...input,reconcileOnly:true});expect(recovered).toMatchObject({result:'checkpointed_terminal',execution_allowed:false});expect(resolveCanaryExecutionGate({stateRoot,repoId,lane,profileHash})).toMatchObject({phase:'safety_latched',execution_allowed:false});expect(provider.mutations()).toBe(1);
  });
});
