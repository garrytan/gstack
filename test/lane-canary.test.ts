import { afterAll, describe, expect, test } from 'bun:test';
import {
  aggregateCanaryWindow,
  appendCanaryComparison,
  createCanaryPending,
  evaluateCanaryPair,
  inspectCanaryWindow,
  claimCanaryFocusedRun,
  inspectCanaryShipCandidate,
  resolveCanaryExecutionGate,
  prepareCanaryControl,
  startCanaryControl,
  terminalCanaryControl,
  bindCanaryFocusedComparison,
} from '../lib/lane-canary';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
describe('paired lane canary', () => { test('fails closed on safety mismatch and distinguishes efficiency uncertainty', () => { expect(evaluateCanaryPair({ legacy: { safety: 'pass', durationMs: 100 }, profile: { safety: 'fail', durationMs: 80 } }).result).toBe('safety_regressed'); expect(evaluateCanaryPair({ legacy: { safety: 'pass', durationMs: 100 }, profile: { safety: 'pass', durationMs: null } }).result).toBe('efficiency_inconclusive'); expect(evaluateCanaryPair({ legacy: { safety: 'pass', durationMs: 100 }, profile: { safety: 'pass', durationMs: 80 } }).result).toBe('qualified'); }); });
describe('canary window aggregate',()=>{test('requires three ordered distinct same-host samples and keeps token unknown explicit',()=>{const sample=(ordinal:number)=>({comparison_id:`comparison-${ordinal}`,ordinal,subject_head:String(ordinal).repeat(40),host_fingerprint:'host-a',class:'passed' as const,focused_duration_ms:80,legacy_duration_ms:100,focused_context_bytes:80,legacy_context_bytes:100,focused_spawns:1,legacy_spawns:1,focused_tokens:null,legacy_tokens:null,token_provenance:'unknown' as const});expect(aggregateCanaryWindow({windowId:'window-1',lane:'single_repo_code',comparisons:[sample(1),sample(2)]})).toMatchObject({result:'efficiency_inconclusive',activation_proof_id:null,next_ordinal:3});expect(aggregateCanaryWindow({windowId:'window-1',lane:'single_repo_code',comparisons:[sample(1),sample(2),sample(3)]})).toMatchObject({result:'passed',token_effect:'unknown'});expect(()=>aggregateCanaryWindow({windowId:'window-1',lane:'single_repo_code',comparisons:[sample(1),{...sample(2),host_fingerprint:'host-b'}]})).toThrow('canary_window_invalid')})});

test('comparable token regression never opens activation', () => {
  const sample = (ordinal: number) => ({ comparison_id: `comparison-token-${ordinal}`, ordinal, subject_head: String(ordinal).repeat(40), host_fingerprint: 'host-a', class: 'passed' as const, focused_duration_ms: 80, legacy_duration_ms: 100, focused_context_bytes: 80, legacy_context_bytes: 100, focused_spawns: 1, legacy_spawns: 1, focused_tokens: 110, legacy_tokens: 100, token_provenance: 'host_reported' as const });
  expect(aggregateCanaryWindow({ windowId: 'window-token', lane: 'single_repo_code', comparisons: [sample(1), sample(2), sample(3)] })).toMatchObject({ result: 'efficiency_regressed', token_effect: 'regressed', activation_proof_id: null });
});

