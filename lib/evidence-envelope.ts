import * as path from 'node:path';
import { applyRedactions, scan } from './redact-engine';
import type { SemanticRole } from './work-profile';
import type { ReleaseProjection } from './release-policy';

export const EVIDENCE_SCHEMA_VERSION = 'ecpe.receipt.v2' as const;
export const EVIDENCE_POLICY_VERSION = 'evidence-policy.v2' as const;
export const FRESHNESS_REASON_PRIORITY = [
  'missing', 'malformed', 'failed', 'expired', 'subject_changed', 'remote_head_changed',
  'command_changed', 'validator_changed', 'capability_changed', 'policy_changed',
  'semantic_policy_changed', 'dependency_changed', 'lockfile_changed', 'toolchain_changed',
  'environment_changed', 'build_changed', 'suite_changed', 'evaluator_changed', 'model_changed',
  'semantic_intersection', 'projection_mismatch',
] as const;
export type FreshnessReason = typeof FRESHNESS_REASON_PRIORITY[number];

export interface EvidenceSubject {
  repo_id: string; branch_ref: string; base_sha: string | null; merge_base_sha: string | null;
  local_head_sha: string | null; remote_pr_head_sha: string | null; tree: string | null;
  wtree: string | null; dirty: boolean | null;
}
export interface DependencyFingerprint { repo_id: string; head_sha: string; tree: string; artifact_sha256: string }
export interface EvalBinding { suite_id: string; evaluator_id: string; model_id: string; build_id?: string }
export interface ReleaseDecision { applicable: boolean; mode: 'per_pr' | 'required_on_release' | 'none'; version: string | null; title_policy: 'version_prefix' | 'conventional' | 'free' }
export interface ShipProviderIdentity { repository_node_id: string; repository_name_with_owner: string; head_repository_node_id: string; head_repository_name_with_owner: string; head_ref_name: string }
export interface ShipReleaseWriteBinding {
  allocation_id: string; release_write_record_id: string; release_write_result_hash: string; version: string;
  before_wtree: string; after_wtree: string; product_manifest_hash_before_release: string; release_projection_hash: string;
  changelog_proposal_sha256: string | null; changelog_insertion_sha256: string | null;
  planned_targets: ReleaseProjection[]; changelog_projection: ReleaseProjection | null; mutated_projections: ReleaseProjection[];
  files: Array<{ path: string; mode: number; after_sha256: string; projections: ReleaseProjection[] }>;
}
export interface PromotionHandoffLineage { block_id: string; lane: SemanticLane; proof_id: string; record_id: string; before_profile_hash: string; after_profile_hash: string; before_sha256: string; after_sha256: string; subject_head: string; subject_tree: string }
type SemanticLane = 'docs_ux' | 'single_repo_code' | 'cross_repo_contract';
export interface CanarySubjectHandoffLineage { block_id: string; lane: SemanticLane; focused_run_id: string; profile_hash: string; promotion_proof_id: string; subject_head: string; subject_tree: string; policy_hash: string }
export interface ShipHandoffInspection { current: true; receipt_run_id: string; state_root_id: string; repo_id: string; pr: number; base_ref: string; base_sha: string; remote_pr_head_sha: string; remote_pr_head_tree: string; provider_identity: ShipProviderIdentity; profile_hash: string; manifest_hash: string; review_run_ids: string[]; validation_run_ids: string[]; release_decision: ReleaseDecision; release_write: ShipReleaseWriteBinding | null; candidate_profile: null | { git_blob_oid: string; schema_validation_hash: string }; promotion: PromotionHandoffLineage | null; canary_subject: CanarySubjectHandoffLineage | null }
export type ShipHandoffVerdict = ShipHandoffInspection | { current: false; blocker: 'ship_handoff_missing_or_stale' | 'ship_handoff_ambiguous' };
export interface EvidenceRecordV2 {
  schema_version: typeof EVIDENCE_SCHEMA_VERSION;
  run_id: string;
  subject: EvidenceSubject;
  capability: { id: string; version: string };
  validator: { id: string; version: string };
  policy_version: string;
  profile_hash: string | null;
  semantic_policy_hash: string;
  inputs: {
    command_argv: string[]; cmd_sha256: string; lockfile_hashes: Record<string, string>;
    dependency_fingerprints: Record<string, DependencyFingerprint>; toolchain_fingerprint: Record<string, string>;
    environment_class: string;
  };
  coverage: { semantic_roles: SemanticRole[]; files: string[] };
  eval_binding?: EvalBinding;
  handoff?: Record<string, unknown>;
  result: 'pass' | 'fail' | 'warning' | 'skipped';
  exit: number; artifacts: string[]; side_effects: string[];
  started_at: string; completed_at: string; created_at: string; expires_at: string | null; duration_s: number;
  log_path?: string;
  ts: string; label: string; command: string; commit?: string;
}

