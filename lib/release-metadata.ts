import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolveCanonicalStateRoot, type CanonicalStateRoot } from './canonical-state-root';
import { acquireDurableOwnerLock, releaseDurableOwnerLock } from './durable-owner-lock';
import { durableAtomicWrite, readDurableAtomic } from './durable-atomic-write';
import { resolveTrustedWorkProfile, type ResolvedWorkProfile } from './trusted-base';
import { buildChangeManifest } from './change-manifest';
import { extractReleaseProjection, resolveReleasePolicy, type ReleaseMode, type ReleaseMetadataDecision, type ReleaseProjection, type LegacySkippedLockfile } from './release-policy';
import { resolveLegacyReleaseDecision, portfolioOpsBootstrap, inspectSkippedLegacyLockfile } from './release-legacy';
import { canonicalGithubRemote, fetchTrustedGithubClaimed, trustedGithubTool } from './release-queue';
import type { CurrentPrIdentity } from './release-queue';
import { bumpVersion, cmpVersion, fmtVersion, npmVersion, parseVersion, versionWidth, type Bump } from './version-source';
import { digest, renderReleaseFile, validateReleaseTargets, type ChangelogProposal, type ReleaseFile } from './release-projections';
import type { Lane } from './work-profile';
import type { ShipHandoffVerdict } from './evidence-envelope';