describe('durable canary activation gate', () => {
  test('binds a pre-ready ShipReceipt only to the exact focused reservation', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'canary-state-')); roots.push(stateRoot);
    const profileHash = '0'.repeat(64); const blockId = `block-${'1'.repeat(32)}`; const subjectHead = '2'.repeat(40); const subjectTree = '3'.repeat(40); const policyHash = '4'.repeat(64);
    createCanaryPending({ stateRoot, repoId: 'portfolioops', lane: 'single_repo_code', profileHash, promotionProofId: `promotion-${'5'.repeat(32)}`, promotionRecordId: `promotion-write-${'6'.repeat(32)}`, promotionLandingIntentId: `landing-${'7'.repeat(32)}`, promotionCheckpointId: `checkpoint-${'8'.repeat(32)}`, promotionReceiptId: `evidence-${'9'.repeat(32)}` });
    const reserved = claimCanaryFocusedRun({ stateRoot, repoId: 'portfolioops', lane: 'single_repo_code', profileHash, blockId, participant: 'portfolioops', subjectHead, subjectTree, hostFingerprint: 'host-a', policyHash });
    expect(inspectCanaryShipCandidate({ stateRoot, repoId: 'portfolioops', lane: 'single_repo_code', profileHash, blockId, subjectHead, subjectTree })).toMatchObject({ focused_run_id: reserved.focused_run_id, block_id: blockId, subject_head: subjectHead, subject_tree: subjectTree });
    expect(() => inspectCanaryShipCandidate({ stateRoot, repoId: 'portfolioops', lane: 'single_repo_code', profileHash, blockId, subjectHead: 'a'.repeat(40), subjectTree })).toThrow('canary_ship_candidate_missing');
  });
  test('keeps enforce execution closed until the ready proof is landing-bound', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'canary-state-')); roots.push(stateRoot);
    const profileHash = 'a'.repeat(64);
    const pending = createCanaryPending({
      stateRoot, repoId: 'portfolioops', lane: 'single_repo_code', profileHash,
      promotionProofId: `promotion-${'b'.repeat(32)}`,
      promotionRecordId: `promotion-write-${'c'.repeat(32)}`,
      promotionLandingIntentId: `landing-${'d'.repeat(32)}`,
      promotionCheckpointId: `checkpoint-${'e'.repeat(32)}`,
      promotionReceiptId: `receipt-${'f'.repeat(32)}`,
    });
    expect(pending).toMatchObject({ phase: 'pending', sample_count: 0, execution_allowed: false });
    expect(createCanaryPending({
      stateRoot, repoId: 'portfolioops', lane: 'single_repo_code', profileHash,
      promotionProofId: `promotion-${'b'.repeat(32)}`,
      promotionRecordId: `promotion-write-${'c'.repeat(32)}`,
      promotionLandingIntentId: `landing-${'d'.repeat(32)}`,
      promotionCheckpointId: `checkpoint-${'e'.repeat(32)}`,
      promotionReceiptId: `receipt-${'f'.repeat(32)}`,
    }).result).toBe('reused');
    expect(statSync(join(stateRoot, 'ecpe', 'lane-canary', 'portfolioops', 'single_repo_code', `${profileHash}.json`)).mode & 0o777).toBe(0o600);

    const sample = (subjectHead: string) => ({
      subject_head: subjectHead, host_fingerprint: 'host-a', class: 'passed' as const,
      focused_duration_ms: 80, legacy_duration_ms: 100,
      focused_context_bytes: 80, legacy_context_bytes: 100,
      focused_spawns: 1, legacy_spawns: 1,
      focused_tokens: null, legacy_tokens: null, token_provenance: 'unknown' as const,
    });
    appendCanaryComparison({ stateRoot, repoId: 'portfolioops', lane: 'single_repo_code', profileHash, comparison: sample('1'.repeat(40)) });
    appendCanaryComparison({ stateRoot, repoId: 'portfolioops', lane: 'single_repo_code', profileHash, comparison: sample('2'.repeat(40)) });
    const ready = appendCanaryComparison({ stateRoot, repoId: 'portfolioops', lane: 'single_repo_code', profileHash, comparison: sample('3'.repeat(40)) });
    expect(ready).toMatchObject({ phase: 'aggregate_ready', sample_count: 3, execution_allowed: false });
    expect(() => appendCanaryComparison({ stateRoot, repoId: 'portfolioops', lane: 'single_repo_code', profileHash, comparison: sample('4'.repeat(40)) })).toThrow('canary_aggregate_ready');
    expect(resolveCanaryExecutionGate({ stateRoot, repoId: 'portfolioops', lane: 'single_repo_code', profileHash })).toMatchObject({ execution_allowed: false, reason: 'canary_pending' });

    expect(inspectCanaryWindow({ stateRoot, repoId: 'portfolioops', lane: 'single_repo_code', profileHash })).toMatchObject({ phase: 'aggregate_ready', sample_count: 3, execution_allowed: false });
  });

  test('recovers the third comparison after aggregate-ready publication but before focused-slot binding', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'canary-state-')); roots.push(stateRoot);
    const profileHash = '6'.repeat(64); const blockId = `block-${'7'.repeat(32)}`; const policyHash = '8'.repeat(64);
    createCanaryPending({ stateRoot, repoId: 'portfolioops', lane: 'single_repo_code', profileHash, promotionProofId: `promotion-${'9'.repeat(32)}`, promotionRecordId: `promotion-write-${'a'.repeat(32)}`, promotionLandingIntentId: `landing-${'b'.repeat(32)}`, promotionCheckpointId: `checkpoint-${'c'.repeat(32)}`, promotionReceiptId: `evidence-${'d'.repeat(32)}` });
    const comparison = (subjectHead: string, subjectTree: string, focusedRunId: string) => ({ source_block_id: blockId, subject_head: subjectHead, subject_tree: subjectTree, focused_run_id: focusedRunId, legacy_control_run_id: `control-${subjectHead.slice(0, 32)}`, policy_hash: policyHash, host_fingerprint: 'host-a', class: 'passed' as const, focused_duration_ms: 80, legacy_duration_ms: 100, focused_context_bytes: 80, legacy_context_bytes: 100, focused_spawns: 1, legacy_spawns: 1, focused_tokens: null, legacy_tokens: null, token_provenance: 'unknown' as const, focused_outcome: 'pass' as const, legacy_control_outcome: 'pass' as const });
    appendCanaryComparison({ stateRoot, repoId: 'portfolioops', lane: 'single_repo_code', profileHash, comparison: comparison('1'.repeat(40), '2'.repeat(40), `focused-${'1'.repeat(32)}`) });
    appendCanaryComparison({ stateRoot, repoId: 'portfolioops', lane: 'single_repo_code', profileHash, comparison: comparison('3'.repeat(40), '4'.repeat(40), `focused-${'3'.repeat(32)}`) });
    const binding = { stateRoot, repoId: 'portfolioops', lane: 'single_repo_code' as const, profileHash, blockId, participant: 'portfolioops' as const, subjectHead: '5'.repeat(40), subjectTree: '6'.repeat(40), hostFingerprint: 'host-a', policyHash };
    const focusedRunId = claimCanaryFocusedRun(binding).focused_run_id!;
    prepareCanaryControl({ ...binding, focusedRunId }); startCanaryControl({ ...binding, focusedRunId });
    terminalCanaryControl({ ...binding, focusedRunId, measurement: { outcome: 'pass', durationMs: 100, contextBytes: 100, helperSpawns: 1, modelSpawns: 0, unauthorizedEffects: 0, tokens: { total: null, provenance: 'unknown' } } });
    const input = { stateRoot, repoId: 'portfolioops', lane: 'single_repo_code' as const, profileHash, comparison: comparison(binding.subjectHead, binding.subjectTree, focusedRunId) };
    const ready = appendCanaryComparison(input);
    expect(ready.phase).toBe('aggregate_ready');
    const recovered = appendCanaryComparison(input);
    expect(recovered).toMatchObject({ result: 'reused', phase: 'aggregate_ready', sample_count: 3 });
    bindCanaryFocusedComparison({ ...binding, focusedRunId, comparisonId: recovered.comparison_ids[2] });
    expect(inspectCanaryWindow({ stateRoot, repoId: 'portfolioops', lane: 'single_repo_code', profileHash })).toMatchObject({ phase: 'aggregate_ready', focused_run_phase: 'comparison_appended' });
  });

  test('rejects duplicate subjects, host movement, and a sixth sample', () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'canary-state-')); roots.push(stateRoot);
    const profileHash = '4'.repeat(64);
    createCanaryPending({ stateRoot, repoId: 'portfolioops', lane: 'docs_ux', profileHash, promotionProofId: `promotion-${'5'.repeat(32)}`, promotionRecordId: `promotion-write-${'6'.repeat(32)}`, promotionLandingIntentId: `landing-${'7'.repeat(32)}`, promotionCheckpointId: `checkpoint-${'8'.repeat(32)}`, promotionReceiptId: `receipt-${'9'.repeat(32)}` });
    const comparison = (head: string, host = 'host-a') => ({ subject_head: head, host_fingerprint: host, class: 'efficiency_inconclusive' as const, focused_duration_ms: null, legacy_duration_ms: 1, focused_context_bytes: null, legacy_context_bytes: 1, focused_spawns: null, legacy_spawns: 0, focused_tokens: null, legacy_tokens: null, token_provenance: 'unknown' as const });
    appendCanaryComparison({ stateRoot, repoId: 'portfolioops', lane: 'docs_ux', profileHash, comparison: comparison('1'.repeat(40)) });
    expect(appendCanaryComparison({ stateRoot, repoId: 'portfolioops', lane: 'docs_ux', profileHash, comparison: comparison('1'.repeat(40)) }).result).toBe('reused');
    expect(() => appendCanaryComparison({ stateRoot, repoId: 'portfolioops', lane: 'docs_ux', profileHash, comparison: { ...comparison('1'.repeat(40)), legacy_duration_ms: 2 } })).toThrow('canary_subject_reused');
    expect(() => appendCanaryComparison({ stateRoot, repoId: 'portfolioops', lane: 'docs_ux', profileHash, comparison: comparison('2'.repeat(40), 'host-b') })).toThrow('canary_host_moved');
    for (const digit of ['2', '3', '4', '5']) appendCanaryComparison({ stateRoot, repoId: 'portfolioops', lane: 'docs_ux', profileHash, comparison: comparison(digit.repeat(40)) });
    expect(inspectCanaryWindow({ stateRoot, repoId: 'portfolioops', lane: 'docs_ux', profileHash })).toMatchObject({ sample_count: 5, aggregate_result: 'efficiency_regressed', next_ordinal: null, next_operation: 'lane_canary_cap_review' });
    expect(() => appendCanaryComparison({ stateRoot, repoId: 'portfolioops', lane: 'docs_ux', profileHash, comparison: comparison('6'.repeat(40)) })).toThrow('canary_sample_cap_exceeded');
  });
});