export interface EvidenceBuildInput {
  repo_id: string; branch_ref: string; base_sha: string | null; merge_base_sha: string | null;
  local_head_sha: string | null; remote_pr_head_sha: string | null; tree: string | null; wtree: string | null; dirty: boolean | null;
  capability: { id: string; version: string }; validator: { id: string; version: string };
  policy_version?: string; profile_hash: string | null; semantic_policy_hash: string;
  lockfile_hashes: Record<string, string>; dependency_fingerprints: Record<string, DependencyFingerprint>;
  toolchain_fingerprint: Record<string, string>; environment_class: string;
  coverage: { semantic_roles: readonly SemanticRole[]; files: string[] }; eval_binding?: EvalBinding; handoff?: Record<string, unknown>;
  started_at: string; completed_at: string; expires_at: string | null; log_path?: string;
  caller: Record<string, unknown> & { command_argv: string[]; result: EvidenceRecordV2['result']; exit: number; artifacts: string[]; side_effects: string[]; label?: string };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') { const row = value as Record<string, unknown>; return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`; }
  return JSON.stringify(value);
}
export function evidenceSha256(value: unknown): string { return new Bun.CryptoHasher('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'); }

function redactToken(token: string): string {
  const findings = scan(token).findings.filter((finding) => finding.tier === 'HIGH');
  if (!findings.length) return token;
  const redacted = applyRedactions(token, findings.map((finding) => finding.id)).body;
  return scan(redacted).findings.some((finding) => finding.tier === 'HIGH') ? '<redacted: HIGH credential in argv>' : redacted;
}
function artifact(value: string): string {
  if (!value || path.isAbsolute(value) || value.includes('\0')) throw new Error('evidence_artifact_invalid');
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized !== value.replaceAll('\\', '/')) throw new Error('evidence_artifact_invalid');
  return normalized;
}
function validIso(value: string): number { const time = Date.parse(value); if (!Number.isFinite(time)) throw new Error('evidence_timestamp_invalid'); return time; }

export function buildEvidenceRecord(input: EvidenceBuildInput): EvidenceRecordV2 {
  const started = validIso(input.started_at); const completed = validIso(input.completed_at);
  if (completed < started || !Number.isSafeInteger(input.caller.exit)) throw new Error('evidence_result_invalid');
  const originalArgv = [...input.caller.command_argv];
  if (!originalArgv.length || originalArgv.some((token) => typeof token !== 'string' || token.includes('\0'))) throw new Error('evidence_command_invalid');
  const safeArgv = originalArgv.map(redactToken); const created = input.completed_at;
  const subject: EvidenceSubject = { repo_id: input.repo_id, branch_ref: input.branch_ref, base_sha: input.base_sha, merge_base_sha: input.merge_base_sha, local_head_sha: input.local_head_sha, remote_pr_head_sha: input.remote_pr_head_sha, tree: input.tree, wtree: input.wtree, dirty: input.dirty };
  const seed = [subject, input.capability, input.validator, originalArgv, created, crypto.randomUUID()];
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION, run_id: `evidence-${evidenceSha256(seed).slice(0, 32)}`, subject,
    capability: { ...input.capability }, validator: { ...input.validator }, policy_version: input.policy_version ?? EVIDENCE_POLICY_VERSION,
    profile_hash: input.profile_hash, semantic_policy_hash: input.semantic_policy_hash,
    inputs: { command_argv: safeArgv, cmd_sha256: evidenceSha256(originalArgv), lockfile_hashes: { ...input.lockfile_hashes }, dependency_fingerprints: structuredClone(input.dependency_fingerprints), toolchain_fingerprint: { ...input.toolchain_fingerprint }, environment_class: input.environment_class },
    coverage: { semantic_roles: [...new Set(input.coverage.semantic_roles)].sort() as SemanticRole[], files: [...new Set(input.coverage.files.map(artifact))].sort() },
    ...(input.eval_binding ? { eval_binding: { ...input.eval_binding } } : {}), ...(input.handoff ? { handoff: structuredClone(input.handoff) } : {}),
    result: input.caller.result, exit: input.caller.exit, artifacts: [...new Set(input.caller.artifacts.map(artifact))].sort(), side_effects: [...new Set(input.caller.side_effects)].sort(),
    started_at: input.started_at, completed_at: input.completed_at, created_at: created, expires_at: input.expires_at, duration_s: Math.round((completed - started) / 100) / 10,
    ...(input.log_path ? { log_path: input.log_path } : {}), ts: created, label: typeof input.caller.label === 'string' ? input.caller.label : input.capability.id,
    command: safeArgv.join(' '), ...(input.local_head_sha ? { commit: input.local_head_sha } : {}),
  };
}