type Queue = ReturnType<typeof fetchTrustedGithubClaimed>;
type Phase = 'allocated' | 'applying' | 'restoring' | 'rolled_back' | 'written_pending_cleanup' | 'written' | 'retired';
interface Identity { root: string; common: string; remote: string; branch: string; head: string; uid: number; state_root_id: string }
interface Bundle {
  schema: 'ecpe.release-bundle.v1'; allocation_id: string; identity: Identity; version: string; policy_hash: string;
  files: ReleaseFile[]; proposal: ChangelogProposal | null; insertion_hash: string | null;
  manifest_hash: string; before_wtree: string; product_fingerprint: string;
  skipped_lockfiles?: LegacySkippedLockfile[];
}
interface Allocation {
  allocation_id: string; record_id: string; phase: Phase; identity: Identity; decision: ReleaseMetadataDecision;
  bump: Bump; version: string; queue: string; product_fingerprint: string; bundle_hash: string | null; result_hash?: string | null; after_wtree: string | null;
  retirement?: ReleaseRetirement | null;
}
interface ReleaseRetirement {
  schema: 'ecpe.release-retirement.v1'; retirement_id: string; allocation_id: string; release_write_record_id: string;
  release_write_result_hash: string; version: string; source: 'ship_receipt'; receipt_run_id: string;
  current_pr_identity: CurrentPrIdentity; binding_sha256: string; reservation_retained: true;
}
interface Ledger { schema: 'ecpe.release-owner.v1'; repository: string; allocations: Allocation[] }
interface ReleaseWriteRecord {
  schema: 'ecpe.release-write-result.v1'; allocation_id: string; release_write_record_id: string; identity: Identity;
  decision: ReleaseMetadataDecision; bump: Bump; version: string; queue: string; product_fingerprint: string;
  product_fingerprint_after_release: string; product_projection_fingerprint_after_release: string;
  policy_hash: string; bundle_hash: string; before_wtree: string; after_wtree: string;
  product_manifest_hash_before_release: string; release_projection_hash: string;
  changelog_proposal: ChangelogProposal | null; changelog_insertion_sha256: string | null;
  files: Array<{ path: string; mode: number; after_sha256: string; projections: ReleaseFile['projections'] }>;
}
export interface CommittedReleaseWriteBinding {
  allocation_id: string; release_write_record_id: string; release_write_result_hash: string; version: string;
  before_wtree: string; after_wtree: string; product_manifest_hash_before_release: string; release_projection_hash: string;
  changelog_proposal_sha256: string | null; changelog_insertion_sha256: string | null;
  planned_targets: ReleaseMetadataDecision['version_targets'];
  changelog_projection: { path: string; format: 'plain_text'; selector: 'whole_file' } | null;
  mutated_projections: ReleaseProjection[];
  files: Array<{ path: string; mode: number; after_sha256: string; projections: ReleaseProjection[] }>;
}
export interface RetiredReleaseLandingProof {
  schema: 'ecpe.retired-release-landing-proof.v1'; proof_id: string; binding_sha256: string;
  state_root_id: string; repository_key: string; allocation_id: string; release_write_record_id: string;
  release_write_result_hash: string; retirement_id: string; receipt_run_id: string;
  current_pr_identity: CurrentPrIdentity; release_write: CommittedReleaseWriteBinding; reservation_retained: true;
}
export interface CommittedReleaseWriteInput { cwd?: string; lane?: Lane; releaseRequested?: boolean; assertReleaseMode?: ReleaseMode; assertTargetRef?: string; assertTargetSha?: string }
export interface ReleaseSelfClaimReceiptInput {
  cwd: string; pr: number; assertTargetRef: string; expectedBase: string; remotePrHead: string;
  stateRootId: string; repositoryNodeId: string; headRepositoryNodeId: string; headRefName: string; stateHome: string;
}
export interface ReleaseMetadataInput {
  cwd?: string; operation: 'allocate' | 'write' | 'inspect' | 'recover' | 'retire'; bump?: Bump; lane?: Lane; releaseRequested?: boolean;
  assertReleaseMode?: ReleaseMode; assertTargetRef?: string; assertTargetSha?: string; currentVersion?: string;
  assertVersion?: string; entryBody?: () => string;
}
/** In-process fixture seams only; no environment variable or CLI selects these. */
export interface ReleaseMetadataDependencies {
  state?: CanonicalStateRoot;
  resolveProfile?: () => ResolvedWorkProfile;
  observeQueue?: (decision: ReleaseMetadataDecision, branch: string) => Queue;
  inspectShipReceipt?: (input: ReleaseSelfClaimReceiptInput) => ShipHandoffVerdict;
  observe?: (phase: string) => void;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8', timeout: 20_000, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } });
  if (result.status !== 0) throw new Error('release_git_identity_invalid');
  return result.stdout.trim();
}
function directory(target: string, create = false): void {
  if (create) fs.mkdirSync(target, { mode: 0o700 });
  const info = fs.lstatSync(target);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid?.() || (info.mode & 0o077) !== 0) throw new Error('release_owner_directory_invalid');
}
function childDirectory(parent: string, name: string): string {
  const target = path.join(parent, name);
  try { directory(target); } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
    try { directory(target, true); syncDirectory(parent); }
    catch (creation: any) { if (creation?.code !== 'EEXIST') throw creation; directory(target); }
  }
  return target;
}
function safeFile(root: string, relative: string): { path: string; bytes: Buffer; mode: number } {
  if (!relative || relative.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') || relative.includes('\\') || relative.includes('\0')) throw new Error('release_projection_path_invalid');
  let target = root;
  for (const component of relative.split('/')) {
    target = path.join(target, component); const info = fs.lstatSync(target);
    if (info.isSymbolicLink() || info.uid !== process.geteuid?.() || (info.mode & 0o022) !== 0) throw new Error('release_projection_file_invalid');
  }
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > 8 * 1024 * 1024) throw new Error('release_projection_file_invalid');
    return { path: target, bytes: fs.readFileSync(fd), mode: info.mode & 0o777 };
  } finally { fs.closeSync(fd); }
}
function inventoryRows(root: string, overlay: Map<string, Buffer> = new Map(), skipped: LegacySkippedLockfile[] = []): unknown[] {
  const result = spawnSync('/usr/bin/git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'buffer', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' } });
  if (result.status !== 0) throw new Error('release_product_inventory_invalid');
  return [...new Set([...result.stdout.toString('utf8').split('\0').filter(Boolean), ...skipped.map(link => link.path)])].sort().map(file => {
    const link = skipped.find(link => link.path === file);
    if (link) {
      if (JSON.stringify(inspectSkippedLegacyLockfile(root, file)) !== JSON.stringify(link)) throw new Error('release_skipped_lockfile_moved');
      return { path: file, skipped_lockfile: link };
    }
    let current;
    try { current = safeFile(root, file); }
    catch (error: any) { if (error?.code === 'ENOENT') return { path: file, missing: true }; throw error; }
    return { path: file, mode: current.mode, sha256: digest(overlay.get(file) ?? current.bytes) };
  });
}
function productProjectionFingerprint(root: string, overlay: Map<string, Buffer> = new Map(), skipped: LegacySkippedLockfile[] = []): string {
  return digest(JSON.stringify({ rows: inventoryRows(root, overlay, skipped) }));
}
function inventory(root: string, overlay: Map<string, Buffer> = new Map(), skipped: LegacySkippedLockfile[] = []): string {
  // Preserve both tracked/untracked product bytes and the staging boundary.
  return digest(JSON.stringify({ rows: inventoryRows(root, overlay, skipped), index: git(root, ['ls-files', '--stage', '-z']) }));
}
function identity(root: string, state: CanonicalStateRoot): Identity {
  const common = fs.realpathSync(path.resolve(root, git(root, ['rev-parse', '--git-common-dir'])));
  const branch = git(root, ['symbolic-ref', '--quiet', 'HEAD']);
  if (!branch.startsWith('refs/heads/')) throw new Error('release_lineage_required');
  return { root, common, remote: canonicalGithubRemote(root).selector.toLowerCase(), branch, head: git(root, ['rev-parse', '--verify', 'HEAD^{commit}']), uid: state.effectiveUid, state_root_id: state.stateRootId };
}
function envelope(value: unknown): string { return JSON.stringify({ value, sha256: digest(JSON.stringify(value)) }) + '\n'; }
function readEnvelope<T>(target: string): T | null {
  return readDurableAtomic(target, {
    decode(bytes) {
      const parsed = JSON.parse(bytes.toString('utf8'));
      if (!parsed || Object.keys(parsed).sort().join(',') !== 'sha256,value' || parsed.sha256 !== digest(JSON.stringify(parsed.value))) throw new Error('release_owner_record_invalid');
      return parsed.value as T;
    },
    isTruncatedTemporary(error) { return error instanceof SyntaxError; },
  });
}
function save(target: string, value: unknown): void { durableAtomicWrite(target, envelope(value)); }
function retirementCore(allocation: Allocation, receiptRunId: string, currentPrIdentity: CurrentPrIdentity) {
  return { allocation_id: allocation.allocation_id, release_write_record_id: allocation.record_id,
    release_write_result_hash: allocation.result_hash!, version: allocation.version, source: 'ship_receipt' as const,
    receipt_run_id: receiptRunId, current_pr_identity: structuredClone(currentPrIdentity), reservation_retained: true as const };
}
function makeRetirement(allocation: Allocation, receiptRunId: string, currentPrIdentity: CurrentPrIdentity): ReleaseRetirement {
  const core = retirementCore(allocation, receiptRunId, currentPrIdentity);
  const bindingSha256 = digest(JSON.stringify(core));
  return { schema: 'ecpe.release-retirement.v1', retirement_id: `release-retirement-${bindingSha256.slice(0, 32)}`, ...core, binding_sha256: bindingSha256 };
}
function validateRetirement(allocation: Allocation): ReleaseRetirement {
  const retirement = allocation.retirement;
  if (!retirement || retirement.schema !== 'ecpe.release-retirement.v1' || retirement.allocation_id !== allocation.allocation_id ||
    retirement.release_write_record_id !== allocation.record_id || retirement.release_write_result_hash !== allocation.result_hash ||
    retirement.version !== allocation.version || retirement.source !== 'ship_receipt' || !/^evidence-[0-9a-f]{32}$/.test(retirement.receipt_run_id) ||
    retirement.reservation_retained !== true || !retirement.current_pr_identity || !Number.isSafeInteger(retirement.current_pr_identity.number) ||
    retirement.current_pr_identity.number <= 0 || !/^[0-9a-f]{40}$/.test(retirement.current_pr_identity.base_oid) ||
    !/^[0-9a-f]{40}$/.test(retirement.current_pr_identity.head_oid) || !retirement.current_pr_identity.head_repository_node_id ||
    !retirement.current_pr_identity.head_ref || retirement.current_pr_identity.head_ref !== allocation.identity.branch.replace(/^refs\/heads\//, '') ||
    retirement.current_pr_identity.head_ref.startsWith('refs/') || retirement.current_pr_identity.head_ref.includes('..')) throw new Error('release_retirement_invalid');
  const expected = makeRetirement(allocation, retirement.receipt_run_id, retirement.current_pr_identity);
  if (JSON.stringify(retirement) !== JSON.stringify(expected)) throw new Error('release_retirement_invalid');
  return retirement;
}
function validateLedger(ledger: Ledger | null, repository: string, expected: { remote: string; common: string; stateRootId: string }): Ledger {
  if (!ledger || ledger.schema !== 'ecpe.release-owner.v1' || ledger.repository !== repository || !Array.isArray(ledger.allocations) || ledger.allocations.length > 4096) throw new Error('release_owner_record_invalid');
  let active = 0;
  for (const row of ledger.allocations) {
    if (!/^release-[0-9a-f-]{36}$/.test(row.allocation_id) || !/^release-write-[0-9a-f-]{36}$/.test(row.record_id) ||
      !['allocated', 'applying', 'restoring', 'rolled_back', 'written_pending_cleanup', 'written', 'retired'].includes(row.phase) ||
      row.identity.remote !== expected.remote || row.identity.common !== expected.common || row.identity.state_root_id !== expected.stateRootId || !parseVersion(row.version)) throw new Error('release_owner_record_invalid');
    const hasResult = row.result_hash !== null && row.result_hash !== undefined;
    if ((row.phase === 'allocated' && row.bundle_hash !== null) || (row.phase !== 'allocated' && !/^[0-9a-f]{64}$/.test(row.bundle_hash ?? '')) ||
      (hasResult && !/^[0-9a-f]{64}$/.test(row.result_hash!)) || (!['written_pending_cleanup', 'written', 'retired'].includes(row.phase) && hasResult) ||
      (['written_pending_cleanup', 'retired'].includes(row.phase) && !hasResult) || (['written_pending_cleanup', 'written', 'retired'].includes(row.phase) && !/^[0-9a-f]{40}$/.test(row.after_wtree ?? ''))) throw new Error('release_owner_record_invalid');
    if (row.phase === 'retired') validateRetirement(row);
    else if (row.retirement !== undefined && row.retirement !== null) throw new Error('release_owner_record_invalid');
    if (row.phase !== 'retired') active += 1;
  }
  if (active > 256 || new Set(ledger.allocations.map(row => row.allocation_id)).size !== ledger.allocations.length ||
    new Set(ledger.allocations.map(row => row.record_id)).size !== ledger.allocations.length ||
    new Set(ledger.allocations.map(row => row.version)).size !== ledger.allocations.length) throw new Error('release_owner_record_invalid');
  return ledger;
}
function bundlePath(owner: string, allocation: Allocation): string { return path.join(owner, `${allocation.allocation_id}.bundle.json`); }
function resultPath(owner: string, allocation: Allocation): string { return path.join(owner, `${allocation.allocation_id}.result.json`); }
function validateBundle(bundle: Bundle | null, allocation: Allocation): Bundle {
  if (!bundle || bundle.schema !== 'ecpe.release-bundle.v1' || digest(JSON.stringify(bundle)) !== allocation.bundle_hash ||
    bundle.allocation_id !== allocation.allocation_id || JSON.stringify(bundle.identity) !== JSON.stringify(allocation.identity) ||
    bundle.version !== allocation.version || bundle.policy_hash !== digest(JSON.stringify(allocation.decision)) ||
    bundle.product_fingerprint !== allocation.product_fingerprint || !Array.isArray(bundle.files) || !bundle.files.length) throw new Error('release_bundle_invalid');
  const targets = validateReleaseTargets(allocation.decision);
  if (JSON.stringify(bundle.skipped_lockfiles ?? []) !== JSON.stringify(allocation.decision.legacy_skipped_lockfiles ?? [])) throw new Error('release_bundle_invalid');
  const actual = bundle.files.flatMap(file => file.projections);
  const sorted = (values: unknown[]) => values.map(value => JSON.stringify(value)).sort();
  if (JSON.stringify(sorted(actual)) !== JSON.stringify(sorted(targets)) || new Set(bundle.files.map(file => file.path)).size !== bundle.files.length || bundle.files.some(file => file.projections.some(item => item.path !== file.path))) throw new Error('release_bundle_invalid');
  for (const file of bundle.files) {
    for (const side of ['before', 'after'] as const) {
      const bytes = Buffer.from(file[side], 'base64');
      if (bytes.toString('base64') !== file[side] || digest(bytes) !== file[`${side}_sha256`]) throw new Error('release_bundle_invalid');
    }
  }
  return bundle;
}
function states(root: string, bundle: Bundle): Array<'before' | 'after'> {
  const result = bundle.files.map(file => {
    const current = safeFile(root, file.path);
    if (current.mode !== file.mode) throw new Error('release_projection_drift');
    const hash = digest(current.bytes);
    if (hash === file.after_sha256) return 'after' as const;
    if (hash === file.before_sha256) return 'before' as const;
    throw new Error('release_projection_drift');
  });
  const normalized = new Map(bundle.files.map(file => [file.path, Buffer.from(file.before, 'base64')]));
  if (inventory(root, normalized, bundle.skipped_lockfiles) !== bundle.product_fingerprint) throw new Error('release_product_drift');
  return result;
}
function releaseProjectionHash(bundle: Bundle): string {
  return digest(JSON.stringify(bundle.files.map(file => ({ path: file.path, before: file.before_sha256, after: file.after_sha256, projections: file.projections }))));
}
function publicProjection(value: ReleaseProjection): ReleaseProjection {
  return { path: value.path, format: value.format, selector: value.selector, ...(value.value_encoding !== undefined ? { value_encoding: value.value_encoding } : {}) };
}
function makeWriteRecord(allocation: Allocation, bundle: Bundle, productFingerprintAfterRelease: string, productProjectionFingerprintAfterRelease: string): ReleaseWriteRecord {
  if (!allocation.after_wtree || !allocation.bundle_hash) throw new Error('release_write_result_invalid');
  return {
    schema: 'ecpe.release-write-result.v1', allocation_id: allocation.allocation_id, release_write_record_id: allocation.record_id,
    identity: allocation.identity, decision: allocation.decision, bump: allocation.bump, version: allocation.version,
    queue: allocation.queue, product_fingerprint: allocation.product_fingerprint, product_fingerprint_after_release: productFingerprintAfterRelease,
    product_projection_fingerprint_after_release: productProjectionFingerprintAfterRelease,
    policy_hash: digest(JSON.stringify(allocation.decision)), bundle_hash: allocation.bundle_hash,
    before_wtree: bundle.before_wtree, after_wtree: allocation.after_wtree,
    product_manifest_hash_before_release: bundle.manifest_hash, release_projection_hash: releaseProjectionHash(bundle),
    changelog_proposal: bundle.proposal, changelog_insertion_sha256: bundle.insertion_hash,
    files: bundle.files.map(file => ({ path: file.path, mode: file.mode, after_sha256: file.after_sha256, projections: file.projections })),
  };
}
function validateWriteRecord(record: ReleaseWriteRecord | null, allocation: Allocation, bundle: Bundle | null): ReleaseWriteRecord {
  if (!record || record.schema !== 'ecpe.release-write-result.v1' || digest(JSON.stringify(record)) !== allocation.result_hash ||
    record.allocation_id !== allocation.allocation_id || record.release_write_record_id !== allocation.record_id ||
    JSON.stringify(record.identity) !== JSON.stringify(allocation.identity) || JSON.stringify(record.decision) !== JSON.stringify(allocation.decision) ||
    record.bump !== allocation.bump || record.version !== allocation.version || record.queue !== allocation.queue ||
    record.product_fingerprint !== allocation.product_fingerprint || record.policy_hash !== digest(JSON.stringify(allocation.decision)) ||
    !/^[0-9a-f]{64}$/.test(record.product_fingerprint_after_release) || !/^[0-9a-f]{64}$/.test(record.product_projection_fingerprint_after_release) ||
    record.bundle_hash !== allocation.bundle_hash || record.after_wtree !== allocation.after_wtree ||
    !/^[0-9a-f]{40}$/.test(record.before_wtree) || !/^[0-9a-f]{40}$/.test(record.after_wtree) ||
    !/^[0-9a-f]{64}$/.test(record.product_manifest_hash_before_release) || !/^[0-9a-f]{64}$/.test(record.release_projection_hash) ||
    !Array.isArray(record.files) || !record.files.length || new Set(record.files.map(file => file.path)).size !== record.files.length ||
    record.files.some(file => !Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777 || !/^[0-9a-f]{64}$/.test(file.after_sha256) || !Array.isArray(file.projections) || file.projections.some(item => item.path !== file.path))) {
    throw new Error('release_write_result_invalid');
  }
  const targets = validateReleaseTargets(allocation.decision);
  const sorted = (values: unknown[]) => values.map(value => JSON.stringify(value)).sort();
  if (JSON.stringify(sorted(record.files.flatMap(file => file.projections))) !== JSON.stringify(sorted(targets))) throw new Error('release_write_result_invalid');
  if ((record.changelog_proposal === null) !== (record.changelog_insertion_sha256 === null) ||
    (record.changelog_proposal !== null && (!/^[0-9a-f]{64}$/.test(record.changelog_proposal.proposal_sha256) || !/^[0-9a-f]{64}$/.test(record.changelog_insertion_sha256!)))) throw new Error('release_write_result_invalid');
  if (bundle) {
    const expected = makeWriteRecord(allocation, bundle, record.product_fingerprint_after_release, record.product_projection_fingerprint_after_release);
    if (JSON.stringify(expected) !== JSON.stringify(record)) throw new Error('release_write_result_invalid');
  }
  return record;
}
function verifyWriteRecordState(root: string, profile: ResolvedWorkProfile, record: ReleaseWriteRecord, committed = false): void {
  for (const file of record.files) {
    const current = safeFile(root, file.path);
    if (current.mode !== file.mode || digest(current.bytes) !== file.after_sha256) throw new Error('release_projection_drift');
  }
  if (productProjectionFingerprint(root, new Map(), record.decision.legacy_skipped_lockfiles) !== record.product_projection_fingerprint_after_release ||
    (!committed && inventory(root, new Map(), record.decision.legacy_skipped_lockfiles) !== record.product_fingerprint_after_release)) throw new Error('release_product_drift');
  const manifest = buildChangeManifest({ cwd: root, profile: profile.effective ?? { semantic_paths: [] }, mergeBaseSha: record.decision.trusted_base_sha, targetBaseSha: record.decision.live_target_sha, targetBaseRef: record.decision.target_ref! });
  if (manifest.wtree !== record.after_wtree) throw new Error('release_product_drift');
}
function syncDirectory(target: string): void { const fd = fs.openSync(target, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }

// Only the final rename targets repository files. The staged replacement lives
// in the external bundle directory, which is verified to share the filesystem.
function replace(root: string, owner: string, allocation: Allocation, file: ReleaseFile, side: 'before' | 'after', observe: (phase: string) => void, assertSubject: () => void = () => {}): void {
  const target = safeFile(root, file.path);
  const temp = path.join(owner, `${allocation.allocation_id}.replacement`);
  const desired = Buffer.from(file[side], 'base64');
  let fd: number;
  try { fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600); }
  catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    const info = fs.lstatSync(temp);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== allocation.identity.uid || info.nlink !== 1 || ![0o600, file.mode].includes(info.mode & 0o777)) throw new Error('release_replacement_invalid');
    // This name is owned by the durable intent; partial scratch bytes carry no authority.
    fs.unlinkSync(temp); syncDirectory(owner);
    fd = fs.openSync(temp, 'wx', 0o600);
  }
  try { fs.writeFileSync(fd, desired); fs.fchmodSync(fd, file.mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  observe(`replacement_fsynced:${file.path}`);
  assertSubject();
  const recheck = safeFile(root, file.path);
  if (!recheck.bytes.equals(target.bytes) || recheck.mode !== target.mode) throw new Error('release_projection_drift');
  fs.renameSync(temp, target.path); observe(`replaced:${file.path}`);
  syncDirectory(path.dirname(target.path)); syncDirectory(owner); observe(`replacement_durable:${file.path}`);
}

function result(allocation: Allocation, bundle: Bundle | null, reason: string, writeRecord: ReleaseWriteRecord | null = null) {
  const written = allocation.phase === 'written';
  return {
    applicable: true, release_mode: allocation.decision.release_mode, title_policy: allocation.decision.title_policy,
    version: allocation.version, reason, allocation_id: allocation.allocation_id, release_write_record_id: written ? allocation.record_id : null,
    trusted_base_sha: allocation.decision.trusted_base_sha, trusted_base_version: allocation.decision.trusted_version,
    current_subject_version: written ? allocation.version : allocation.decision.current_version,
    current_pr_identity: null, self_claim_excluded: false, profile_hash: allocation.decision.profile_hash,
    policy_source: allocation.decision.source, bootstrap_descriptor: allocation.decision.bootstrap_descriptor ?? null,
    warnings: (allocation.decision.legacy_skipped_lockfiles ?? []).map(link => `${link.path} is a symlink; not synced.`),
    version_source: allocation.decision.version_source, planned_targets: allocation.decision.version_targets,
    changelog_projection: allocation.decision.changelog_path ? { path: allocation.decision.changelog_path, format: 'plain_text', selector: 'whole_file' } : null,
    phase: allocation.phase, before_wtree: writeRecord?.before_wtree ?? bundle?.before_wtree ?? null, after_wtree: allocation.after_wtree,
    product_manifest_hash_before_release: writeRecord?.product_manifest_hash_before_release ?? bundle?.manifest_hash ?? null,
    release_projection_hash: writeRecord?.release_projection_hash ?? (bundle ? releaseProjectionHash(bundle) : null),
    changelog_proposal_sha256: writeRecord?.changelog_proposal?.proposal_sha256 ?? bundle?.proposal?.proposal_sha256 ?? null,
    changelog_insertion_sha256: writeRecord?.changelog_insertion_sha256 ?? bundle?.insertion_hash ?? null,
    mutated_projections: written ? (writeRecord?.files.flatMap(file => file.projections) ?? bundle?.files.flatMap(file => file.projections) ?? []) : [],
  };
}

function committedBinding(allocation: Allocation, record: ReleaseWriteRecord): CommittedReleaseWriteBinding {
  return {
    allocation_id: record.allocation_id, release_write_record_id: record.release_write_record_id, release_write_result_hash: allocation.result_hash!,
    version: record.version, before_wtree: record.before_wtree, after_wtree: record.after_wtree,
    product_manifest_hash_before_release: record.product_manifest_hash_before_release, release_projection_hash: record.release_projection_hash,
    changelog_proposal_sha256: record.changelog_proposal?.proposal_sha256 ?? null, changelog_insertion_sha256: record.changelog_insertion_sha256,
    planned_targets: record.decision.version_targets.map(publicProjection),
    changelog_projection: record.decision.changelog_path ? { path: record.decision.changelog_path, format: 'plain_text', selector: 'whole_file' } : null,
    mutated_projections: record.files.flatMap(file => file.projections.map(publicProjection)),
    files: record.files.map(file => ({ path: file.path, mode: file.mode, after_sha256: file.after_sha256, projections: file.projections.map(publicProjection) })),
  };
}
function committedDecisionMatches(current: ReleaseMetadataDecision, recorded: ReleaseMetadataDecision, version: string): boolean {
  return current.source === 'trusted_profile' && current.applicable && recorded.source === 'trusted_profile' &&
    current.release_mode === recorded.release_mode && current.title_policy === recorded.title_policy &&
    current.profile_hash === recorded.profile_hash && current.trusted_base_sha === recorded.trusted_base_sha &&
    current.live_target_sha === recorded.live_target_sha && current.target_ref === recorded.target_ref &&
    current.current_version === version && current.trusted_version === recorded.trusted_version &&
    current.target_version === recorded.target_version && JSON.stringify(current.version_source) === JSON.stringify(recorded.version_source) &&
    JSON.stringify(current.version_targets) === JSON.stringify(recorded.version_targets) && current.changelog_path === recorded.changelog_path;
}

/**
 * Read-only delivery bridge for the post-release commit. This intentionally
 * does not call the normal recovery inspector: that inspector owns the
 * pre-commit HEAD/index transaction and must remain strict.
 */
function inspectCommittedReleaseState(input: CommittedReleaseWriteInput, dependencies: Pick<ReleaseMetadataDependencies, 'state' | 'resolveProfile'> = {}): {
  binding: CommittedReleaseWriteBinding; allocationQueue: string; allocationBump: Bump; allocationPhase: 'written' | 'retired'; retirement: ReleaseRetirement | null;
  decision: ReleaseMetadataDecision; current: Identity; state: CanonicalStateRoot;
} {
  const root = fs.realpathSync(path.resolve(input.cwd ?? process.cwd()));
  if (git(root, ['rev-parse', '--show-toplevel']) !== root || git(root, ['status', '--porcelain=v1', '--untracked-files=all']) !== '') throw new Error('release_commit_state_invalid');
  const state = dependencies.state ?? resolveCanonicalStateRoot(); directory(state.root);
  if (state.root === root || state.root.startsWith(`${root}${path.sep}`) || state.effectiveUid !== process.geteuid?.()) throw new Error('release_owner_root_invalid');
  const current = identity(root, state); const repository = digest(`${current.remote}\0${current.common}`);
  const metadataRoot = path.join(state.root, 'release-metadata'); const owner = path.join(metadataRoot, repository);
  try { directory(metadataRoot); directory(owner); }
  catch (error: any) { if (error?.code === 'ENOENT') throw new Error('release_write_result_missing'); throw error; }
  const lock = acquireDurableOwnerLock(path.join(owner, 'owner'), 'release_owner_busy', 20_000);
  try {
    const ledger = validateLedger(readEnvelope<Ledger>(path.join(owner, 'ledger.json')), repository, { remote: current.remote, common: current.common, stateRootId: state.stateRootId });
    const candidates = ledger.allocations.filter(row => row.identity.branch === current.branch && row.identity.remote === current.remote && row.identity.common === current.common && row.identity.root === current.root && row.identity.uid === current.uid && row.identity.state_root_id === current.state_root_id);
    const parents = git(root, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ');
    const tree = git(root, ['rev-parse', '--verify', 'HEAD^{tree}']);
    const exact = candidates.flatMap(allocation => {
      if (!['written', 'retired'].includes(allocation.phase) || !allocation.result_hash || !/^[0-9a-f]{64}$/.test(allocation.result_hash) || !allocation.after_wtree) return [];
      const record = validateWriteRecord(readEnvelope<ReleaseWriteRecord>(resultPath(owner, allocation)), allocation, null);
      return parents.length === 2 && parents[1] === record.identity.head && tree === record.after_wtree ? [{ allocation, record }] : [];
    });
    if (exact.length !== 1) throw new Error(exact.length ? 'release_owner_ambiguous' : candidates.length ? 'release_commit_lineage_invalid' : 'release_write_result_missing');
    const { allocation, record } = exact[0];
    const resolveProfile = dependencies.resolveProfile ?? (() => resolveTrustedWorkProfile({ cwd: root, lane: input.lane ?? 'single_repo_code', assertTargetRef: input.assertTargetRef, assertTargetSha: input.assertTargetSha }));
    const profile = resolveProfile();
    verifyWriteRecordState(root, profile, record, true);
    const decision = resolveReleasePolicy({ resolvedProfile: profile, cwd: root, releaseRequested: input.releaseRequested, assertReleaseMode: input.assertReleaseMode });
    if (!committedDecisionMatches(decision, record.decision, record.version)) throw new Error('release_policy_moved');
    const binding = committedBinding(allocation, record);
    if (JSON.stringify(identity(root, state)) !== JSON.stringify(current) || JSON.stringify(resolveProfile()) !== JSON.stringify(profile)) throw new Error('release_commit_lineage_invalid');
    const committed = { binding, allocationQueue: allocation.queue, allocationBump: allocation.bump, allocationPhase: allocation.phase as 'written' | 'retired', retirement: allocation.phase === 'retired' ? validateRetirement(allocation) : null, decision: record.decision, current, state };
    if (committed.allocationPhase === 'retired') assertRetirementCurrent(committed, committed.retirement!);
    return committed;
  } finally { releaseDurableOwnerLock(lock); }
}

export function inspectCommittedReleaseWrite(input: CommittedReleaseWriteInput, dependencies: Pick<ReleaseMetadataDependencies, 'state' | 'resolveProfile'> = {}): CommittedReleaseWriteBinding {
  return inspectCommittedReleaseState(input, dependencies).binding;
}

function assertRetirementCurrent(state: ReturnType<typeof inspectCommittedReleaseState>, retirement: ReleaseRetirement): void {
  if (retirement.current_pr_identity.head_oid !== state.current.head || retirement.current_pr_identity.base_oid !== state.decision.live_target_sha ||
    retirement.current_pr_identity.head_ref !== state.current.branch.replace(/^refs\/heads\//, '')) throw new Error('release_commit_lineage_invalid');
}
function assertRetirementProof(state: ReturnType<typeof inspectCommittedReleaseState>, receiptRunId: string, currentPrIdentity: CurrentPrIdentity): void {
  if (state.allocationPhase !== 'retired') return;
  const retirement = state.retirement!;
  if (retirement.receipt_run_id !== receiptRunId || JSON.stringify(retirement.current_pr_identity) !== JSON.stringify(currentPrIdentity)) throw new Error('release_retirement_invalid');
}

export async function inspectReleaseSelfClaimReplay(input: CommittedReleaseWriteInput & { bump?: Bump; assertVersion?: string; currentVersion?: string }, dependencies: Pick<ReleaseMetadataDependencies, 'state' | 'resolveProfile' | 'observeQueue' | 'inspectShipReceipt'> = {}) {
  let firstState: ReturnType<typeof inspectCommittedReleaseState>;
  try { firstState = inspectCommittedReleaseState(input, dependencies); }
  catch (error) {
    if (error instanceof Error && ['release_commit_state_invalid', 'release_write_result_missing'].includes(error.message)) throw new Error('release_lineage_required');
    throw error;
  }
  const { binding, decision, current, state } = firstState;
  if (input.bump !== undefined && input.bump !== firstState.allocationBump) throw new Error('release_lineage_required');
  if (input.assertVersion !== undefined && input.assertVersion !== binding.version) throw new Error('release_version_assertion_mismatch');
  if (input.currentVersion !== undefined && input.currentVersion !== binding.version) throw new Error('release_current_version_mismatch');
  const observeQueue = dependencies.observeQueue ?? ((await (async () => {
    const gh = await trustedGithubTool(); const remote = canonicalGithubRemote(current.root);
    return (value: ReleaseMetadataDecision, branch: string) => fetchTrustedGithubClaimed(gh, value.target_ref!.replace(/^origin\//, ''), value.version_source!, value.live_target_sha, current.head, branch.replace(/^refs\/heads\//, ''), remote);
  })()));
  const firstQueue = observeQueue(decision, current.branch);
  const exact = firstQueue.exactSelfClaim;
  if (!exact || firstQueue.unresolvedSelfClaim || !firstQueue.currentPrIdentity || JSON.stringify(exact.identity) !== JSON.stringify(firstQueue.currentPrIdentity) ||
    exact.repository_node_id !== exact.identity.head_repository_node_id || exact.version !== binding.version || exact.identity.base_oid !== decision.live_target_sha ||
    exact.identity.head_oid !== current.head || exact.identity.head_ref !== current.branch.replace(/^refs\/heads\//, '')) throw new Error('release_lineage_required');
  const inspectReceipt = dependencies.inspectShipReceipt;
  if (!inspectReceipt) throw new Error('ship_handoff_missing_or_stale');
  const receipt = inspectReceipt({ cwd: current.root, pr: exact.identity.number, assertTargetRef: decision.target_ref!, expectedBase: exact.identity.base_oid,
    remotePrHead: exact.identity.head_oid, stateRootId: state.stateRootId, repositoryNodeId: exact.repository_node_id,
    headRepositoryNodeId: exact.identity.head_repository_node_id, headRefName: exact.identity.head_ref, stateHome: state.root });
  if (!receipt.current) throw new Error(receipt.blocker);
  if (receipt.state_root_id !== state.stateRootId || receipt.pr !== exact.identity.number || receipt.base_ref !== decision.target_ref ||
    receipt.base_sha !== exact.identity.base_oid || receipt.remote_pr_head_sha !== exact.identity.head_oid || receipt.remote_pr_head_tree !== binding.after_wtree ||
    receipt.provider_identity.repository_node_id !== exact.repository_node_id || receipt.provider_identity.head_repository_node_id !== exact.identity.head_repository_node_id ||
    receipt.provider_identity.head_ref_name !== exact.identity.head_ref || !receipt.release_decision.applicable || receipt.release_decision.mode !== decision.release_mode ||
    receipt.release_decision.version !== binding.version || receipt.release_decision.title_policy !== decision.title_policy || JSON.stringify(receipt.release_write) !== JSON.stringify(binding)) {
    throw new Error('ship_handoff_missing_or_stale');
  }
  assertRetirementProof(firstState, receipt.receipt_run_id, exact.identity);
  const secondState = inspectCommittedReleaseState(input, dependencies);
  if (JSON.stringify(secondState.binding) !== JSON.stringify(binding) || secondState.allocationQueue !== firstState.allocationQueue ||
    JSON.stringify(secondState.current) !== JSON.stringify(current) || JSON.stringify(secondState.decision) !== JSON.stringify(decision)) throw new Error('release_lineage_required');
  assertRetirementProof(secondState, receipt.receipt_run_id, exact.identity);
  const secondQueue = observeQueue(decision, current.branch);
  if (firstQueue.snapshot !== secondQueue.snapshot || JSON.stringify(firstQueue.exactSelfClaim) !== JSON.stringify(secondQueue.exactSelfClaim) ||
    firstQueue.unresolvedSelfClaim !== secondQueue.unresolvedSelfClaim) throw new Error('release_queue_drift');
  const finalState = inspectCommittedReleaseState(input, dependencies);
  if (JSON.stringify(finalState.binding) !== JSON.stringify(binding) || finalState.allocationQueue !== firstState.allocationQueue ||
    JSON.stringify(finalState.current) !== JSON.stringify(current) || JSON.stringify(finalState.decision) !== JSON.stringify(decision)) throw new Error('release_lineage_required');
  assertRetirementProof(finalState, receipt.receipt_run_id, exact.identity);
  const queueMatches = exact.snapshot === firstState.allocationQueue;
  return {
    applicable: true, release_mode: decision.release_mode, title_policy: decision.title_policy, version: binding.version,
    reason: queueMatches ? 'already_bumped' : 'queue_drift', allocation_id: binding.allocation_id,
    release_write_record_id: binding.release_write_record_id, receipt_run_id: receipt.receipt_run_id,
    trusted_base_sha: decision.trusted_base_sha, trusted_base_version: decision.trusted_version, current_subject_version: binding.version,
    current_pr_identity: structuredClone(exact.identity), self_claim_excluded: queueMatches, queue_matches: queueMatches,
    profile_hash: decision.profile_hash, policy_source: decision.source, bootstrap_descriptor: decision.bootstrap_descriptor ?? null,
    warnings: (decision.legacy_skipped_lockfiles ?? []).map(link => `${link.path} is a symlink; not synced.`),
    version_source: structuredClone(decision.version_source), planned_targets: structuredClone(binding.planned_targets),
    changelog_projection: structuredClone(binding.changelog_projection), phase: finalState.allocationPhase,
    before_wtree: binding.before_wtree, after_wtree: binding.after_wtree,
    product_manifest_hash_before_release: binding.product_manifest_hash_before_release, release_projection_hash: binding.release_projection_hash,
    changelog_proposal_sha256: binding.changelog_proposal_sha256, changelog_insertion_sha256: binding.changelog_insertion_sha256,
    mutated_projections: structuredClone(binding.mutated_projections),
  };
}

function retiredResult(state: ReturnType<typeof inspectCommittedReleaseState>, retirement: ReleaseRetirement) {
  return {
    applicable: true, release_mode: state.decision.release_mode, title_policy: state.decision.title_policy,
    version: state.binding.version, reason: 'retired' as const, phase: 'retired' as const,
    allocation_id: state.binding.allocation_id, release_write_record_id: state.binding.release_write_record_id,
    receipt_run_id: retirement.receipt_run_id, retirement_id: retirement.retirement_id,
    current_pr_identity: structuredClone(retirement.current_pr_identity), self_claim_excluded: true,
    reservation_retained: true as const, trusted_base_sha: state.decision.trusted_base_sha,
    trusted_base_version: state.decision.trusted_version, profile_hash: state.decision.profile_hash,
  };
}

function releaseLandingProof(stateRootId: string, repositoryKey: string, binding: CommittedReleaseWriteBinding, retirement: ReleaseRetirement): RetiredReleaseLandingProof {
  const core = {
    state_root_id: stateRootId, repository_key: repositoryKey, allocation_id: binding.allocation_id,
    release_write_record_id: binding.release_write_record_id, release_write_result_hash: binding.release_write_result_hash,
    retirement_id: retirement.retirement_id, receipt_run_id: retirement.receipt_run_id,
    current_pr_identity: structuredClone(retirement.current_pr_identity), release_write: structuredClone(binding), reservation_retained: true as const,
  };
  const bindingSha256 = digest(JSON.stringify(core));
  return { schema: 'ecpe.retired-release-landing-proof.v1', proof_id: `release-land-proof-${bindingSha256.slice(0, 32)}`, ...core, binding_sha256: bindingSha256 };
}

export function inspectRetiredReleaseLandingProof(input: CommittedReleaseWriteInput, dependencies: Pick<ReleaseMetadataDependencies, 'state' | 'resolveProfile' | 'inspectShipReceipt'> = {}): RetiredReleaseLandingProof {
  const state = inspectCommittedReleaseState(input, dependencies);
  if (state.allocationPhase !== 'retired' || !state.retirement) throw new Error('release_retirement_required');
  const retirement = state.retirement; assertRetirementCurrent(state, retirement);
  const inspectReceipt = dependencies.inspectShipReceipt;
  if (!inspectReceipt) throw new Error('ship_handoff_missing_or_stale');
  const identity = retirement.current_pr_identity;
  const receipt = inspectReceipt({ cwd: state.current.root, pr: identity.number, assertTargetRef: state.decision.target_ref!, expectedBase: identity.base_oid,
    remotePrHead: identity.head_oid, stateRootId: state.state.stateRootId, repositoryNodeId: identity.head_repository_node_id,
    headRepositoryNodeId: identity.head_repository_node_id, headRefName: identity.head_ref, stateHome: state.state.root });
  if (!receipt.current || receipt.receipt_run_id !== retirement.receipt_run_id || receipt.state_root_id !== state.state.stateRootId ||
    receipt.pr !== identity.number || receipt.base_ref !== state.decision.target_ref || receipt.base_sha !== identity.base_oid ||
    receipt.remote_pr_head_sha !== identity.head_oid || receipt.remote_pr_head_tree !== state.binding.after_wtree ||
    receipt.provider_identity.repository_node_id !== identity.head_repository_node_id ||
    receipt.provider_identity.head_repository_node_id !== identity.head_repository_node_id || receipt.provider_identity.head_ref_name !== identity.head_ref ||
    !receipt.release_decision.applicable || receipt.release_decision.mode !== state.decision.release_mode ||
    receipt.release_decision.version !== state.binding.version || receipt.release_decision.title_policy !== state.decision.title_policy ||
    JSON.stringify(receipt.release_write) !== JSON.stringify(state.binding)) throw new Error('ship_handoff_missing_or_stale');
  const final = inspectCommittedReleaseState(input, dependencies);
  if (final.allocationPhase !== 'retired' || !final.retirement || JSON.stringify(final.binding) !== JSON.stringify(state.binding) ||
    JSON.stringify(final.current) !== JSON.stringify(state.current) || JSON.stringify(final.decision) !== JSON.stringify(state.decision) ||
    JSON.stringify(final.retirement) !== JSON.stringify(retirement)) throw new Error('release_retirement_predecessor_invalid');
  return releaseLandingProof(state.state.stateRootId, digest(`${state.current.remote}\0${state.current.common}`), state.binding, retirement);
}

export async function inspectRetiredReleaseLandReadinessProof(input: CommittedReleaseWriteInput, dependencies: Pick<ReleaseMetadataDependencies, 'state' | 'resolveProfile' | 'observeQueue' | 'inspectShipReceipt'> = {}): Promise<RetiredReleaseLandingProof> {
  const proof = inspectRetiredReleaseLandingProof(input, dependencies);
  const replay = await inspectReleaseSelfClaimReplay(input, dependencies);
  if (replay.reason !== 'already_bumped' || replay.phase !== 'retired' || replay.queue_matches !== true || replay.self_claim_excluded !== true ||
    replay.allocation_id !== proof.allocation_id || replay.release_write_record_id !== proof.release_write_record_id ||
    replay.receipt_run_id !== proof.receipt_run_id || JSON.stringify(replay.current_pr_identity) !== JSON.stringify(proof.current_pr_identity)) {
    throw new Error('release_queue_drift');
  }
  const final = inspectRetiredReleaseLandingProof(input, dependencies);
  if (JSON.stringify(final) !== JSON.stringify(proof)) throw new Error('release_land_projection_drift');
  return proof;
}

export function inspectHistoricalRetiredReleaseLandingProof(input: ReleaseSelfClaimReceiptInput, dependencies: Pick<ReleaseMetadataDependencies, 'state' | 'inspectShipReceipt'> = {}): RetiredReleaseLandingProof {
  const root = fs.realpathSync(path.resolve(input.cwd));
  if (git(root, ['rev-parse', '--show-toplevel']) !== root) throw new Error('release_repo_root_required');
  const state = dependencies.state ?? resolveCanonicalStateRoot(); directory(state.root);
  if (fs.realpathSync(path.resolve(input.stateHome)) !== fs.realpathSync(state.root) || input.stateRootId !== undefined && input.stateRootId !== state.stateRootId ||
    state.root === root || state.root.startsWith(`${root}${path.sep}`) || state.effectiveUid !== process.geteuid?.()) throw new Error('release_owner_root_invalid');
  const current = identity(root, state); const repository = digest(`${current.remote}\0${current.common}`);
  const owner = path.join(state.root, 'release-metadata', repository); directory(owner);
  const lock = acquireDurableOwnerLock(path.join(owner, 'owner'), 'release_owner_busy', 20_000);
  try {
    const ledger = validateLedger(readEnvelope<Ledger>(path.join(owner, 'ledger.json')), repository, { remote: current.remote, common: current.common, stateRootId: state.stateRootId });
    const candidates = ledger.allocations.filter(row => row.phase === 'retired' && row.identity.root === current.root && row.identity.remote === current.remote &&
      row.identity.common === current.common && row.identity.uid === current.uid && row.identity.state_root_id === current.state_root_id &&
      row.identity.branch === `refs/heads/${input.headRefName}` && row.decision.target_ref === input.assertTargetRef && row.retirement?.current_pr_identity.number === input.pr &&
      row.retirement.current_pr_identity.base_oid === input.expectedBase && row.retirement.current_pr_identity.head_oid === input.remotePrHead &&
      row.retirement.current_pr_identity.head_repository_node_id === input.headRepositoryNodeId && row.retirement.current_pr_identity.head_ref === input.headRefName);
    if (candidates.length !== 1) throw new Error(candidates.length ? 'release_owner_ambiguous' : 'release_retirement_required');
    const allocation = candidates[0]; const retirement = validateRetirement(allocation);
    if (input.repositoryNodeId !== input.headRepositoryNodeId || retirement.receipt_run_id.length === 0) throw new Error('release_retirement_invalid');
    const record = validateWriteRecord(readEnvelope<ReleaseWriteRecord>(resultPath(owner, allocation)), allocation, null);
    const binding = committedBinding(allocation, record); const inspectReceipt = dependencies.inspectShipReceipt;
    if (!inspectReceipt) throw new Error('ship_handoff_missing_or_stale');
    const receipt = inspectReceipt(input);
    if (!receipt.current || receipt.receipt_run_id !== retirement.receipt_run_id || receipt.state_root_id !== state.stateRootId || receipt.pr !== input.pr ||
      receipt.base_ref !== input.assertTargetRef || receipt.base_sha !== input.expectedBase || receipt.remote_pr_head_sha !== input.remotePrHead ||
      receipt.remote_pr_head_tree !== binding.after_wtree || receipt.provider_identity.repository_node_id !== input.repositoryNodeId ||
      receipt.provider_identity.head_repository_node_id !== input.headRepositoryNodeId || receipt.provider_identity.head_ref_name !== input.headRefName ||
      !receipt.release_decision.applicable || receipt.release_decision.mode !== allocation.decision.release_mode ||
      receipt.release_decision.version !== binding.version || receipt.release_decision.title_policy !== allocation.decision.title_policy ||
      JSON.stringify(receipt.release_write) !== JSON.stringify(binding)) {
      throw new Error('ship_handoff_missing_or_stale');
    }
    return releaseLandingProof(state.stateRootId, repository, binding, retirement);
  } finally { releaseDurableOwnerLock(lock); }
}

/**
 * Terminalize active local ownership after the exact current PR + protected
 * ShipReceipt have taken over. The version remains a permanent collision
 * reservation; this operation never deletes the compact write result.
 */
export async function retireReleaseAllocation(input: CommittedReleaseWriteInput & { bump?: Bump; assertVersion?: string; currentVersion?: string }, dependencies: ReleaseMetadataDependencies = {}) {
  const initial = inspectCommittedReleaseState(input, dependencies);
  if (input.bump !== undefined && input.bump !== initial.allocationBump) throw new Error('release_lineage_required');
  if (input.assertVersion !== undefined && input.assertVersion !== initial.binding.version) throw new Error('release_version_assertion_mismatch');
  if (input.currentVersion !== undefined && input.currentVersion !== initial.binding.version) throw new Error('release_current_version_mismatch');
  if (initial.allocationPhase === 'retired') {
    const retirement = initial.retirement!;
    assertRetirementCurrent(initial, retirement);
    return retiredResult(initial, retirement);
  }

  const replay = await inspectReleaseSelfClaimReplay(input, dependencies);
  if (replay.reason !== 'already_bumped' || !replay.queue_matches || !replay.self_claim_excluded) throw new Error('release_queue_drift');
  if (replay.allocation_id !== initial.binding.allocation_id || replay.release_write_record_id !== initial.binding.release_write_record_id ||
    replay.version !== initial.binding.version || replay.current_pr_identity.head_oid !== initial.current.head ||
    replay.current_pr_identity.base_oid !== initial.decision.live_target_sha || replay.current_pr_identity.head_ref !== initial.current.branch.replace(/^refs\/heads\//, '')) throw new Error('release_retirement_predecessor_invalid');
  const inspectReceipt = dependencies.inspectShipReceipt;
  if (!inspectReceipt) throw new Error('ship_handoff_missing_or_stale');
  const verifyReceipt = () => {
    const identity = replay.current_pr_identity;
    const receipt = inspectReceipt({ cwd: initial.current.root, pr: identity.number, assertTargetRef: initial.decision.target_ref!, expectedBase: identity.base_oid,
      remotePrHead: identity.head_oid, stateRootId: initial.state.stateRootId, repositoryNodeId: identity.head_repository_node_id,
      headRepositoryNodeId: identity.head_repository_node_id, headRefName: identity.head_ref, stateHome: initial.state.root });
    if (!receipt.current) throw new Error(receipt.blocker);
    if (receipt.receipt_run_id !== replay.receipt_run_id || receipt.state_root_id !== initial.state.stateRootId || receipt.pr !== identity.number || receipt.base_ref !== initial.decision.target_ref ||
      receipt.base_sha !== identity.base_oid || receipt.remote_pr_head_sha !== identity.head_oid || receipt.remote_pr_head_tree !== initial.binding.after_wtree ||
      receipt.provider_identity.repository_node_id !== identity.head_repository_node_id || receipt.provider_identity.head_repository_node_id !== identity.head_repository_node_id ||
      receipt.provider_identity.head_ref_name !== identity.head_ref || !receipt.release_decision.applicable || receipt.release_decision.mode !== initial.decision.release_mode ||
      receipt.release_decision.version !== initial.binding.version || receipt.release_decision.title_policy !== initial.decision.title_policy ||
      JSON.stringify(receipt.release_write) !== JSON.stringify(initial.binding)) throw new Error('ship_handoff_missing_or_stale');
    return receipt;
  };
  const root = initial.current.root; const state = initial.state; const repository = digest(`${initial.current.remote}\0${initial.current.common}`);
  const owner = path.join(state.root, 'release-metadata', repository); directory(owner);
  const lock = acquireDurableOwnerLock(path.join(owner, 'owner'), 'release_owner_busy', 20_000);
  const observe = dependencies.observe ?? (() => {});
  try {
    const ledgerPath = path.join(owner, 'ledger.json');
    const ledger = validateLedger(readEnvelope<Ledger>(ledgerPath), repository, { remote: initial.current.remote, common: initial.current.common, stateRootId: state.stateRootId });
    const matches = ledger.allocations.filter(row => row.allocation_id === initial.binding.allocation_id && row.record_id === initial.binding.release_write_record_id);
    if (matches.length !== 1) throw new Error(matches.length ? 'release_owner_ambiguous' : 'release_write_result_missing');
    const allocation = matches[0];
    if (!['written', 'retired'].includes(allocation.phase) || allocation.result_hash !== initial.binding.release_write_result_hash || allocation.version !== initial.binding.version) throw new Error('release_retirement_predecessor_invalid');
    const record = validateWriteRecord(readEnvelope<ReleaseWriteRecord>(resultPath(owner, allocation)), allocation, null);
    const current = identity(root, state); const parents = git(root, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ');
    if (JSON.stringify(current) !== JSON.stringify(initial.current) || parents.length !== 2 || parents[1] !== record.identity.head ||
      git(root, ['rev-parse', '--verify', 'HEAD^{tree}']) !== record.after_wtree) throw new Error('release_commit_lineage_invalid');
    const resolveProfile = dependencies.resolveProfile ?? (() => resolveTrustedWorkProfile({ cwd: root, lane: input.lane ?? 'single_repo_code', assertTargetRef: input.assertTargetRef, assertTargetSha: input.assertTargetSha }));
    const profile = resolveProfile(); verifyWriteRecordState(root, profile, record, true);
    const decision = resolveReleasePolicy({ resolvedProfile: profile, cwd: root, releaseRequested: input.releaseRequested, assertReleaseMode: input.assertReleaseMode });
    if (!committedDecisionMatches(decision, record.decision, record.version) || JSON.stringify(record.decision) !== JSON.stringify(initial.decision) || JSON.stringify(initial.binding) !== JSON.stringify(committedBinding(allocation, record)) ||
      JSON.stringify(identity(root, state)) !== JSON.stringify(current) || JSON.stringify(resolveProfile()) !== JSON.stringify(profile)) throw new Error('release_retirement_predecessor_invalid');
    if (allocation.phase === 'retired') {
      const retirement = validateRetirement(allocation); const terminal = { ...initial, current, allocationPhase: 'retired' as const, retirement };
      assertRetirementProof(terminal, replay.receipt_run_id, replay.current_pr_identity); assertRetirementCurrent(terminal, retirement);
      return retiredResult(terminal, retirement);
    }
    const retirement = makeRetirement(allocation, replay.receipt_run_id, replay.current_pr_identity);
    observe('before_retirement_publication');
    verifyReceipt();
    verifyWriteRecordState(root, profile, record, true);
    const finalRecord = validateWriteRecord(readEnvelope<ReleaseWriteRecord>(resultPath(owner, allocation)), allocation, null);
    if (JSON.stringify(finalRecord) !== JSON.stringify(record) || JSON.stringify(identity(root, state)) !== JSON.stringify(current) ||
      JSON.stringify(resolveProfile()) !== JSON.stringify(profile)) throw new Error('release_retirement_predecessor_invalid');
    allocation.phase = 'retired'; allocation.retirement = retirement;
    save(ledgerPath, ledger); observe('retirement_durable');
    return retiredResult({ ...initial, allocationPhase: 'retired', retirement }, retirement);
  } finally { releaseDurableOwnerLock(lock); }
}

export async function releaseMetadata(input: ReleaseMetadataInput, dependencies: ReleaseMetadataDependencies = {}) {
  if (input.operation === 'retire') return retireReleaseAllocation(input, dependencies);
  if (!['allocate', 'write', 'inspect', 'recover'].includes(input.operation) || (input.bump !== undefined && !['major', 'minor', 'patch', 'micro'].includes(input.bump)) || (['allocate', 'write'].includes(input.operation) && !input.bump)) throw new Error('release_operation_invalid');
  const root = fs.realpathSync(path.resolve(input.cwd ?? process.cwd()));
  if (git(root, ['rev-parse', '--show-toplevel']) !== root) throw new Error('release_repo_root_required');
  const resolveProfile = dependencies.resolveProfile ?? (() => resolveTrustedWorkProfile({ cwd: root, lane: input.lane ?? 'single_repo_code', assertTargetRef: input.assertTargetRef, assertTargetSha: input.assertTargetSha }));
  const profile = resolveProfile();
  const config = profile.mode === 'legacy' ? { mode: 'per_pr' as const } : profile.trusted_release ?? profile.effective?.release;
  if (!config) throw new Error('trusted_release_policy_missing');
  if (input.assertReleaseMode && input.assertReleaseMode !== config.mode) throw new Error('release_mode_assertion_mismatch');
  if (config.mode === 'none' || (config.mode === 'required_on_release' && !input.releaseRequested)) {
    const inactive = resolveReleasePolicy({ resolvedProfile: profile, cwd: root, releaseRequested: input.releaseRequested, assertReleaseMode: input.assertReleaseMode });
    if (inactive.source !== 'trusted_profile' || inactive.applicable) throw new Error('release_policy_moved');
    if (input.operation === 'write' || input.operation === 'recover') throw new Error('release_not_applicable');
    return { applicable: false, state: 'NOT_APPLICABLE', reason: inactive.reason, release_mode: inactive.release_mode, title_policy: inactive.title_policy, version: null };
  }
  const state = dependencies.state ?? resolveCanonicalStateRoot(); directory(state.root);
  if (state.root === root || state.root.startsWith(`${root}${path.sep}`) || state.effectiveUid !== process.geteuid?.()) throw new Error('release_owner_root_invalid');
  const subject = identity(root, state);
  if (profile.mode === 'profile' && git(root, ['status', '--porcelain=v1', '--untracked-files=all']) === '') {
    const currentDecision = resolveReleasePolicy({ resolvedProfile: profile, cwd: root, releaseRequested: input.releaseRequested, assertReleaseMode: input.assertReleaseMode });
    if (currentDecision.source === 'trusted_profile' && currentDecision.applicable && currentDecision.current_version !== currentDecision.target_version) {
      return inspectReleaseSelfClaimReplay(input, dependencies);
    }
  }
  const repository = digest(`${subject.remote}\0${subject.common}`);
  const owner = childDirectory(childDirectory(state.root, 'release-metadata'), repository);
  if (fs.statSync(owner).dev !== fs.statSync(root).dev) throw new Error('release_cross_device_unsupported');
  // Release publication performs several fsyncs and invariant checks. A
  // concurrent caller must serialize behind that bounded transaction instead
  // of spuriously failing when the default short lock window is exceeded.
  const lock = acquireDurableOwnerLock(path.join(owner, 'owner'), 'release_owner_busy', 20_000);
  const observe = dependencies.observe ?? (() => {});
  let bootstrapBefore = new Map<string, Buffer>();
  let bootstrapAfter = new Map<string, Buffer>();
  let boundSkippedLockfiles: LegacySkippedLockfile[] = [];
  let durableWriteCompleted = false;
  const assertSubject = () => {
    if (JSON.stringify(identity(root, state)) !== JSON.stringify(subject)) throw new Error('release_subject_moved');
    if (JSON.stringify(resolveProfile()) !== JSON.stringify(profile)) throw new Error('release_policy_moved');
    // A compact write result deliberately does not retain pre-release bytes.
    // Once that result is authoritative, exact post-state verification below
    // replaces the bootstrap overlay check while identity/profile remain pinned.
    if (profile.mode === 'legacy' && !durableWriteCompleted) portfolioOpsBootstrap(root, profile, bootstrapBefore, bootstrapAfter);
    for (const link of boundSkippedLockfiles) {
      if (JSON.stringify(inspectSkippedLegacyLockfile(root, link.path)) !== JSON.stringify(link)) throw new Error('release_skipped_lockfile_moved');
    }
  };
  try {
    const ledgerPath = path.join(owner, 'ledger.json');
    const ledger = validateLedger(readEnvelope<Ledger>(ledgerPath) ?? { schema: 'ecpe.release-owner.v1', repository, allocations: [] }, repository, { remote: subject.remote, common: subject.common, stateRootId: state.stateRootId });
    const matches = ledger.allocations.filter(item => item.identity.branch === subject.branch && item.phase !== 'retired');
    if (matches.length > 1) throw new Error('release_owner_ambiguous');
    let allocation = matches[0];
    if (allocation && JSON.stringify(allocation.identity) !== JSON.stringify(subject)) throw new Error('release_lineage_required');
    const storedBundle = allocation ? readEnvelope<Bundle>(bundlePath(owner, allocation)) : null;
    let bundle = allocation?.bundle_hash && storedBundle ? validateBundle(storedBundle, allocation) : null;
    if (allocation && !bundle && !allocation.bundle_hash && allocation.phase === 'allocated') {
      // Bundle publication can win the crash race with write-intent publication.
      // Its owner-derived name and exact allocation binding permit check-first
      // adoption, without consulting replacement stdin or caller paths.
      const orphan = readEnvelope<Bundle>(bundlePath(owner, allocation));
      if (orphan) bundle = validateBundle(orphan, { ...allocation, bundle_hash: digest(JSON.stringify(orphan)) });
    }
    let writeRecord = allocation?.result_hash ? validateWriteRecord(readEnvelope<ReleaseWriteRecord>(resultPath(owner, allocation)), allocation, bundle) : null;
    if (allocation && ['applying', 'restoring', 'rolled_back'].includes(allocation.phase) && !bundle) throw new Error('release_bundle_invalid');
    if (allocation?.phase === 'written_pending_cleanup' && !writeRecord) throw new Error('release_write_result_invalid');
    if (allocation?.phase === 'written' && !writeRecord && !bundle) throw new Error('release_write_result_invalid');
    if (bundle) {
      const current = states(root, bundle);
      if (allocation && ['written_pending_cleanup', 'written'].includes(allocation.phase) && current.some(value => value !== 'after')) throw new Error('release_projection_drift');
    }
    if (writeRecord) {
      durableWriteCompleted = true;
      verifyWriteRecordState(root, profile, writeRecord);
    }
    bootstrapBefore = new Map(bundle?.files.map(file => [file.path, Buffer.from(file.before, 'base64')]) ?? []);
    bootstrapAfter = new Map(bundle?.files.map(file => [file.path, Buffer.from(file.after, 'base64')]) ?? []);
    const resolvedDecision = writeRecord && profile.mode === 'legacy' ? (() => {
      const recorded = allocation!.decision;
      if (recorded.source !== 'legacy_metadata' || profile.trusted_merge_base_sha !== recorded.trusted_base_sha ||
        profile.trusted_base.target_sha !== recorded.live_target_sha || profile.trusted_base.candidate_sha !== recorded.subject_sha ||
        profile.trusted_base.target_ref !== recorded.target_ref) throw new Error('release_policy_moved');
      return recorded;
    })() : writeRecord ? resolveReleasePolicy({ resolvedProfile: profile, cwd: root, releaseRequested: input.releaseRequested, assertReleaseMode: input.assertReleaseMode,
      readCurrentVersion: projection => projection.value_encoding === 'npm_semver' ? npmVersion(allocation!.decision.current_version!) : allocation!.decision.current_version!,
    }) : profile.mode === 'legacy' ? resolveLegacyReleaseDecision(root, profile, bootstrapBefore, bootstrapAfter) : resolveReleasePolicy({ resolvedProfile: profile, cwd: root, releaseRequested: input.releaseRequested, assertReleaseMode: input.assertReleaseMode,
      ...(bundle ? { readCurrentVersion: projection => {
        const file = bundle!.files.find(file => file.path === projection.path);
        if (!file) throw new Error('release_bundle_invalid');
        return extractReleaseProjection(Buffer.from(file.before, 'base64').toString('utf8'), projection);
      } } : {}),
    });
    if (resolvedDecision.source === 'legacy_seam' || !resolvedDecision.applicable) throw new Error('release_not_applicable');
    const decision: ReleaseMetadataDecision = resolvedDecision;
    boundSkippedLockfiles = decision.legacy_skipped_lockfiles ?? [];
    if (input.currentVersion !== undefined && extractReleaseProjection(safeFile(root, decision.version_source!.path).bytes.toString('utf8'), decision.version_source!) !== input.currentVersion) throw new Error('release_current_version_mismatch');
    if (allocation && (JSON.stringify(allocation.decision) !== JSON.stringify(decision) || (input.bump !== undefined && input.bump !== allocation.bump))) throw new Error('release_lineage_required');
    if (!allocation && decision.current_version !== decision.target_version) throw new Error('release_lineage_required');
    validateReleaseTargets(decision);
    if (input.operation === 'inspect' && !allocation) return { applicable: true, phase: 'absent', version: null };

    const finishBundleCleanup = (target: Allocation, record: ReleaseWriteRecord): void => {
      assertSubject();
      verifyWriteRecordState(root, profile, record);
      const targetPath = bundlePath(owner, target);
      const retained = readEnvelope<Bundle>(targetPath);
      if (retained) {
        validateBundle(retained, target);
        const info = fs.lstatSync(targetPath);
        if (!info.isFile() || info.isSymbolicLink() || info.uid !== target.identity.uid || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) throw new Error('release_bundle_invalid');
        fs.unlinkSync(targetPath);
        syncDirectory(owner);
        observe('bundle_unlinked');
        assertSubject();
      } else {
        // A prior process may have died after the unlink+directory fsync but
        // before publishing the final ledger phase.
        syncDirectory(owner);
      }
      bundle = null;
      assertSubject();
      target.phase = 'written';
      save(ledgerPath, ledger);
      observe('bundle_cleanup_durable');
      assertSubject();
    };

    const publishWriteResult = (target: Allocation, source: Bundle): ReleaseWriteRecord => {
      if (states(root, source).some(value => value !== 'after')) throw new Error('release_projection_verification_failed');
      const afterFingerprint = inventory(root, new Map(), target.decision.legacy_skipped_lockfiles);
      const afterProjectionFingerprint = productProjectionFingerprint(root, new Map(), target.decision.legacy_skipped_lockfiles);
      const record = makeWriteRecord(target, source, afterFingerprint, afterProjectionFingerprint);
      save(resultPath(owner, target), record);
      observe('write_result_tombstone_durable');
      assertSubject();
      target.result_hash = digest(JSON.stringify(record));
      target.phase = 'written_pending_cleanup';
      save(ledgerPath, ledger);
      writeRecord = validateWriteRecord(record, target, source);
      durableWriteCompleted = true;
      observe('write_result_durable');
      assertSubject();
      finishBundleCleanup(target, writeRecord);
      return writeRecord;
    };

    assertSubject();
    if (allocation && input.assertVersion && input.assertVersion !== allocation.version) throw new Error('release_version_assertion_mismatch');
    if (input.operation === 'recover' && (!allocation || (!bundle && !(['written_pending_cleanup', 'written'].includes(allocation.phase) && writeRecord)))) throw new Error('release_recovery_unprepared');
    const observeQueue = dependencies.observeQueue ?? ((await (async () => {
      const gh = await trustedGithubTool(); const remote = canonicalGithubRemote(root);
      return (value: ReleaseMetadataDecision, branch: string) => fetchTrustedGithubClaimed(gh, value.target_ref!.replace(/^origin\//, ''), value.version_source!, value.live_target_sha, value.subject_sha, branch.replace(/^refs\/heads\//, ''), remote);
    })()));
    const first = observeQueue(decision, subject.branch), second = observeQueue(decision, subject.branch);
    if (first.snapshot !== second.snapshot) throw new Error('release_queue_drift');
    if (second.possibleSelfClaim) throw new Error('release_lineage_required');
    assertSubject();
    if (allocation && second.snapshot !== allocation.queue) return result(allocation, bundle, 'queue_drift', writeRecord);
    if (allocation?.phase === 'written_pending_cleanup') {
      if (!writeRecord) throw new Error('release_write_result_invalid');
      if (input.operation === 'write' || input.operation === 'recover') finishBundleCleanup(allocation, writeRecord);
      return result(allocation, bundle, input.operation === 'write' || input.operation === 'recover' ? 'already_bumped' : allocation.phase, writeRecord);
    }
    if (!allocation) {
      if (ledger.allocations.filter(row => row.phase !== 'retired').length >= 256) throw new Error('release_owner_capacity');
      if (ledger.allocations.length >= 4096) throw new Error('release_retirement_capacity');
      const base = parseVersion(decision.target_version!)!;
      const claims = [...second.claimed.map(item => item.version), ...ledger.allocations.map(item => item.version)].map(value => parseVersion(value)!);
      if (claims.some(value => !value)) throw new Error('release_queue_unknown');
      const highest = [base, ...claims].sort(cmpVersion).at(-1)!;
      const version = fmtVersion(bumpVersion(highest, input.bump!, versionWidth(decision.target_version!)), versionWidth(decision.target_version!));
      if (input.assertVersion && input.assertVersion !== version) throw new Error('release_version_assertion_mismatch');
      allocation = { allocation_id: `release-${randomUUID()}`, record_id: `release-write-${randomUUID()}`, phase: 'allocated', identity: subject,
        decision, bump: input.bump!, version, queue: second.snapshot, product_fingerprint: inventory(root, new Map(), decision.legacy_skipped_lockfiles), bundle_hash: null, result_hash: null, after_wtree: null };
      ledger.allocations.push(allocation); save(ledgerPath, ledger); observe('allocation_durable');
    }
    if (input.assertVersion && input.assertVersion !== allocation.version) throw new Error('release_version_assertion_mismatch');
    if (!bundle && !writeRecord && inventory(root, new Map(), decision.legacy_skipped_lockfiles) !== allocation.product_fingerprint) throw new Error('release_product_drift');
    if (input.operation !== 'write' && input.operation !== 'recover') return result(allocation, bundle, allocation.phase === 'written' ? 'already_bumped' : allocation.phase, writeRecord);
    if (allocation.phase === 'rolled_back') throw new Error('release_transaction_rolled_back');
    if (allocation.phase === 'written') {
      if (writeRecord) return result(allocation, bundle, 'already_bumped', writeRecord);
      if (!bundle || states(root, bundle).some(value => value !== 'after')) throw new Error('release_projection_drift');
      writeRecord = publishWriteResult(allocation, bundle);
      return result(allocation, bundle, 'already_bumped', writeRecord);
    }
    if (bundle && !allocation.bundle_hash) {
      allocation.bundle_hash = digest(JSON.stringify(bundle)); allocation.phase = 'applying'; save(ledgerPath, ledger); observe('write_intent_durable');
    }
    if (!bundle) {
      const projections = validateReleaseTargets(decision);
      const paths = [...new Set(projections.map(item => item.path))];
      const entry = decision.changelog_path ? input.entryBody?.() : undefined;
      const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const rendered = paths.map(file => {
        const current = safeFile(root, file);
        return renderReleaseFile({ path: file, bytes: current.bytes, mode: current.mode, projections: projections.filter(item => item.path === file), version: allocation.version, current: decision.current_version!, entry, date, legacyMirror: decision.source === 'legacy_metadata' });
      });
      const manifest = buildChangeManifest({ cwd: root, profile: profile.effective ?? { semantic_paths: [] }, mergeBaseSha: decision.trusted_base_sha, targetBaseSha: decision.live_target_sha, targetBaseRef: decision.target_ref! });
      bundle = { schema: 'ecpe.release-bundle.v1', allocation_id: allocation.allocation_id, identity: subject, version: allocation.version, policy_hash: digest(JSON.stringify(decision)),
        files: rendered.map(value => value.file), proposal: rendered.find(value => value.proposal)?.proposal ?? null, insertion_hash: rendered.find(value => value.insertionHash)?.insertionHash ?? null,
        manifest_hash: manifest.manifest_hash, before_wtree: manifest.wtree, product_fingerprint: allocation.product_fingerprint,
        ...(decision.legacy_skipped_lockfiles ? { skipped_lockfiles: decision.legacy_skipped_lockfiles } : {}) };
      states(root, bundle);
      bootstrapBefore = new Map(bundle.files.map(file => [file.path, Buffer.from(file.before, 'base64')]));
      bootstrapAfter = new Map(bundle.files.map(file => [file.path, Buffer.from(file.after, 'base64')]));
      save(bundlePath(owner, allocation), bundle); observe('bundle_durable');
      allocation.bundle_hash = digest(JSON.stringify(bundle)); allocation.phase = 'applying'; save(ledgerPath, ledger); observe('write_intent_durable');
    }
    const restore = () => {
      allocation.phase = 'restoring'; save(ledgerPath, ledger);
      const current = states(root, bundle!);
      for (let index = 0; index < bundle!.files.length; index++) if (current[index] !== 'before') replace(root, owner, allocation, bundle!.files[index], 'before', () => {});
      if (states(root, bundle!).some(value => value !== 'before')) throw new Error('release_restore_failed');
      allocation.phase = 'rolled_back'; save(ledgerPath, ledger);
    };
    if (allocation.phase === 'restoring') { restore(); throw new Error('release_transaction_rolled_back'); }
    try {
      const current = states(root, bundle);
      for (let index = 0; index < bundle.files.length; index++) {
        states(root, bundle);
        if (current[index] !== 'after') replace(root, owner, allocation, bundle.files[index], 'after', observe, assertSubject);
      }
      if (states(root, bundle).some(value => value !== 'after')) throw new Error('release_projection_verification_failed');
      allocation.after_wtree = buildChangeManifest({ cwd: root, profile: profile.effective ?? { semantic_paths: [] }, mergeBaseSha: decision.trusted_base_sha, targetBaseSha: decision.live_target_sha, targetBaseRef: decision.target_ref! }).wtree;
      observe('before_success_publication');
      assertSubject();
    } catch (error) {
      try { restore(); } catch { throw new Error('release_manual_repair_required'); }
      throw error;
    }
    writeRecord = publishWriteResult(allocation, bundle);
    return result(allocation, bundle, 'written', writeRecord);
  } finally { releaseDurableOwnerLock(lock); }
}
