import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolveExecutionPlan, resolveManifestLane } from '../lib/execution-plan';
import { parseWorkProfile } from '../lib/work-profile';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createInstalledAuthorityFixture } from './helpers/installed-authority';

const root = join(import.meta.dir, '..');
let installed: ReturnType<typeof createInstalledAuthorityFixture>;
const profile = parseWorkProfile(readFileSync(join(import.meta.dir, 'fixtures/work-profile/valid.yaml'), 'utf8'));
const resolved: any = { schema_version: 'harness.gstack.work-profile.v1', mode: 'profile', activation: { docs_ux: 'legacy', single_repo_code: 'enforce', cross_repo_contract: 'legacy' }, lane: 'single_repo_code', lane_activation: 'enforce', execution: 'profile', trusted_base: { source: 'remote_default', target_ref: 'origin/main', target_sha: 'a'.repeat(40), candidate_sha: 'b'.repeat(40), merge_base_sha: 'a'.repeat(40) }, trusted_merge_base_sha: 'a'.repeat(40), profile_hash: profile.semantic_policy_hash, semantic_policy_hashes: {}, candidate_state: 'same', effective: profile, warnings: [] };
const manifest: any = { schema_version: 1, target_base_ref: 'origin/main', target_base_sha: 'a'.repeat(40), merge_base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40), wtree: 'c'.repeat(64), changed: [{ path: 'src/a.ts', roles: ['code'], source: 'committed' }], roles: ['code'], fallback_paths: [], declaration_required_paths: [], classification_state: 'complete', manifest_hash: 'd'.repeat(64) };

describe('fused execution plan', () => {
  beforeAll(() => {
    const build = spawnSync(process.execPath, ['run', 'scripts/build-authority-bundles.ts'], { timeout: 30_000, cwd: root, encoding: 'utf8' });
    expect(build.status, build.stderr).toBe(0);
    installed = createInstalledAuthorityFixture(root);
  });
  afterAll(() => installed.cleanup());
  test('rejects a resolved profile from a different lane',()=>{expect(()=>resolveExecutionPlan({skill:'ship',workKind:'release',finishLine:'pr_open',lane:'docs_ux',resolvedProfile:resolved,manifest})).toThrow('execution_plan_lane_mismatch')});
  test('derives one exact semantic landing lane from the same manifest used by the plan',()=>{expect(resolveManifestLane(null,{...manifest,roles:['runtime']})).toBe('single_repo_code');expect(resolveManifestLane(profile,{...manifest,roles:['docs'],changed:[{path:'docs/a.md',roles:['docs'],source:'committed'}]})).toBe('docs_ux');expect(resolveManifestLane(profile,manifest)).toBe('single_repo_code');expect(resolveManifestLane({...profile,dependency_surfaces:[{glob:'contracts/**',dependency_ids:['x'],capability_ids:['unit']}]},{...manifest,changed:[{path:'contracts/a.json',roles:['contract'],source:'committed'}],roles:['contract']})).toBe('cross_repo_contract')});
  test('returns one content-bound read-only decision without running validators or effects', () => {
    let spawnCount = 0;
    const plan = resolveExecutionPlan({ skill: 'review', workKind: 'review', finishLine: 'review_receipt', lane: 'single_repo_code', resolvedProfile: resolved, manifest, onSpawn: () => spawnCount++ });
    expect(plan.schema).toBe('ecpe.execution-plan.v1'); expect(plan.decision_id).toMatch(/^decision-[0-9a-f]{24}$/); expect(plan.requirements.validator_ids).toEqual(['unit']); expect(plan.evidence_requirements).toEqual([expect.objectContaining({ validator_id: 'unit', capability_id: 'unit', execution_effect: 'read' })]); expect(plan.effect_proposal).toEqual([]); expect(spawnCount).toBe(0);
  });
  test('hard-blocks PR effects while semantic declarations are missing', () => {
    const plan = resolveExecutionPlan({ skill: 'ship', workKind: 'release', finishLine: 'pr_open', lane: 'docs_ux', resolvedProfile: { ...resolved, lane: 'docs_ux', effective: profile }, manifest: { ...manifest, classification_state: 'semantic_declaration_required', declaration_required_paths: ['docs/new.md'] } });
    expect(plan.blockers).toContain('semantic_declaration_required'); expect(plan.effect_proposal).toEqual([]);
  });
  test('does not propose delivery effects while required evidence is stale', () => {
    const plan = resolveExecutionPlan({ skill: 'ship', workKind: 'release', finishLine: 'pr_open', lane: 'single_repo_code', resolvedProfile: { ...resolved, execution: 'profile' }, manifest, currentEvidence: [{ validator_id: 'unit', current: false }] });
    expect(plan.blockers).toEqual(['evidence_not_current:unit']);
    expect(plan.effect_proposal).toEqual([]);
  });
  test('blocks delivery when a candidate policy change is not promoted', () => {
    const plan = resolveExecutionPlan({ skill: 'ship', workKind: 'release', finishLine: 'pr_open', lane: 'single_repo_code', resolvedProfile: { ...resolved, execution: 'profile', candidate_state: 'ignored_untrusted' }, manifest, currentEvidence: [{ validator_id: 'unit', current: true }] });
    expect(plan.blockers).toContain('candidate_policy_unresolved');
    expect(plan.effect_proposal).toEqual([]);
  });
  test('the anchored CLI owns lifecycle and current-evidence projection in one process', () => {
    const state = mkdtempSync(join(tmpdir(), 'execution-plan-state-'));
    const repository = mkdtempSync(join(tmpdir(), 'execution-plan-repo-'));
    try {
      const runGit = (args: string[]) => { const result = spawnSync('/usr/bin/git', args, { timeout: 30_000, cwd: repository, encoding: 'utf8' }); if (result.status !== 0) throw new Error(result.stderr); };
      runGit(['init', '-b', 'main']); runGit(['config', 'user.name', 'T']); runGit(['config', 'user.email', 't@example.test']);
      writeFileSync(join(repository, 'README.md'), 'test\n'); runGit(['add', '.']); runGit(['commit', '-m', 'base']);
      runGit(['remote', 'add', 'origin', repository]); runGit(['fetch', 'origin', 'main:refs/remotes/origin/main']);
      const child = spawnSync(join(installed.bin, 'gstack-execution-plan'), ['resolve', '--skill', 'setup-deploy', '--work-kind', 'operation', '--finish-line', 'local_change', '--lane', 'auto', '--json'], { timeout: 30_000, cwd: repository, encoding: 'utf8', env: { ...process.env, ECPE_TESTING: '1', ECPE_TEST_STATE_ROOT: state, GSTACK_FORCE_LEGACY: '1' } });
      expect(child.status, child.stderr).toBe(0);
      const output = JSON.parse(child.stdout);
      expect(output.schema).toBe('ecpe.execution-plan.v1');
      expect(output.lifecycle).toEqual(expect.objectContaining({ run_id: expect.any(String), tel_start: expect.any(Number), slug: expect.any(String) }));
      expect(output.current_evidence).toBeArray();
      expect(output.initial_section_batches).toEqual([]);
      expect(child.stdout.trim().split('\n')).toHaveLength(1);
    } finally { rmSync(state, { recursive: true, force: true }); rmSync(repository, { recursive: true, force: true }); }
  });
});
