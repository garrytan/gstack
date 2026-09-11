import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildChangeManifest } from './change-manifest';
import { buildEvidenceRecord, EVIDENCE_POLICY_VERSION, inspectShipHandoff, type EvidenceRecordV2, type ReleaseDecision, type ShipReleaseWriteBinding } from './evidence-envelope';
import { snapshotProviderHead, assertProviderHeadSnapshot, type ProviderHeadSnapshot } from './provider-access';
import { ledgerCandidates, readJsonlUnion, resolveProjectIdentity } from './project-identity';
import { resolveProfileValidatorBinding } from './profile-validator-binding';
import { resolveTrustedWorkProfile } from './trusted-base';
import { evaluateValidatorBinding } from './validator-runner';
import { LANES, parseWorkProfile, resolveProfileRequirements, type Lane } from './work-profile';
import { inspectCanaryShipCandidate } from './lane-canary';
import { resolveReleasePolicy } from './release-policy';
import { inspectCommittedReleaseWrite, type CommittedReleaseWriteInput } from './release-metadata';
import { durableAtomicWrite } from './durable-atomic-write';
import { acquireDurableOwnerLock, releaseDurableOwnerLock } from './durable-owner-lock';
import { canonicalStateRootId, resolveCanonicalStateRoot, type CanonicalStateRoot } from './canonical-state-root';

type ProviderAdapter = (cwd: string, pr: number, options?: { requireLocalHead?: boolean }) => Promise<ProviderHeadSnapshot>;
type ReviewRow = Record<string, unknown> & { run_id?: string; status?: string; skill?: string; capability_id?: string; repo_id?: string; branch_ref?: string; wtree?: string; manifest_hash?: string; target_sha?: string; merge_base_sha?: string };

function stateHome(value?: string, injected?: CanonicalStateRoot): CanonicalStateRoot {
  if (!value && !injected) return resolveCanonicalStateRoot();
  const root = fs.realpathSync(path.resolve(injected?.root ?? value!)); const info = fs.lstatSync(root); const uid = process.geteuid?.();
  if (info.isSymbolicLink() || !info.isDirectory() || uid === undefined || info.uid !== uid || (info.mode & 0o022) !== 0 || (value && root !== fs.realpathSync(path.resolve(value)))) throw new Error('ship_handoff_state_root_invalid');
  const expectedStateRootId = canonicalStateRootId(uid, root); const stateRootId = injected?.stateRootId ?? expectedStateRootId;
  if (stateRootId !== expectedStateRootId || injected?.effectiveUid !== undefined && injected.effectiveUid !== uid) throw new Error('ship_handoff_state_root_invalid');
  return { root, stateRootId, effectiveUid: uid };
}

export interface ShipHandoffDependencies {
  state?: CanonicalStateRoot;
  releaseState?: CanonicalStateRoot;
  inspectReleaseWrite?: (input: CommittedReleaseWriteInput) => ShipReleaseWriteBinding;
  observe?: (phase: 'receipt_durable') => void;
}

