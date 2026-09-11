import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { inspectCommittedReleaseWrite, inspectHistoricalRetiredReleaseLandingProof, inspectReleaseSelfClaimReplay, inspectRetiredReleaseLandingProof, inspectRetiredReleaseLandReadinessProof, releaseMetadata, retireReleaseAllocation } from '../lib/release-metadata';
import { releaseFixture, fixtureGit } from './helpers/release-metadata-fixture';
import { digest, validateReleaseTargets, renderReleaseFile } from '../lib/release-projections';
import { buildEvidenceRecord, inspectShipHandoff } from '../lib/evidence-envelope';
import { inspectReleaseLandReadiness } from '../lib/release-landing';
import { landingIntentIdForDescriptor } from '../lib/landing-safety';
import type { ProviderHeadSnapshot } from '../lib/provider-access';

const worker = path.join(import.meta.dir, 'fixtures/release-metadata-worker.ts');
const retirementWorker = path.join(import.meta.dir, 'fixtures/release-retirement-worker.ts');
const input = (root: string) => ({ cwd: root, operation: 'write' as const, bump: 'patch' as const, entryBody: () => '- Release fixture.\r\n- Preserve metadata bytes.' });
const run = (fixture: ReturnType<typeof releaseFixture>, crash = '', entry = 'yes') => Bun.spawnSync([process.execPath, worker, fixture.root, fixture.state, crash, entry], { timeout: 30_000 });
const text = (value: Uint8Array) => Buffer.from(value).toString('utf8');
function metadata(fixture: ReturnType<typeof releaseFixture>) { return new Map([...fixture.before.keys()].map(name => [name, fs.readFileSync(path.join(fixture.root, name))])); }
function ownerDirectory(fixture: ReturnType<typeof releaseFixture>) {
  const owners = path.join(fixture.state, 'release-metadata');
  return path.join(owners, fs.readdirSync(owners)[0]);
}

