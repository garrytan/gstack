import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendReservedEcpeBatch, validateEcpeObservation } from './ecpe-metrics';
import { materializePrivateValidatorEnv, releasePrivateValidatorEnv } from './private-validator-env';
import { releaseRuntimeBinding, resolveRegisteredRuntimeBinding } from './validator-runtime';
import { compareCandidateProfile, LANES, parseWorkProfile, type ParsedWorkProfile } from './work-profile';
import { durableAtomicWrite } from './durable-atomic-write';
import { acquireDurableOwnerLock, releaseDurableOwnerLock } from './durable-owner-lock';

export const CDO_PREVIEW_DESCRIPTOR = Object.freeze({
  id: 'cdo-os.local' as const,
  registryId: 'cdo-os' as const,
  participant: 'cdo-os' as const,
  candidatePath: '.gstack/work-profile.yaml' as const,
  comparisonRef: 'main' as const,
  files: Object.freeze(['AGENTS.md', 'SYSTEM_PROMPT.md', 'docs/agent-runtime-contract.md', 'README.md', 'SESSION.md']),
});

type PreviewPhase = 'allocated' | 'candidate_written' | 'running' | 'result_sealed' | 'cleaned';
interface PreviewStateV1 {
  schema: 'ecpe.candidate-preview-state.v1'; descriptor: 'cdo-os.local'; block_id: string; participant: 'cdo-os'; repo_id: string;
  lease: string; lease_root: string; checkout_root: string; subject_head_sha: string; subject_tree_sha: string;
  comparison_ref: 'main'; comparison_sha: string; merge_base_sha: string; phase: PreviewPhase;
  candidate_sha256: string | null; candidate_profile_hash: string | null; activation_projection_hash: string | null;
  preview_lanes: string[]; validator_ids: string[]; run_id: string; result: 'pass' | 'fail' | null; child_exits: number[];
  repository_fs_manifest_before_sha256: string | null; repository_fs_manifest_after_sha256: string | null;
  subject_tombstone: string | null; private_subject_cleanup_complete: boolean; generation:number; ambiguity_count:number; retry_deadline:string; created_at: string; completed_at: string | null;
}