function stableReceipt(record: EvidenceRecordV2): unknown {
  return { subject: record.subject, capability: record.capability, validator: record.validator, policy_version: record.policy_version, profile_hash: record.profile_hash, semantic_policy_hash: record.semantic_policy_hash, inputs: record.inputs, coverage: record.coverage, handoff: record.handoff, result: record.result, exit: record.exit, artifacts: record.artifacts, side_effects: record.side_effects, expires_at: record.expires_at };
}
function handoffResult(record: EvidenceRecordV2) {
  const handoff = record.handoff as Record<string, unknown>;
  return { schema: 'ecpe.ship-handoff-write.v1' as const, receipt_run_id: record.run_id, pr: handoff.pr_number as number, remote_pr_head_sha: record.subject.remote_pr_head_sha!, remote_pr_head_tree: record.subject.tree!, review_run_ids: [...handoff.review_run_ids as string[]], validation_run_ids: [...handoff.validation_run_ids as string[]], promotion: (handoff.promotion ?? null) as Record<string, unknown> | null, canary_subject: (handoff.canary_subject ?? null) as Record<string, unknown> | null };
}
function readOwnedLedger(target: string, sync = false): string {
  let fd: number;
  try { fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); }
  catch (error: any) { if (error?.code === 'ENOENT') return ''; throw new Error('ship_handoff_ledger_invalid'); }
  try {
    const info = fs.fstatSync(fd); const uid = process.geteuid?.();
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== uid || (info.mode & 0o777) !== 0o600 || info.size > 16 * 1024 * 1024) throw new Error('ship_handoff_ledger_invalid');
    const value = fs.readFileSync(fd, 'utf8'); if (sync) fs.fsyncSync(fd); return value;
  } finally { fs.closeSync(fd); }
}
function validateProtectedLedgerPath(home: string, target: string): boolean {
  const base = path.join(home, 'projects'); const relative = path.relative(base, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('ship_handoff_ledger_invalid');
  const directories = [...new Set([home, base, path.dirname(target)])]; const uid = process.geteuid?.();
  if (uid === undefined) throw new Error('ship_handoff_ledger_invalid');
  for (const directory of directories) {
    let info: fs.Stats;
    try { info = fs.lstatSync(directory); } catch (error: any) { if (error?.code === 'ENOENT' && directory !== home) return false; throw new Error('ship_handoff_ledger_invalid'); }
    if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== uid || (info.mode & 0o022) !== 0) throw new Error('ship_handoff_ledger_invalid');
  }
  return true;
}
function readProtectedEvidenceRecords(paths: string[], home: string): EvidenceRecordV2[] {
  const rows: EvidenceRecordV2[] = []; const seen = new Map<string, string>();
  for (const candidate of [...new Set(paths)]) {
    if (!validateProtectedLedgerPath(home, candidate)) continue;
    const content = readOwnedLedger(candidate);
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let row: EvidenceRecordV2;
      try { row = JSON.parse(line) as EvidenceRecordV2; } catch { continue; }
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const encoded = JSON.stringify(row); const key = typeof row.run_id === 'string' && row.run_id ? `run:${row.run_id}` : `row:${encoded}`;
      const prior = seen.get(key); if (prior !== undefined && prior !== encoded) throw new Error('ship_handoff_ambiguous');
      if (prior === undefined) { seen.set(key, encoded); rows.push(row); }
    }
  }
  return rows;
}
function syncLedger(target: string): void {
  readOwnedLedger(target, true); const parent = fs.openSync(path.dirname(target), 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}

function currentReviewIds(cwd: string, home: string, manifestHash: string, wtree: string, targetSha: string, mergeBaseSha: string): string[] {
  const identity = resolveProjectIdentity(cwd, { mode: 'profile' });
  const rows = readJsonlUnion<ReviewRow>(ledgerCandidates(identity, 'reviews', home));
  const newest = new Map<string, ReviewRow>();
  for (const row of rows) {
    const capability = String(row.capability_id ?? (row.skill === 'review' ? 'review.code' : ''));
    if (capability) newest.set(capability, row);
  }
  return [...newest.values()].filter((row) => (row.status === 'clean' || row.status === 'pass') && row.repo_id === identity.repo_id && row.branch_ref === identity.raw_branch && row.wtree === wtree && row.manifest_hash === manifestHash && row.target_sha === targetSha && row.merge_base_sha === mergeBaseSha && typeof row.run_id === 'string').map((row) => row.run_id!).sort();
}

export async function appendShipHandoff(input: { cwd: string; pr: number; assertTargetRef: string; lane?: Lane | 'auto'; blockId?: string; releaseRequested?: boolean; stateHome?: string; provider?: ProviderAdapter }, dependencies: ShipHandoffDependencies = {}) {
  if (!Number.isSafeInteger(input.pr) || input.pr <= 0) throw new Error('ship_handoff_pr_invalid');
  const cwd = fs.realpathSync(path.resolve(input.cwd)); const shipState = stateHome(input.stateHome, dependencies.state); const home = shipState.root; const requestedLane = input.lane ?? 'single_repo_code';
  if (dependencies.releaseState && (dependencies.releaseState.root !== shipState.root || dependencies.releaseState.stateRootId !== shipState.stateRootId || dependencies.releaseState.effectiveUid !== shipState.effectiveUid)) throw new Error('ship_handoff_state_root_invalid');
  const provider = input.provider ?? snapshotProviderHead;
  const observed = await provider(cwd, input.pr, { requireLocalHead: true });
  const snapshot = assertProviderHeadSnapshot(observed, { prNumber: input.pr, expectedHeadOid: observed.headRefOid, expectedBaseOid: observed.baseRefOid, expectedTargetRef: input.assertTargetRef, requireAutomationNull: true });
  const identity = resolveProjectIdentity(cwd, { mode: 'profile' });
  const gitTree = Bun.spawnSync(['/usr/bin/git', 'rev-parse', 'HEAD^{tree}'], { cwd, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
  const gitStatus = Bun.spawnSync(['/usr/bin/git', 'status', '--porcelain=v1', '--untracked-files=all'], { cwd, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
  const subjectTree = gitTree.stdout.toString().trim();
  if (gitTree.exitCode !== 0 || gitStatus.exitCode !== 0 || gitStatus.stdout.toString() !== '' || !/^[0-9a-f]{40}$/.test(subjectTree)) throw new Error('ship_handoff_subject_dirty');
  const resolvedLanes = (requestedLane === 'auto' ? LANES : [requestedLane]).map((candidateLane) => ({
    lane: candidateLane,
    resolved: resolveTrustedWorkProfile({ cwd, lane: candidateLane, assertTargetRef: input.assertTargetRef, safetyStateRoot: home }),
  }));
  const promotionLanes = resolvedLanes.filter(({ resolved: candidate }) => candidate.candidate_state === 'authorized_promotion' && candidate.promotion_lineage !== null);
  if (promotionLanes.length > 1) throw new Error('ship_handoff_lane_ambiguous');
  const canaryLanes = input.blockId ? resolvedLanes.flatMap(({ lane: candidateLane, resolved: candidate }) => {
    if (!candidate.profile_hash || candidate.execution === 'profile' || (candidate.candidate_state === 'authorized_promotion' && candidate.promotion_lineage !== null)) return [];
    try {
      return [{ lane: candidateLane, resolved: candidate, subject: inspectCanaryShipCandidate({ stateRoot: home, repoId: identity.repo_id, lane: candidateLane, profileHash: candidate.profile_hash, blockId: input.blockId!, subjectHead: snapshot.headRefOid, subjectTree }) }];
    } catch (error) {
      if (error instanceof Error && ['canary_lineage_missing', 'canary_ship_candidate_not_pending', 'canary_ship_candidate_missing'].includes(error.message)) return [];
      throw error;
    }
  }) : [];
  if (canaryLanes.length > 1 || (canaryLanes.length === 1 && promotionLanes.length === 1)) throw new Error('ship_handoff_lane_ambiguous');
  const selected = canaryLanes[0] ?? promotionLanes[0] ?? resolvedLanes.find(({ lane: candidateLane }) => candidateLane === 'single_repo_code') ?? resolvedLanes[0];
  const lane = selected.lane; const resolved = selected.resolved;
  const authorizedPromotion = resolved.candidate_state === 'authorized_promotion' && resolved.promotion_lineage !== null;
  let canarySubject: ReturnType<typeof inspectCanaryShipCandidate> | null = null;
  if (canaryLanes.length === 1) canarySubject = canaryLanes[0].subject;
  else if (resolved.execution !== 'profile' && !authorizedPromotion && input.blockId && resolved.profile_hash) {
    try { canarySubject = inspectCanaryShipCandidate({ stateRoot: home, repoId: identity.repo_id, lane, profileHash: resolved.profile_hash, blockId: input.blockId, subjectHead: snapshot.headRefOid, subjectTree }); }
    catch (error) { if (!(error instanceof Error) || !['canary_lineage_missing', 'canary_ship_candidate_not_pending', 'canary_ship_candidate_missing'].includes(error.message)) throw error; }
  }
  if (!resolved.effective || (resolved.execution !== 'profile' && !authorizedPromotion && !canarySubject) || resolved.trusted_base.target_sha !== snapshot.baseRefOid) throw new Error('ship_handoff_profile_mismatch');
  const manifest = buildChangeManifest({ cwd, profile: resolved.effective, targetBaseRef: resolved.trusted_base.target_ref ?? undefined, targetBaseSha: resolved.trusted_base.target_sha, mergeBaseSha: resolved.trusted_base.merge_base_sha });
  if (resolved.trusted_base.candidate_sha !== snapshot.headRefOid) throw new Error('ship_handoff_head_mismatch');
  const requirements = resolveProfileRequirements(resolved.effective, { roles: manifest.roles, lane, finishLine: 'pr_open' });
  if (requirements.unbound_capabilities.length) throw new Error('ship_handoff_capability_unbound');
  const validationRunIds: string[] = [];
  for (const validatorId of requirements.validator_ids) {
    const resolvedBinding = resolveProfileValidatorBinding({
      cwd, lane, validatorId, assertTargetRef: input.assertTargetRef, stateHome: home, resolvedProfile: resolved,
      ...(canarySubject ? { canary: {
        blockId: canarySubject.block_id,
        focusedRunId: canarySubject.focused_run_id,
        subjectHead: canarySubject.subject_head,
        subjectTree: canarySubject.subject_tree,
        policyHash: canarySubject.policy_hash,
      } } : {}),
    });
    const verdict = evaluateValidatorBinding(resolvedBinding.binding);
    if (!verdict.current || !verdict.receipt_run_id) throw new Error(`ship_validation_missing:${validatorId}`);
    validationRunIds.push(verdict.receipt_run_id);
  }
  const reviewRunIds = currentReviewIds(cwd, home, manifest.manifest_hash, manifest.wtree, resolved.trusted_base.target_sha, resolved.trusted_base.merge_base_sha);
  const post = await provider(cwd, input.pr, { requireLocalHead: true });
  assertProviderHeadSnapshot(post, { prNumber: input.pr, expectedHeadOid: snapshot.headRefOid, expectedBaseOid: snapshot.baseRefOid, expectedTargetRef: snapshot.targetRef, expectedRepositoryNodeId: snapshot.repositoryNodeId, expectedHeadRepositoryNodeId: snapshot.headRepositoryNodeId, expectedHeadRefName: snapshot.headRefName, requireAutomationNull: true });
  let promotionHandoff: Record<string, unknown> = {};
  if (authorizedPromotion) {
    const lineage = resolved.promotion_lineage!;
    const profileBytes = fs.readFileSync(path.join(cwd, '.gstack', 'work-profile.yaml'));
    const profile = parseWorkProfile(profileBytes.toString('utf8'));
    const blob = Bun.spawnSync(['/usr/bin/git', 'rev-parse', 'HEAD:.gstack/work-profile.yaml'], { cwd, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
    const bytesHash = new Bun.CryptoHasher('sha256').update(profileBytes).digest('hex');
    const blobOid = blob.stdout.toString().trim();
    if (blob.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(blobOid) || bytesHash !== lineage.after_sha256 || profile.semantic_policy_hash !== lineage.after_profile_hash) throw new Error('ship_handoff_promotion_mismatch');
    promotionHandoff = { candidate_profile: { git_blob_oid: blobOid, schema_validation_hash: profile.semantic_policy_hash }, promotion: lineage };
  }
  const policy = resolveReleasePolicy({ resolvedProfile: resolved, cwd, releaseRequested: input.releaseRequested });
  if (policy.source !== 'trusted_profile') throw new Error('ship_handoff_release_policy_invalid');
  const release: ReleaseDecision = { applicable: policy.applicable, mode: policy.release_mode, version: policy.applicable ? policy.current_version : null, title_policy: policy.title_policy };
  const releaseWrite = policy.applicable ? (dependencies.inspectReleaseWrite
    ? dependencies.inspectReleaseWrite({ cwd, lane, releaseRequested: input.releaseRequested, assertTargetRef: input.assertTargetRef })
    : inspectCommittedReleaseWrite({ cwd, lane, releaseRequested: input.releaseRequested, assertTargetRef: input.assertTargetRef }, { state: dependencies.releaseState ?? shipState, resolveProfile: () => resolved })) : null;
  if (releaseWrite && (releaseWrite.version !== release.version || releaseWrite.after_wtree !== subjectTree)) throw new Error('ship_handoff_release_binding_mismatch');
  const now = new Date().toISOString();
  const record = buildEvidenceRecord({
    repo_id: identity.repo_id, branch_ref: identity.raw_branch, base_sha: snapshot.baseRefOid, merge_base_sha: resolved.trusted_base.merge_base_sha,
    local_head_sha: snapshot.headRefOid, remote_pr_head_sha: snapshot.headRefOid, tree: subjectTree,
    wtree: manifest.wtree, dirty: false, capability: { id: 'delivery.pr_open', version: '1' }, validator: { id: 'gstack.ship-handoff', version: '1' }, policy_version: EVIDENCE_POLICY_VERSION,
    profile_hash: resolved.profile_hash, semantic_policy_hash: resolved.effective.semantic_policy_hash, lockfile_hashes: {}, dependency_fingerprints: {}, toolchain_fingerprint: {}, environment_class: 'provider',
    coverage: { semantic_roles: manifest.roles, files: manifest.changed.map((entry) => entry.path) }, started_at: now, completed_at: now, expires_at: null,
    handoff: { stage: 'ship', state_root_id: shipState.stateRootId, pr_number: input.pr, base_ref: snapshot.targetRef, provider_identity: { repository_node_id: snapshot.repositoryNodeId, repository_name_with_owner: snapshot.repositoryNameWithOwner, head_repository_node_id: snapshot.headRepositoryNodeId, head_repository_name_with_owner: snapshot.headRepositoryNameWithOwner, head_ref_name: snapshot.headRefName }, manifest_hash: manifest.manifest_hash, review_run_ids: reviewRunIds, validation_run_ids: validationRunIds.sort(), evidence_run_ids: [...reviewRunIds, ...validationRunIds].sort(), release, release_write: releaseWrite, ...promotionHandoff, ...(canarySubject ? { canary_subject: canarySubject } : {}) },
    caller: { command_argv: ['gstack-evidence', 'handoff', '--stage', 'ship', '--pr', String(input.pr), '--assert-target-ref', input.assertTargetRef, ...(input.releaseRequested ? ['--release-requested'] : []), ...(input.blockId ? ['--assert-milestone-block', input.blockId] : [])], result: 'pass', exit: 0, artifacts: [], side_effects: ['provider_pr_observed'] },
  });
  const directory = path.join(home, 'projects', identity.write_slug); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const ledger = path.join(directory, `${identity.write_branch}-evidence.jsonl`); const owned = acquireDurableOwnerLock(`${ledger}.jsonl-append`, 'ship_handoff_owner_busy', 20_000);
  try {
    const existing = readProtectedEvidenceRecords(ledgerCandidates(identity, 'evidence', home), home).filter(item => {
      const handoff = item.handoff as Record<string, unknown> | undefined;
      return item.capability?.id === 'delivery.pr_open' && item.validator?.id === 'gstack.ship-handoff' && item.subject?.repo_id === identity.repo_id && item.subject?.base_sha === snapshot.baseRefOid && item.subject?.remote_pr_head_sha === snapshot.headRefOid && handoff?.pr_number === input.pr && handoff?.base_ref === snapshot.targetRef;
    });
    if (existing.length > 1) throw new Error('ship_handoff_ambiguous');
    if (existing.length === 1) {
      if (JSON.stringify(stableReceipt(existing[0])) !== JSON.stringify(stableReceipt(record))) throw new Error('ship_handoff_conflict');
      const canonicalRows = readProtectedEvidenceRecords([ledger], home);
      if (!canonicalRows.some(item => item.run_id === existing[0].run_id)) {
        const previous = readOwnedLedger(ledger); if (previous && !previous.endsWith('\n')) throw new Error('ship_handoff_ledger_invalid');
        durableAtomicWrite(ledger, `${previous}${JSON.stringify(existing[0])}\n`, { mode: 0o600 });
      }
      syncLedger(ledger);
      return handoffResult(existing[0]);
    }
    const previous = readOwnedLedger(ledger);
    if (previous && !previous.endsWith('\n')) throw new Error('ship_handoff_ledger_invalid');
    durableAtomicWrite(ledger, `${previous}${JSON.stringify(record)}\n`, { mode: 0o600 });
    dependencies.observe?.('receipt_durable');
    const verified = readJsonlUnion<EvidenceRecordV2>([ledger]).filter(item => item.run_id === record.run_id);
    if (verified.length !== 1 || JSON.stringify(verified[0]) !== JSON.stringify(record)) throw new Error('ship_handoff_publication_failed');
    return handoffResult(record);
  } finally { releaseDurableOwnerLock(owned); }
}

export async function inspectCurrentShipHandoff(input: { cwd: string; pr: number; assertTargetRef: string; expectedBase: string; remotePrHead: string; stateHome?: string; provider?: ProviderAdapter }) {
  const cwd = fs.realpathSync(path.resolve(input.cwd)); const shipState = stateHome(input.stateHome); const home = shipState.root; const provider = input.provider ?? snapshotProviderHead;
  const snapshot = assertProviderHeadSnapshot(await provider(cwd, input.pr), { prNumber: input.pr, expectedHeadOid: input.remotePrHead, expectedBaseOid: input.expectedBase, expectedTargetRef: input.assertTargetRef, requireAutomationNull: true });
  return inspectAssertedShipHandoff({ cwd, pr: input.pr, assertTargetRef: snapshot.targetRef, expectedBase: snapshot.baseRefOid, remotePrHead: snapshot.headRefOid, repositoryNodeId: snapshot.repositoryNodeId, headRepositoryNodeId: snapshot.headRepositoryNodeId, headRefName: snapshot.headRefName, stateHome: home, stateRootId: shipState.stateRootId });
}

export function inspectAssertedShipHandoff(input: { cwd: string; pr: number; assertTargetRef: string; expectedBase: string; remotePrHead: string; stateRootId?: string; repositoryNodeId?: string; headRepositoryNodeId?: string; headRefName?: string; stateHome?: string }) {
  const cwd = fs.realpathSync(path.resolve(input.cwd)); const shipState = stateHome(input.stateHome); const home = shipState.root;
  const identity = resolveProjectIdentity(cwd, { mode: 'profile' });
  const records = readProtectedEvidenceRecords(ledgerCandidates(identity, 'evidence', home), home);
  return inspectShipHandoff(records, { repoId: identity.repo_id, pr: input.pr, baseRef: input.assertTargetRef, baseSha: input.expectedBase, remotePrHeadSha: input.remotePrHead, stateRootId: input.stateRootId ?? shipState.stateRootId, repositoryNodeId: input.repositoryNodeId, headRepositoryNodeId: input.headRepositoryNodeId, headRefName: input.headRefName });
}