export interface FreshnessExpectation {
  now: string; subject: EvidenceSubject; command_argv: string[]; capability: EvidenceRecordV2['capability']; validator: EvidenceRecordV2['validator'];
  policy_version: string; semantic_policy_hash: string; lockfile_hashes: Record<string, string>; dependency_fingerprints: Record<string, DependencyFingerprint>;
  toolchain_fingerprint: Record<string, string>; environment_class: string; eval_binding?: EvalBinding; semantic_intersection: boolean; projection_matches: boolean;
}
export interface FreshnessVerdict { current: boolean; reasons: FreshnessReason[]; primary_reason: FreshnessReason | null; receipt_run_id?: string }
function same(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b); }
function malformed(record: EvidenceRecordV2): boolean {
  return !record || record.schema_version !== EVIDENCE_SCHEMA_VERSION || typeof record.run_id !== 'string' || !record.subject || !record.inputs || !Array.isArray(record.inputs.command_argv) || typeof record.inputs.cmd_sha256 !== 'string';
}
export function evaluateFreshness(record: EvidenceRecordV2 | null | undefined, expected: FreshnessExpectation): FreshnessVerdict {
  if (!record) return { current: false, reasons: ['missing'], primary_reason: 'missing' };
  if (malformed(record)) return { current: false, reasons: ['malformed'], primary_reason: 'malformed' };
  const found = new Set<FreshnessReason>();
  if (record.result !== 'pass' || record.exit !== 0) found.add('failed');
  if (record.expires_at && Date.parse(expected.now) > Date.parse(record.expires_at)) found.add('expired');
  const { remote_pr_head_sha: recordRemote, ...recordSubject } = record.subject;
  const { remote_pr_head_sha: expectedRemote, ...expectedSubject } = expected.subject;
  if (!same(recordSubject, expectedSubject)) found.add('subject_changed');
  if (recordRemote !== expectedRemote) found.add('remote_head_changed');
  if (record.inputs.cmd_sha256 !== evidenceSha256(expected.command_argv)) found.add('command_changed');
  if (record.validator.version !== expected.validator.version || record.validator.id !== expected.validator.id) found.add('validator_changed');
  if (!same(record.capability, expected.capability)) found.add('capability_changed');
  if (record.policy_version !== expected.policy_version) found.add('policy_changed');
  if (record.semantic_policy_hash !== expected.semantic_policy_hash) found.add('semantic_policy_changed');
  if (!same(record.inputs.dependency_fingerprints, expected.dependency_fingerprints)) found.add('dependency_changed');
  if (!same(record.inputs.lockfile_hashes, expected.lockfile_hashes)) found.add('lockfile_changed');
  if (!same(record.inputs.toolchain_fingerprint, expected.toolchain_fingerprint)) found.add('toolchain_changed');
  if (record.inputs.environment_class !== expected.environment_class) found.add('environment_changed');
  if (record.eval_binding?.build_id !== expected.eval_binding?.build_id) found.add('build_changed');
  if (record.eval_binding?.suite_id !== expected.eval_binding?.suite_id) found.add('suite_changed');
  if (record.eval_binding?.evaluator_id !== expected.eval_binding?.evaluator_id) found.add('evaluator_changed');
  if (record.eval_binding?.model_id !== expected.eval_binding?.model_id) found.add('model_changed');
  if (!expected.semantic_intersection) found.add('semantic_intersection');
  if (!expected.projection_matches) found.add('projection_mismatch');
  const reasons = FRESHNESS_REASON_PRIORITY.filter((reason) => found.has(reason));
  return { current: reasons.length === 0, reasons, primary_reason: reasons[0] ?? null, receipt_run_id: record.run_id };
}

