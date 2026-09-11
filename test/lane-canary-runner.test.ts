import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appendTimelineBatch } from '../lib/ecpe-metrics';
import {
  claimCanaryFocusedRun,
  createCanaryPending,
  inspectCanaryWindow,
  supersedeCanaryFocusedReservation,
} from '../lib/lane-canary';
import { inspectCanaryFocusedRun, runCanaryControl } from '../lib/lane-canary-runner';
import { acquireDurableOwnerLock, releaseDurableOwnerLock } from '../lib/durable-owner-lock';
import { readMilestoneBlock, startMilestoneBlock } from '../lib/milestone-block';

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const stateRoot = mkdtempSync(join(tmpdir(), 'canary-runner-')); roots.push(stateRoot);
  const profileHash = 'a'.repeat(64);
  const started=startMilestoneBlock({stateRoot,roots:{code_root_id:'code',workspace_root_id:'workspace',state_root_id:'state'},codeRootHead:'2'.repeat(40),registryHash:'b'.repeat(64),duration:'P30D',participants:['harness-governance','portfolioops','cdo-os'],lanes:['docs_ux','single_repo_code','cross_repo_contract']});
  createCanaryPending({ stateRoot, repoId: 'portfolioops', lane: 'single_repo_code', profileHash,
    promotionProofId: `promotion-${'b'.repeat(32)}`, promotionRecordId: `promotion-write-${'c'.repeat(32)}`,
    promotionLandingIntentId: `landing-${'d'.repeat(32)}`, promotionCheckpointId: `checkpoint-${'e'.repeat(32)}`,
    promotionReceiptId: `receipt-${'f'.repeat(32)}` });
  return { stateRoot, repoId: 'portfolioops', lane: 'single_repo_code' as const, profileHash,
    blockId: started.block.block_id, participant: 'portfolioops' as const,
    subjectHead: '2'.repeat(40), subjectTree: '3'.repeat(40), hostFingerprint: `host-${'4'.repeat(32)}`,
    policyHash: started.block.policy_hash };
}

describe('canary focused-run single flight', () => {
  test('reserves one durable focused ID and sends concurrent invocations to legacy', () => {
    const input = fixture();
    const owner = claimCanaryFocusedRun(input);
    expect(owner).toMatchObject({ result: 'focused_reserved', execution: 'profile_canary' });
    expect(owner.focused_run_id).toMatch(/^focused-[0-9a-f]{32}$/);
    expect(claimCanaryFocusedRun(input)).toMatchObject({ result: 'canary_in_progress', execution: 'legacy', focused_run_id: null });
    expect(claimCanaryFocusedRun({ ...input, subjectHead: '6'.repeat(40), subjectTree: '7'.repeat(40) }))
      .toMatchObject({ result: 'canary_in_progress', execution: 'legacy' });
  });

  test('allows an explicitly revalidated pre-effect moved subject to supersede without a sample', () => {
    const input = fixture();
    const first = claimCanaryFocusedRun(input);
    expect(supersedeCanaryFocusedReservation({ ...input, focusedRunId: first.focused_run_id!,
      currentSubjectHead: '6'.repeat(40), currentSubjectTree: '7'.repeat(40) })).toMatchObject({ result: 'reservation_superseded' });
    const replacement = claimCanaryFocusedRun({ ...input, subjectHead: '6'.repeat(40), subjectTree: '7'.repeat(40) });
    expect(replacement).toMatchObject({ result: 'focused_reserved', execution: 'profile_canary' });
    expect(replacement.focused_run_id).not.toBe(first.focused_run_id);
    expect(inspectCanaryWindow(input)).toMatchObject({ sample_count: 0 });
  });
});

