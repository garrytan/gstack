import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { decideLanePromotion, recordLanePromotionAssessment } from '../lib/lane-promotion';
import { applyProfilePromotion } from '../lib/profile-promotion-writer';
import { appendShipHandoff, inspectAssertedShipHandoff, inspectCurrentShipHandoff } from '../lib/ship-handoff';
import { parseWorkProfile } from '../lib/work-profile';
import type { ProviderHeadSnapshot } from '../lib/provider-access';

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
const git = (cwd: string, args: string[]) => { const result = spawnSync('/usr/bin/git', args, { timeout: 30_000, cwd, encoding: 'utf8' }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim(); };

describe('profile promotion gate', () => {
  test('requires one monotonic step, enough samples, and zero safety failures', () => {
    expect(decideLanePromotion({ from: 'shadow', to: 'enforce', sampleCount: 10, requiredSamples: 10, safetyFailures: 0, efficiencyRegressed: false }).decision).toBe('promote');
    expect(decideLanePromotion({ from: 'shadow', to: 'enforce', sampleCount: 10, requiredSamples: 10, safetyFailures: 1, efficiencyRegressed: false }).decision).toBe('safety_stop');
    expect(() => decideLanePromotion({ from: 'legacy', to: 'enforce', sampleCount: 10, requiredSamples: 10, safetyFailures: 0, efficiencyRegressed: false })).toThrow('promotion_not_monotonic');
  });

  test('binds the authorized promotion proof, write record, and committed candidate blob in ShipReceipt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ship-profile-promotion-')); roots.push(root);
    const cwd = join(root, 'repo'); const home = join(root, 'state');
    mkdirSync(cwd); mkdirSync(home, { mode: 0o700 }); mkdirSync(join(root, 'config')); mkdirSync(join(cwd, '.gstack')); mkdirSync(join(cwd, 'src'));
    const source = readFileSync(join(import.meta.dir, 'fixtures/work-profile/shadow.yaml'), 'utf8')
      .replace('  - glob: src/**\n    roles: [code]\n', '  - glob: src/**\n    roles: [code]\n  - glob: .gstack/work-profile.yaml\n    roles: [code]\n')
      .replace('argv: [bun, test]', 'argv: [/usr/bin/true]')
      .replace('docs_ux: { activation: legacy, required_capabilities: [], stage_requirements: {} }', 'docs_ux: { activation: shadow, required_capabilities: [], stage_requirements: {} }')
      .replace('single_repo_code: { activation: shadow, required_capabilities: [unit], stage_requirements: {} }', 'single_repo_code: { activation: legacy, required_capabilities: [unit], stage_requirements: {} }');
    writeFileSync(join(cwd, '.gstack/work-profile.yaml'), source); writeFileSync(join(cwd, 'src/a.ts'), 'one\n');
    git(cwd, ['init', '-b', 'main']); git(cwd, ['config', 'user.name', 'T']); git(cwd, ['config', 'user.email', 't@e']); git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'base']);
    const base = git(cwd, ['rev-parse', 'HEAD']); const tree = git(cwd, ['rev-parse', 'HEAD^{tree}']);
    git(cwd, ['update-ref', 'refs/remotes/origin/main', base]); git(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']); git(cwd, ['switch', '-c', 'feature']);
    writeFileSync(join(root, 'config/workspace-registry.toml'), `[registry]\nversion=2\n[[entry]]\nid="portfolioops"\npath="repo"\nkind="repository"\nremote_required=false\ntrusted_base_ref="refs/heads/main"\nactive=true\n`);
    const beforeProfile = parseWorkProfile(source);
    const assessment = recordLanePromotionAssessment({ stateRoot: home, snapshot: {
      block_id: `block-${'1'.repeat(32)}`, participant: 'portfolioops', lane: 'docs_ux', activation: 'shadow', profile_hash: beforeProfile.semantic_policy_hash,
      subject_head: base, subject_tree: tree, terminal_comparison_ids: ['1', '2', '3', '4', '5'], distinct_subject_heads: ['a', 'b', 'c'], elapsed_days: 14,
      surface_coverage_complete: true, hard_floor_coverage_complete: true, safety_statuses: ['pass'], unauthorized_effects: 0, content_leak_events: 0,
      added_paid_or_helper_calls: 0, unknown_validator_baselines: 0, efficiency_regressed: false,
    } });
    const written = applyProfilePromotion({ stateRoot: home, cwd, proofId: assessment.proof_id!, lane: 'docs_ux', assertSelector: '/lanes/docs_ux/activation' });
    writeFileSync(join(cwd, 'src/a.ts'), 'two\n'); git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'promote lane']); const head = git(cwd, ['rev-parse', 'HEAD']);
    const ensured = spawnSync(join(import.meta.dir, '..', 'bin/gstack-evidence'), ['ensure', '--validator', 'unit', '--lane', 'docs_ux', '--assert-target-ref', 'origin/main', '--json'], { timeout: 30_000, cwd, env: { ...process.env, GSTACK_HOME: home }, encoding: 'utf8' });
    expect(ensured.status).toBe(0);
    const snapshot: ProviderHeadSnapshot = { repositoryNameWithOwner: 'o/r', repositoryNodeId: 'R_1', headRepositoryNameWithOwner: 'o/r', headRepositoryNodeId: 'R_1', viewerPermission: 'WRITE', prNumber: 7, prState: 'OPEN', repositorySelector: 'o/r', targetRef: 'origin/main', baseRefName: 'main', baseRefOid: base, headRefName: 'feature', headRefOid: head, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', autoMergeRequest: null, mergeQueueEntry: null };
    const provider = async () => snapshot;
    const receipt = await appendShipHandoff({ cwd, pr: 7, assertTargetRef: 'origin/main', lane: 'auto', stateHome: home, provider });
    expect(receipt.promotion).toMatchObject({ lane: 'docs_ux', proof_id: assessment.proof_id, record_id: written.record_id });
    expect(await inspectCurrentShipHandoff({ cwd, pr: 7, assertTargetRef: 'origin/main', expectedBase: base, remotePrHead: head, stateHome: home, provider })).toMatchObject({
      current: true,
      candidate_profile: { git_blob_oid: git(cwd, ['rev-parse', 'HEAD:.gstack/work-profile.yaml']) },
      promotion: { proof_id: assessment.proof_id, record_id: written.record_id, subject_head: base, subject_tree: tree },
    });
    expect(inspectAssertedShipHandoff({ cwd, pr: 7, assertTargetRef: 'origin/main', expectedBase: base, remotePrHead: head, stateHome: home })).toMatchObject({ current: true, receipt_run_id: receipt.receipt_run_id });
  });
});
