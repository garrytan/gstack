import { resolveEffectScope } from '../../lib/effect-scope';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendJsonl } from '../../lib/jsonl-store';
import { directMergeProviderHead, discoverDirectMergeProviderHead, reconcileDirectMergeProviderHead, resolveDirectMergeLandingIntent, assertProviderHeadSnapshot, resolveProviderLandingIntentRoot, snapshotProviderHead } from '../../lib/provider-access';
import { discoverProviderPr, executeGitPush, executeGitStageCommit, executeProviderComment, executeProviderPr, executeRollback, prepareDocumentRelease, finishDocumentRelease } from '../../lib/closed-effect-adapters';
import { ProcessLocalGrant, type GovernedSkill } from '../../lib/effect-scope';
import { cancelTerminalLanding } from '../../lib/terminal-landing-cancel';
import { resolveTrustedWorkProfile } from '../../lib/trusted-base';
import { buildChangeManifest } from '../../lib/change-manifest';
import { resolveManifestLane } from '../../lib/execution-plan';
import { resolveProfileValidatorBinding } from '../../lib/profile-validator-binding';
import { ensureValidator, type TrustedValidatorBinding } from '../../lib/validator-runner';
import { withRemoteHead } from '../../lib/remote-head-validation';
import type { EvidenceRecordV2 } from '../../lib/evidence-envelope';
import { abandonRecordingProjection } from '../../lib/milestone-close-journal';
import { resolveRuntimeStateRoot } from '../../lib/canonical-state-root';
import { applyProfilePromotion } from '../../lib/profile-promotion-writer';
import { applyProfileDowngrade } from '../../lib/profile-downgrade-writer';
import { inspectAssertedShipHandoff } from '../../lib/ship-handoff';
import { createPromotionCanaryPending } from '../../lib/promotion-landing';
import { LANES, type Lane } from '../../lib/work-profile';
import { inspectCanaryActivationCandidate, inspectCanarySampleCandidate, inspectCanaryWindow, reconcileCanaryActivationLanding, reconcileCanarySampleLanding } from '../../lib/lane-canary';
import { resolveProjectIdentity } from '../../lib/project-identity';
import { findMilestoneLandingById, findMilestoneLandingByRawIntent, withMilestoneLandingJournal, type DurableMilestoneLanding, type MilestoneLandingDescriptor } from '../../lib/milestone-block';
import { admitMergedDelivery, findMergedDeliveryByRawIntent, type MergedDeliveryReceipt } from '../../lib/merged-delivery';
import { inspectReleaseLandReadiness } from '../../lib/release-landing';
import { inspectHistoricalRetiredReleaseLandingProof } from '../../lib/release-metadata';
import { landingIntentIdForDescriptor } from '../../lib/landing-safety';
import { assertEcpeAuthorityPlatform } from '../../lib/ecpe-platform';
import { inspectGitBaseSync, executeGitBaseSync } from '../../lib/git-base-sync-adapter';