function validProjection(value: unknown): value is ReleaseProjection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.path === 'string' && !!row.path && ['plain_text', 'json', 'toml'].includes(String(row.format)) && ['whole_file', '/version', '/packages//version', '/project/version'].includes(String(row.selector)) && (row.value_encoding === undefined || typeof row.value_encoding === 'string');
}
function copyProjection(value: ReleaseProjection): ReleaseProjection { return { path: value.path, format: value.format, selector: value.selector, ...(value.value_encoding !== undefined ? { value_encoding: value.value_encoding } : {}) }; }
function releaseWriteBinding(value: unknown, release: ReleaseDecision, tree: string): ShipReleaseWriteBinding | null | false {
  if (value === null) return release.applicable ? false : null;
  if (!release.applicable || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>; const hash64 = /^[0-9a-f]{64}$/; const hash40 = /^[0-9a-f]{40}$/;
  if (!/^release-[0-9a-f-]{36}$/.test(String(row.allocation_id)) || !/^release-write-[0-9a-f-]{36}$/.test(String(row.release_write_record_id)) || !hash64.test(String(row.release_write_result_hash)) || row.version !== release.version || !hash40.test(String(row.before_wtree)) || !hash40.test(String(row.after_wtree)) || row.after_wtree !== tree || !hash64.test(String(row.product_manifest_hash_before_release)) || !hash64.test(String(row.release_projection_hash))) return false;
  if ((row.changelog_proposal_sha256 === null) !== (row.changelog_insertion_sha256 === null) || (row.changelog_proposal_sha256 !== null && (!hash64.test(String(row.changelog_proposal_sha256)) || !hash64.test(String(row.changelog_insertion_sha256))))) return false;
  if (!Array.isArray(row.planned_targets) || !row.planned_targets.every(validProjection) || !Array.isArray(row.mutated_projections) || !row.mutated_projections.every(validProjection) || (row.changelog_projection !== null && !validProjection(row.changelog_projection)) || !Array.isArray(row.files) || !row.files.length) return false;
  const files = row.files as Array<Record<string, unknown>>;
  if (files.some(file => !file || typeof file !== 'object' || Array.isArray(file)) || new Set(files.map(file => file.path)).size !== files.length || files.some(file => typeof file.path !== 'string' || !Number.isSafeInteger(file.mode) || (file.mode as number) < 0 || (file.mode as number) > 0o777 || !hash64.test(String(file.after_sha256)) || !Array.isArray(file.projections) || !(file.projections as unknown[]).every(item => validProjection(item) && item.path === file.path))) return false;
  const canonicalRows = (rows: unknown[]) => rows.map(canonical).sort();
  if (!same(canonicalRows(files.flatMap(file => file.projections as unknown[])), canonicalRows(row.mutated_projections))) return false;
  const expectedMutations = [...row.planned_targets, ...(row.changelog_projection === null ? [] : [row.changelog_projection])];
  if (!same(canonicalRows(expectedMutations), canonicalRows(row.mutated_projections))) return false;
  if (row.changelog_projection === null ? row.changelog_proposal_sha256 !== null || row.changelog_insertion_sha256 !== null : row.changelog_proposal_sha256 === null || row.changelog_insertion_sha256 === null || row.changelog_projection.format !== 'plain_text' || row.changelog_projection.selector !== 'whole_file') return false;
  return {
    allocation_id: row.allocation_id as string, release_write_record_id: row.release_write_record_id as string, release_write_result_hash: row.release_write_result_hash as string,
    version: row.version as string, before_wtree: row.before_wtree as string, after_wtree: row.after_wtree as string,
    product_manifest_hash_before_release: row.product_manifest_hash_before_release as string, release_projection_hash: row.release_projection_hash as string,
    changelog_proposal_sha256: row.changelog_proposal_sha256 as string | null, changelog_insertion_sha256: row.changelog_insertion_sha256 as string | null,
    planned_targets: (row.planned_targets as ReleaseProjection[]).map(copyProjection), changelog_projection: row.changelog_projection === null ? null : copyProjection(row.changelog_projection as ReleaseProjection),
    mutated_projections: (row.mutated_projections as ReleaseProjection[]).map(copyProjection), files: files.map(file => ({ path: file.path as string, mode: file.mode as number, after_sha256: file.after_sha256 as string, projections: (file.projections as ReleaseProjection[]).map(copyProjection) })),
  };
}

export function inspectShipHandoff(records: EvidenceRecordV2[], input: { repoId: string; pr: number; baseRef: string; baseSha: string; remotePrHeadSha: string; stateRootId?: string; repositoryNodeId?: string; headRepositoryNodeId?: string; headRefName?: string }): ShipHandoffVerdict {
  const candidates = records.filter((record) => {
    const handoff = record?.handoff as Record<string, unknown> | undefined;
    return record?.schema_version === EVIDENCE_SCHEMA_VERSION && record?.result === 'pass' && record?.exit === 0
      && record?.capability?.id === 'delivery.pr_open' && record?.validator?.id === 'gstack.ship-handoff'
      && record?.subject?.repo_id === input.repoId && record?.subject?.base_sha === input.baseSha && record?.subject?.remote_pr_head_sha === input.remotePrHeadSha
      && handoff?.stage === 'ship' && handoff.pr_number === input.pr && handoff.base_ref === input.baseRef;
  });
  if (candidates.length > 1) return { current: false, blocker: 'ship_handoff_ambiguous' };
  if (candidates.length !== 1) return { current: false, blocker: 'ship_handoff_missing_or_stale' };
  const record = candidates[0]; const handoff = record.handoff as Record<string, unknown>;
  const release = handoff.release as ReleaseDecision | undefined;
  const provider = handoff.provider_identity as ShipProviderIdentity | undefined;
  if (typeof handoff.state_root_id !== 'string' || !/^state_[0-9a-f]{32}$/.test(handoff.state_root_id) || (input.stateRootId !== undefined && handoff.state_root_id !== input.stateRootId) || typeof handoff.manifest_hash !== 'string' || !/^[0-9a-f]{64}$/.test(handoff.manifest_hash) || !Array.isArray(handoff.review_run_ids) || !handoff.review_run_ids.every((id) => typeof id === 'string') || !Array.isArray(handoff.validation_run_ids) || !handoff.validation_run_ids.every((id) => typeof id === 'string') || !release || typeof release.applicable !== 'boolean' || !['per_pr', 'required_on_release', 'none'].includes(release.mode) || !['version_prefix', 'conventional', 'free'].includes(release.title_policy) || (release.applicable ? typeof release.version !== 'string' || !release.version : release.version !== null) || (release.mode === 'none' && release.applicable) || (release.mode === 'per_pr' && !release.applicable) || !provider || !['repository_node_id', 'repository_name_with_owner', 'head_repository_node_id', 'head_repository_name_with_owner', 'head_ref_name'].every(key => typeof (provider as any)[key] === 'string' && !!(provider as any)[key]) || (input.repositoryNodeId !== undefined && provider.repository_node_id !== input.repositoryNodeId) || (input.headRepositoryNodeId !== undefined && provider.head_repository_node_id !== input.headRepositoryNodeId) || (input.headRefName !== undefined && provider.head_ref_name !== input.headRefName)) return { current: false, blocker: 'ship_handoff_missing_or_stale' };
  const releaseWrite = releaseWriteBinding(handoff.release_write, release, String(record.subject.tree));
  if (releaseWrite === false) return { current: false, blocker: 'ship_handoff_missing_or_stale' };
  let candidate: ShipHandoffInspection['candidate_profile'] = null;
  if (handoff.candidate_profile !== undefined) {
    const row = handoff.candidate_profile as Record<string, unknown>;
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.git_blob_oid !== 'string' || !/^[0-9a-f]{40}$/.test(row.git_blob_oid) || typeof row.schema_validation_hash !== 'string' || !/^[0-9a-f]{64}$/.test(row.schema_validation_hash)) return { current: false, blocker: 'ship_handoff_missing_or_stale' };
    candidate = { git_blob_oid: row.git_blob_oid, schema_validation_hash: row.schema_validation_hash };
  }
  let promotion: ShipHandoffInspection['promotion'] = null;
  if (handoff.promotion !== undefined) {
    const row = handoff.promotion as Record<string, unknown>;
    if (!row || typeof row !== 'object' || Array.isArray(row)) return { current: false, blocker: 'ship_handoff_missing_or_stale' };
    const lane = row.lane;
    if (!candidate || !['docs_ux', 'single_repo_code', 'cross_repo_contract'].includes(String(lane))
      || typeof row.block_id !== 'string' || !/^block-[0-9a-f]{32}$/.test(row.block_id)
      || typeof row.proof_id !== 'string' || !/^promotion-[0-9a-f]{32}$/.test(row.proof_id)
      || typeof row.record_id !== 'string' || !/^promotion-write-[0-9a-f]{32}$/.test(row.record_id)
      || !['before_profile_hash', 'after_profile_hash', 'before_sha256', 'after_sha256'].every((key) => typeof row[key] === 'string' && /^[0-9a-f]{64}$/.test(row[key] as string))
      || !['subject_head', 'subject_tree'].every((key) => typeof row[key] === 'string' && /^[0-9a-f]{40}$/.test(row[key] as string))
      || candidate.schema_validation_hash !== row.after_profile_hash) return { current: false, blocker: 'ship_handoff_missing_or_stale' };
    promotion = { block_id: row.block_id as string, lane: lane as SemanticLane, proof_id: row.proof_id as string, record_id: row.record_id as string, before_profile_hash: row.before_profile_hash as string, after_profile_hash: row.after_profile_hash as string, before_sha256: row.before_sha256 as string, after_sha256: row.after_sha256 as string, subject_head: row.subject_head as string, subject_tree: row.subject_tree as string };
  }
  let canarySubject: ShipHandoffInspection['canary_subject'] = null;
  if (handoff.canary_subject !== undefined) {
    const row = handoff.canary_subject as Record<string, unknown>;
    if (!row || typeof row !== 'object' || Array.isArray(row) || !['docs_ux', 'single_repo_code', 'cross_repo_contract'].includes(String(row.lane))
      || typeof row.block_id !== 'string' || !/^block-[0-9a-f]{32}$/.test(row.block_id)
      || typeof row.focused_run_id !== 'string' || !/^focused-[0-9a-f]{32}$/.test(row.focused_run_id)
      || typeof row.promotion_proof_id !== 'string' || !/^promotion-[0-9a-f]{32}$/.test(row.promotion_proof_id)
      || !['profile_hash', 'policy_hash'].every((key) => typeof row[key] === 'string' && /^[0-9a-f]{64}$/.test(row[key] as string))
      || !['subject_head', 'subject_tree'].every((key) => typeof row[key] === 'string' && /^[0-9a-f]{40}$/.test(row[key] as string))
      || row.subject_head !== record.subject.remote_pr_head_sha || row.subject_tree !== record.subject.tree || row.profile_hash !== record.profile_hash) return { current: false, blocker: 'ship_handoff_missing_or_stale' };
    canarySubject = { block_id: row.block_id as string, lane: row.lane as SemanticLane, focused_run_id: row.focused_run_id as string, profile_hash: row.profile_hash as string, promotion_proof_id: row.promotion_proof_id as string, subject_head: row.subject_head as string, subject_tree: row.subject_tree as string, policy_hash: row.policy_hash as string };
  }
  if (promotion && canarySubject) return { current: false, blocker: 'ship_handoff_missing_or_stale' };
  if (typeof record.subject.tree !== 'string' || !/^[0-9a-f]{40}$/.test(record.subject.tree) || typeof record.profile_hash !== 'string' || !/^[0-9a-f]{64}$/.test(record.profile_hash)) return { current: false, blocker: 'ship_handoff_missing_or_stale' };
  return { current: true, receipt_run_id: record.run_id, state_root_id: handoff.state_root_id, repo_id: input.repoId, pr: input.pr, base_ref: input.baseRef, base_sha: input.baseSha, remote_pr_head_sha: input.remotePrHeadSha, remote_pr_head_tree: record.subject.tree, provider_identity: { repository_node_id: provider.repository_node_id, repository_name_with_owner: provider.repository_name_with_owner, head_repository_node_id: provider.head_repository_node_id, head_repository_name_with_owner: provider.head_repository_name_with_owner, head_ref_name: provider.head_ref_name }, profile_hash: record.profile_hash, manifest_hash: handoff.manifest_hash, review_run_ids: [...handoff.review_run_ids] as string[], validation_run_ids: [...handoff.validation_run_ids] as string[], release_decision: { applicable: release.applicable, mode: release.mode, version: release.version, title_policy: release.title_policy }, release_write: releaseWrite, candidate_profile: candidate, promotion, canary_subject: canarySubject };
}
