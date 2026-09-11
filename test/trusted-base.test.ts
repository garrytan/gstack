import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveTrustedActivationSnapshot, resolveTrustedWorkProfile } from '../lib/trusted-base';
import { appendCanaryComparison, createCanaryPending, reconcileCanaryActivationLanding } from '../lib/lane-canary';
import { parseWorkProfile } from '../lib/work-profile';
import { prepareLandingIntent, reconcileLandingIntent } from '../lib/landing-safety';
import { startMilestoneBlock } from '../lib/milestone-block';

const roots: string[] = [];
const run = (cwd: string, args: string[]) => {
  const result = spawnSync('/usr/bin/git', args, { timeout: 30_000, cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
function repo(withProfile: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'trusted-base-')); roots.push(root);
  run(root, ['init', '-b', 'main']); run(root, ['config', 'user.name', 'Test']); run(root, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(root, 'README.md'), 'base\n');
  if (withProfile) { mkdirSync(join(root, '.gstack')); cpSync(join(import.meta.dir, 'fixtures/work-profile/shadow.yaml'), join(root, '.gstack/work-profile.yaml')); }
  run(root, ['add', '.']); run(root, ['commit', '-m', 'base']);
  run(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']); run(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  run(root, ['switch', '-c', 'feature']);
  return root;
}
function registeredLocalRepo(): { cwd: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), 'trusted-local-base-')); roots.push(root);
  const cwd = join(root, 'local'); mkdirSync(cwd); mkdirSync(join(root, 'config'));
  run(cwd, ['init', '-b', 'main']); run(cwd, ['config', 'user.name', 'Test']); run(cwd, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(cwd, 'README.md'), 'base\n'); mkdirSync(join(cwd, '.gstack')); cpSync(join(import.meta.dir, 'fixtures/work-profile/shadow.yaml'), join(cwd, '.gstack/work-profile.yaml'));
  run(cwd, ['add', '.']); run(cwd, ['commit', '-m', 'base']); const sha = run(cwd, ['rev-parse', 'HEAD']); run(cwd, ['switch', '-c', 'feature']);
  writeFileSync(join(root, 'config/workspace-registry.toml'), `[registry]\nversion = 2\n[[entry]]\nid = "local"\npath = "local"\nkind = "repository"\nremote_required = false\ntrusted_base_ref = "refs/heads/main"\nactive = true\n`);
  return { cwd, sha };
}
function registeredPortfolioEnforceRepo(): { cwd: string; sha: string; profileHash: string; stateRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'trusted-portfolio-base-')); roots.push(root);
  const cwd = join(root, 'portfolio'); const stateRoot = join(root, 'state'); mkdirSync(cwd); mkdirSync(stateRoot); mkdirSync(join(root, 'config')); mkdirSync(join(cwd, '.gstack'));
  run(cwd, ['init', '-b', 'main']); run(cwd, ['config', 'user.name', 'Test']); run(cwd, ['config', 'user.email', 'test@example.com']);
  const source = readFileSync(join(import.meta.dir, 'fixtures/work-profile/shadow.yaml'), 'utf8').replace('activation: shadow', 'activation: enforce');
  writeFileSync(join(cwd, '.gstack/work-profile.yaml'), source); writeFileSync(join(cwd, 'README.md'), 'base\n');
  run(cwd, ['add', '.']); run(cwd, ['commit', '-m', 'base']); const sha = run(cwd, ['rev-parse', 'HEAD']); run(cwd, ['switch', '-c', 'feature']);
  writeFileSync(join(root, 'config/workspace-registry.toml'), `[registry]\nversion = 2\n[[entry]]\nid = "portfolioops"\npath = "portfolio"\nkind = "repository"\nremote_required = false\ntrusted_base_ref = "refs/heads/main"\nactive = true\n`);
  return { cwd, sha, profileHash: parseWorkProfile(source).semantic_policy_hash, stateRoot };
}
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('trusted base profile resolution', () => {
  test('a first-profile candidate cannot activate itself', () => {
    const cwd = repo(false); mkdirSync(join(cwd, '.gstack')); cpSync(join(import.meta.dir, 'fixtures/work-profile/shadow.yaml'), join(cwd, '.gstack/work-profile.yaml'));
    const result = resolveTrustedWorkProfile({ cwd, lane: 'single_repo_code', assertTargetRef: 'origin/main' });
    expect(result.mode).toBe('legacy'); expect(result.execution).toBe('legacy'); expect(result.candidate_state).toBe('ignored_untrusted'); expect(result.effective).toBeNull();
  });

  test('trusted shadow computes policy but executes legacy', () => {
    const result = resolveTrustedWorkProfile({ cwd: repo(true), lane: 'single_repo_code', assertTargetRef: 'origin/main' });
    expect(result.mode).toBe('profile'); expect(result.lane_activation).toBe('shadow'); expect(result.execution).toBe('legacy'); expect(result.profile_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.trusted_base.source).toBe('remote_default');
  });

  test('freezes safety activations from the trusted base and excludes a candidate promotion', () => {
    const cwd = repo(true);
    const trusted = parseWorkProfile(readFile(join(cwd, '.gstack/work-profile.yaml')));
    const candidate = readFile(join(cwd, '.gstack/work-profile.yaml')).replaceAll('activation: shadow', 'activation: enforce');
    writeFileSync(join(cwd, '.gstack/work-profile.yaml'), candidate);
    const snapshot = resolveTrustedActivationSnapshot({ cwd, assertTargetRef: 'origin/main' });
    expect(snapshot.profile_blob_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.fromEntries(Object.entries(snapshot.activations).map(([lane, item]) => [lane, item.activation]))).toEqual(Object.fromEntries(Object.entries(trusted.lanes).map(([lane, item]) => [lane, item.activation])));
    expect(new Set(Object.values(snapshot.activations).map((item) => item.profile_lineage_hash)).size).toBe(1);
    expect(snapshot.activations.single_repo_code.profile_lineage_hash).not.toBe(parseWorkProfile(candidate).semantic_policy_hash);
  });

  test('target assertions cannot select a different base', () => {
    expect(() => resolveTrustedWorkProfile({ cwd: repo(true), lane: 'single_repo_code', assertTargetRef: 'main' })).toThrow('trusted_base_assertion_mismatch');
  });

  test('only exact GSTACK_FORCE_LEGACY=1 is accepted', () => {
    const cwd = repo(true); const source = join(cwd, '.gstack/work-profile.yaml'); writeFileSync(source, readFile(source).replace('activation: shadow', 'activation: enforce')); run(cwd, ['add', '.']); run(cwd, ['commit', '-m', 'enforce']); run(cwd, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    expect(resolveTrustedWorkProfile({ cwd, lane: 'single_repo_code', assertTargetRef: 'origin/main', environment: { GSTACK_FORCE_LEGACY: '1' } }).execution).toBe('legacy');
    expect(() => resolveTrustedWorkProfile({ cwd, lane: 'single_repo_code', environment: { GSTACK_FORCE_LEGACY: 'true' } })).toThrow('force_legacy_invalid');
  });

  test('allows a local comparison ref only as an explicitly advisory remote-less preview', () => {
    const cwd = repo(true);
    run(cwd, ['update-ref', '-d', 'refs/remotes/origin/HEAD']); run(cwd, ['update-ref', '-d', 'refs/remotes/origin/main']);
    const result = resolveTrustedWorkProfile({ cwd, lane: 'single_repo_code', advisoryComparisonRef: 'main' });
    expect(result.trusted_base.source).toBe('untrusted_comparison_ref');
    expect(result.execution).toBe('legacy');
    expect(result.warnings).toContain('untrusted_comparison_ref');
    expect(() => resolveTrustedWorkProfile({ cwd, lane: 'single_repo_code' })).toThrow('local_project_registry_missing');
  });

  test('uses the reviewed registry base for a remote-less repository and treats SHA as equality-only', () => {
    const { cwd, sha } = registeredLocalRepo();
    const result = resolveTrustedWorkProfile({ cwd, lane: 'single_repo_code', assertTargetSha: sha });
    expect(result.trusted_base).toMatchObject({ source: 'registry_pinned_commit', target_ref: 'refs/heads/main', target_sha: sha });
    expect(result.mode).toBe('profile');
    expect(() => resolveTrustedWorkProfile({ cwd, lane: 'single_repo_code', assertTargetSha: 'f'.repeat(40) })).toThrow('local_trusted_base_target_mismatch');
    expect(() => resolveTrustedWorkProfile({ cwd, lane: 'single_repo_code', assertTargetRef: 'refs/heads/main' })).toThrow('trusted_base_assertion_kind_mismatch');
  });

  test('requires a landed canary supersession before trusted enforce can execute profile gates', async () => {
    const { cwd, sha, profileHash, stateRoot } = registeredPortfolioEnforceRepo();
    const missing = resolveTrustedWorkProfile({ cwd, lane: 'single_repo_code', assertTargetSha: sha, safetyStateRoot: stateRoot });
    expect(missing.execution).toBe('legacy'); expect(missing.warnings).toContain('enforce_lineage_unresolved');
    createCanaryPending({ stateRoot, repoId: 'portfolioops', lane: 'single_repo_code', profileHash, promotionProofId: `promotion-${'1'.repeat(32)}`, promotionRecordId: `promotion-write-${'2'.repeat(32)}`, promotionLandingIntentId: `landing-${'3'.repeat(32)}`, promotionCheckpointId: `checkpoint-${'4'.repeat(32)}`, promotionReceiptId: `receipt-${'5'.repeat(32)}` });
    const pending = resolveTrustedWorkProfile({ cwd, lane: 'single_repo_code', assertTargetSha: sha, safetyStateRoot: stateRoot });
    expect(pending.execution).toBe('legacy'); expect(pending.warnings).toContain('canary_pending');
    const started = startMilestoneBlock({ stateRoot, roots: { code_root_id: 'code', workspace_root_id: 'workspace', state_root_id: 'state' }, codeRootHead: sha, registryHash: '6'.repeat(64), duration: 'P30D', participants: ['harness-governance', 'portfolioops', 'cdo-os'], lanes: ['docs_ux', 'single_repo_code', 'cross_repo_contract'] });
    const blockId = started.block.block_id; const subjectTree = run(cwd, ['rev-parse', 'HEAD^{tree}']); const policyHash = started.block.policy_hash;
    const comparison = (head: string, tree: string) => ({ source_block_id: blockId, subject_head: head, subject_tree: tree, focused_run_id: `focused-${head.slice(0, 32)}`, legacy_control_run_id: `control-${head.slice(0, 32)}`, policy_hash: policyHash, host_fingerprint: 'host-a', class: 'passed' as const, focused_duration_ms: 8, legacy_duration_ms: 10, focused_context_bytes: 8, legacy_context_bytes: 10, focused_spawns: 0, legacy_spawns: 0, focused_tokens: null, legacy_tokens: null, token_provenance: 'unknown' as const });
    appendCanaryComparison({ stateRoot, repoId: 'portfolioops', lane: 'single_repo_code', profileHash, comparison: comparison('1'.repeat(40), 'a'.repeat(40)) });
    appendCanaryComparison({ stateRoot, repoId: 'portfolioops', lane: 'single_repo_code', profileHash, comparison: comparison('2'.repeat(40), 'b'.repeat(40)) });
    const ready = appendCanaryComparison({ stateRoot, repoId: 'portfolioops', lane: 'single_repo_code', profileHash, comparison: comparison(sha, subjectTree) });
    const providerIntentRoot = join(stateRoot, 'provider-intents'); const repositoryNodeId = 'R_local';
    const descriptor = { repoId: 'local/portfolioops', repositoryNodeId, prNumber: 7, expectedHeadOid: sha, expectedBaseOid: sha, targetRef: 'origin/main', mode: 'direct_observed' as const, providerOperationId: 'local:direct-pr:7' };
    const mergeProvider = async () => { const intent = prepareLandingIntent(providerIntentRoot, descriptor); reconcileLandingIntent(providerIntentRoot, intent.intentId, { terminal: false, providerState: 'merged', headOid: sha, baseOid: sha, mergeSha: 'd'.repeat(40), mergeTreeMatches: true }); return { status: 'merged' as const, mergeSha: 'd'.repeat(40), expectedHeadOid: sha, expectedBaseOid: sha, intentId: intent.intentId, baseAtomicity: 'verified' as const }; };
    const claim = { block_id: blockId, lane: 'single_repo_code' as const, focused_run_id: `focused-${sha.slice(0, 32)}`, profile_hash: profileHash, promotion_proof_id: `promotion-${'1'.repeat(32)}`, subject_head: sha, subject_tree: subjectTree, policy_hash: policyHash };
    await reconcileCanaryActivationLanding({ stateRoot, providerIntentRoot, repoId: 'portfolioops', lane: 'single_repo_code', profileHash, blockId, activationProofId: ready.activation_proof_id!, expectedRepositoryNodeId: repositoryNodeId, mergeProvider, handoff: { current: true, receipt_run_id: `evidence-${'8'.repeat(32)}`, repo_id: 'portfolioops', pr: 7, base_ref: 'origin/main', base_sha: sha, remote_pr_head_sha: sha, remote_pr_head_tree: subjectTree, profile_hash: profileHash, canary_subject: claim } });
    expect(resolveTrustedWorkProfile({ cwd, lane: 'single_repo_code', assertTargetSha: sha, safetyStateRoot: stateRoot }).execution).toBe('profile');
  });
});

function readFile(path: string): string { return readFileSync(path, 'utf8'); }
