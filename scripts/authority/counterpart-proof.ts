import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildCounterpartFingerprint } from '../../lib/counterpart-proof';
import { EVIDENCE_POLICY_VERSION, type EvidenceRecordV2 } from '../../lib/evidence-envelope';
import { appendJsonl } from '../../lib/jsonl-store';
import { ledgerCandidates, readJsonlUnion, resolveRegisteredProjectLocation } from '../../lib/project-identity';
import { materializePrivateValidatorEnv, releasePrivateValidatorEnv } from '../../lib/private-validator-env';
import { resolveRegisteredRuntimeBinding, releaseRuntimeBinding } from '../../lib/validator-runtime';
import { ensureValidator, evaluateValidatorBinding, type TrustedValidatorBinding } from '../../lib/validator-runner';
import { resolveRuntimeStateRoot } from '../../lib/canonical-state-root';
import { resolveTrustedWorkProfile } from '../../lib/trusted-base';
import type { Lane } from '../../lib/work-profile';

function fail(error: unknown, status = 2): never { process.stderr.write(JSON.stringify({ result: null, error: { code: error instanceof Error ? error.message : 'counterpart_proof_failed' } }) + '\n'); process.exit(status); }
function sha(value: unknown): string { return new Bun.CryptoHasher('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'); }
function git(cwd: string, args: string[], optional = false): string | null { const result = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8', timeout: 20_000, env: { PATH: '/usr/bin:/bin', HOME: os.homedir(), LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1' } }); if (result.status !== 0) { if (optional) return null; throw new Error('counterpart_git_failure'); } return result.stdout.trim(); }
function exactHead(cwd: string): { ref: string; sha: string } {
  const symbolic = git(cwd, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], true);
  const candidates = [symbolic, 'refs/remotes/origin/main', 'refs/remotes/origin/master', 'HEAD'].filter((item): item is string => Boolean(item));
  for (const ref of candidates) { const value = git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`], true); if (value && /^[0-9a-f]{40}$/.test(value)) return { ref, sha: value }; }
  throw new Error('counterpart_subject_invalid');
}

try {
  const args = process.argv.slice(2); if (args.shift() !== 'ensure') throw new Error('counterpart_command_invalid');
  const values = new Map<string, string>(); let json = false;
  while (args.length) { const flag = args.shift()!; if (flag === '--json') { if (json) throw new Error('counterpart_arguments_invalid'); json = true; continue; } const value = args.shift(); if (!value || value.startsWith('--') || values.has(flag) || !['--dependency-id', '--capability', '--assert-target-ref', '--assert-target-sha', '--assert-counterpart-head', '--lane'].includes(flag)) throw new Error('counterpart_arguments_invalid'); values.set(flag, value); }
  const dependencyId = values.get('--dependency-id'); const capability = values.get('--capability'); const lane = (values.get('--lane') ?? 'cross_repo_contract') as Lane;
  if (!json || !dependencyId || !capability || !['docs_ux', 'single_repo_code', 'cross_repo_contract'].includes(lane) || (values.has('--assert-target-ref') && values.has('--assert-target-sha'))) throw new Error('counterpart_arguments_invalid');
  const resolved = resolveTrustedWorkProfile({ cwd: process.cwd(), lane, assertTargetRef: values.get('--assert-target-ref'), assertTargetSha: values.get('--assert-target-sha') });
  if (!resolved.effective || resolved.execution !== 'profile') throw new Error('trusted_profile_required');
  const dependency = resolved.effective.dependencies?.[dependencyId] as any;
  if (!dependency || dependency.counterpart_gate?.capability !== capability) throw new Error('counterpart_binding_missing');
  const gate = dependency.counterpart_gate as any;
  const registered = resolveRegisteredProjectLocation(dependency.registry_id, process.cwd());
  if (registered.identity.repo_id !== dependency.repo_id) throw new Error('counterpart_identity_mismatch');
  const selected = exactHead(registered.root);
  const asserted = values.get('--assert-counterpart-head'); if (asserted && asserted.toLowerCase() !== selected.sha) throw new Error('counterpart_head_mismatch');
  const fingerprint = buildCounterpartFingerprint({ repositoryRoot: registered.root, repoId: registered.identity.repo_id, headSha: selected.sha, artifactPaths: dependency.artifact_paths });
  const logicalArgv = gate.kind === 'python_pytest' ? ['python', '-m', 'pytest', ...gate.test_paths] : ['python', '-m', 'unittest', ...gate.test_modules];
  const runtimeSpec = gate.runtime.source === 'consumer' ? resolved.effective.runtimes?.[gate.runtime.runtime_id] as any : null;
  if (!runtimeSpec || runtimeSpec.kind !== 'registered_python') throw new Error('counterpart_runtime_unsupported');
  const validatorId = `${dependencyId}.counterpart`;
  const state = resolveRuntimeStateRoot();
  const ledgerDirectory = path.join(state.root, 'projects', registered.identity.write_slug);
  const ledgerFile = path.join(ledgerDirectory, `${registered.identity.write_branch}-evidence.jsonl`);
  const currentRecord = readJsonlUnion<EvidenceRecordV2>(ledgerCandidates(registered.identity, 'evidence', state.root)).filter((record) => record.schema_version === 'ecpe.receipt.v2' && record.subject?.repo_id === registered.identity.repo_id && record.validator?.id === validatorId).at(-1) ?? null;
  const runtime = resolveRegisteredRuntimeBinding({ repositoryRoot: registered.root, runtimeId: runtimeSpec.registry_runtime_id, sourceRoots: ['.'], binding: { mode: 'argv0' }, argv: logicalArgv });
  const now = new Date().toISOString();
  const binding: TrustedValidatorBinding = {
    validatorId, effect: 'read', argv: logicalArgv, cwd: registered.root, currentRecord,
    evidenceContext: {
      repo_id: registered.identity.repo_id, branch_ref: selected.ref, base_sha: null, merge_base_sha: null, local_head_sha: selected.sha, remote_pr_head_sha: null,
      tree: fingerprint.tree, wtree: sha(fingerprint), dirty: false,
      capability: { id: capability, version: resolved.effective.capabilities[capability].version }, validator: { id: validatorId, version: sha(gate) },
      policy_version: EVIDENCE_POLICY_VERSION, profile_hash: resolved.profile_hash, semantic_policy_hash: sha({ dependency: { repo_id: dependency.repo_id, artifact_paths: dependency.artifact_paths }, gate }),
      lockfile_hashes: {}, dependency_fingerprints: { [dependencyId]: { repo_id: fingerprint.repo_id, head_sha: fingerprint.head_sha, tree: fingerprint.tree, artifact_sha256: fingerprint.artifact_sha256 } },
      toolchain_fingerprint: { python: runtime.fingerprint }, environment_class: 'private_counterpart', coverage: { semantic_roles: ['contract'], files: dependency.artifact_paths },
      started_at: now, completed_at: now, expires_at: null,
    },
  };
  const buffered: EvidenceRecordV2[] = [];
  let privateSubject: ReturnType<typeof materializePrivateValidatorEnv> | null = null;
  let finalExit = 0;
  try {
    const current = evaluateValidatorBinding(binding);
    if (current.current) {
      const result = ensureValidator(binding, { spawn: () => { throw new Error('counterpart_check_first_spawned'); }, append: () => { throw new Error('counterpart_check_first_appended'); } });
      process.stdout.write(JSON.stringify({ schema: 'ecpe.counterpart-proof.v2', dependency_id: dependencyId, capability, fingerprint, ...result }) + '\n');
    } else {
      privateSubject = materializePrivateValidatorEnv({ sourceRepository: registered.root, subjectSha: selected.sha });
      binding.cwd = privateSubject.checkout_root;
      const result = ensureValidator(binding, {
        spawn: () => {
          const before = git(privateSubject!.checkout_root, ['status', '--porcelain=v1', '--untracked-files=all']); if (before !== '') throw new Error('counterpart_private_subject_dirty');
          const child = spawnSync(runtime.argv[0], runtime.argv.slice(1), { cwd: privateSubject!.checkout_root, shell: false, stdio: 'inherit', env: { ...privateSubject!.environment, ...runtime.environment, PYTHONPATH: gate.source_roots.map((relative: string) => path.join(privateSubject!.checkout_root, relative)).join(path.delimiter) } });
          const afterHead = git(privateSubject!.checkout_root, ['rev-parse', 'HEAD^{commit}']); const afterTree = git(privateSubject!.checkout_root, ['rev-parse', 'HEAD^{tree}']); const afterStatus = git(privateSubject!.checkout_root, ['status', '--porcelain=v1', '--untracked-files=all']);
          if (afterHead !== selected.sha || afterTree !== fingerprint.tree || afterStatus !== '') throw new Error('counterpart_private_subject_mutated');
          return { exitCode: child.status ?? 1 };
        }, append: (record) => buffered.push(record),
      });
      if (git(registered.root, ['rev-parse', '--verify', `${selected.ref}^{commit}`]) !== selected.sha) throw new Error('counterpart_head_moved');
      releasePrivateValidatorEnv(privateSubject); privateSubject = null;
      if (buffered.length) { fs.mkdirSync(ledgerDirectory, { recursive: true, mode: 0o700 }); for (const record of buffered) appendJsonl(ledgerFile, record, { mode: 0o600 }); }
      process.stdout.write(JSON.stringify({ schema: 'ecpe.counterpart-proof.v2', dependency_id: dependencyId, capability, fingerprint, ...result }) + '\n');
      if (result.disposition === 'live_fail') finalExit = result.child_exit ?? 1;
    }
  } finally { if (privateSubject) releasePrivateValidatorEnv(privateSubject); releaseRuntimeBinding(runtime); }
  if (finalExit) process.exitCode = finalExit;
} catch (error) { fail(error); }