function fail(message: string, status = 2): never { console.error(JSON.stringify({ error: message })); process.exit(status); }
try { assertEcpeAuthorityPlatform(); } catch (error) { fail(error instanceof Error ? error.message : 'ecpe_native_windows_unsupported', 1); }
function replayMilestoneLanding(landing:DurableMilestoneLanding):MilestoneLandingDescriptor{return{kind:landing.kind,participant:landing.participant,repositoryNodeId:landing.repository_node_id,prNumber:landing.pr,expectedHeadOid:landing.expected_head_oid,expectedBaseOid:landing.expected_base_oid,targetRef:landing.target_ref,subjectTree:landing.subject_tree,rawProviderIntentId:landing.raw_provider_intent_id,shipReceiptId:landing.ship_receipt_id,lanes:landing.lanes as Lane[]}}
function admittedMilestoneResult(receipt:MergedDeliveryReceipt){return{status:'merged' as const,mergeSha:receipt.merge_sha,expectedHeadOid:receipt.expected_head_oid,expectedBaseOid:receipt.expected_base_oid,intentId:receipt.raw_intent_id,baseAtomicity:'verified' as const,providerBaseAtomicity:'observed_only' as const,deliveryReceiptId:receipt.receipt_id,deliveryReceiptBindingSha256:receipt.binding_sha256,landingCheckpointId:receipt.landing_checkpoint.checkpoint_id,landingCheckpointBindingSha256:receipt.landing_checkpoint.binding_sha256,releaseDriftStatus:receipt.release.drift_status,shipReceiptId:receipt.ship_receipt_id}}
async function mergeAndAdmit(input:{stateRoot:string;handoff:Extract<ReturnType<typeof inspectAssertedShipHandoff>,{current:true}>;descriptor:Awaited<ReturnType<typeof resolveDirectMergeLandingIntent>>['descriptor'];subjectTree:string;lane:Lane;reconcileOnly:boolean;provider:()=>Promise<any>}){
  const prior=findMergedDeliveryByRawIntent(input.stateRoot,landingIntentIdForDescriptor(input.descriptor));
  if(prior)return admittedMilestoneResult(prior);
  const releaseRequested=input.handoff.release_decision.mode==='required_on_release'&&input.handoff.release_decision.applicable;
  if(input.handoff.release_decision.applicable&&!input.reconcileOnly){
    const proof=inspectHistoricalRetiredReleaseLandingProof({cwd:process.cwd(),lane:input.lane,releaseRequested,assertTargetRef:input.descriptor.targetRef,pr:input.descriptor.prNumber,expectedBase:input.descriptor.expectedBaseOid,remotePrHead:input.descriptor.expectedHeadOid,stateRootId:input.handoff.state_root_id,repositoryNodeId:input.descriptor.repositoryNodeId,headRepositoryNodeId:input.handoff.provider_identity.head_repository_node_id,headRefName:input.handoff.provider_identity.head_ref_name,stateHome:input.stateRoot,expectedHeadTree:input.subjectTree,receiptRunId:input.handoff.receipt_run_id});
    await inspectReleaseLandReadiness({cwd:process.cwd(),lane:input.lane,releaseRequested,assertTargetRef:input.descriptor.targetRef,pr:input.descriptor.prNumber,expectedBase:input.descriptor.expectedBaseOid,remotePrHead:input.descriptor.expectedHeadOid,stateRootId:input.handoff.state_root_id,repositoryNodeId:input.descriptor.repositoryNodeId,headRepositoryNodeId:input.handoff.provider_identity.head_repository_node_id,headRefName:input.handoff.provider_identity.head_ref_name,stateHome:input.stateRoot,expectedHeadTree:input.subjectTree,receiptRunId:input.handoff.receipt_run_id,retirementId:proof.retirement_id});
  }
  const raw=await input.provider();if(raw.status!=='merged')throw new Error('provider_merge_incomplete');
  const receipt=await admitMergedDelivery({stateRoot:input.stateRoot,stateRootId:input.handoff.state_root_id,cwd:process.cwd(),descriptor:input.descriptor,shipReceiptId:input.handoff.receipt_run_id,headRepositoryNodeId:input.handoff.provider_identity.head_repository_node_id,headRefName:input.handoff.provider_identity.head_ref_name,expectedHeadTree:input.subjectTree,mergeSha:raw.mergeSha,lane:input.lane,releaseRequested});
  return admittedMilestoneResult(receipt);
}
const argv = process.argv.slice(2);
const command = argv.shift();
if (command === 'git-base-sync') {
  const action = argv.shift(); const values = new Map<string, string>(); let json = false;
  const common = ['--skill', '--lane', '--assert-target-ref'];
  const allowed = action === 'inspect' ? common : [...common, '--expected-head', '--expected-base', '--assert-index-preimage', '--assert-repository'];
  if (!['inspect', 'apply'].includes(action ?? '')) fail('effect_argument_invalid');
  while (argv.length) {
    const flag = argv.shift()!;
    if (flag === '--json') { if (json) fail('effect_argument_invalid'); json = true; continue; }
    const value = argv.shift();
    if (!allowed.includes(flag) || !value || value.startsWith('--') || values.has(flag)) fail('effect_argument_invalid');
    values.set(flag, value);
  }
  if (!json || allowed.some(flag => !values.get(flag)) || values.get('--skill') !== 'ship'
    || !LANES.includes(values.get('--lane') as Lane)) fail('effect_argument_invalid');
  try {
    const input = { skill: 'ship' as const, lane: values.get('--lane') as Lane, assertTargetRef: values.get('--assert-target-ref')! };
    const result = action === 'inspect' ? await inspectGitBaseSync(process.cwd(), input)
      : await executeGitBaseSync(process.cwd(), { ...input, expectedHead: values.get('--expected-head')!, expectedBase: values.get('--expected-base')!,
        assertIndexPreimage: values.get('--assert-index-preimage')!, assertRepository: values.get('--assert-repository')! });
    console.log(JSON.stringify({ schema: 'ecpe.closed-effect-result.v1', result })); process.exit(0);
  } catch (error) { fail(error instanceof Error ? error.message : 'git_base_sync_failed', 1); }
}
if (command === 'document-release') {
  const action = argv.shift();
  if (!['prepare', 'finish'].includes(action ?? '')) fail('effect_argument_invalid');
  const values = new Map<string, string>(); const paths: string[] = []; let json = false;
  const allowed = action === 'prepare' ? ['--skill', '--task-id', '--path'] : ['--skill', '--task-id', '--grant-id', '--result-file'];
  while (argv.length) {
    const flag = argv.shift()!;
    if (flag === '--json') { if (json) fail('effect_argument_invalid'); json = true; continue; }
    const value = argv.shift();
    if (!allowed.includes(flag) || !value || value.startsWith('--') || values.has(flag)) fail('effect_argument_invalid');
    if (flag === '--path') paths.push(value); else values.set(flag, value);
  }
  if (!json || values.get('--skill') !== 'ship' || !values.get('--task-id')
    || (action === 'prepare' ? !paths.length : !values.get('--grant-id') || !values.get('--result-file'))) fail('effect_argument_invalid');
  try {
    let result: unknown;
    if (action === 'prepare') result = await prepareDocumentRelease(process.cwd(), { taskId: values.get('--task-id')!, paths });
    else {
      let reply: unknown = null;
      let fd: number | undefined;
      try {
        fd = fs.openSync(path.resolve(values.get('--result-file')!), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const info = fs.fstatSync(fd);
        if (info.isFile() && info.size <= 1_048_576) reply = JSON.parse(fs.readFileSync(fd, 'utf8'));
      } catch { /* An unreadable/malformed result burns the exact lease and fails closed. */ }
      finally { if (fd !== undefined) fs.closeSync(fd); }
      result = await finishDocumentRelease(process.cwd(), { taskId: values.get('--task-id')!, grantId: values.get('--grant-id')!, result: reply });
    }
    console.log(JSON.stringify({ schema: 'ecpe.closed-effect-result.v1', result })); process.exit(0);
  } catch (error) { fail(error instanceof Error ? error.message : 'document_release_failed', 1); }
}
if(command==='apply-profile-downgrade'){
  const values=new Map<string,string>();let json=false;while(argv.length){const flag=argv.shift()!;if(flag==='--json'){if(json)fail('effect_argument_invalid');json=true;continue}const value=argv.shift();if(!['--latch-id','--lane','--workspace-handle','--assert-selector','--target'].includes(flag)||!value||value.startsWith('--')||values.has(flag))fail('effect_argument_invalid');values.set(flag,value)}const lane=values.get('--lane')as any,target=values.get('--target')as any;if(!json||!values.get('--latch-id')||!['docs_ux','single_repo_code','cross_repo_contract'].includes(lane)||!values.get('--workspace-handle')||!values.get('--assert-selector')||!['shadow','legacy'].includes(target))fail('effect_argument_invalid');if(process.env.ECPE_PROFILE_DOWNGRADE_AUTHORIZED!=='1')fail('grant_required',1);try{console.log(JSON.stringify({schema:'ecpe.closed-effect-result.v1',result:applyProfileDowngrade({stateRoot:resolveRuntimeStateRoot().root,latchId:values.get('--latch-id')!,lane,workspaceHandle:values.get('--workspace-handle')!,assertSelector:values.get('--assert-selector')!,target})}));process.exit(0)}catch(error){fail(error instanceof Error?error.message:'profile_downgrade_failed',1)}
}
if(command==='apply-profile-promotion'){
  const values=new Map<string,string>();let json=false;while(argv.length){const flag=argv.shift()!;if(flag==='--json'){if(json)fail('effect_argument_invalid');json=true;continue}const value=argv.shift();if(!['--proof-id','--lane','--assert-selector'].includes(flag)||!value||value.startsWith('--')||values.has(flag))fail('effect_argument_invalid');values.set(flag,value)}const lane=values.get('--lane')as any;if(!json||!values.get('--proof-id')||!['docs_ux','single_repo_code','cross_repo_contract'].includes(lane)||!values.get('--assert-selector'))fail('effect_argument_invalid');if(process.env.ECPE_PROFILE_PROMOTION_AUTHORIZED!=='1')fail('grant_required',1);try{console.log(JSON.stringify({schema:'ecpe.closed-effect-result.v1',result:applyProfilePromotion({stateRoot:resolveRuntimeStateRoot().root,cwd:process.cwd(),proofId:values.get('--proof-id')!,lane,assertSelector:values.get('--assert-selector')!})}));process.exit(0)}catch(error){fail(error instanceof Error?error.message:'profile_promotion_failed',1)}
}
if (command === 'recording-terminal') {
  if (argv.shift() !== 'abandon') fail('effect_command_invalid');
  const values = new Map<string, string>(); let json = false;
  while (argv.length) { const flag = argv.shift()!; if (flag === '--json') { if (json) fail('effect_argument_invalid'); json = true; continue; } const value = argv.shift(); if (!['--binding-id','--repo-id','--assert-gate','--assert-index-preimage'].includes(flag) || !value || value.startsWith('--') || values.has(flag)) fail('effect_argument_invalid'); values.set(flag,value); }
  if (!json || process.env.ECPE_RECORDING_ABANDON_AUTHORIZED !== '1' || [...['--binding-id','--repo-id','--assert-gate','--assert-index-preimage']].some(flag=>!values.get(flag))) fail('grant_required', 1);
  try { console.log(JSON.stringify({schema:'ecpe.closed-effect-result.v1',result:abandonRecordingProjection({stateRoot:resolveRuntimeStateRoot().root,cwd:process.cwd(),bindingId:values.get('--binding-id')!,repoId:values.get('--repo-id')!,assertGate:values.get('--assert-gate')!,assertIndexPreimage:values.get('--assert-index-preimage')!})})); process.exit(0); } catch(error){ fail(error instanceof Error?error.message:'recording_abandon_failed',1); }
}
if (['git-stage-commit', 'git-push', 'provider-pr', 'provider-comment', 'rollback', 'cancel-terminal-landing'].includes(command ?? '')) {
  const action = command === 'provider-pr' ? argv.shift() : undefined;
  const parsed = new Map<string, string[]>();
  let releaseRequested=false;let json=false;
  while (argv.length) {
    const flag = argv.shift()!;
    if (flag === '--json') { if(json)fail('effect_argument_invalid');json=true;continue; }
    if (flag === '--release-requested') { if(command!=='provider-pr'||releaseRequested)fail('effect_argument_invalid');releaseRequested=true;continue; }
    const value = argv.shift();
    if (!flag.startsWith('--') || !value) fail('effect_argument_invalid');
    parsed.set(flag, [...(parsed.get(flag) ?? []), value]);
  }
  const one = (name: string) => parsed.get(name)?.at(-1);
  const skill = one('--skill') as GovernedSkill;
  if(command==='provider-pr'){
    const allowed=new Set(['--skill','--provider','--base','--pr','--title','--body-file','--assert-body-sha256','--lane','--assert-target-ref','--assert-release-mode','--assert-title-policy','--version']);
    if(!json||[...parsed.keys()].some(flag=>!allowed.has(flag))||[...parsed.values()].some(values=>values.length!==1)||!['create','update','discover'].includes(action??''))fail('effect_argument_invalid');
    if(one('--provider')&&!['github','gitlab'].includes(one('--provider')!))fail('effect_argument_invalid');
    if(action==='discover'){
      if(releaseRequested||one('--skill')!=='ship'||[...parsed.keys()].some(flag=>!['--skill','--provider'].includes(flag)))fail('effect_argument_invalid');
    }else{
      if(!one('--lane')||!one('--assert-target-ref')||!one('--assert-release-mode')||!one('--assert-title-policy')||!/^[0-9a-f]{64}$/.test(one('--assert-body-sha256')??'')||action==='create'&&one('--pr')!==undefined||action==='update'&&!/^[1-9][0-9]*$/.test(one('--pr')??''))fail('effect_argument_invalid');
    }
  }
  try {
    let result: unknown;
    if (command === 'git-stage-commit') result = await executeGitStageCommit(process.cwd(), { skill, operation: one('--operation') ?? '', paths: parsed.get('--assert-path') ?? [] });
    else if (command === 'git-push') result = await executeGitPush(process.cwd(), { skill, operation: one('--operation') ?? '' });
    else if (command === 'provider-pr' && action === 'discover') result = await discoverProviderPr(process.cwd(), { skill, provider: one('--provider') as any });
    else if (command === 'provider-pr') result = await executeProviderPr(process.cwd(), { skill, action: action as 'create' | 'update', provider: one('--provider') as any, base: one('--base'), pr: one('--pr') ? Number(one('--pr')) : undefined, title: one('--title') ?? '', bodyFile: one('--body-file') ?? '', assertBodySha256: one('--assert-body-sha256') ?? '', lane: one('--lane') as any, assertTargetRef: one('--assert-target-ref')!, assertReleaseMode:one('--assert-release-mode') as any,assertTitlePolicy: one('--assert-title-policy') as any, releaseRequested, version: one('--version') });
    else if (command === 'provider-comment') result = await executeProviderComment(process.cwd(), { skill, operation: one('--operation') ?? '', pr: Number(one('--pr')), commentId: one('--comment-id') ?? '', replyIntent: one('--reply-intent') ?? '', bodyFile: one('--body-file') ?? '' });
    else if (command === 'cancel-terminal-landing') result = await cancelTerminalLanding(process.cwd(), { purpose: one('--purpose') ?? '', proposalHash: one('--proposal-hash') ?? '' });
    else result = await executeRollback();
    console.log(JSON.stringify({ schema: 'ecpe.closed-effect-result.v1', result }));
    process.exit(0);
  } catch (error) { fail(error instanceof Error ? error.message : 'closed_effect_failed', 1); }
}
if (command === 'provider-merge') {
  const mergeMode = argv.shift();
  if (!['direct', 'reconcile', 'discover'].includes(mergeMode ?? '')) fail('effect_command_invalid');
  if(mergeMode==='discover'){
    const values=new Map<string,string>();while(argv.length){const flag=argv.shift()!,value=argv.shift();if(!['--skill','--pr'].includes(flag)||!value||value.startsWith('--')||values.has(flag))fail('effect_argument_invalid');values.set(flag,value)}
    const pr=values.get('--pr');if(values.get('--skill')!=='land-and-deploy'||!pr||!/^[1-9][0-9]*$/.test(pr))fail('effect_land_assertion_invalid');
    try {
      const discovered=await discoverDirectMergeProviderHead(process.cwd(),Number(pr));
      if(discovered.status==='absent'){console.log(JSON.stringify(discovered));process.exit(0)}
      const state=resolveRuntimeStateRoot();
      const bound=findMilestoneLandingByRawIntent(state.root,discovered.intentId);
      let admitted:ReturnType<typeof admittedMilestoneResult>|null=null;
      let handoff:Extract<ReturnType<typeof inspectAssertedShipHandoff>,{current:true}>|null=null;
      const protectedReceipt=findMergedDeliveryByRawIntent(state.root,discovered.intentId);
      if(protectedReceipt)admitted=admittedMilestoneResult(protectedReceipt);
      if(bound&&discovered.status==='merged'){
        if(!bound.landing.ship_receipt_id||bound.landing.lanes.length!==1)throw new Error('ship_receipt_invalid');
        const inspected=inspectAssertedShipHandoff({cwd:process.cwd(),pr:bound.landing.pr,assertTargetRef:bound.landing.target_ref,expectedBase:bound.landing.expected_base_oid,remotePrHead:bound.landing.expected_head_oid,stateHome:state.root});
        if(!inspected.current||inspected.receipt_run_id!==bound.landing.ship_receipt_id)throw new Error('ship_receipt_invalid');
        handoff=inspected;
        const resolved=await resolveDirectMergeLandingIntent(process.cwd(),{prNumber:bound.landing.pr,expectedHeadOid:bound.landing.expected_head_oid,expectedBaseOid:bound.landing.expected_base_oid,expectedTargetRef:bound.landing.target_ref,expectedRepositoryNodeId:bound.landing.repository_node_id});
        if(resolved.intentId!==bound.landing.raw_provider_intent_id)throw new Error('milestone_landing_recovery_mismatch');
        admitted=await mergeAndAdmit({stateRoot:state.root,handoff,descriptor:resolved.descriptor,subjectTree:bound.landing.subject_tree,lane:bound.landing.lanes[0] as Lane,reconcileOnly:true,provider:()=>Promise.resolve(discovered)});
        await withMilestoneLandingJournal({stateRoot:state.root,assertedBlockId:bound.block.block_id,landing:replayMilestoneLanding(bound.landing),reconcileOnly:true},()=>Promise.resolve(admitted!));
      }else if(!admitted&&discovered.status==='merged'){
        const resolved=await resolveDirectMergeLandingIntent(process.cwd(),{prNumber:Number(pr),expectedHeadOid:discovered.expectedHeadOid,expectedBaseOid:discovered.expectedBaseOid,expectedTargetRef:discovered.expectedTargetRef,expectedRepositoryNodeId:discovered.expectedRepositoryNodeId});
        if(resolved.intentId!==discovered.intentId)throw new Error('provider_landing_recovery_mismatch');
        const inspected=inspectAssertedShipHandoff({cwd:process.cwd(),pr:Number(pr),assertTargetRef:discovered.expectedTargetRef,expectedBase:discovered.expectedBaseOid,remotePrHead:discovered.expectedHeadOid,stateHome:state.root});
        if(!inspected.current)throw new Error('ship_receipt_invalid');
        handoff=inspected;
        let lane=(handoff.canary_subject?.lane??handoff.promotion?.lane) as Lane|undefined;
        if(!lane){
          const profiles=LANES.map(candidate=>resolveTrustedWorkProfile({cwd:process.cwd(),lane:candidate,assertTargetRef:discovered.expectedTargetRef,safetyStateRoot:state.root}));
          const profile=profiles[0];const effective=profile.effective??{semantic_paths:[{glob:'**',roles:['runtime']}],prose_only_surfaces:[],dependency_surfaces:[]} as any;
          const manifest=buildChangeManifest({cwd:process.cwd(),profile:effective,targetBaseRef:profile.trusted_base.target_ref??undefined,targetBaseSha:profile.trusted_base.target_sha,mergeBaseSha:profile.trusted_base.merge_base_sha});
          lane=resolveManifestLane(profile.effective,manifest);
        }
        admitted=await mergeAndAdmit({stateRoot:state.root,handoff,descriptor:resolved.descriptor,subjectTree:handoff.remote_pr_head_tree,lane,reconcileOnly:true,provider:()=>Promise.resolve(discovered)});
      }
      const recovery:any={...discovered,...(admitted??{}),milestone_block_id:bound?.block.block_id??null,milestone_landing_id:bound?.landing.landing_id??null,landing_kind:bound?.landing.kind??'ordinary',lane:bound?.landing.lanes.length===1?bound.landing.lanes[0]:null,lanes:bound?.landing.lanes??[],subject_tree:bound?.landing.subject_tree??null,ship_receipt_id:bound?.landing.ship_receipt_id??null,canary_proof_id:null,canary_sample_id:null};
      if(bound&&['canary_activation','canary_sample'].includes(bound.landing.kind)){
        const lane=bound.landing.lanes[0] as Lane;
        if(!handoff?.canary_subject)throw new Error('canary_land_lineage_missing');
        const profileHash=handoff.canary_subject.profile_hash;const repoId=resolveProjectIdentity(process.cwd(),{mode:'profile'}).repo_id;
        if(bound.landing.kind==='canary_activation')recovery.canary_proof_id=inspectCanaryActivationCandidate({stateRoot:state.root,repoId,lane,profileHash,blockId:bound.block.block_id,subjectHead:bound.landing.expected_head_oid,subjectTree:bound.landing.subject_tree,reconcileOnly:true}).proof_id;
        else recovery.canary_sample_id=inspectCanarySampleCandidate({stateRoot:state.root,repoId,lane,profileHash,blockId:bound.block.block_id,subjectHead:bound.landing.expected_head_oid,subjectTree:bound.landing.subject_tree,reconcileOnly:true}).sample_id;
      }
      console.log(JSON.stringify(recovery));process.exit(0)
    }catch(error){fail(error instanceof Error?error.message:'provider_discovery_failed',1)}
  }
  if (mergeMode === 'direct' && process.env.ECPE_MERGE_AUTHORIZED !== '1') fail('grant_required');
  const values = new Map<string, string>();
  const allowed = new Set(['--skill','--pr','--expected','--expected-base','--assert-target-ref','--expected-repository-node','--assert-plan-lane','--lane','--assert-ship-receipt','--assert-milestone-block','--assert-milestone-landing','--assert-canary-proof','--assert-canary-sample']);
  while (argv.length) { const flag = argv.shift()!, value = argv.shift(); if (!allowed.has(flag) || !value || value.startsWith('--') || values.has(flag)) fail('effect_argument_invalid'); values.set(flag, value); }
  const pr = values.get('--pr');
  if (!pr || !/^[1-9][0-9]*$/.test(pr) || values.get('--skill') !== 'land-and-deploy' || !values.get('--expected-repository-node')) fail('effect_land_assertion_invalid');
  try {
    const state = resolveRuntimeStateRoot();
    const assertedLandingId=values.get('--assert-milestone-landing');
    if(assertedLandingId){
      if(mergeMode!=='reconcile')throw new Error('milestone_landing_recovery_invalid');
      const bound=findMilestoneLandingById(state.root,assertedLandingId);if(!bound)throw new Error('milestone_landing_recovery_missing');
      const landing=replayMilestoneLanding(bound.landing);const assertedLane=values.get('--lane') as Lane|undefined;const planLane=values.get('--assert-plan-lane') as Lane|undefined;
      if(values.get('--assert-milestone-block')!==bound.block.block_id||values.get('--expected')!==landing.expectedHeadOid||values.get('--expected-base')!==landing.expectedBaseOid||values.get('--assert-target-ref')!==landing.targetRef||values.get('--expected-repository-node')!==landing.repositoryNodeId||planLane!==landing.lanes[0]||landing.lanes.length!==1||(assertedLane!==undefined&&assertedLane!==landing.lanes[0])||values.get('--assert-ship-receipt')!==(landing.shipReceiptId??undefined))throw new Error('milestone_landing_recovery_mismatch');
      const raw=await resolveDirectMergeLandingIntent(process.cwd(),{prNumber:landing.prNumber,expectedHeadOid:landing.expectedHeadOid,expectedBaseOid:landing.expectedBaseOid,expectedTargetRef:landing.targetRef,expectedRepositoryNodeId:landing.repositoryNodeId});if(raw.intentId!==landing.rawProviderIntentId)throw new Error('milestone_landing_recovery_mismatch');
      const handoff=inspectAssertedShipHandoff({cwd:process.cwd(),pr:landing.prNumber,assertTargetRef:landing.targetRef,expectedBase:landing.expectedBaseOid,remotePrHead:landing.expectedHeadOid,stateHome:state.root});if(!handoff.current||handoff.receipt_run_id!==landing.shipReceiptId)throw new Error('ship_receipt_invalid');
      const lane=landing.lanes[0] as Lane;const mergeExpected={prNumber:landing.prNumber,expectedHeadOid:landing.expectedHeadOid,expectedBaseOid:landing.expectedBaseOid,expectedTargetRef:landing.targetRef,expectedRepositoryNodeId:landing.repositoryNodeId};
      const mergeProvider=()=>mergeAndAdmit({stateRoot:state.root,handoff,descriptor:raw.descriptor,subjectTree:landing.subjectTree,lane,reconcileOnly:true,provider:async()=>{const reconciliation=await reconcileDirectMergeProviderHead(process.cwd(),mergeExpected);if(reconciliation.status!=='merged')throw new Error('provider_merge_incomplete');return reconciliation}});const identity=resolveProjectIdentity(process.cwd(),{mode:'profile'});
      if(landing.kind==='ordinary'){const merged=await withMilestoneLandingJournal({stateRoot:state.root,assertedBlockId:bound.block.block_id,landing,reconcileOnly:true},mergeProvider);console.log(JSON.stringify(merged));process.exit(0)}
      if(landing.kind==='promotion'){if(!handoff.promotion)throw new Error('promotion_ship_receipt_invalid');const merged=await withMilestoneLandingJournal({stateRoot:state.root,assertedBlockId:bound.block.block_id,landing,reconcileOnly:true},mergeProvider);const canary=createPromotionCanaryPending({stateRoot:state.root,handoff,merge:merged});console.log(JSON.stringify({...merged,promotion_canary:canary}));process.exit(0)}
      if(!handoff.canary_subject||handoff.canary_subject.block_id!==bound.block.block_id||handoff.canary_subject.lane!==landing.lanes[0]||handoff.canary_subject.subject_head!==landing.expectedHeadOid||handoff.canary_subject.subject_tree!==landing.subjectTree)throw new Error('canary_ship_receipt_invalid');const profileHash=handoff.canary_subject.profile_hash;
      if(landing.kind==='canary_activation'){const candidate=inspectCanaryActivationCandidate({stateRoot:state.root,repoId:identity.repo_id,lane,profileHash,blockId:bound.block.block_id,subjectHead:landing.expectedHeadOid,subjectTree:landing.subjectTree,reconcileOnly:true});if(values.get('--assert-canary-proof')!==candidate.proof_id)throw new Error('canary_land_assertion_invalid');const activation=await reconcileCanaryActivationLanding({stateRoot:state.root,providerIntentRoot:resolveProviderLandingIntentRoot(),repoId:identity.repo_id,lane,profileHash,blockId:bound.block.block_id,activationProofId:candidate.proof_id,handoff,expectedRepositoryNodeId:landing.repositoryNodeId,mergeProvider,milestoneLanding:landing,reconcileOnly:true});console.log(JSON.stringify({status:'merged',canary_activation:activation}));process.exit(0)}
      const candidate=inspectCanarySampleCandidate({stateRoot:state.root,repoId:identity.repo_id,lane,profileHash,blockId:bound.block.block_id,subjectHead:landing.expectedHeadOid,subjectTree:landing.subjectTree,reconcileOnly:true});if(values.get('--assert-canary-sample')!==candidate.sample_id)throw new Error('canary_land_assertion_invalid');const sample=await reconcileCanarySampleLanding({stateRoot:state.root,providerIntentRoot:resolveProviderLandingIntentRoot(),repoId:identity.repo_id,lane,profileHash,blockId:bound.block.block_id,sampleId:candidate.sample_id,handoff,expectedRepositoryNodeId:landing.repositoryNodeId,mergeProvider,milestoneLanding:landing,reconcileOnly:true});console.log(JSON.stringify({status:'merged',canary_sample:sample}));process.exit(0)
    }
    const profiles = LANES.map((lane) => resolveTrustedWorkProfile({ cwd: process.cwd(), lane, assertTargetRef: values.get('--assert-target-ref'), safetyStateRoot: state.root }));
    const planLane=values.get('--assert-plan-lane') as Lane|undefined;if(!planLane||!LANES.includes(planLane))throw new Error('milestone_landing_lane_missing');
    const laneProfile=profiles[0];const manifestProfile=laneProfile.effective??{semantic_paths:[{glob:'**',roles:['runtime']}],prose_only_surfaces:[],dependency_surfaces:[]}as any;const landingManifest=buildChangeManifest({cwd:process.cwd(),profile:manifestProfile,targetBaseRef:laneProfile.trusted_base.target_ref??undefined,targetBaseSha:laneProfile.trusted_base.target_sha,mergeBaseSha:laneProfile.trusted_base.merge_base_sha});const derivedLane=resolveManifestLane(laneProfile.effective,landingManifest);if(planLane!==derivedLane)throw new Error('milestone_landing_lane_mismatch');
    const promotions = profiles
      .filter((profile) => profile.candidate_state === 'authorized_promotion' && profile.promotion_lineage !== null);
    if (promotions.length > 1) throw new Error('promotion_lineage_ambiguous');
    let promotionReceipt: ReturnType<typeof inspectAssertedShipHandoff> | null = null;
    const assertedLane = values.get('--lane') as Lane | undefined; const assertedReceipt = values.get('--assert-ship-receipt');
    const assertedBlock = values.get('--assert-milestone-block'); const assertedCanaryProof = values.get('--assert-canary-proof'); const assertedCanarySample = values.get('--assert-canary-sample');
    if (assertedCanaryProof && assertedCanarySample) throw new Error('canary_land_assertion_invalid');
    const head = values.get('--expected') ?? ''; const treeResult = spawnSync('/usr/bin/git', ['rev-parse', 'HEAD^{tree}'], { cwd: process.cwd(), encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
    const subjectTree = treeResult.status === 0 ? treeResult.stdout.trim() : '';
    const identity = resolveProjectIdentity(process.cwd(), { mode: 'profile' });
    const canaryStates = profiles.flatMap((profile) => {
      if (!profile.profile_hash || profile.lane_activation !== 'enforce') return [];
      try { return [{ profile, inspection: inspectCanaryWindow({ stateRoot: state.root, repoId: identity.repo_id, lane: profile.lane, profileHash: profile.profile_hash }) }]; }
      catch (error) { if (error instanceof Error && error.message === 'canary_lineage_missing') return []; throw error; }
    });
    if (canaryStates.some(({ inspection }) => inspection.phase === 'safety_stop_required')) throw new Error('canary_safety_stop_required');
    const candidates = canaryStates.flatMap(({ profile, inspection }) => {
      if (!['aggregate_ready', 'activation_landing_intent', 'activation_checkpointed', 'pending_superseded'].includes(inspection.phase) || !/^[0-9a-f]{40}$/.test(head) || !/^[0-9a-f]{40}$/.test(subjectTree)) return [];
      try { return [inspectCanaryActivationCandidate({ stateRoot: state.root, repoId: identity.repo_id, lane: profile.lane, profileHash: profile.profile_hash!, subjectHead: head, subjectTree })]; }
      catch (error) { if (error instanceof Error && error.message === 'canary_activation_subject_mismatch') return []; throw error; }
    });
    if (candidates.length > 1) throw new Error('canary_activation_ambiguous');
    const canaryCandidate = candidates[0] ?? null;
    const sampleCandidates = canaryStates.flatMap(({ profile, inspection }) => {
      if (inspection.phase !== 'pending' || !/^[0-9a-f]{40}$/.test(head) || !/^[0-9a-f]{40}$/.test(subjectTree)) return [];
      try { return [inspectCanarySampleCandidate({ stateRoot: state.root, repoId: identity.repo_id, lane: profile.lane, profileHash: profile.profile_hash!, subjectHead: head, subjectTree })]; }
      catch (error) { if (error instanceof Error && error.message === 'canary_sample_candidate_missing') return []; throw error; }
    });
    if (sampleCandidates.length > 1) throw new Error('canary_sample_ambiguous');
    const sampleCandidate = sampleCandidates[0] ?? null;
    if (canaryCandidate && sampleCandidate) throw new Error('canary_land_ambiguous');
    if (canaryCandidate) {
      if (!assertedCanaryProof || assertedCanaryProof !== canaryCandidate.proof_id || assertedBlock !== canaryCandidate.block_id || assertedLane !== canaryCandidate.lane || !assertedReceipt || !values.get('--expected-repository-node')) throw new Error('canary_land_assertion_invalid');
    } else if (sampleCandidate) {
      if (!assertedCanarySample || assertedCanarySample !== sampleCandidate.sample_id || assertedBlock !== sampleCandidate.block_id || assertedLane !== sampleCandidate.lane || !assertedReceipt || !values.get('--expected-repository-node')) throw new Error('canary_land_assertion_invalid');
    } else if (assertedCanaryProof || assertedCanarySample) {
      throw new Error('canary_land_assertion_invalid');
    }
    if (!assertedReceipt || !/^evidence-[0-9a-f]{32}$/.test(assertedReceipt) || !values.get('--expected-repository-node')) throw new Error('ship_receipt_required');
    {
      if (assertedLane !== undefined && !LANES.includes(assertedLane)) throw new Error('promotion_land_assertion_invalid');
      promotionReceipt = inspectAssertedShipHandoff({ cwd: process.cwd(), pr: Number(pr), assertTargetRef: values.get('--assert-target-ref') ?? '', expectedBase: values.get('--expected-base') ?? '', remotePrHead: values.get('--expected') ?? '', stateHome: state.root });
      if (!promotionReceipt.current || promotionReceipt.receipt_run_id !== assertedReceipt) throw new Error('ship_receipt_invalid');
      if (canaryCandidate || sampleCandidate) {
        const candidate = canaryCandidate ?? sampleCandidate!;
        const subject = promotionReceipt.canary_subject;
        if (!subject || subject.block_id !== candidate.block_id || subject.lane !== candidate.lane || subject.profile_hash !== candidate.profile_hash
          || subject.promotion_proof_id !== candidate.promotion_proof_id || subject.subject_head !== candidate.subject_head || subject.subject_tree !== candidate.subject_tree
          || subject.policy_hash !== candidate.policy_hash || subject.focused_run_id !== candidate.focused_run_id) throw new Error('canary_ship_receipt_invalid');
      } else if (assertedLane) {
        if (!promotionReceipt.promotion || promotionReceipt.promotion.lane !== assertedLane) throw new Error('promotion_ship_receipt_invalid');
        if (promotionReceipt.canary_subject || assertedBlock !== promotionReceipt.promotion.block_id) throw new Error('promotion_ship_receipt_invalid');
        const profile = profiles.find((item) => item.lane === assertedLane)!;
        const candidateMatches = profile.candidate_state === 'authorized_promotion' && JSON.stringify(profile.promotion_lineage) === JSON.stringify(promotionReceipt.promotion);
        const landedProfileMatches = profile.profile_hash === promotionReceipt.promotion.after_profile_hash && profile.lane_activation === 'enforce' && ['same', 'absent'].includes(profile.candidate_state);
        if (!candidateMatches && !landedProfileMatches) throw new Error('promotion_ship_receipt_invalid');
      }
    }
    if (!assertedLane && promotions.length === 1) {
      throw new Error('promotion_land_assertion_invalid');
    }
    const mergeExpected = {
      prNumber: Number(pr), expectedHeadOid: head, expectedBaseOid: values.get('--expected-base') ?? '',
      expectedTargetRef: values.get('--assert-target-ref') ?? '', expectedRepositoryNodeId: values.get('--expected-repository-node')!,
    };
    const rawLanding=await resolveDirectMergeLandingIntent(process.cwd(),mergeExpected);
    if(assertedLane&&assertedLane!==planLane)throw new Error('milestone_landing_lane_mismatch');
    const journalLanes=[planLane];
    if(!promotionReceipt?.current)throw new Error('ship_receipt_required');
    const milestoneLanding:MilestoneLandingDescriptor={kind:canaryCandidate?'canary_activation':sampleCandidate?'canary_sample':promotionReceipt.promotion?'promotion':'ordinary',participant:'portfolioops',repositoryNodeId:mergeExpected.expectedRepositoryNodeId,prNumber:mergeExpected.prNumber,expectedHeadOid:mergeExpected.expectedHeadOid,expectedBaseOid:mergeExpected.expectedBaseOid,targetRef:mergeExpected.expectedTargetRef,subjectTree,rawProviderIntentId:rawLanding.intentId,shipReceiptId:promotionReceipt.receipt_run_id,lanes:journalLanes};
    const mergeProvider = () => mergeAndAdmit({stateRoot:state.root,handoff:promotionReceipt,descriptor:rawLanding.descriptor,subjectTree,lane:planLane,reconcileOnly:mergeMode==='reconcile',provider:async()=>{const raw=mergeMode==='reconcile'?await reconcileDirectMergeProviderHead(process.cwd(),mergeExpected):await directMergeProviderHead(process.cwd(),mergeExpected);if(raw.status!=='merged')throw new Error('provider_merge_incomplete');return raw}});
    if (canaryCandidate && promotionReceipt?.current && promotionReceipt.canary_subject) {
      const activation = await reconcileCanaryActivationLanding({ stateRoot: state.root, providerIntentRoot: resolveProviderLandingIntentRoot(), repoId: identity.repo_id, lane: canaryCandidate.lane, profileHash: canaryCandidate.profile_hash, blockId: canaryCandidate.block_id, activationProofId: canaryCandidate.proof_id, handoff: promotionReceipt, expectedRepositoryNodeId: values.get('--expected-repository-node')!, mergeProvider, milestoneLanding, reconcileOnly:mergeMode==='reconcile' });
      console.log(JSON.stringify({ status: 'merged', canary_activation: activation }));
      process.exit(0);
    }
    if (sampleCandidate && promotionReceipt?.current && promotionReceipt.canary_subject) {
      const sample = await reconcileCanarySampleLanding({ stateRoot: state.root, providerIntentRoot: resolveProviderLandingIntentRoot(), repoId: identity.repo_id, lane: sampleCandidate.lane, profileHash: sampleCandidate.profile_hash, blockId: sampleCandidate.block_id, sampleId: sampleCandidate.sample_id, handoff: promotionReceipt, expectedRepositoryNodeId: values.get('--expected-repository-node')!, mergeProvider, milestoneLanding, reconcileOnly:mergeMode==='reconcile' });
      console.log(JSON.stringify({ status: 'merged', canary_sample: sample }));
      process.exit(0);
    }
    const merged = await withMilestoneLandingJournal({stateRoot:state.root,assertedBlockId:assertedBlock,landing:milestoneLanding,reconcileOnly:mergeMode==='reconcile'},mergeProvider);
    const canary = promotionReceipt?.current && promotionReceipt.promotion ? createPromotionCanaryPending({ stateRoot: state.root, handoff: promotionReceipt, merge: merged }) : null;
    console.log(JSON.stringify({ ...merged, ...(canary ? { promotion_canary: canary } : {}) }));
    process.exit(0);
  } catch (error) { fail(error instanceof Error ? error.message : 'provider_merge_failed', 1); }
}
if (!['resolve', 'ensure-paid-validator'].includes(command ?? '')) fail('effect_command_invalid');
const values = new Map<string, string[]>();
let fix = false;
while (argv.length) {
  const flag = argv.shift()!;
  if (flag === '--fix') { fix = true; continue; }
  if (flag === '--json') continue;
  const value = argv.shift();
  if (!flag.startsWith('--') || !value) fail('effect_argument_invalid');
  values.set(flag, [...(values.get(flag) ?? []), value]);
}
const one = (name: string) => values.get(name)?.at(-1);
try {
  const allowed = new Set(['--skill', '--capability', '--validator-id', '--assert-path', '--pr', '--comment-id', '--mode', '--assert-environment', '--assert-target-ref', '--assert-target-sha', '--lane', '--expected-head', '--expected-base']);
  for (const flag of values.keys()) if (!allowed.has(flag)) throw new Error('effect_argument_invalid');
  const capability = command === 'ensure-paid-validator' ? 'paid_model' : one('--capability');
  let trustedDeployTarget: { id: string; environment_class: string; trigger: string; binding: Record<string, string> } | undefined;
  let classificationState: 'complete' | 'semantic_declaration_required' | undefined;
  let candidatePolicyState: 'absent' | 'same' | 'strengthening_applied' | 'authorized_promotion' | 'ignored_untrusted' | undefined;
  if (one('--skill') === 'land-and-deploy' && (capability === 'merge' || capability === 'deploy')) {
    const profile = resolveTrustedWorkProfile({ cwd: process.cwd(), lane: 'single_repo_code', assertTargetRef: one('--assert-target-ref'), assertTargetSha: one('--assert-target-sha') });
    if (profile.execution === 'profile' && profile.effective) {
      trustedDeployTarget = Object.values(profile.effective.deploy_targets)[0] as typeof trustedDeployTarget;
      classificationState = buildChangeManifest({ cwd: process.cwd(), profile: profile.effective, targetBaseRef: profile.trusted_base.target_ref ?? undefined, targetBaseSha: profile.trusted_base.target_sha, mergeBaseSha: profile.trusted_base.merge_base_sha }).classification_state;
      candidatePolicyState = profile.candidate_state;
    }
  }
  let paidBinding: ReturnType<typeof resolveProfileValidatorBinding> | undefined;
  if (command === 'ensure-paid-validator') {
    const lane = one('--lane');
    const validatorId = one('--validator-id');
    if (!validatorId || !['docs_ux', 'single_repo_code', 'cross_repo_contract'].includes(lane ?? '') || (one('--assert-target-ref') && one('--assert-target-sha'))) throw new Error('effect_argument_invalid');
    const stateHome = process.env.GSTACK_HOME || (process.env.HOME ? path.join(process.env.HOME, '.gstack') : '');
    if (!stateHome) throw new Error('state_home_unavailable');
    paidBinding = resolveProfileValidatorBinding({ cwd: process.cwd(), lane: lane as any, validatorId, assertTargetRef: one('--assert-target-ref'), assertTargetSha: one('--assert-target-sha'), stateHome });
    if (paidBinding.binding.effect !== 'paid_model') throw new Error('validator_effect_mismatch');
  }
  const grants = resolveEffectScope({
    skill: one('--skill') ?? '', capability,
    validatorId: one('--validator-id'), fix, paths: values.get('--assert-path'),
    pr: one('--pr') && /^[1-9][0-9]*$/.test(one('--pr')!) ? Number(one('--pr')) : undefined,
    commentId: one('--comment-id'), mode: one('--mode'), environment: one('--assert-environment'), trustedDeployTarget, classificationState, candidatePolicyState,
    trustedPaidValidatorId: paidBinding?.binding.validatorId,
    trustedPaidValidatorBinding: paidBinding?.binding.paidGrantAssertions as any,
  });
  if (command === 'ensure-paid-validator') {
    if (!paidBinding) throw new Error('validator_unavailable');
    const buffered: EvidenceRecordV2[] = [];
    const runBinding = (binding: TrustedValidatorBinding, environment: Record<string, string>) => ensureValidator(binding, {
      grant: new ProcessLocalGrant(grants[0]),
      spawn: (logical) => {
        const executable = logical[0] === 'bun' ? process.execPath : logical[0];
        if (!path.isAbsolute(executable)) throw new Error('paid_validator_executable_untrusted');
        const info = fs.lstatSync(executable);
        if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0) throw new Error('paid_validator_attestation_failed');
        const child = spawnSync(fs.realpathSync(executable), logical.slice(1), { cwd: binding.cwd, stdio: 'inherit', shell: false, env: environment });
        return { exitCode: child.status ?? 1 };
      },
      append: (record) => buffered.push(record),
    });
    let result;
    const pr = one('--pr');
    if (pr) {
      if (!/^[1-9][0-9]*$/.test(pr) || !one('--expected-head') || !one('--expected-base') || !one('--assert-target-ref') || one('--assert-target-sha')) throw new Error('effect_remote_assertion_invalid');
      const snapshot = assertProviderHeadSnapshot(await snapshotProviderHead(process.cwd(), Number(pr)), {
        prNumber: Number(pr), expectedHeadOid: one('--expected-head')!, expectedBaseOid: one('--expected-base')!, expectedTargetRef: one('--assert-target-ref')!, requireAutomationNull: true,
      });
      if (paidBinding.resolvedProfile.trusted_base.target_sha !== snapshot.baseRefOid) throw new Error('provider_base_moved');
      result = withRemoteHead({ sourceRepository: process.cwd(), repoId: paidBinding.binding.evidenceContext.repo_id, prNumber: Number(pr), baseRef: snapshot.targetRef, baseSha: snapshot.baseRefOid, headSha: snapshot.headRefOid }, (subject) => {
        const remote = resolveProfileValidatorBinding({ cwd: process.cwd(), lane: one('--lane') as any, validatorId: one('--validator-id')!, assertTargetRef: one('--assert-target-ref'), stateHome: process.env.GSTACK_HOME || path.join(os.homedir(), '.gstack'), resolvedProfile: paidBinding!.resolvedProfile, subject: { cwd: subject.checkout_root, localHeadSha: subject.subject_sha, remotePrHeadSha: subject.remote_pr_head_sha, baseSha: subject.base_sha, mergeBaseSha: subject.base_sha, branchRef: paidBinding!.binding.evidenceContext.branch_ref } });
        return runBinding(remote.binding, subject.environment);
      });
      assertProviderHeadSnapshot(await snapshotProviderHead(process.cwd(), Number(pr)), { prNumber: Number(pr), expectedHeadOid: snapshot.headRefOid, expectedBaseOid: snapshot.baseRefOid, expectedTargetRef: snapshot.targetRef, requireAutomationNull: true });
    } else {
      if (one('--expected-head') || one('--expected-base')) throw new Error('effect_remote_assertion_invalid');
      const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-paid-validator-env-'));
      fs.chmodSync(isolated, 0o700);
      try {
        const home = path.join(isolated, 'home'); fs.mkdirSync(home, { mode: 0o700 });
        result = runBinding(paidBinding.binding, { HOME: home, PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' });
      } finally { fs.rmSync(isolated, { recursive: true, force: true }); }
    }
    if (buffered.length) { fs.mkdirSync(paidBinding.ledgerDirectory, { recursive: true, mode: 0o700 }); for (const record of buffered) appendJsonl(paidBinding.ledgerFile, record, { mode: 0o600 }); }
    console.log(JSON.stringify({ schema: 'ecpe.paid-validator-result.v2', ...result }));
    if (result.disposition === 'live_fail') process.exit(result.child_exit ?? 1);
  } else {
    console.log(JSON.stringify({ schema: 'ecpe.effect-resolution.v1', grants }));
  }
} catch (error) { fail(error instanceof Error ? error.message : 'effect_resolution_failed'); }