describe('focused terminal inspection and exactly-once control', () => {
  test('returns only one exact terminal ordinary focused run', () => {
    const input = fixture();
    const claim = claimCanaryFocusedRun(input);
    expect(() => inspectCanaryFocusedRun({ ...input, focusedRunId: claim.focused_run_id! })).toThrow('canary_focused_run_nonterminal');
    appendTimelineBatch(input.stateRoot, 'portfolioops', [
      { skill: 'review', event: 'started', run_id: claim.focused_run_id, session: claim.focused_run_id, ts: '2026-09-08T00:00:00.000Z' },
      { skill: 'review', event: 'completed', run_id: claim.focused_run_id, session: claim.focused_run_id, outcome: 'success', duration_s: 2, ts: '2026-09-08T00:00:02.000Z' },
    ]);
    expect(inspectCanaryFocusedRun({ ...input, focusedRunId: claim.focused_run_id! })).toMatchObject({ result: 'terminal', focused_run_id: claim.focused_run_id, outcome: 'success' });
    appendTimelineBatch(input.stateRoot, 'portfolioops', [
      { skill: 'review', event: 'completed', run_id: claim.focused_run_id, session: claim.focused_run_id, outcome: 'success', duration_s: 2, ts: '2026-09-08T00:00:03.000Z' },
    ]);
    expect(() => inspectCanaryFocusedRun({ ...input, focusedRunId: claim.focused_run_id! })).toThrow('canary_focused_run_ambiguous');
  });

  test('spawns one control, appends one comparison, and makes retry read-only', () => {
    const input = fixture();
    const claim = claimCanaryFocusedRun(input);
    appendTimelineBatch(input.stateRoot, 'portfolioops', [
      { skill: 'review', event: 'started', run_id: claim.focused_run_id, session: claim.focused_run_id, ts: '2026-09-08T00:00:00.000Z' },
      { skill: 'review', event: 'completed', run_id: claim.focused_run_id, session: claim.focused_run_id, outcome: 'success', duration_s: 2, ts: '2026-09-08T00:00:02.000Z' },
    ]);
    let spawns = 0;
    const executeControl = () => { spawns += 1; return { outcome: 'pass' as const, durationMs: 2500, contextBytes: 10, helperSpawns: 1, modelSpawns: 0, unauthorizedEffects: 0, tokens: { total: null, provenance: 'unknown' as const } }; };
    const first = runCanaryControl({ ...input, focusedRunId: claim.focused_run_id! }, { executeControl });
    const retry = runCanaryControl({ ...input, focusedRunId: claim.focused_run_id! }, { executeControl });
    expect(spawns).toBe(1);
    expect(first).toMatchObject({ result: 'comparison_appended', sample_count: 1 });
    expect(retry).toMatchObject({ result: 'reused', sample_count: 1 });
  });

  test('a concurrent caller cannot turn a live control into an ambiguous comparison', () => {
    const input = fixture();
    const claim = claimCanaryFocusedRun(input); const focusedRunId = claim.focused_run_id!;
    appendTimelineBatch(input.stateRoot, 'portfolioops', [
      { skill: 'review', event: 'started', run_id: focusedRunId, session: focusedRunId, ts: '2026-09-08T00:00:00.000Z' },
      { skill: 'review', event: 'completed', run_id: focusedRunId, session: focusedRunId, outcome: 'success', duration_s: 2, ts: '2026-09-08T00:00:02.000Z' },
    ]);
    const lockTarget = join(resolve(input.stateRoot), 'ecpe', 'lane-canary-control', input.repoId, input.lane, `${focusedRunId}.json`);
    const owner = acquireDurableOwnerLock(lockTarget, 'owner_busy');
    try {
      expect(() => runCanaryControl({ ...input, focusedRunId }, { ownerLockTimeoutMs: 25, executeControl: () => { throw new Error('must_not_run'); } })).toThrow('canary_control_owner_busy');
      expect(inspectCanaryWindow(input)).toMatchObject({ sample_count: 0, focused_run_phase: 'focused_reserved' });
    } finally { releaseDurableOwnerLock(owner); }
  });

  test('never reruns an ambiguous started control and records it inconclusive', () => {
    const input = fixture();
    const claim = claimCanaryFocusedRun(input);
    appendTimelineBatch(input.stateRoot, 'portfolioops', [
      { skill: 'review', event: 'started', run_id: claim.focused_run_id, session: claim.focused_run_id, ts: '2026-09-08T00:00:00.000Z' },
      { skill: 'review', event: 'completed', run_id: claim.focused_run_id, session: claim.focused_run_id, outcome: 'success', duration_s: 2, ts: '2026-09-08T00:00:02.000Z' },
    ]);
    let spawns = 0;
    expect(() => runCanaryControl({ ...input, focusedRunId: claim.focused_run_id! }, {
      beforeSpawn: () => { throw new Error('simulated_crash'); },
      executeControl: () => { spawns += 1; throw new Error('must_not_run'); },
    })).toThrow('simulated_crash');
    const recovered = runCanaryControl({ ...input, focusedRunId: claim.focused_run_id! }, { executeControl: () => { spawns += 1; throw new Error('must_not_run'); } });
    expect(spawns).toBe(0);
    expect(recovered).toMatchObject({ result: 'comparison_appended', comparison_class: 'efficiency_inconclusive' });
    expect(inspectCanaryWindow(input)).toMatchObject({ sample_count: 1, phase: 'pending' });
  });

  test('recovers crashes after control terminal and comparison append without another spawn', () => {
    const terminalCrash = fixture(); const firstClaim = claimCanaryFocusedRun(terminalCrash);
    appendTimelineBatch(terminalCrash.stateRoot, 'portfolioops', [
      { skill: 'review', event: 'started', run_id: firstClaim.focused_run_id, session: firstClaim.focused_run_id, ts: '2026-09-08T00:00:00.000Z' },
      { skill: 'review', event: 'completed', run_id: firstClaim.focused_run_id, session: firstClaim.focused_run_id, outcome: 'success', duration_s: 2, ts: '2026-09-08T00:00:02.000Z' },
    ]);
    let firstSpawns=0;const measured=()=>{firstSpawns+=1;return{outcome:'pass' as const,durationMs:2500,contextBytes:10,helperSpawns:1,modelSpawns:0,unauthorizedEffects:0,tokens:{total:null,provenance:'unknown' as const}}};
    expect(()=>runCanaryControl({...terminalCrash,focusedRunId:firstClaim.focused_run_id!},{executeControl:measured,afterControlTerminal:()=>{throw new Error('terminal_crash')}})).toThrow('terminal_crash');
    expect(runCanaryControl({...terminalCrash,focusedRunId:firstClaim.focused_run_id!},{executeControl:measured})).toMatchObject({result:'comparison_appended',sample_count:1});expect(firstSpawns).toBe(1);

    const comparisonCrash=fixture();const secondClaim=claimCanaryFocusedRun(comparisonCrash);
    appendTimelineBatch(comparisonCrash.stateRoot,'portfolioops',[
      {skill:'review',event:'started',run_id:secondClaim.focused_run_id,session:secondClaim.focused_run_id,ts:'2026-09-08T00:00:00.000Z'},
      {skill:'review',event:'completed',run_id:secondClaim.focused_run_id,session:secondClaim.focused_run_id,outcome:'success',duration_s:2,ts:'2026-09-08T00:00:02.000Z'},
    ]);
    let secondSpawns=0;const secondMeasured=()=>{secondSpawns+=1;return{outcome:'pass' as const,durationMs:2500,contextBytes:10,helperSpawns:1,modelSpawns:0,unauthorizedEffects:0,tokens:{total:null,provenance:'unknown' as const}}};
    expect(()=>runCanaryControl({...comparisonCrash,focusedRunId:secondClaim.focused_run_id!},{executeControl:secondMeasured,afterComparisonAppended:()=>{throw new Error('comparison_crash')}})).toThrow('comparison_crash');
    expect(runCanaryControl({...comparisonCrash,focusedRunId:secondClaim.focused_run_id!},{executeControl:secondMeasured})).toMatchObject({result:'reused',sample_count:1});expect(secondSpawns).toBe(1);
  });

  test('atomically stops the milestone and latches every trusted enforce lane on safety regression',()=>{const stateRoot=mkdtempSync(join(tmpdir(),'canary-safety-'));roots.push(stateRoot);const started=startMilestoneBlock({stateRoot,roots:{code_root_id:'code',workspace_root_id:'workspace',state_root_id:'state'},codeRootHead:'a'.repeat(40),registryHash:'b'.repeat(64),duration:'P30D',participants:['harness-governance','portfolioops','cdo-os'],lanes:['docs_ux','single_repo_code','cross_repo_contract']});const profileHash='c'.repeat(64);createCanaryPending({stateRoot,repoId:'portfolioops',lane:'single_repo_code',profileHash,promotionProofId:`promotion-${'d'.repeat(32)}`,promotionRecordId:`promotion-write-${'e'.repeat(32)}`,promotionLandingIntentId:`landing-${'f'.repeat(32)}`,promotionCheckpointId:`checkpoint-${'1'.repeat(32)}`,promotionReceiptId:`receipt-${'2'.repeat(32)}`});const input={stateRoot,repoId:'portfolioops',lane:'single_repo_code' as const,profileHash,blockId:started.block.block_id,participant:'portfolioops' as const,subjectHead:'3'.repeat(40),subjectTree:'4'.repeat(40),hostFingerprint:`host-${'5'.repeat(32)}`,policyHash:started.block.policy_hash};const claim=claimCanaryFocusedRun(input);appendTimelineBatch(stateRoot,'portfolioops',[{skill:'review',event:'started',run_id:claim.focused_run_id,session:claim.focused_run_id,ts:'2026-09-08T00:00:00.000Z'},{skill:'review',event:'completed',run_id:claim.focused_run_id,session:claim.focused_run_id,outcome:'failure',duration_s:1,ts:'2026-09-08T00:00:01.000Z'}]);const activations={docs_ux:{activation:'enforce' as const,profile_lineage_hash:'6'.repeat(64)},single_repo_code:{activation:'enforce' as const,profile_lineage_hash:profileHash},cross_repo_contract:{activation:'enforce' as const,profile_lineage_hash:'7'.repeat(64)}};const result=runCanaryControl({...input,focusedRunId:claim.focused_run_id!},{executeControl:()=>({outcome:'pass',durationMs:1000,contextBytes:10,helperSpawns:1,modelSpawns:0,unauthorizedEffects:0,tokens:{total:null,provenance:'unknown'}}),trustedActivations:activations,profileBlobSha:'8'.repeat(40)});expect(result).toMatchObject({comparison_class:'safety_regressed',phase:'safety_latched',execution_allowed:false});expect(readMilestoneBlock(stateRoot,started.block.block_id)).toMatchObject({phase:'terminal_unreported',terminal_reason:'safety_failure',latches:[{lane:'docs_ux'},{lane:'single_repo_code'},{lane:'cross_repo_contract'}]});expect(inspectCanaryWindow(input)).toMatchObject({phase:'safety_latched',execution_allowed:false,canonical_stop_comparison:{class:'safety_regressed'}});expect(claimCanaryFocusedRun({...input,subjectHead:'9'.repeat(40),subjectTree:'0'.repeat(40)})).toMatchObject({result:'safety_latched',execution:'legacy',focused_run_id:null})});
});