const HASH40 = /^[0-9a-f]{40}$/;
const BLOCK = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const digest = (value: string | Uint8Array) => new Bun.CryptoHasher('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') { const row = value as Record<string, unknown>; return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`; }
  return JSON.stringify(value);
}
function git(cwd: string, args: string[], code: string): string {
  const child = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8', timeout: 30_000, shell: false, env: { PATH: '/usr/bin:/bin', HOME: os.homedir(), LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1' } });
  if (child.status !== 0) throw new Error(code); return child.stdout.trim();
}
function stateFile(stateRoot: string, blockId: string): string {
  if (!BLOCK.test(blockId)) throw new Error('candidate_preview_block_invalid');
  return path.join(path.resolve(stateRoot), 'ecpe', 'candidate-preview', `slot-${digest(`${CDO_PREVIEW_DESCRIPTOR.id}\0${blockId}`).slice(0, 32)}.json`);
}
function runFile(stateRoot: string, runId: string): string {
  if (!/^candidate-[0-9a-f]{32}$/.test(runId)) throw new Error('candidate_preview_run_invalid');
  return path.join(path.resolve(stateRoot), 'ecpe', 'candidate-preview', 'runs', `${runId}.json`);
}
function durableWrite(target: string, value: unknown): void {
  durableAtomicWrite(target, `${canonical(value)}\n`);
}
function withLock<T>(stateRoot: string, blockId: string, callback: () => T): T {
  const owned=acquireDurableOwnerLock(stateFile(stateRoot,blockId),'candidate_preview_busy');
  try{return callback()}finally{releaseDurableOwnerLock(owned)}
}
function readState(stateRoot: string, blockId: string): PreviewStateV1 {
  let value: PreviewStateV1; try { value = JSON.parse(fs.readFileSync(stateFile(stateRoot, blockId), 'utf8')); } catch { throw new Error('candidate_preview_missing'); }
  if (value.schema !== 'ecpe.candidate-preview-state.v1' || value.descriptor !== CDO_PREVIEW_DESCRIPTOR.id || value.block_id !== blockId || value.participant !== CDO_PREVIEW_DESCRIPTOR.participant || !/^preview-[0-9a-f]{32}$/.test(value.lease) || !/^candidate-[0-9a-f]{32}$/.test(value.run_id)) throw new Error('candidate_preview_state_invalid');
  return value;
}
function assertLease(value: PreviewStateV1, lease: string): void { if (value.lease !== lease) throw new Error('candidate_preview_lease_mismatch'); }
function resolveSubject(sourceRepository: string) {
  const root = fs.realpathSync(sourceRepository); const head = git(root, ['rev-parse', 'HEAD^{commit}'], 'candidate_preview_subject_invalid').toLowerCase(); const tree = git(root, ['rev-parse', 'HEAD^{tree}'], 'candidate_preview_subject_invalid').toLowerCase();
  if (!HASH40.test(head) || !HASH40.test(tree)) throw new Error('candidate_preview_subject_invalid'); return { root, head, tree };
}
function validatePrivateRoot(value: PreviewStateV1): void {
  if (value.private_subject_cleanup_complete) return; const leaseRoot = path.resolve(value.lease_root);
  if (path.dirname(leaseRoot) !== path.resolve(os.tmpdir()) || !path.basename(leaseRoot).startsWith('gstack-private-validator-')) throw new Error('candidate_preview_lease_invalid');
  if (fs.realpathSync(value.checkout_root) !== fs.realpathSync(path.join(leaseRoot, 'checkout'))) throw new Error('candidate_preview_lease_invalid');
  const marker = JSON.parse(fs.readFileSync(path.join(leaseRoot, '.candidate-preview-owner.json'), 'utf8'));
  if (marker.lease !== value.lease || marker.block_id !== value.block_id || marker.head !== value.subject_head_sha || marker.tree !== value.subject_tree_sha) throw new Error('candidate_preview_marker_invalid');
  if (git(value.checkout_root, ['rev-parse', 'HEAD^{commit}'], 'candidate_preview_subject_invalid') !== value.subject_head_sha || git(value.checkout_root, ['rev-parse', 'HEAD^{tree}'], 'candidate_preview_subject_invalid') !== value.subject_tree_sha) throw new Error('candidate_preview_subject_moved');
}
function committedFile(repository: string, head: string, relative: string): Uint8Array {
  if (path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('candidate_preview_source_invalid');
  const child = spawnSync('/usr/bin/git', ['show', `${head}:${relative}`], { cwd: repository, timeout: 30_000, shell: false, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
  if (child.status !== 0) throw new Error('candidate_preview_source_missing'); return child.stdout;
}
function repositoryManifest(root: string): string {
  const rows: Array<[string, number, number, string]> = [];
  const visit = (directory: string, prefix: string) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { if (!prefix && entry.name === '.git') continue; const relative = prefix ? `${prefix}/${entry.name}` : entry.name; const absolute = path.join(directory, entry.name); const info = fs.lstatSync(absolute); if (info.isSymbolicLink()) rows.push([relative, info.mode & 0o7777, info.size, `symlink:${fs.readlinkSync(absolute)}`]); else if (info.isDirectory()) visit(absolute, relative); else if (info.isFile()) rows.push([relative, info.mode & 0o7777, info.size, digest(fs.readFileSync(absolute))]); else throw new Error('candidate_preview_filesystem_invalid'); } };
  visit(root, ''); return digest(canonical(rows));
}
function candidatePath(value: PreviewStateV1): string { const target = path.resolve(value.checkout_root, CDO_PREVIEW_DESCRIPTOR.candidatePath); if (!target.startsWith(`${path.resolve(value.checkout_root)}${path.sep}`)) throw new Error('candidate_preview_path_invalid'); return target; }
function exactUtf8(bytes: Uint8Array): string {
  if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) throw new Error('candidate_preview_input_size'); let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('candidate_preview_input_encoding'); }
  if (source.charCodeAt(0) === 0xfeff || source.includes('\0')) throw new Error('candidate_preview_input_encoding'); return source;
}
function activationProjection(profile: ParsedWorkProfile) { const projection = Object.fromEntries(LANES.map((lane) => [lane, profile.lanes[lane].activation])); return { hash: digest(canonical(projection)), previewLanes: LANES.filter((lane) => profile.lanes[lane].activation !== 'legacy').sort() }; }

export function validateCandidatePreview(input: { trusted: ParsedWorkProfile; candidate: ParsedWorkProfile; candidateBytes: Uint8Array | string; candidateBlobSha: string }) {
  if (!HASH40.test(input.candidateBlobSha)) throw new Error('candidate_blob_invalid'); const comparison = compareCandidateProfile(input.trusted, input.candidate);
  const body = { schema: 'ecpe.candidate-preview.v1' as const, execution: 'legacy' as const, candidate_state: comparison.state, candidate_blob_sha: input.candidateBlobSha, candidate_profile_hash: input.candidate.semantic_policy_hash, warnings: comparison.warnings };
  const bytes = typeof input.candidateBytes === 'string' ? input.candidateBytes : new TextDecoder().decode(input.candidateBytes); return { ...body, validation_hash: digest(`${canonical(body)}\0${bytes}`) };
}
export function inspectCandidateSource(input: { sourceRepository: string; repoId: string; blockId: string }) {
  const subject = resolveSubject(input.sourceRepository); return { schema: 'ecpe.candidate-preview.source.v1' as const, descriptor: CDO_PREVIEW_DESCRIPTOR.id, block_id: input.blockId, repo_id: input.repoId, head_sha: subject.head, tree: subject.tree, files: CDO_PREVIEW_DESCRIPTOR.files.map((file) => { const bytes = committedFile(subject.root, subject.head, file); return { path: file, blob_oid: git(subject.root, ['rev-parse', `${subject.head}:${file}`], 'candidate_preview_source_missing'), sha256: digest(bytes), content: new TextDecoder().decode(bytes) }; }) };
}
export function initCandidatePreview(input: { stateRoot: string; sourceRepository: string; repoId: string; blockId: string; assertSubjectHead: string; assertSubjectTree: string }) {
  return withLock(input.stateRoot, input.blockId, () => {
    const subject = resolveSubject(input.sourceRepository); if (subject.head !== input.assertSubjectHead || subject.tree !== input.assertSubjectTree) throw new Error('subject_moved'); const target = stateFile(input.stateRoot, input.blockId);
    if (fs.existsSync(target)) { const existing = readState(input.stateRoot, input.blockId); if (existing.repo_id !== input.repoId || existing.subject_head_sha !== subject.head || existing.subject_tree_sha !== subject.tree) throw new Error('preview_slot_conflict'); if (existing.phase !== 'cleaned') validatePrivateRoot(existing); return { disposition: 'reused' as const, lease: existing.lease, run_id: existing.run_id, phase: existing.phase, subject_head_sha: existing.subject_head_sha, subject_tree_sha: existing.subject_tree_sha }; }
    const comparisonSha = git(subject.root, ['rev-parse', `refs/heads/${CDO_PREVIEW_DESCRIPTOR.comparisonRef}^{commit}`], 'candidate_preview_comparison_missing'); const mergeBase = git(subject.root, ['merge-base', subject.head, comparisonSha], 'candidate_preview_comparison_missing'); const privateRoot = materializePrivateValidatorEnv({ sourceRepository: subject.root, subjectSha: subject.head });
    const lease = `preview-${digest(`${input.blockId}\0${input.repoId}\0${subject.head}\0${subject.tree}`).slice(0, 32)}`; const runId = `candidate-${digest(`${lease}\0${comparisonSha}\0${mergeBase}`).slice(0, 32)}`;
    durableWrite(path.join(privateRoot.lease_root, '.candidate-preview-owner.json'), { schema: 'ecpe.candidate-preview-owner.v1', lease, block_id: input.blockId, head: subject.head, tree: subject.tree });
    const created=new Date();const state: PreviewStateV1 = { schema: 'ecpe.candidate-preview-state.v1', descriptor: CDO_PREVIEW_DESCRIPTOR.id, block_id: input.blockId, participant: CDO_PREVIEW_DESCRIPTOR.participant, repo_id: input.repoId, lease, lease_root: privateRoot.lease_root, checkout_root: privateRoot.checkout_root, subject_head_sha: subject.head, subject_tree_sha: subject.tree, comparison_ref: CDO_PREVIEW_DESCRIPTOR.comparisonRef, comparison_sha: comparisonSha, merge_base_sha: mergeBase, phase: 'allocated', candidate_sha256: null, candidate_profile_hash: null, activation_projection_hash: null, preview_lanes: [], validator_ids: ['cdo_preview_python', 'cdo_preview_bash'], run_id: runId, result: null, child_exits: [], repository_fs_manifest_before_sha256: null, repository_fs_manifest_after_sha256: null, subject_tombstone: null, private_subject_cleanup_complete: false,generation:0,ambiguity_count:0,retry_deadline:new Date(created.getTime()+30*60_000).toISOString(), created_at: created.toISOString(), completed_at: null };
    try { durableWrite(target, state); } catch (error) { releasePrivateValidatorEnv(privateRoot); throw error; }
    return { disposition: 'allocated' as const, lease, run_id: runId, phase: state.phase, subject_head_sha: subject.head, subject_tree_sha: subject.tree };
  });
}
export function writeCandidatePreview(input: { stateRoot: string; blockId: string; lease: string; bytes: Uint8Array }) {
  return withLock(input.stateRoot, input.blockId, () => {
    const value = readState(input.stateRoot, input.blockId); assertLease(value, input.lease); validatePrivateRoot(value); if (!['allocated', 'candidate_written'].includes(value.phase)) throw new Error('candidate_preview_phase_invalid');
    const source = exactUtf8(input.bytes); const candidate = parseWorkProfile(source); const hash = digest(input.bytes); const activation = activationProjection(candidate);
    if (value.phase === 'candidate_written') { if (value.candidate_sha256 !== hash) throw new Error('preview_slot_conflict'); return { disposition: 'reused' as const, lease: value.lease, run_id: value.run_id, candidate_sha256: hash, preview_lanes: value.preview_lanes }; }
    const target = candidatePath(value); durableAtomicWrite(target,input.bytes);
    value.phase = 'candidate_written'; value.candidate_sha256 = hash; value.candidate_profile_hash = candidate.semantic_policy_hash; value.activation_projection_hash = activation.hash; value.preview_lanes = activation.previewLanes; durableWrite(stateFile(input.stateRoot, input.blockId), value);
    return { disposition: 'written' as const, lease: value.lease, run_id: value.run_id, candidate_sha256: hash, candidate_profile_hash: candidate.semantic_policy_hash, activation_projection_hash: activation.hash, preview_lanes: activation.previewLanes };
  });
}
function bashFiles(root: string): string[] { return git(root, ['ls-files', '--', 'scripts/*.sh', 'scripts/lib/*.sh'], 'candidate_preview_source_invalid').split('\n').filter(Boolean).sort().map((relative) => { const absolute = path.resolve(root, relative); const info = fs.lstatSync(absolute); if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`) || !info.isFile() || info.isSymbolicLink()) throw new Error('candidate_preview_source_invalid'); return absolute; }); }
function removePrivateSubject(value: PreviewStateV1): void {
  validatePrivateRoot(value); const checkout = path.resolve(value.checkout_root); const lease = path.resolve(value.lease_root); if (checkout !== path.join(lease, 'checkout')) throw new Error('candidate_preview_lease_invalid');
  fs.rmSync(checkout, { recursive: true, force: false }); const parent = fs.openSync(lease, 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); } if (fs.existsSync(checkout)) throw new Error('candidate_preview_cleanup_incomplete');
  value.private_subject_cleanup_complete = true; value.subject_tombstone = digest(canonical({ lease: value.lease, head: value.subject_head_sha, tree: value.subject_tree_sha, checkout: 'checkout', absent: true }));
}
function publicTerminal(value: PreviewStateV1) { return { disposition: value.result === 'pass' ? 'live_pass' as const : 'live_fail' as const, run_id: value.run_id, result: value.result, spawned: true, child_exits: value.child_exits, subject_head_sha: value.subject_head_sha, subject_tree_sha: value.subject_tree_sha, candidate_sha256: value.candidate_sha256, activation_projection_hash: value.activation_projection_hash, preview_lanes: value.preview_lanes, private_subject_cleanup_complete: value.private_subject_cleanup_complete, subject_tombstone: value.subject_tombstone }; }
export function runCandidatePreview(input: { stateRoot: string; sourceRepository: string; blockId: string; lease: string; comparisonRef: string; runtimeManifestPath?: string; timelineSlug?: string;now?:Date;eventObserver?:(event:string)=>void }) {
  return withLock(input.stateRoot, input.blockId, () => {
    const value = readState(input.stateRoot, input.blockId); assertLease(value, input.lease); if (input.comparisonRef !== CDO_PREVIEW_DESCRIPTOR.comparisonRef) throw new Error('candidate_preview_comparison_mismatch');
    if (value.phase === 'result_sealed') return { ...publicTerminal(value), disposition: 'receipt_current' as const, spawned: false };if(value.phase==='running'){validatePrivateRoot(value);const now=input.now??new Date();if(value.ambiguity_count>=1||now.toISOString()>=value.retry_deadline){value.result='fail';value.completed_at=now.toISOString();removePrivateSubject(value);value.phase='result_sealed';durableWrite(stateFile(input.stateRoot,input.blockId),value);durableWrite(runFile(input.stateRoot,value.run_id),value);return{...publicTerminal(value),disposition:'terminalized' as const,spawned:false,attempt_reason:'participant_unavailable',terminal_kind:null}}value.ambiguity_count+=1;value.generation+=1;value.phase='candidate_written';durableWrite(stateFile(input.stateRoot,input.blockId),value)}if (value.phase !== 'candidate_written') throw new Error('candidate_preview_phase_invalid'); validatePrivateRoot(value);
    const live = resolveSubject(input.sourceRepository); const liveComparison = git(live.root, ['rev-parse', `refs/heads/${CDO_PREVIEW_DESCRIPTOR.comparisonRef}^{commit}`], 'candidate_preview_comparison_missing'); if (live.head !== value.subject_head_sha || live.tree !== value.subject_tree_sha || liveComparison !== value.comparison_sha) throw new Error('subject_moved');
    const candidate = parseWorkProfile(fs.readFileSync(candidatePath(value), 'utf8')); const projection = activationProjection(candidate); if (digest(fs.readFileSync(candidatePath(value))) !== value.candidate_sha256 || candidate.semantic_policy_hash !== value.candidate_profile_hash || projection.hash !== value.activation_projection_hash) throw new Error('candidate_preview_candidate_moved');
    const runtime = resolveRegisteredRuntimeBinding({ repositoryRoot: value.checkout_root, runtimeId: 'cdo_preview_python', manifestPath: input.runtimeManifestPath, sourceRoots: ['.'], binding: { mode: 'argv0' }, argv: ['python', '-m', 'pytest', '-q', '-p', 'no:cacheprovider'] });
    const bash = '/bin/bash'; const bashInfo = fs.lstatSync(bash); if (!bashInfo.isFile() || bashInfo.isSymbolicLink() || (bashInfo.mode & 0o022) !== 0 || (bashInfo.mode & 0o111) === 0) { releaseRuntimeBinding(runtime); throw new Error('candidate_preview_bash_invalid'); }
    const before = repositoryManifest(value.checkout_root); const beforeStatus = git(value.checkout_root, ['status', '--porcelain=v1', '--untracked-files=all'], 'candidate_preview_subject_invalid'); value.phase = 'running'; value.repository_fs_manifest_before_sha256 = before; durableWrite(stateFile(input.stateRoot, input.blockId), value);
    let pythonExit = 1; let bashExit = 1;
    try {input.eventObserver?.('baseline_started'); const env = { ...runtime.environment, HOME: path.join(value.lease_root, 'home'), TMPDIR: path.join(value.lease_root, 'tmp'), XDG_CACHE_HOME: path.join(value.lease_root, 'cache'), PYTHONPYCACHEPREFIX: path.join(value.lease_root, 'pycache'), PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', LC_ALL: 'C', LANG: 'C', PATH: '/usr/bin:/bin' };
      const python = spawnSync(runtime.argv[0], runtime.argv.slice(1), { cwd: value.checkout_root, shell: false, timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'], env }); pythonExit = python.status ?? 1;
      const scripts = bashFiles(value.checkout_root); if (!scripts.length) throw new Error('candidate_preview_scripts_missing'); const shell = spawnSync(bash, ['-n', ...scripts], { cwd: value.checkout_root, shell: false, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], env: { HOME: env.HOME, TMPDIR: env.TMPDIR, PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' } }); bashExit = shell.status ?? 1;
    } finally { releaseRuntimeBinding(runtime); }
    const after = repositoryManifest(value.checkout_root); const afterStatus = git(value.checkout_root, ['status', '--porcelain=v1', '--untracked-files=all'], 'candidate_preview_subject_invalid'); value.child_exits = [pythonExit, bashExit]; value.repository_fs_manifest_after_sha256 = after; value.result = pythonExit === 0 && bashExit === 0 && before === after && beforeStatus === afterStatus ? 'pass' : 'fail'; value.completed_at = new Date().toISOString(); removePrivateSubject(value); value.phase = 'result_sealed';
    durableWrite(stateFile(input.stateRoot, input.blockId), value); durableWrite(runFile(input.stateRoot, value.run_id), value);
    const observation = validateEcpeObservation({ schema_version: 1, run_id: value.run_id, timestamp: value.completed_at, wtree: value.repo_id, kind: 'candidate_preview', work_kind: 'review', finish_line: 'review_receipt', candidate_preview: { block_id: value.block_id, participant: value.participant, repo_id: value.repo_id, descriptor_id: value.descriptor, candidate_sha256: value.candidate_sha256, comparison_ref: value.comparison_ref, subject_head_sha: value.subject_head_sha, subject_tree_sha: value.subject_tree_sha, activation_projection_hash: value.activation_projection_hash, preview_lanes: value.preview_lanes, validator_ids: value.validator_ids, result: value.result, clean_before: true, clean_after: true, subject_materialization: 'helper_owned_private_checkout', repository_fs_manifest_before_sha256: before, repository_fs_manifest_after_sha256: after, private_subject_cleanup_complete: true, repository_file_creations: 0, external_effects: 0, paid_effects: 0 } }, { allowReservedProducer: true });
    if (input.timelineSlug) appendReservedEcpeBatch(path.join(input.stateRoot, 'projects', input.timelineSlug, 'timeline.jsonl'), [observation]); return publicTerminal(value);
  });
}
export function checkCandidatePreview(input: { stateRoot: string; sourceRepository: string; runId: string; frozen?: boolean }) {
  let value: PreviewStateV1; try { value = JSON.parse(fs.readFileSync(runFile(input.stateRoot, input.runId), 'utf8')); } catch { throw new Error('candidate_preview_run_missing'); }
  if (value.schema !== 'ecpe.candidate-preview-state.v1' || value.run_id !== input.runId || value.phase !== 'result_sealed' || !value.private_subject_cleanup_complete || !value.subject_tombstone || value.result === null) throw new Error('candidate_preview_run_invalid'); const live = input.frozen ? null : resolveSubject(input.sourceRepository); const current = input.frozen === true || (live!.head === value.subject_head_sha && live!.tree === value.subject_tree_sha);
  return { disposition: current && value.result === 'pass' ? 'checked' as const : 'retryable' as const, current, run_id: value.run_id, result: value.result, subject_head_sha: value.subject_head_sha, subject_tree_sha: value.subject_tree_sha, private_subject_cleanup_complete: true, subject_tombstone: value.subject_tombstone };
}
export function inspectCandidatePreview(input: { stateRoot: string; blockId: string; sourceRepository?: string }) {
  const value = readState(input.stateRoot, input.blockId); if (value.phase !== 'result_sealed' || value.result !== 'pass' || !value.private_subject_cleanup_complete) throw new Error('candidate_preview_not_current'); if (input.sourceRepository) { const live = resolveSubject(input.sourceRepository); if (live.head !== value.subject_head_sha || live.tree !== value.subject_tree_sha) throw new Error('candidate_preview_not_current'); }
  return { disposition: 'receipt_current' as const, run_id: value.run_id, result: value.result, subject_head_sha: value.subject_head_sha, subject_tree_sha: value.subject_tree_sha, candidate_sha256: value.candidate_sha256, activation_projection_hash: value.activation_projection_hash, preview_lanes: value.preview_lanes, private_subject_cleanup_complete: true };
}
export function inspectCandidatePreviewLease(input: { stateRoot: string; blockId: string }) {
  const value = readState(input.stateRoot, input.blockId); if (!value.private_subject_cleanup_complete && value.phase !== 'cleaned') validatePrivateRoot(value);
  return { disposition: value.phase === 'cleaned' ? 'cleaned' as const : 'recovered' as const, lease: value.phase === 'cleaned' ? null : value.lease, run_id: value.run_id, phase: value.phase,generation:value.generation,ambiguity_count:value.ambiguity_count,retry_deadline:value.retry_deadline, recovery_scope: 'lease', next_operation: value.phase === 'allocated' ? 'candidate_preview_write' : value.phase === 'candidate_written' || value.phase === 'running' ? 'candidate_preview_run' : value.phase === 'result_sealed' ? 'candidate_preview_cleanup' : null };
}
export function cleanupCandidatePreview(input: { stateRoot: string; blockId: string; lease: string }) {
  return withLock(input.stateRoot, input.blockId, () => { const value = readState(input.stateRoot, input.blockId); assertLease(value, input.lease); if (value.phase === 'cleaned') return { disposition: 'reused' as const, run_id: value.run_id, cleaned: true, tombstone: value.subject_tombstone }; if (value.phase !== 'result_sealed' || !value.private_subject_cleanup_complete || !value.subject_tombstone) throw new Error('candidate_preview_not_terminal'); releasePrivateValidatorEnv({ lease_root: value.lease_root }); value.phase = 'cleaned'; durableWrite(stateFile(input.stateRoot, input.blockId), value); return { disposition: 'cleaned' as const, run_id: value.run_id, cleaned: true, tombstone: value.subject_tombstone }; });
}
