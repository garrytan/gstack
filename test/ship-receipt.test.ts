import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendShipHandoff, inspectCurrentShipHandoff } from '../lib/ship-handoff';
import type { ProviderHeadSnapshot } from '../lib/provider-access';
import { appendJsonl } from '../lib/jsonl-store';

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
function git(cwd: string, args: string[]) { const result = spawnSync('/usr/bin/git', args, { timeout: 30_000, cwd, encoding: 'utf8' }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim(); }
function fixture(activeRelease = false) {
  const root = mkdtempSync(join(tmpdir(), 'ship-receipt-')); roots.push(root); const cwd = join(root, 'repo'); const home = join(root, 'home'); mkdirSync(cwd); mkdirSync(home); mkdirSync(join(root, 'config')); mkdirSync(join(cwd, '.gstack'));
  git(cwd, ['init', '-b', 'main']); git(cwd, ['config', 'user.name', 'T']); git(cwd, ['config', 'user.email', 't@e']);
  writeFileSync(join(cwd, '.gstack/work-profile.yaml'), `schema_version: harness.gstack.work-profile.v1
semantic_paths:
  - glob: src/**
    roles: [code]
capabilities: { unit: { version: "1" } }
validators:
  unit:
    capability: unit
    execution_effect: read
    argv: [/usr/bin/true]
    required_by_surface: [code]
    depends_on: [code]
lanes:
  docs_ux: { activation: legacy, required_capabilities: [], stage_requirements: {} }
  single_repo_code: { activation: enforce, required_capabilities: [unit], stage_requirements: { pr_open: [unit] } }
  cross_repo_contract: { activation: legacy, required_capabilities: [], stage_requirements: {} }
release: ${activeRelease ? `
  mode: per_pr
  title_policy: version_prefix
  version_source: { path: VERSION, format: plain_text, selector: whole_file }
  version_targets:
    - { path: VERSION, format: plain_text, selector: whole_file, value_encoding: exact }` : '{ mode: none, title_policy: free }'}
metadata_projections:${activeRelease ? `
  - { path: VERSION, format: plain_text, selector: whole_file }` : ' []'}
deploy_targets:
  none: { id: none, environment_class: none, trigger: none, binding: { adapter_id: none.v1 } }
recording: { response: response, artifact: receipt, local_change: session, review_receipt: session, pr_open: session, merged: release, deployed: release, verified: session, operation_result: session }
`);
  mkdirSync(join(cwd, 'src')); writeFileSync(join(cwd, 'src/a.ts'), 'one\n'); if (activeRelease) writeFileSync(join(cwd, 'VERSION'), '1.0.0\n'); git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'base']); const base = git(cwd, ['rev-parse', 'HEAD']);
  git(cwd, ['update-ref', 'refs/remotes/origin/main', base]); git(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']); git(cwd, ['switch', '-c', 'feature']); writeFileSync(join(cwd, 'src/a.ts'), 'two\n'); if (activeRelease) writeFileSync(join(cwd, 'VERSION'), '1.0.1\n'); git(cwd, ['add', '.']); git(cwd, ['commit', '-m', 'change']); const head = git(cwd, ['rev-parse', 'HEAD']);
  writeFileSync(join(root, 'config/workspace-registry.toml'), `[registry]\nversion=2\n[[entry]]\nid="fixture"\npath="repo"\nkind="repository"\nremote_required=false\ntrusted_base_ref="refs/heads/main"\nactive=true\n`);
  const snapshot: ProviderHeadSnapshot = { repositoryNameWithOwner: 'o/r', repositoryNodeId: 'R_1', headRepositoryNameWithOwner: 'o/r', headRepositoryNodeId: 'R_1', viewerPermission: 'WRITE', prNumber: 7, prState: 'OPEN', repositorySelector: 'o/r', targetRef: 'origin/main', baseRefName: 'main', baseRefOid: base, headRefName: 'feature', headRefOid: head, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', autoMergeRequest: null, mergeQueueEntry: null };
  return { root, cwd, home, base, head, snapshot };
}

describe('ship handoff receipt', () => {
  test('writes and re-reads one exact live-head handoff only after required evidence is current', async () => {
    const f = fixture();
    const ensured = spawnSync(join(import.meta.dir, '..', 'bin/gstack-evidence'), ['ensure', '--validator', 'unit', '--assert-target-ref', 'origin/main', '--json'], { timeout: 30_000, cwd: f.cwd, env: { ...process.env, GSTACK_HOME: f.home }, encoding: 'utf8' });
    expect(ensured.status).toBe(0);
    const provider = async () => f.snapshot;
    const written = await appendShipHandoff({ cwd: f.cwd, pr: 7, assertTargetRef: 'origin/main', stateHome: f.home, provider });
    expect(written.validation_run_ids).toHaveLength(1);
    expect(await inspectCurrentShipHandoff({ cwd: f.cwd, pr: 7, assertTargetRef: 'origin/main', expectedBase: f.base, remotePrHead: f.head, stateHome: f.home, provider })).toMatchObject({ current: true, pr: 7, remote_pr_head_sha: f.head });
    await expect(inspectCurrentShipHandoff({ cwd: f.cwd, pr: 7, assertTargetRef: 'origin/main', expectedBase: f.base, remotePrHead: 'f'.repeat(40), stateHome: f.home, provider })).rejects.toThrow('provider_head_moved');
    const retried = await appendShipHandoff({ cwd: f.cwd, pr: 7, assertTargetRef: 'origin/main', stateHome: f.home, provider });
    expect(retried).toEqual(written);
    const ledger = readFileSync(join(f.home, 'projects', 'fixture', 'feature-evidence.jsonl'), 'utf8').trim().split('\n');
    expect(ledger).toHaveLength(2); // validator receipt plus exactly one ShipReceipt
    const ship = ledger.map(line => JSON.parse(line)).find(row => row.validator?.id === 'gstack.ship-handoff');
    appendJsonl(join(f.home, 'projects', 'fixture', 'feature-evidence.jsonl'), { ...ship, handoff: { ...ship.handoff, manifest_hash: 'f'.repeat(64) } }, { mode: 0o600 });
    await expect(inspectCurrentShipHandoff({ cwd: f.cwd, pr: 7, assertTargetRef: 'origin/main', expectedBase: f.base, remotePrHead: f.head, stateHome: f.home, provider })).rejects.toThrow('ship_handoff_ambiguous');
  });

  test('concurrent retries publish one stable receipt', async () => {
    const f = fixture();
    const ensured = spawnSync(join(import.meta.dir, '..', 'bin/gstack-evidence'), ['ensure', '--validator', 'unit', '--assert-target-ref', 'origin/main', '--json'], { timeout: 30_000, cwd: f.cwd, env: { ...process.env, GSTACK_HOME: f.home }, encoding: 'utf8' });
    expect(ensured.status).toBe(0); const provider = async () => f.snapshot;
    const raced = await Promise.all([appendShipHandoff({ cwd: f.cwd, pr: 7, assertTargetRef: 'origin/main', stateHome: f.home, provider }), appendShipHandoff({ cwd: f.cwd, pr: 7, assertTargetRef: 'origin/main', stateHome: f.home, provider })]);
    expect(raced[0]).toEqual(raced[1]);
    const lines = () => readFileSync(join(f.home, 'projects', 'fixture', 'feature-evidence.jsonl'), 'utf8').trim().split('\n');
    expect(lines()).toHaveLength(2);
  });

  test('response loss after durable publication returns the frozen receipt on retry', async () => {
    const f = fixture();
    const ensured = spawnSync(join(import.meta.dir, '..', 'bin/gstack-evidence'), ['ensure', '--validator', 'unit', '--assert-target-ref', 'origin/main', '--json'], { timeout: 30_000, cwd: f.cwd, env: { ...process.env, GSTACK_HOME: f.home }, encoding: 'utf8' });
    expect(ensured.status).toBe(0); const provider = async () => f.snapshot;
    await expect(appendShipHandoff({ cwd: f.cwd, pr: 7, assertTargetRef: 'origin/main', stateHome: f.home, provider }, { observe: () => { throw new Error('fixture_stdout_lost'); } })).rejects.toThrow('fixture_stdout_lost');
    const recovered = await appendShipHandoff({ cwd: f.cwd, pr: 7, assertTargetRef: 'origin/main', stateHome: f.home, provider });
    const ledger = readFileSync(join(f.home, 'projects', 'fixture', 'feature-evidence.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(ledger).toHaveLength(2); expect(ledger.filter(row => row.validator?.id === 'gstack.ship-handoff').map(row => row.run_id)).toEqual([recovered.receipt_run_id]);
  });

  test('replay and inspection reject an unsafe canonical ledger instead of trusting tolerant reads', async () => {
    const f = fixture();
    const ensured = spawnSync(join(import.meta.dir, '..', 'bin/gstack-evidence'), ['ensure', '--validator', 'unit', '--assert-target-ref', 'origin/main', '--json'], { timeout: 30_000, cwd: f.cwd, env: { ...process.env, GSTACK_HOME: f.home }, encoding: 'utf8' });
    expect(ensured.status).toBe(0); const provider = async () => f.snapshot;
    await appendShipHandoff({ cwd: f.cwd, pr: 7, assertTargetRef: 'origin/main', stateHome: f.home, provider });
    const ledger = join(f.home, 'projects', 'fixture', 'feature-evidence.jsonl'), retained = `${ledger}.retained`;
    renameSync(ledger, retained); symlinkSync(retained, ledger);
    await expect(appendShipHandoff({ cwd: f.cwd, pr: 7, assertTargetRef: 'origin/main', stateHome: f.home, provider })).rejects.toThrow('ship_handoff_ledger_invalid');
    await expect(inspectCurrentShipHandoff({ cwd: f.cwd, pr: 7, assertTargetRef: 'origin/main', expectedBase: f.base, remotePrHead: f.head, stateHome: f.home, provider })).rejects.toThrow('ship_handoff_ledger_invalid');
    chmodSync(retained, 0o600);
  });

  test('active release payload is derived from the protected write inspector and round-trips exactly', async () => {
    const f = fixture(true);
    const ensured = spawnSync(join(import.meta.dir, '..', 'bin/gstack-evidence'), ['ensure', '--validator', 'unit', '--assert-target-ref', 'origin/main', '--json'], { timeout: 30_000, cwd: f.cwd, env: { ...process.env, GSTACK_HOME: f.home }, encoding: 'utf8' });
    expect(ensured.stderr).toBe(''); expect(ensured.status).toBe(0); const provider = async () => f.snapshot; const tree = git(f.cwd, ['rev-parse', 'HEAD^{tree}']);
    const releaseWrite = { allocation_id: `release-${'1'.repeat(8)}-1111-4111-8111-${'1'.repeat(12)}`, release_write_record_id: `release-write-${'2'.repeat(8)}-2222-4222-8222-${'2'.repeat(12)}`, release_write_result_hash: '3'.repeat(64), version: '1.0.1', before_wtree: '4'.repeat(40), after_wtree: tree, product_manifest_hash_before_release: '5'.repeat(64), release_projection_hash: '6'.repeat(64), changelog_proposal_sha256: null, changelog_insertion_sha256: null, planned_targets: [{ path: 'VERSION', format: 'plain_text' as const, selector: 'whole_file' as const }], changelog_projection: null, mutated_projections: [{ path: 'VERSION', format: 'plain_text' as const, selector: 'whole_file' as const }], files: [{ path: 'VERSION', mode: 0o644, after_sha256: '7'.repeat(64), projections: [{ path: 'VERSION', format: 'plain_text' as const, selector: 'whole_file' as const }] }] };
    const written = await appendShipHandoff({ cwd: f.cwd, pr: 7, assertTargetRef: 'origin/main', releaseRequested: true, stateHome: f.home, provider }, { inspectReleaseWrite: () => releaseWrite });
    expect(await inspectCurrentShipHandoff({ cwd: f.cwd, pr: 7, assertTargetRef: 'origin/main', expectedBase: f.base, remotePrHead: f.head, stateHome: f.home, provider })).toMatchObject({ current: true, receipt_run_id: written.receipt_run_id, release_decision: { applicable: true, version: '1.0.1' }, release_write: releaseWrite });
  });
});