async function exactSelfClaimFixture() {
  const fixture = releaseFixture();
  const base = fixtureGit(fixture.root, 'rev-parse', 'refs/remotes/origin/main');
  const cleanQueue = JSON.stringify({ repositoryId: 'R_fixture', repository: 'owner/repo', base: 'main', targetSha: base, rows: [], refs: [] });
  fixture.dependencies.observeQueue = () => ({ claimed: [], snapshot: cleanQueue, currentPrIdentity: null, possibleSelfClaim: false, exactSelfClaim: null, unresolvedSelfClaim: false });
  const written = await releaseMetadata(input(fixture.root), fixture.dependencies);
  fixtureGit(fixture.root, 'add', '-A'); fixtureGit(fixture.root, 'commit', '-qm', 'release metadata');
  const head = fixtureGit(fixture.root, 'rev-parse', 'HEAD');
  const tree = fixtureGit(fixture.root, 'rev-parse', 'HEAD^{tree}');
  const binding = inspectCommittedReleaseWrite({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies);
  const identity = { number: 7, base_oid: base, head_oid: head, head_repository_node_id: 'R_fixture', head_ref: 'feature' };
  const rawQueue = JSON.stringify({ repositoryId: 'R_fixture', repository: 'owner/repo', base: 'main', targetSha: base, rows: [{ number: 7, baseRefName: 'main', headRefName: 'feature', headRefOid: head, headRepositoryId: 'R_fixture', headRepository: 'owner/repo', version: written.version, isDraft: false }], refs: [{ name: 'feature', oid: head, version: written.version }] });
  fixture.dependencies.observeQueue = () => ({ claimed: [{ pr: 0, branch: 'origin/feature', version: written.version }, { pr: 7, branch: 'feature', version: written.version }], snapshot: rawQueue, currentPrIdentity: identity, possibleSelfClaim: true, exactSelfClaim: { identity, repository_node_id: 'R_fixture', version: written.version, claimed: [], snapshot: cleanQueue }, unresolvedSelfClaim: false });
  const now = new Date().toISOString();
  const receiptRecord = buildEvidenceRecord({ repo_id: 'fixture', branch_ref: 'refs/heads/feature', base_sha: base, merge_base_sha: base, local_head_sha: head, remote_pr_head_sha: head, tree, wtree: tree, dirty: false,
    capability: { id: 'delivery.pr_open', version: '1' }, validator: { id: 'gstack.ship-handoff', version: '1' }, profile_hash: 'b'.repeat(64), semantic_policy_hash: 'c'.repeat(64),
    lockfile_hashes: {}, dependency_fingerprints: {}, toolchain_fingerprint: {}, environment_class: 'provider', coverage: { semantic_roles: [], files: [] }, started_at: now, completed_at: now, expires_at: null,
    handoff: { stage: 'ship', state_root_id: `state_${'f'.repeat(32)}`, pr_number: 7, base_ref: 'origin/main', provider_identity: { repository_node_id: 'R_fixture', repository_name_with_owner: 'owner/repo', head_repository_node_id: 'R_fixture', head_repository_name_with_owner: 'owner/repo', head_ref_name: 'feature' }, manifest_hash: 'a'.repeat(64), review_run_ids: [], validation_run_ids: [], evidence_run_ids: [], release: { applicable: true, mode: 'per_pr', version: written.version, title_policy: 'version_prefix' }, release_write: binding },
    caller: { command_argv: ['gstack-evidence', 'handoff'], result: 'pass', exit: 0, artifacts: [], side_effects: [] } });
  const readReceipt = () => inspectShipHandoff([receiptRecord], { repoId: 'fixture', pr: 7, baseRef: 'origin/main', baseSha: base, remotePrHeadSha: head, stateRootId: `state_${'f'.repeat(32)}`, repositoryNodeId: 'R_fixture', headRepositoryNodeId: 'R_fixture', headRefName: 'feature' });
  fixture.dependencies.inspectShipReceipt = readReceipt;
  return { fixture, written, identity, receiptRecord, cleanQueue, rawQueue, readReceipt };
}

describe('owned exact release metadata', () => {
  test('retires exact ShipReceipt ownership once while retaining the version reservation forever', async () => {
    const setup = await exactSelfClaimFixture(); const { fixture, written, identity, receiptRecord } = setup;
    try {
      const beforeProduct = metadata(fixture); const owner = ownerDirectory(fixture);
      const resultPath = path.join(owner, `${written.allocation_id}.result.json`); const beforeResult = fs.readFileSync(resultPath);
      const events: string[] = []; fixture.dependencies.observe = phase => events.push(phase);
      const retired = await releaseMetadata({ cwd: fixture.root, operation: 'retire', lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies);
      expect(retired).toMatchObject({ reason: 'retired', phase: 'retired', allocation_id: written.allocation_id, release_write_record_id: written.release_write_record_id, receipt_run_id: receiptRecord.run_id, current_pr_identity: identity, reservation_retained: true });
      expect(retired.retirement_id).toMatch(/^release-retirement-[0-9a-f]{32}$/);
      expect(metadata(fixture)).toEqual(beforeProduct); expect(fs.readFileSync(resultPath)).toEqual(beforeResult);
      expect(events).toEqual(['before_retirement_publication', 'retirement_durable']);
      const ledger = JSON.parse(fs.readFileSync(path.join(owner, 'ledger.json'), 'utf8')).value;
      expect(ledger.allocations).toHaveLength(1); expect(ledger.allocations[0]).toMatchObject({ phase: 'retired', version: written.version, retirement: { retirement_id: retired.retirement_id, reservation_retained: true, receipt_run_id: receiptRecord.run_id } });
      const retry = await retireReleaseAllocation({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies);
      expect(retry).toEqual(retired); expect(events).toEqual(['before_retirement_publication', 'retirement_durable']);
      await expect(inspectReleaseSelfClaimReplay({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies)).resolves.toMatchObject({ reason: 'already_bumped', phase: 'retired', allocation_id: written.allocation_id });

      const parent = fixtureGit(fixture.root, 'rev-parse', 'HEAD^'); const tree = fixtureGit(fixture.root, 'rev-parse', 'HEAD^{tree}');
      const replacement = fixtureGit(fixture.root, 'commit-tree', tree, '-p', parent, '-m', 'same tree replacement release commit');
      fixtureGit(fixture.root, 'reset', '--hard', replacement);
      expect(() => inspectCommittedReleaseWrite({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies)).toThrow('release_commit_lineage_invalid');
      await expect(retireReleaseAllocation({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies)).rejects.toThrow('release_commit_lineage_invalid');

      const other = path.join(fixture.directory, 'other'); fixtureGit(fixture.root, 'worktree', 'add', '-qb', 'another-after-retirement', other, 'main');
      fs.writeFileSync(path.join(other, 'docs.md'), 'A later task needs its own version.\n');
      const { releaseFixtureDependencies } = await import('./helpers/release-metadata-fixture');
      const later = await releaseMetadata({ ...input(other), operation: 'allocate' }, releaseFixtureDependencies(other, fixture.state));
      expect(later.version).toBe('1.0.2');
    } finally { fixture.cleanup(); }
  }, 30000);

  test('exports an exact read-only retired release proof for the land gate', async () => {
    const { fixture, written, identity, receiptRecord } = await exactSelfClaimFixture();
    try {
      const retired = await retireReleaseAllocation({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies);
      const proof = inspectRetiredReleaseLandingProof({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies);
      expect(proof).toMatchObject({
        schema: 'ecpe.retired-release-landing-proof.v1', allocation_id: written.allocation_id,
        release_write_record_id: written.release_write_record_id, retirement_id: retired.retirement_id,
        receipt_run_id: receiptRecord.run_id, current_pr_identity: identity, reservation_retained: true,
      });
      expect(proof.release_write).toEqual(inspectCommittedReleaseWrite({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies));
      expect(proof.binding_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(proof.proof_id).toMatch(/^release-land-proof-[0-9a-f]{32}$/);
    } finally { fixture.cleanup(); }
  }, 30000);

  test('feeds an actual retired release proof and live queue replay into land readiness', async () => {
    const { fixture, identity, receiptRecord } = await exactSelfClaimFixture();
    try {
      const retired = await retireReleaseAllocation({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies);
      const binding = inspectCommittedReleaseWrite({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies);
      const descriptor = { repoId: 'github.com/owner/repo', repositoryNodeId: 'R_fixture', prNumber: identity.number,
        expectedHeadOid: identity.head_oid, expectedBaseOid: identity.base_oid, targetRef: 'origin/main', mode: 'direct_observed' as const,
        providerOperationId: `github.com:direct-pr:${identity.number}` };
      const provider: ProviderHeadSnapshot = { repositoryNameWithOwner: 'owner/repo', repositoryNodeId: 'R_fixture', viewerPermission: 'ADMIN',
        prNumber: identity.number, prState: 'OPEN', repositorySelector: 'owner/repo', headRepositoryNameWithOwner: 'owner/repo',
        headRepositoryNodeId: 'R_fixture', targetRef: 'origin/main', baseRefName: 'main', baseRefOid: identity.base_oid,
        headRefName: identity.head_ref, headRefOid: identity.head_oid, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', autoMergeRequest: null, mergeQueueEntry: null };
      const readiness = await inspectReleaseLandReadiness({ cwd: fixture.root, pr: identity.number, assertTargetRef: 'origin/main',
        expectedBase: identity.base_oid, remotePrHead: identity.head_oid, stateRootId: `state_${'f'.repeat(32)}`,
        repositoryNodeId: 'R_fixture', headRepositoryNodeId: 'R_fixture', headRefName: identity.head_ref, stateHome: fixture.state,
        expectedHeadTree: binding.after_wtree, retirementId: retired.retirement_id, receiptRunId: receiptRecord.run_id,
        lane: 'single_repo_code', releaseRequested: true }, {
        snapshotOpenProvider: async () => structuredClone(provider),
        inspectCurrentRetiredProof: async () => inspectRetiredReleaseLandReadinessProof({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies),
        resolveLandingIntent: async () => ({ descriptor, intentId: landingIntentIdForDescriptor(descriptor) }),
      });
      expect(readiness).toMatchObject({ schema: 'ecpe.release-land-readiness.v1', retirement_id: retired.retirement_id,
        receipt_run_id: receiptRecord.run_id, expected_head_tree: binding.after_wtree });
      const competing = JSON.stringify({ repositoryId: 'R_fixture', repository: 'owner/repo', base: 'main', targetSha: identity.base_oid,
        rows: [{ number: 8, version: binding.version }], refs: [] });
      fixture.dependencies.observeQueue = () => ({ claimed: [{ pr: 7, branch: 'feature', version: binding.version }], snapshot: competing,
        currentPrIdentity: identity, possibleSelfClaim: true, exactSelfClaim: { identity, repository_node_id: 'R_fixture', version: binding.version,
          claimed: [{ pr: 8, branch: 'other', version: binding.version }], snapshot: competing }, unresolvedSelfClaim: false });
      await expect(inspectRetiredReleaseLandReadinessProof({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies))
        .rejects.toThrow('release_queue_drift');
    } finally { fixture.cleanup(); }
  }, 60000);

  test('reconstructs the retired release proof after the local checkout advances', async () => {
    const { fixture, identity, receiptRecord } = await exactSelfClaimFixture();
    try {
      const retired = await retireReleaseAllocation({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies);
      fs.writeFileSync(path.join(fixture.root, 'after-merge.txt'), 'local checkout advanced after provider merge\n');
      fixtureGit(fixture.root, 'add', 'after-merge.txt'); fixtureGit(fixture.root, 'commit', '-qm', 'advance after merge');
      const proof = inspectHistoricalRetiredReleaseLandingProof({
        cwd: fixture.root, pr: identity.number, assertTargetRef: 'origin/main', expectedBase: identity.base_oid,
        remotePrHead: identity.head_oid, stateRootId: `state_${'f'.repeat(32)}`, repositoryNodeId: 'R_fixture', headRepositoryNodeId: 'R_fixture',
        headRefName: identity.head_ref, stateHome: fixture.state,
      }, fixture.dependencies);
      expect(proof).toMatchObject({ retirement_id: retired.retirement_id, receipt_run_id: receiptRecord.run_id,
        current_pr_identity: identity, reservation_retained: true });
      const original = fixture.dependencies.inspectShipReceipt!;
      fixture.dependencies.inspectShipReceipt = input => {
        const receipt = original(input);
        return receipt.current ? { ...receipt, release_decision: { ...receipt.release_decision, mode: 'required_on_release' as const } } : receipt;
      };
      expect(() => inspectHistoricalRetiredReleaseLandingProof({ cwd: fixture.root, pr: identity.number, assertTargetRef: 'origin/main',
        expectedBase: identity.base_oid, remotePrHead: identity.head_oid, stateRootId: `state_${'f'.repeat(32)}`,
        repositoryNodeId: 'R_fixture', headRepositoryNodeId: 'R_fixture', headRefName: identity.head_ref, stateHome: fixture.state }, fixture.dependencies))
        .toThrow('ship_handoff_missing_or_stale');
    } finally { fixture.cleanup(); }
  }, 30000);

  test('recovers the same retirement after durable-publication response loss and rejects weaker evidence', async () => {
    const setup = await exactSelfClaimFixture(); const { fixture, written } = setup;
    try {
      fixture.dependencies.observe = phase => { if (phase === 'retirement_durable') throw new Error('fixture_response_loss'); };
      await expect(retireReleaseAllocation({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies)).rejects.toThrow('fixture_response_loss');
      fixture.dependencies.observe = undefined;
      const recovered = await retireReleaseAllocation({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies);
      expect(recovered).toMatchObject({ reason: 'retired', allocation_id: written.allocation_id, reservation_retained: true });

      const next = await exactSelfClaimFixture();
      try {
        next.fixture.dependencies.inspectShipReceipt = () => ({ current: false, blocker: 'ship_handoff_missing_or_stale' });
        await expect(retireReleaseAllocation({ cwd: next.fixture.root, lane: 'single_repo_code', releaseRequested: true }, next.fixture.dependencies)).rejects.toThrow('ship_handoff_missing_or_stale');
        next.fixture.dependencies.inspectShipReceipt = next.readReceipt;
        const competing = JSON.stringify({ repositoryId: 'R_fixture', rows: [{ number: 8, version: '1.0.2' }], refs: [] });
        next.fixture.dependencies.observeQueue = () => ({ claimed: [{ pr: 7, branch: 'feature', version: next.written.version }], snapshot: next.rawQueue, currentPrIdentity: next.identity, possibleSelfClaim: true, exactSelfClaim: { identity: next.identity, repository_node_id: 'R_fixture', version: next.written.version, claimed: [{ pr: 8, branch: 'other', version: '1.0.2' }], snapshot: competing }, unresolvedSelfClaim: false });
        await expect(retireReleaseAllocation({ cwd: next.fixture.root, lane: 'single_repo_code', releaseRequested: true }, next.fixture.dependencies)).rejects.toThrow('release_queue_drift');
      } finally { next.fixture.cleanup(); }
    } finally { fixture.cleanup(); }
  }, 30000);

  test('blocks product movement at the retirement publication boundary without changing owner state', async () => {
    const { fixture } = await exactSelfClaimFixture();
    try {
      fixture.dependencies.observe = phase => { if (phase === 'before_retirement_publication') fs.chmodSync(path.join(fixture.root, 'docs.md'), 0o600); };
      await expect(retireReleaseAllocation({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies)).rejects.toThrow('release_product_drift');
      const ledger = JSON.parse(fs.readFileSync(path.join(ownerDirectory(fixture), 'ledger.json'), 'utf8')).value;
      expect(ledger.allocations[0].phase).toBe('written'); expect(ledger.allocations[0].retirement).toBeUndefined();
    } finally { fixture.cleanup(); }
  }, 20000);

  test('blocks ShipReceipt movement at the retirement publication boundary', async () => {
    const { fixture, readReceipt } = await exactSelfClaimFixture();
    try {
      let reads = 0;
      fixture.dependencies.inspectShipReceipt = () => ++reads === 1 ? readReceipt() : { current: false, blocker: 'ship_handoff_missing_or_stale' };
      await expect(retireReleaseAllocation({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies)).rejects.toThrow('ship_handoff_missing_or_stale');
      expect(reads).toBe(2);
      const ledger = JSON.parse(fs.readFileSync(path.join(ownerDirectory(fixture), 'ledger.json'), 'utf8')).value;
      expect(ledger.allocations[0].phase).toBe('written');
    } finally { fixture.cleanup(); }
  }, 20000);

  test('serializes two retirement processes into one durable terminal record', async () => {
    const setup = await exactSelfClaimFixture(); const { fixture, written, identity, receiptRecord, cleanQueue, rawQueue } = setup;
    try {
      const configPath = path.join(fixture.state, 'retirement-worker.json');
      fs.writeFileSync(configPath, JSON.stringify({ version: written.version, identity, receipt: receiptRecord, cleanQueue, rawQueue }));
      const children = [1, 2].map(() => Bun.spawn([process.execPath, retirementWorker, fixture.root, fixture.state, configPath], { stdout: 'pipe', stderr: 'pipe' }));
      const results = await Promise.all(children.map(async child => ({ code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() })));
      expect(results.map(item => item.code)).toEqual([0, 0]); expect(results.map(item => item.stderr)).toEqual(['', '']);
      const values = results.map(item => JSON.parse(item.stdout));
      expect(new Set(values.map(item => item.retirement_id)).size).toBe(1); expect(values.map(item => item.phase)).toEqual(['retired', 'retired']);
      const ledger = JSON.parse(fs.readFileSync(path.join(ownerDirectory(fixture), 'ledger.json'), 'utf8')).value;
      expect(ledger.allocations).toHaveLength(1); expect(ledger.allocations[0].phase).toBe('retired');
    } finally { fixture.cleanup(); }
  }, 40000);

  test('reclaims one active-owner slot but keeps every retired version in collision history', async () => {
    const { fixture } = await exactSelfClaimFixture();
    try {
      await retireReleaseAllocation({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies);
      const ledgerPath = path.join(ownerDirectory(fixture), 'ledger.json'); const envelope = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); const retired = envelope.value.allocations[0];
      for (let index = 1; index <= 255; index++) envelope.value.allocations.push({
        allocation_id: `release-00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
        record_id: `release-write-10000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
        phase: 'allocated', identity: { ...retired.identity, branch: `refs/heads/reserved-${index}` }, decision: retired.decision,
        bump: 'patch', version: `2.0.${index}`, queue: retired.queue, product_fingerprint: retired.product_fingerprint,
        bundle_hash: null, after_wtree: null,
      });
      envelope.sha256 = digest(JSON.stringify(envelope.value)); fs.writeFileSync(ledgerPath, JSON.stringify(envelope) + '\n');
      const { releaseFixtureDependencies } = await import('./helpers/release-metadata-fixture');
      const other = path.join(fixture.directory, 'capacity-one'); fixtureGit(fixture.root, 'worktree', 'add', '-qb', 'capacity-one', other, 'main');
      fs.writeFileSync(path.join(other, 'docs.md'), 'One reclaimed active slot.\n');
      const accepted = await releaseMetadata({ ...input(other), operation: 'allocate' }, releaseFixtureDependencies(other, fixture.state));
      expect(accepted.version).toBe('2.0.256');
      const final = path.join(fixture.directory, 'capacity-full'); fixtureGit(fixture.root, 'worktree', 'add', '-qb', 'capacity-full', final, 'main');
      fs.writeFileSync(path.join(final, 'docs.md'), 'No active slot remains.\n');
      await expect(releaseMetadata({ ...input(final), operation: 'allocate' }, releaseFixtureDependencies(final, fixture.state))).rejects.toThrow('release_owner_capacity');
    } finally { fixture.cleanup(); }
  }, 30000);

  test('fails closed at the durable tombstone cap and on semantically forged retirement data', async () => {
    const { fixture } = await exactSelfClaimFixture();
    try {
      await retireReleaseAllocation({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies);
      const ledgerPath = path.join(ownerDirectory(fixture), 'ledger.json'); let envelope = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      envelope.value.allocations[0].retirement.reservation_retained = false; envelope.sha256 = digest(JSON.stringify(envelope.value)); fs.writeFileSync(ledgerPath, JSON.stringify(envelope) + '\n');
      expect(() => inspectCommittedReleaseWrite({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies)).toThrow('release_retirement_invalid');

      envelope.value.allocations[0].retirement.reservation_retained = true; const seed = envelope.value.allocations[0];
      for (let index = 1; index < 4096; index++) {
        const allocation = { ...structuredClone(seed), allocation_id: `release-20000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
          record_id: `release-write-30000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
          identity: { ...seed.identity, branch: `refs/heads/tombstone-${index}` }, version: `3.0.${index}`, result_hash: digest(`result-${index}`) };
        const currentPrIdentity = { ...seed.retirement.current_pr_identity, number: index + 10, head_ref: `tombstone-${index}`, head_oid: digest(`head-${index}`).slice(0, 40) };
        const core = { allocation_id: allocation.allocation_id, release_write_record_id: allocation.record_id, release_write_result_hash: allocation.result_hash,
          version: allocation.version, source: 'ship_receipt', receipt_run_id: `evidence-${digest(`receipt-${index}`).slice(0, 32)}`, current_pr_identity: currentPrIdentity, reservation_retained: true };
        const binding = digest(JSON.stringify(core)); allocation.retirement = { schema: 'ecpe.release-retirement.v1', retirement_id: `release-retirement-${binding.slice(0, 32)}`, ...core, binding_sha256: binding };
        envelope.value.allocations.push(allocation);
      }
      envelope.sha256 = digest(JSON.stringify(envelope.value)); fs.writeFileSync(ledgerPath, JSON.stringify(envelope) + '\n');
      const other = path.join(fixture.directory, 'tombstone-cap'); fixtureGit(fixture.root, 'worktree', 'add', '-qb', 'tombstone-cap', other, 'main');
      fs.writeFileSync(path.join(other, 'docs.md'), 'Tombstone cap must fail closed.\n');
      const { releaseFixtureDependencies } = await import('./helpers/release-metadata-fixture');
      await expect(releaseMetadata({ ...input(other), operation: 'allocate' }, releaseFixtureDependencies(other, fixture.state))).rejects.toThrow('release_retirement_capacity');
    } finally { fixture.cleanup(); }
  }, 30000);

  test('selects the new exact committed lineage after a retired branch starts a later release', async () => {
    const { fixture, written: first } = await exactSelfClaimFixture();
    try {
      await retireReleaseAllocation({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies);
      const firstHead = fixtureGit(fixture.root, 'rev-parse', 'HEAD'); fixtureGit(fixture.root, 'update-ref', 'refs/remotes/origin/main', firstHead);
      fs.writeFileSync(path.join(fixture.root, 'docs.md'), 'A later change on the same branch.\n');
      const cleanQueue = JSON.stringify({ repositoryId: 'R_fixture', repository: 'owner/repo', base: 'main', targetSha: firstHead, rows: [], refs: [] });
      fixture.dependencies.observeQueue = () => ({ claimed: [], snapshot: cleanQueue, currentPrIdentity: null, possibleSelfClaim: false, exactSelfClaim: null, unresolvedSelfClaim: false });
      const second = await releaseMetadata(input(fixture.root), fixture.dependencies);
      expect(second.version).toBe('1.0.2'); expect(second.allocation_id).not.toBe(first.allocation_id);
      fixtureGit(fixture.root, 'add', '-A'); fixtureGit(fixture.root, 'commit', '-qm', 'second release metadata');
      const binding = inspectCommittedReleaseWrite({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies);
      expect(binding).toMatchObject({ allocation_id: second.allocation_id, release_write_record_id: second.release_write_record_id, version: '1.0.2' });
    } finally { fixture.cleanup(); }
  }, 30000);
  test('binds a written release only to its single exact committed after-tree', async () => {
    const fixture = releaseFixture();
    try {
      const written = await releaseMetadata(input(fixture.root), fixture.dependencies);
      fixtureGit(fixture.root, 'add', '-A'); fixtureGit(fixture.root, 'commit', '-qm', 'release metadata');
      const binding = inspectCommittedReleaseWrite({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies);
      expect(binding).toMatchObject({ allocation_id: written.allocation_id, release_write_record_id: written.release_write_record_id, version: written.version, before_wtree: written.before_wtree, after_wtree: written.after_wtree, release_projection_hash: written.release_projection_hash });
      expect(binding.release_write_result_hash).toHaveLength(64); expect(binding.files).toHaveLength(3);
      fixtureGit(fixture.root, 'commit', '--allow-empty', '-qm', 'unexpected extra commit');
      expect(() => inspectCommittedReleaseWrite({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies)).toThrow('release_commit_lineage_invalid');
    } finally { fixture.cleanup(); }
  }, 20000);

  test('rejects a merge commit even when its first parent and tree mimic the exact release commit', async () => {
    const fixture = releaseFixture();
    try {
      const preReleaseHead = fixtureGit(fixture.root, 'rev-parse', 'HEAD');
      const written = await releaseMetadata(input(fixture.root), fixture.dependencies);
      fixtureGit(fixture.root, 'add', '-A');
      const afterTree = fixtureGit(fixture.root, 'write-tree');
      expect(afterTree).toBe(written.after_wtree);
      const side = fixtureGit(fixture.root, 'commit-tree', `${preReleaseHead}^{tree}`, '-p', preReleaseHead, '-m', 'side parent');
      const merge = fixtureGit(fixture.root, 'commit-tree', afterTree, '-p', preReleaseHead, '-p', side, '-m', 'forged release merge');
      fixtureGit(fixture.root, 'reset', '--hard', merge);
      expect(() => inspectCommittedReleaseWrite({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies)).toThrow('release_commit_lineage_invalid');
    } finally { fixture.cleanup(); }
  }, 20000);

  test('rejects non-release file mode drift that Git status and tree do not report', async () => {
    const fixture = releaseFixture();
    try {
      await releaseMetadata(input(fixture.root), fixture.dependencies);
      fixtureGit(fixture.root, 'add', '-A'); fixtureGit(fixture.root, 'commit', '-qm', 'release metadata');
      fs.chmodSync(path.join(fixture.root, 'docs.md'), 0o600);
      expect(fixtureGit(fixture.root, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
      expect(() => inspectCommittedReleaseWrite({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies)).toThrow('release_product_drift');
    } finally { fixture.cleanup(); }
  }, 20000);

  test('reuses one exact committed release through its durable self PR receipt without business writes', async () => {
    const fixture = releaseFixture();
    try {
      const base = fixtureGit(fixture.root, 'rev-parse', 'refs/remotes/origin/main');
      const cleanQueue = JSON.stringify({ repositoryId: 'R_fixture', repository: 'owner/repo', base: 'main', targetSha: base, rows: [], refs: [] });
      fixture.dependencies.observeQueue = () => ({ claimed: [], snapshot: cleanQueue, currentPrIdentity: null, possibleSelfClaim: false, exactSelfClaim: null, unresolvedSelfClaim: false });
      const written = await releaseMetadata(input(fixture.root), fixture.dependencies);
      fixtureGit(fixture.root, 'add', '-A'); fixtureGit(fixture.root, 'commit', '-qm', 'release metadata');
      const head = fixtureGit(fixture.root, 'rev-parse', 'HEAD');
      const tree = fixtureGit(fixture.root, 'rev-parse', 'HEAD^{tree}');
      const binding = inspectCommittedReleaseWrite({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies);
      const identity = { number: 7, base_oid: base, head_oid: head, head_repository_node_id: 'R_fixture', head_ref: 'feature' };
      const rawQueue = JSON.stringify({ repositoryId: 'R_fixture', repository: 'owner/repo', base: 'main', targetSha: base, rows: [{ number: 7, baseRefName: 'main', headRefName: 'feature', headRefOid: head, headRepositoryId: 'R_fixture', headRepository: 'owner/repo', version: written.version, isDraft: false }], refs: [{ name: 'feature', oid: head, version: written.version }] });
      fixture.dependencies.observeQueue = () => ({ claimed: [{ pr: 0, branch: 'origin/feature', version: written.version }, { pr: 7, branch: 'feature', version: written.version }], snapshot: rawQueue, currentPrIdentity: identity, possibleSelfClaim: true, exactSelfClaim: { identity, repository_node_id: 'R_fixture', version: written.version, claimed: [], snapshot: cleanQueue }, unresolvedSelfClaim: false });
      const now = new Date().toISOString();
      const receiptRecord = buildEvidenceRecord({ repo_id: 'fixture', branch_ref: 'refs/heads/feature', base_sha: base, merge_base_sha: base, local_head_sha: head, remote_pr_head_sha: head, tree, wtree: tree, dirty: false,
        capability: { id: 'delivery.pr_open', version: '1' }, validator: { id: 'gstack.ship-handoff', version: '1' }, profile_hash: 'b'.repeat(64), semantic_policy_hash: 'c'.repeat(64),
        lockfile_hashes: {}, dependency_fingerprints: {}, toolchain_fingerprint: {}, environment_class: 'provider', coverage: { semantic_roles: [], files: [] }, started_at: now, completed_at: now, expires_at: null,
        handoff: { stage: 'ship', state_root_id: `state_${'f'.repeat(32)}`, pr_number: 7, base_ref: 'origin/main', provider_identity: { repository_node_id: 'R_fixture', repository_name_with_owner: 'owner/repo', head_repository_node_id: 'R_fixture', head_repository_name_with_owner: 'owner/repo', head_ref_name: 'feature' }, manifest_hash: 'a'.repeat(64), review_run_ids: [], validation_run_ids: [], evidence_run_ids: [], release: { applicable: true, mode: 'per_pr', version: written.version, title_policy: 'version_prefix' }, release_write: binding },
        caller: { command_argv: ['gstack-evidence', 'handoff'], result: 'pass', exit: 0, artifacts: [], side_effects: [] } });
      const readReceipt = () => inspectShipHandoff([receiptRecord], { repoId: 'fixture', pr: 7, baseRef: 'origin/main', baseSha: base, remotePrHeadSha: head, stateRootId: `state_${'f'.repeat(32)}`, repositoryNodeId: 'R_fixture', headRepositoryNodeId: 'R_fixture', headRefName: 'feature' });
      expect(readReceipt()).toMatchObject({ current: true, receipt_run_id: receiptRecord.run_id, release_write: binding });
      fixture.dependencies.inspectShipReceipt = readReceipt;
      const before = metadata(fixture); const events: string[] = []; fixture.dependencies.observe = phase => events.push(phase);
      const replay = await inspectReleaseSelfClaimReplay({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies);
      expect(replay).toMatchObject({ reason: 'already_bumped', allocation_id: written.allocation_id, release_write_record_id: written.release_write_record_id, receipt_run_id: receiptRecord.run_id, current_pr_identity: identity, self_claim_excluded: true, queue_matches: true });
      expect(metadata(fixture)).toEqual(before); expect(events).toEqual([]);
      const routed = await releaseMetadata({ ...input(fixture.root), operation: 'inspect' }, fixture.dependencies);
      expect(routed).toMatchObject({ reason: 'already_bumped', allocation_id: written.allocation_id, release_write_record_id: written.release_write_record_id, current_pr_identity: identity, self_claim_excluded: true });
      expect(metadata(fixture)).toEqual(before); expect(events).toEqual([]);

      const competingQueue = JSON.stringify({ repositoryId: 'R_fixture', repository: 'owner/repo', base: 'main', targetSha: base, rows: [{ number: 8, baseRefName: 'main', headRefName: 'other', headRefOid: '8'.repeat(40), headRepositoryId: 'R_fixture', headRepository: 'owner/repo', version: '1.0.2', isDraft: false }], refs: [] });
      fixture.dependencies.observeQueue = () => ({ claimed: [{ pr: 7, branch: 'feature', version: written.version }], snapshot: rawQueue, currentPrIdentity: identity, possibleSelfClaim: true, exactSelfClaim: { identity, repository_node_id: 'R_fixture', version: written.version, claimed: [{ pr: 8, branch: 'other', version: '1.0.2' }], snapshot: competingQueue }, unresolvedSelfClaim: false });
      await expect(inspectReleaseSelfClaimReplay({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies)).resolves.toMatchObject({ reason: 'queue_drift', self_claim_excluded: false, queue_matches: false, allocation_id: written.allocation_id });
      expect(metadata(fixture)).toEqual(before); expect(events).toEqual([]);

      fixture.dependencies.observeQueue = () => ({ claimed: [{ pr: 7, branch: 'feature', version: written.version }], snapshot: rawQueue, currentPrIdentity: identity, possibleSelfClaim: true, exactSelfClaim: null, unresolvedSelfClaim: true });
      await expect(inspectReleaseSelfClaimReplay({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies)).rejects.toThrow('release_lineage_required');
      expect(metadata(fixture)).toEqual(before); expect(events).toEqual([]);

      fixture.dependencies.observeQueue = () => ({ claimed: [{ pr: 7, branch: 'feature', version: written.version }], snapshot: rawQueue, currentPrIdentity: identity, possibleSelfClaim: true, exactSelfClaim: { identity, repository_node_id: 'R_fixture', version: written.version, claimed: [], snapshot: cleanQueue }, unresolvedSelfClaim: false });
      fixture.dependencies.inspectShipReceipt = () => ({ current: false, blocker: 'ship_handoff_missing_or_stale' });
      await expect(inspectReleaseSelfClaimReplay({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies)).rejects.toThrow('ship_handoff_missing_or_stale');
      expect(metadata(fixture)).toEqual(before); expect(events).toEqual([]);

      fixture.dependencies.inspectShipReceipt = readReceipt;
      let queueReads = 0;
      fixture.dependencies.observeQueue = () => {
        queueReads += 1;
        if (queueReads === 2) fs.chmodSync(path.join(fixture.root, 'docs.md'), 0o600);
        return { claimed: [{ pr: 7, branch: 'feature', version: written.version }], snapshot: rawQueue, currentPrIdentity: identity, possibleSelfClaim: true, exactSelfClaim: { identity, repository_node_id: 'R_fixture', version: written.version, claimed: [], snapshot: cleanQueue }, unresolvedSelfClaim: false };
      };
      await expect(inspectReleaseSelfClaimReplay({ cwd: fixture.root, lane: 'single_repo_code', releaseRequested: true }, fixture.dependencies)).rejects.toThrow('release_product_drift');
      expect(queueReads).toBe(2); expect(events).toEqual([]);
    } finally { fixture.cleanup(); }
  }, 20000);
  test('writes exactly VERSION, TOML field, JSON fields once, and generated changelog insertion', async () => {
    const fixture = releaseFixture(true);
    try {
      const phases: string[] = []; fixture.dependencies.observe = phase => phases.push(phase);
      const result = await releaseMetadata(input(fixture.root), fixture.dependencies);
      expect(result).toMatchObject({ reason: 'written', version: '1.0.1', phase: 'written' });
      expect(result.planned_targets).toHaveLength(4); expect(result.mutated_projections).toHaveLength(5);
      expect(result.release_write_record_id).toMatch(/^release-write-/);
      expect(result.before_wtree).not.toBe(result.after_wtree);
      expect(result.release_projection_hash).toHaveLength(64); expect(result.product_manifest_hash_before_release).toHaveLength(64);
      expect(fs.readFileSync(path.join(fixture.root, 'pyproject.toml'), 'utf8')).toBe(fixture.before.get('pyproject.toml')!.toString().replace("version  = '1.0.0'", "version  = '1.0.1'"));
      expect(fs.readFileSync(path.join(fixture.root, 'package-lock.json'), 'utf8')).toBe(fixture.before.get('package-lock.json')!.toString().replaceAll('"1.0.0"', '"1.0.1"'));
      expect(phases.filter(phase => phase === 'replaced:package-lock.json')).toHaveLength(1);
      const changelog = fs.readFileSync(path.join(fixture.root, 'CHANGELOG.md'), 'utf8');
      expect(changelog.endsWith(fixture.before.get('CHANGELOG.md')!.toString().slice('# Changelog\r\n'.length))).toBe(true);
      expect(fs.readFileSync(path.join(fixture.root, 'docs.md'))).toEqual(fixture.before.get('docs.md'));
      const owner = ownerDirectory(fixture);
      expect(fs.readdirSync(owner).filter(name => name.endsWith('.bundle.json'))).toEqual([]);
      expect(fs.readdirSync(owner).filter(name => name.endsWith('.result.json'))).toHaveLength(1);
      const beforeRetry = metadata(fixture); const second = await releaseMetadata({ ...input(fixture.root), entryBody: () => { throw new Error('stdin must not be read'); } }, fixture.dependencies);
      expect(second).toMatchObject({ reason: 'already_bumped', allocation_id: result.allocation_id, release_write_record_id: result.release_write_record_id });
      expect(metadata(fixture)).toEqual(beforeRetry);
      expect(phases.filter(phase => phase.startsWith('replaced:'))).toHaveLength(4);
    } finally { fixture.cleanup(); }
  }, 20000);

  test('allocation response loss reuses the single owner before preparing metadata', async () => {
    const fixture = releaseFixture();
    try {
      const first = await releaseMetadata({ ...input(fixture.root), operation: 'allocate' }, fixture.dependencies);
      const second = await releaseMetadata({ ...input(fixture.root), operation: 'allocate' }, fixture.dependencies);
      expect(second).toEqual(first); expect(metadata(fixture)).toEqual(fixture.before);
      const written = await releaseMetadata(input(fixture.root), fixture.dependencies);
      expect(written.allocation_id).toBe(first.allocation_id);
    } finally { fixture.cleanup(); }
  }, 20000);

    for (const phase of ['bundle_durable', 'write_intent_durable', 'replacement_fsynced:VERSION', 'replaced:VERSION', 'replacement_durable:VERSION', 'replaced:pyproject.toml', 'replaced:package-lock.json', 'replaced:CHANGELOG.md', 'write_result_tombstone_durable', 'write_result_durable', 'bundle_unlinked', 'bundle_cleanup_durable']) {
    test(`fresh-process recovery after ${phase}, with original stdin gone`, () => {
      const fixture = releaseFixture(true);
      try {
        const killed = run(fixture, phase); expect(killed.exitCode).not.toBe(0);
        const recovered = run(fixture, '', 'gone'); expect(text(recovered.stderr)).toBe(''); expect(recovered.exitCode).toBe(0);
        const result = JSON.parse(text(recovered.stdout)); expect(result.version).toBe('1.0.1');
        const second = run(fixture, '', 'gone'); expect(second.exitCode).toBe(0);
        expect(JSON.parse(text(second.stdout)).release_write_record_id).toBe(result.release_write_record_id);
        expect(fs.readdirSync(ownerDirectory(fixture)).filter(name => name.endsWith('.bundle.json'))).toEqual([]);
        expect(fs.readdirSync(ownerDirectory(fixture)).filter(name => name.endsWith('.result.json'))).toHaveLength(1);
        const trace = fs.readFileSync(path.join(fixture.state, 'trace'), 'utf8');
        for (const name of ['VERSION', 'pyproject.toml', 'package-lock.json', 'CHANGELOG.md']) expect(trace.split('\n').filter(line => line.endsWith(`:replaced:${name}`))).toHaveLength(1);
        expect(fs.readFileSync(path.join(fixture.root, 'CHANGELOG.md'), 'utf8').match(/## \[1\.0\.1\]/g)).toHaveLength(1);
      } finally { fixture.cleanup(); }
    }, 20000);
  }

  test('two processes race the same owner and produce one write record and one insertion', async () => {
    const fixture = releaseFixture(true);
    try {
      const children = [1, 2].map(() => Bun.spawn([process.execPath, worker, fixture.root, fixture.state, ''], { stdout: 'pipe', stderr: 'pipe' }));
      const results = await Promise.all(children.map(async child => ({ code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() })));
      expect(results.map(value => value.stderr)).toEqual(['', '']); expect(results.map(value => value.code)).toEqual([0, 0]);
      const values = results.map(value => JSON.parse(value.stdout));
      expect(new Set(values.map(value => value.release_write_record_id)).size).toBe(1);
      expect(values.map(value => value.reason).sort()).toEqual(['already_bumped', 'written']);
      expect(fs.readdirSync(ownerDirectory(fixture)).filter(name => name.endsWith('.bundle.json'))).toEqual([]);
      expect(fs.readdirSync(ownerDirectory(fixture)).filter(name => name.endsWith('.result.json'))).toHaveLength(1);
    } finally { fixture.cleanup(); }
  }, 20000);

  test('caught write failure restores every exact before byte and does not reallocate', async () => {
    const fixture = releaseFixture();
    try {
      fixture.dependencies.observe = phase => { if (phase === 'replaced:pyproject.toml') throw new Error('fixture_io_failure'); };
      await expect(releaseMetadata(input(fixture.root), fixture.dependencies)).rejects.toThrow('fixture_io_failure');
      expect(metadata(fixture)).toEqual(fixture.before);
      fixture.dependencies.observe = undefined;
      await expect(releaseMetadata(input(fixture.root), fixture.dependencies)).rejects.toThrow('release_transaction_rolled_back');
    } finally { fixture.cleanup(); }
  });

  for (const drift of ['pyproject.toml', 'CHANGELOG.md', 'docs.md']) {
    test(`unexpected ${drift} bytes block interrupted recovery without overwriting the edit`, () => {
      const fixture = releaseFixture();
      try {
        expect(run(fixture, 'replaced:VERSION').exitCode).not.toBe(0);
        fs.appendFileSync(path.join(fixture.root, drift), '\nUser edit.\n');
        const before = metadata(fixture), retry = run(fixture, '', 'gone');
        expect(retry.exitCode).toBe(2); expect(text(retry.stderr)).toMatch(/release_(projection|product)_drift/);
        expect(metadata(fixture)).toEqual(before);
      } finally { fixture.cleanup(); }
    });
  }

  test('queue movement returns queue_drift with zero second mutation', async () => {
    const fixture = releaseFixture();
    try {
      const first = await releaseMetadata(input(fixture.root), fixture.dependencies), before = metadata(fixture);
      fixture.dependencies.observeQueue = () => ({ claimed: [{ pr: 2, branch: 'other', version: '1.0.1' }], snapshot: 'changed', possibleSelfClaim: false, currentPrIdentity: null, exactSelfClaim: null, unresolvedSelfClaim: false });
      const second = await releaseMetadata(input(fixture.root), fixture.dependencies);
      expect(second).toMatchObject({ reason: 'queue_drift', allocation_id: first.allocation_id, release_write_record_id: first.release_write_record_id });
      expect(metadata(fixture)).toEqual(before);
    } finally { fixture.cleanup(); }
  }, 20000);

  test('same repository worktrees reserve different local versions', async () => {
    const fixture = releaseFixture();
    try {
      const first = await releaseMetadata({ ...input(fixture.root), operation: 'allocate' }, fixture.dependencies);
      const other = path.join(fixture.directory, 'other'); fixtureGit(fixture.root, 'worktree', 'add', '-qb', 'another', other, 'main');
      const { releaseFixtureDependencies } = await import('./helpers/release-metadata-fixture');
      const second = await releaseMetadata({ ...input(other), operation: 'allocate' }, releaseFixtureDependencies(other, fixture.state));
      expect(first.version).toBe('1.0.1'); expect(second.version).toBe('1.0.2');
    } finally { fixture.cleanup(); }
  });

  test('rejects the 257th owner allocation before append and leaves the 256-row ledger readable', async () => {
    const fixture = releaseFixture();
    try {
      await releaseMetadata({ ...input(fixture.root), operation: 'allocate' }, fixture.dependencies);
      const owners = path.join(fixture.state, 'release-metadata');
      const owner = path.join(owners, fs.readdirSync(owners)[0]);
      const ledgerPath = path.join(owner, 'ledger.json');
      const envelope = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      const seed = envelope.value.allocations[0];
      for (let index = 1; index < 256; index++) {
        envelope.value.allocations.push({
          ...structuredClone(seed),
          allocation_id: `release-${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
          record_id: `release-write-${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
          identity: { ...seed.identity, branch: `refs/heads/reserved-${index}` },
          version: `2.0.${index}`,
        });
      }
      envelope.sha256 = digest(JSON.stringify(envelope.value));
      fs.writeFileSync(ledgerPath, JSON.stringify(envelope) + '\n');
      fixtureGit(fixture.root, 'branch', 'capacity-new', 'HEAD');
      fixtureGit(fixture.root, 'symbolic-ref', 'HEAD', 'refs/heads/capacity-new');
      const before = fs.readFileSync(ledgerPath);
      const { releaseFixtureDependencies } = await import('./helpers/release-metadata-fixture');
      await expect(releaseMetadata({ ...input(fixture.root), operation: 'allocate' }, releaseFixtureDependencies(fixture.root, fixture.state))).rejects.toThrow('release_owner_capacity');
      expect(fs.readFileSync(ledgerPath)).toEqual(before);
      expect(JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).value.allocations).toHaveLength(256);
    } finally { fixture.cleanup(); }
  });

  test('rejects an unknown self claim without treating branch text as ownership', async () => {
    const fixture = releaseFixture();
    try {
      fixture.dependencies.observeQueue = () => ({ claimed: [], snapshot: 'self', possibleSelfClaim: true, currentPrIdentity: null, exactSelfClaim: null, unresolvedSelfClaim: true });
      await expect(releaseMetadata(input(fixture.root), fixture.dependencies)).rejects.toThrow('release_lineage_required');
      expect(metadata(fixture)).toEqual(fixture.before);
    } finally { fixture.cleanup(); }
  });

  test('rejects invalid changelog body before any tracked write', async () => {
    for (const body of ['## 9.9.9', '', 'Title\n===']) {
      const fixture = releaseFixture();
      try {
        await expect(releaseMetadata({ ...input(fixture.root), entryBody: () => body }, fixture.dependencies)).rejects.toThrow('release_changelog_entry_invalid');
        expect(metadata(fixture)).toEqual(fixture.before);
      } finally { fixture.cleanup(); }
    }
  });

  test('written ownership cannot certify restored before bytes as already_bumped', async () => {
    const fixture = releaseFixture();
    try {
      await releaseMetadata(input(fixture.root), fixture.dependencies);
      fs.writeFileSync(path.join(fixture.root, 'VERSION'), fixture.before.get('VERSION')!);
      const before = metadata(fixture);
      await expect(releaseMetadata({ ...input(fixture.root), operation: 'inspect' }, fixture.dependencies)).rejects.toThrow('release_projection_drift');
      expect(metadata(fixture)).toEqual(before);
    } finally { fixture.cleanup(); }
  }, 20000);

  test('compact written ownership rejects staging-boundary drift with identical worktree bytes', async () => {
    const fixture = releaseFixture();
    try {
      await releaseMetadata(input(fixture.root), fixture.dependencies);
      fixtureGit(fixture.root, 'add', 'docs.md');
      await expect(releaseMetadata({ ...input(fixture.root), operation: 'inspect' }, fixture.dependencies)).rejects.toThrow('release_product_drift');
    } finally { fixture.cleanup(); }
  }, 20000);

  test('compact written ownership rejects a byte-identical target advance', async () => {
    const fixture = releaseFixture();
    try {
      await releaseMetadata(input(fixture.root), fixture.dependencies);
      const target = fixtureGit(fixture.root, 'rev-parse', 'refs/remotes/origin/main');
      const advanced = fixtureGit(fixture.root, 'commit-tree', `${target}^{tree}`, '-p', target, '-m', 'Advanced target with identical bytes');
      fixtureGit(fixture.root, 'update-ref', 'refs/remotes/origin/main', advanced);
      await expect(releaseMetadata({ ...input(fixture.root), operation: 'inspect' }, fixture.dependencies)).rejects.toThrow('release_lineage_required');
    } finally { fixture.cleanup(); }
  }, 20000);

  test('pending cleanup still enforces queue and asserted version before certifying success', async () => {
    const fixture = releaseFixture();
    try {
      fixture.dependencies.observe = phase => { if (phase === 'write_result_durable') throw new Error('fixture_power_loss'); };
      await expect(releaseMetadata(input(fixture.root), fixture.dependencies)).rejects.toThrow('fixture_power_loss');
      fixture.dependencies.observe = undefined;
      await expect(releaseMetadata({ ...input(fixture.root), assertVersion: '9.9.9' }, fixture.dependencies)).rejects.toThrow('release_version_assertion_mismatch');
      fixture.dependencies.observeQueue = () => ({ claimed: [{ pr: 2, branch: 'other', version: '1.0.1' }], snapshot: 'changed', possibleSelfClaim: false, currentPrIdentity: null, exactSelfClaim: null, unresolvedSelfClaim: false });
      const retried = await releaseMetadata(input(fixture.root), fixture.dependencies);
      expect(retried).toMatchObject({ reason: 'queue_drift', phase: 'written_pending_cleanup' });
      expect(fs.readdirSync(ownerDirectory(fixture)).filter(name => name.endsWith('.bundle.json'))).toHaveLength(1);
    } finally { fixture.cleanup(); }
  }, 20000);

  for (const boundary of ['write_result_tombstone_durable', 'write_result_durable', 'bundle_unlinked']) {
    test(`identity movement at ${boundary} cannot publish terminal success`, async () => {
      const fixture = releaseFixture();
      try {
        fixtureGit(fixture.root, 'branch', 'moved-during-publication', 'HEAD');
        let moved = false;
        fixture.dependencies.observe = phase => {
          if (moved || phase !== boundary) return;
          moved = true;
          fixtureGit(fixture.root, 'symbolic-ref', 'HEAD', 'refs/heads/moved-during-publication');
        };
        await expect(releaseMetadata(input(fixture.root), fixture.dependencies)).rejects.toThrow('release_subject_moved');
        expect(moved).toBe(true);
        const owner = ownerDirectory(fixture);
        const ledger = JSON.parse(fs.readFileSync(path.join(owner, 'ledger.json'), 'utf8')).value;
        expect(ledger.allocations[0].phase).not.toBe('written');
      } finally { fixture.cleanup(); }
    }, 20000);
  }

  test('staging drift at success publication is not adopted into the compact result', async () => {
    const fixture = releaseFixture();
    try {
      fixture.dependencies.observe = phase => { if (phase === 'before_success_publication') fixtureGit(fixture.root, 'add', 'docs.md'); };
      await expect(releaseMetadata(input(fixture.root), fixture.dependencies)).rejects.toThrow('release_product_drift');
      const owner = ownerDirectory(fixture);
      const ledger = JSON.parse(fs.readFileSync(path.join(owner, 'ledger.json'), 'utf8')).value;
      expect(ledger.allocations[0].phase).toBe('applying');
      expect(fs.readdirSync(owner).filter(name => name.endsWith('.bundle.json'))).toHaveLength(1);
      expect(fs.readdirSync(owner).filter(name => name.endsWith('.result.json'))).toEqual([]);
    } finally { fixture.cleanup(); }
  }, 20000);

  test('identity movement after durable cleanup cannot receive stale success', async () => {
    const fixture = releaseFixture();
    try {
      fixtureGit(fixture.root, 'branch', 'moved-after-cleanup', 'HEAD');
      fixture.dependencies.observe = phase => {
        if (phase === 'bundle_cleanup_durable') fixtureGit(fixture.root, 'symbolic-ref', 'HEAD', 'refs/heads/moved-after-cleanup');
      };
      await expect(releaseMetadata(input(fixture.root), fixture.dependencies)).rejects.toThrow('release_subject_moved');
      const owner = ownerDirectory(fixture);
      const ledger = JSON.parse(fs.readFileSync(path.join(owner, 'ledger.json'), 'utf8')).value;
      expect(ledger.allocations[0].phase).toBe('written');
      expect(fs.readdirSync(owner).filter(name => name.endsWith('.bundle.json'))).toEqual([]);
      fixtureGit(fixture.root, 'symbolic-ref', 'HEAD', 'refs/heads/feature');
      fixture.dependencies.observe = undefined;
      await expect(releaseMetadata(input(fixture.root), fixture.dependencies)).resolves.toMatchObject({ reason: 'already_bumped', phase: 'written' });
    } finally { fixture.cleanup(); }
  }, 20000);

  test('a corrupted bundle is rejected before any recovery write', () => {
    const fixture = releaseFixture();
    try {
      expect(run(fixture, 'write_intent_durable').exitCode).not.toBe(0);
      const owners = path.join(fixture.state, 'release-metadata');
      const owner = path.join(owners, fs.readdirSync(owners)[0]);
      const bundle = path.join(owner, fs.readdirSync(owner).find(name => name.endsWith('.bundle.json'))!);
      const encoded = JSON.parse(fs.readFileSync(bundle, 'utf8')); encoded.value.version = '9.9.9';
      fs.writeFileSync(bundle, JSON.stringify(encoded));
      const before = metadata(fixture), retry = run(fixture, '', 'gone');
      expect(retry.exitCode).toBe(2); expect(text(retry.stderr)).toBe('release_owner_record_invalid'); expect(metadata(fixture)).toEqual(before);
    } finally { fixture.cleanup(); }
  });

  test('strict target validation rejects duplicates, incompatible projections, and path escape', () => {
    const source = { path: 'VERSION', format: 'plain_text', selector: 'whole_file' } as const;
    for (const targets of [[source, source], [source, { ...source, path: '../VERSION' }], [source, { path: 'VERSION', format: 'toml', selector: '/project/version' }]]) {
      expect(() => validateReleaseTargets({ version_source: source, version_targets: targets, changelog_path: null } as any)).toThrow();
    }
  });

  test('JSON duplicate keys cannot hide a second version and TOML multiline decoys cannot be edited', () => {
    const base = { path: 'file', mode: 0o644, version: '1.0.1', current: '1.0.0', date: '2026-09-09' };
    expect(() => renderReleaseFile({ ...base, bytes: Buffer.from('{"version":"1.0.0","version":"1.0.0"}'), projections: [{ path: 'file', format: 'json', selector: '/version', purpose: 'version' }] })).toThrow('release_projection_duplicate_key');
    expect(() => renderReleaseFile({ ...base, bytes: Buffer.from('description="""\n[project]\nversion = "1.0.0"\n"""\n[project]\nversion = "1.0.0"\n'), projections: [{ path: 'file', format: 'toml', selector: '/project/version', purpose: 'version' }] })).toThrow('release_toml_layout_unsupported');
  });

  for (const boundary of ['before_replacement', 'before_success_publication']) {
    for (const movement of ['branch', 'head', 'target']) {
      test(`identity movement at ${boundary}: ${movement} cannot publish stale success`, async () => {
        const fixture = releaseFixture();
        try {
          const initialHead = fixtureGit(fixture.root, 'rev-parse', 'HEAD');
          const sameTreeHead = fixtureGit(fixture.root, 'commit-tree', `${initialHead}^{tree}`, '-p', initialHead, '-m', 'Same bytes, different identity');
          fixtureGit(fixture.root, 'branch', 'moved-branch', initialHead);
          const phases: string[] = []; let moved = false;
          fixture.dependencies.observe = phase => {
            phases.push(phase);
            const atBoundary = boundary === 'before_replacement' ? phase.startsWith('replacement_fsynced:') : phase === boundary;
            if (moved || !atBoundary) return;
            moved = true;
            if (movement === 'branch') fixtureGit(fixture.root, 'symbolic-ref', 'HEAD', 'refs/heads/moved-branch');
            else fixtureGit(fixture.root, 'update-ref', movement === 'head' ? 'refs/heads/feature' : 'refs/remotes/origin/main', sameTreeHead);
          };
          await expect(releaseMetadata(input(fixture.root), fixture.dependencies)).rejects.toThrow(movement === 'target' ? 'release_policy_moved' : 'release_subject_moved');
          expect(moved).toBe(true); expect(phases).not.toContain('write_result_durable');
          expect(metadata(fixture)).toEqual(fixture.before);
          if (boundary === 'before_replacement') expect(phases.filter(phase => phase.startsWith('replaced:'))).toHaveLength(0);
          const owners = path.join(fixture.state, 'release-metadata');
          const ledger = JSON.parse(fs.readFileSync(path.join(owners, fs.readdirSync(owners)[0], 'ledger.json'), 'utf8')).value;
          expect(ledger.allocations).toHaveLength(1); expect(ledger.allocations[0].phase).toBe('rolled_back');
          expect(ledger.allocations[0].identity.head).toBe(initialHead);
        } finally { fixture.cleanup(); }
      }, 20000);
    }
  }

  test('byte-identical branch movement during entry collection cannot receive release writes', async () => {
    const fixture = releaseFixture();
    try {
      fixtureGit(fixture.root, 'branch', 'moved-during-input', 'HEAD');
      const phases: string[] = []; fixture.dependencies.observe = phase => phases.push(phase);
      await expect(releaseMetadata({ ...input(fixture.root), entryBody: () => {
        fixtureGit(fixture.root, 'symbolic-ref', 'HEAD', 'refs/heads/moved-during-input');
        return '- Body collected after a branch change.';
      } }, fixture.dependencies)).rejects.toThrow('release_subject_moved');
      expect(phases.filter(phase => phase.startsWith('replaced:'))).toHaveLength(0);
      expect(phases).not.toContain('write_result_durable'); expect(metadata(fixture)).toEqual(fixture.before);
    } finally { fixture.cleanup(); }
  });

  test('CHANGELOG preserves UTF-8 BOM and uses original-byte insertion offset', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Changelog\r\n\r\n## [1.0.0]\r\n\r\n- 기존 항목.\r\n')]);
    const rendered = renderReleaseFile({ path: 'CHANGELOG.md', bytes, mode: 0o644, projections: [{ path: 'CHANGELOG.md', format: 'plain_text', selector: 'whole_file', purpose: 'changelog' }], version: '1.0.1', current: '1.0.0', entry: '- New entry.', date: '2026-09-09' });
    const after = Buffer.from(rendered.file.after, 'base64');
    expect(rendered.proposal).toMatchObject({ insertion_start_byte: 16, insertion_end_byte: 16 });
    expect(after.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const insertedLength = after.length - bytes.length;
    expect(Buffer.concat([after.subarray(0, 16), after.subarray(16 + insertedLength)])).toEqual(bytes);
    expect(Buffer.from(rendered.file.before, 'base64')).toEqual(bytes);
  });

  test('indented same-version headings are rejected using exact version tokens', () => {
    const render = (heading: string) => renderReleaseFile({ path: 'CHANGELOG.md', bytes: Buffer.from(`# Changelog\n\n${heading}\n\n- Existing.\n`), mode: 0o644, projections: [{ path: 'CHANGELOG.md', format: 'plain_text', selector: 'whole_file', purpose: 'changelog' }], version: '1.0.1', current: '1.0.0', entry: '- New entry.', date: '2026-09-09' });
    for (const indent of ['', ' ', '  ', '   ']) {
      for (const token of ['[1.0.1]', 'v1.0.1', '1.0.1', '[1.0.1] / [1.0.10]']) expect(() => render(`${indent}##\t${token}`)).toThrow('release_changelog_version_exists');
    }
    for (const token of ['[1.0.10]', '[11.0.1]', '[1.0.1.0]', '[1.0.1-rc.1]']) expect(() => render(`  ## ${token}`)).not.toThrow();
  });
});
