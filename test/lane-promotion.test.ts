import { afterAll, describe, expect, test } from 'bun:test';
import { assessLanePromotionSnapshot, decideLanePromotion, inspectLanePromotionAssessment, LANE_PROMOTION_POLICY_HASH, recordLanePromotionAssessment } from '../lib/lane-promotion';
import { applyProfilePromotion, inspectProfilePromotion, reconcileProfilePromotion } from '../lib/profile-promotion-writer';
import { parseWorkProfile } from '../lib/work-profile';
import { resolveTrustedWorkProfile } from '../lib/trusted-base';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
const git = (cwd: string, args: string[]) => { const result = spawnSync('/usr/bin/git', args, { timeout: 30_000, cwd, encoding: 'utf8' }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim(); };

describe('lane promotion policy', () => {
  test('is monotonic and requires safety-clean proof', () => {
    expect(decideLanePromotion({ from: 'legacy', to: 'shadow', sampleCount: 10, requiredSamples: 10, safetyFailures: 0, efficiencyRegressed: false }).decision).toBe('promote');
    expect(decideLanePromotion({ from: 'shadow', to: 'enforce', sampleCount: 10, requiredSamples: 10, safetyFailures: 1, efficiencyRegressed: false }).decision).toBe('safety_stop');
    expect(() => decideLanePromotion({ from: 'shadow', to: 'legacy', sampleCount: 10, requiredSamples: 10, safetyFailures: 0, efficiencyRegressed: false })).toThrow('promotion_not_monotonic');
  });
});

describe('compiled promotion snapshot', () => {
  test('uses fixed lane thresholds and emits no proof for unknown safety', () => {
    const base = { block_id: 'block-1', participant: 'portfolioops' as const, lane: 'single_repo_code' as const, activation: 'shadow' as const, profile_hash: 'a'.repeat(64), subject_head: 'b'.repeat(40), subject_tree: 'c'.repeat(40), terminal_comparison_ids: ['1', '2', '3', '4', '5'], distinct_subject_heads: ['a', 'b', 'c'], elapsed_days: 14, surface_coverage_complete: true, hard_floor_coverage_complete: true, safety_statuses: ['pass', 'not_applicable'] as Array<'pass' | 'not_applicable' | 'unknown' | 'regressed'>, unauthorized_effects: 0, content_leak_events: 0, added_paid_or_helper_calls: 0, unknown_validator_baselines: 0, efficiency_regressed: false };
    const eligible = assessLanePromotionSnapshot(base);
    expect(eligible.proof_id).toMatch(/^promotion-/); expect(eligible.policy_hash).toBe(LANE_PROMOTION_POLICY_HASH);
    expect(assessLanePromotionSnapshot({ ...base, safety_statuses: ['unknown'] })).toMatchObject({ eligible: false, proof_id: null, reason_codes: ['safety_unknown'] });
    expect(assessLanePromotionSnapshot({ ...base, terminal_comparison_ids: ['1'] })).toMatchObject({ eligible: false, proof_id: null, reason_codes: ['insufficient_comparisons'] });
  });
});

test('durably recovers one exact eligible proof and rejects evidence movement', () => {
  const state = mkdtempSync(join(tmpdir(), 'promotion-')); roots.push(state);
  const snapshot = { block_id: `block-${'1'.repeat(32)}`, participant: 'portfolioops' as const, lane: 'docs_ux' as const, activation: 'shadow' as const, profile_hash: 'a'.repeat(64), subject_head: 'b'.repeat(40), subject_tree: 'c'.repeat(40), terminal_comparison_ids: ['1', '2', '3'], distinct_subject_heads: ['a', 'b'], elapsed_days: 7, surface_coverage_complete: true, hard_floor_coverage_complete: true, safety_statuses: ['pass'] as const, unauthorized_effects: 0, content_leak_events: 0, added_paid_or_helper_calls: 0, unknown_validator_baselines: 0, efficiency_regressed: false };
  const first = recordLanePromotionAssessment({ stateRoot: state, snapshot: { ...snapshot, safety_statuses: [...snapshot.safety_statuses] } });
  expect(first).toMatchObject({ result: 'eligible', eligible: true });
  expect(recordLanePromotionAssessment({ stateRoot: state, snapshot: { ...snapshot, safety_statuses: [...snapshot.safety_statuses] } }).result).toBe('reused');
  expect(inspectLanePromotionAssessment({ stateRoot: state, blockId: snapshot.block_id, participant: 'portfolioops', lane: 'docs_ux' })).toMatchObject({ phase: 'eligible', proof_id: first.proof_id });
  expect(() => recordLanePromotionAssessment({ stateRoot: state, snapshot: { ...snapshot, safety_statuses: ['pass'], terminal_comparison_ids: ['1', '2', '3', '4'] } })).toThrow('promotion_evidence_moved');
});

test('closed writer changes only the selected shadow scalar and authorizes only that candidate', () => {
  const root = mkdtempSync(join(tmpdir(), 'promotion-writer-')); roots.push(root);
  const repo = join(root, 'repo'); const state = join(root, 'state');
  mkdirSync(repo); mkdirSync(state); mkdirSync(join(root, 'config')); mkdirSync(join(repo, '.gstack'));
  const source = readFileSync(join(import.meta.dir, 'fixtures/work-profile/shadow.yaml'), 'utf8');
  writeFileSync(join(repo, '.gstack/work-profile.yaml'), source);
  git(repo, ['init', '-b', 'main']); git(repo, ['config', 'user.name', 'T']); git(repo, ['config', 'user.email', 't@e']); git(repo, ['add', '.']); git(repo, ['commit', '-m', 'base']);
  const head = git(repo, ['rev-parse', 'HEAD']); const tree = git(repo, ['rev-parse', 'HEAD^{tree}']); const profile = parseWorkProfile(source);
  writeFileSync(join(root, 'config/workspace-registry.toml'), `[registry]\nversion=2\n[[entry]]\nid="portfolioops"\npath="repo"\nkind="repository"\nremote_required=false\ntrusted_base_ref="refs/heads/main"\nactive=true\n`);
  git(repo, ['switch', '-c', 'feature']);
  const snapshot = { block_id: `block-${'2'.repeat(32)}`, participant: 'portfolioops' as const, lane: 'single_repo_code' as const, activation: 'shadow' as const, profile_hash: profile.semantic_policy_hash, subject_head: head, subject_tree: tree, terminal_comparison_ids: ['1', '2', '3', '4', '5'], distinct_subject_heads: ['a', 'b', 'c'], elapsed_days: 14, surface_coverage_complete: true, hard_floor_coverage_complete: true, safety_statuses: ['pass'] as Array<'pass'>, unauthorized_effects: 0, content_leak_events: 0, added_paid_or_helper_calls: 0, unknown_validator_baselines: 0, efficiency_regressed: false };
  const proof = recordLanePromotionAssessment({ stateRoot: state, snapshot });
  const written = applyProfilePromotion({ stateRoot: state, cwd: repo, proofId: proof.proof_id!, lane: 'single_repo_code', assertSelector: '/lanes/single_repo_code/activation' });
  expect(written).toMatchObject({ result: 'written', phase: 'written' });
  const after = readFileSync(join(repo, '.gstack/work-profile.yaml'), 'utf8'); expect(after.replace('activation: enforce', 'activation: shadow')).toBe(source);
  expect(inspectProfilePromotion({ stateRoot: state, blockId: snapshot.block_id, lane: 'single_repo_code' })).toMatchObject({ phase: 'written', record_id: written.record_id });
  expect(reconcileProfilePromotion({ stateRoot: state, cwd: repo, blockId: snapshot.block_id, lane: 'single_repo_code' }).result).toBe('reused');
  expect(applyProfilePromotion({ stateRoot: state, cwd: repo, proofId: proof.proof_id!, lane: 'single_repo_code', assertSelector: '/lanes/single_repo_code/activation' }).result).toBe('reused');
  const resolved = resolveTrustedWorkProfile({ cwd: repo, lane: 'single_repo_code', assertTargetSha: head, safetyStateRoot: state });
  expect(resolved.candidate_state).toBe('authorized_promotion'); expect(resolved.lane_activation).toBe('enforce'); expect(resolved.execution).toBe('legacy'); expect(resolved.warnings).toContain('enforce_lineage_unresolved');
  expect(resolved.promotion_lineage).toMatchObject({ proof_id: proof.proof_id, record_id: written.record_id, before_profile_hash: profile.semantic_policy_hash });
});
