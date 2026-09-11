import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { legacyValidatorDescriptor } from '../../lib/legacy-validator';
import { resolveProjectIdentity } from '../../lib/project-identity';
import { resolveTrustedWorkProfile } from '../../lib/trusted-base';
import { releaseRuntimeBinding, resolveRegisteredRuntimeBinding, resolveRuntimeBinding } from '../../lib/validator-runtime';
import type { Lane } from '../../lib/work-profile';

type RuntimeResult = ReturnType<typeof resolveRuntimeBinding>;
const BASE_ENV = { PATH: '/usr/bin:/bin', LC_ALL: 'C', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' };
function fail(error: unknown): never { process.stderr.write(JSON.stringify({ result: null, error: { code: error instanceof Error ? error.message : 'validator_runtime_failed' } }) + '\n'); process.exit(2); }
function parse(args: string[]): { command: string; values: Map<string, string>; json: boolean } {
  const command = args.shift() ?? ''; const values = new Map<string, string>(); let json = false;
  while (args.length) { const flag = args.shift()!; if (flag === '--json') { if (json) throw new Error('validator_runtime_arguments_invalid'); json = true; continue; } const value = args.shift(); if (!flag.startsWith('--') || !value || value.startsWith('--') || values.has(flag)) throw new Error('validator_runtime_arguments_invalid'); values.set(flag, value); }
  return { command, values, json };
}
function selectedLane(value?: string): Lane { if (!value || !['docs_ux', 'single_repo_code', 'cross_repo_contract'].includes(value)) throw new Error('lane_invalid'); return value as Lane; }
function publicRuntime(binding: RuntimeResult) { return { fingerprint: binding.fingerprint, interpreter_sha256: new Bun.CryptoHasher('sha256').update(readFileSync(binding.interpreter)).digest('hex') }; }

try {
  const { command, values, json } = parse(process.argv.slice(2));
  if (command === 'resolve') {
    if (!json || [...values.keys()].some((flag) => !['--validator', '--assert-target-ref', '--lane'].includes(flag))) throw new Error('validator_runtime_arguments_invalid');
    const validatorId = values.get('--validator'); if (!validatorId) throw new Error('validator_required');
    const lane = selectedLane(values.get('--lane'));
    const resolved = resolveTrustedWorkProfile({ cwd: process.cwd(), lane, assertTargetRef: values.get('--assert-target-ref') });
    if (!resolved.effective) throw new Error('trusted_profile_required');
    const validator = resolved.effective.validators[validatorId]; if (!validator || !validator.argv || !validator.runtime_id || !validator.runtime_binding) throw new Error('validator_runtime_unavailable');
    const runtime = resolved.effective.runtimes?.[validator.runtime_id] as Record<string, unknown> | undefined; if (!runtime) throw new Error('validator_runtime_unavailable');
    let binding: RuntimeResult;
    if (runtime.kind === 'registered_python') binding = resolveRegisteredRuntimeBinding({ repositoryRoot: process.cwd(), runtimeId: runtime.registry_runtime_id as 'harness_test_python' | 'cdo_preview_python', sourceRoots: runtime.source_roots as string[], binding: validator.runtime_binding, argv: validator.argv });
    else if (runtime.kind === 'python_venv') binding = resolveRuntimeBinding({ repositoryRoot: process.cwd(), interpreterRelpath: runtime.interpreter_relpath as string, lockfiles: runtime.lockfiles as string[], sourceRoots: runtime.source_roots as string[], binding: validator.runtime_binding, argv: validator.argv });
    else throw new Error('validator_runtime_unavailable');
    const output = { schema: 'ecpe.validator-runtime.v1', validator_id: validatorId, validator_binding: resolved.validator_version_hashes[validatorId], semantic_policy_hash: resolved.semantic_policy_hashes[validatorId], runtime: publicRuntime(binding) };
    releaseRuntimeBinding(binding); process.stdout.write(JSON.stringify(output) + '\n');
  } else if (command === 'resolve-bootstrap' || command === 'exec-bootstrap') {
    if ([...values.keys()].some((flag) => !['--legacy-validator', '--assert-target-ref'].includes(flag)) || (command === 'resolve-bootstrap' && !json) || (command === 'exec-bootstrap' && json)) throw new Error('validator_runtime_arguments_invalid');
    const trusted = resolveTrustedWorkProfile({ cwd: process.cwd(), lane: 'single_repo_code', assertTargetRef: values.get('--assert-target-ref') });
    if (trusted.mode !== 'legacy' || trusted.profile_hash !== null) throw new Error('bootstrap_runtime_forbidden');
    const identity = resolveProjectIdentity(process.cwd(), { mode: 'legacy' }); const descriptor = legacyValidatorDescriptor(identity.repo_id, values.get('--legacy-validator') ?? '');
    let binding: RuntimeResult | undefined;
    if (descriptor.interpreter_relpath) binding = resolveRuntimeBinding({ repositoryRoot: process.cwd(), interpreterRelpath: descriptor.interpreter_relpath, lockfiles: descriptor.lockfiles ?? [], sourceRoots: descriptor.source_roots, binding: descriptor.runtime_binding ?? { mode: 'argv0' }, argv: descriptor.argv });
    const output = { schema: 'ecpe.validator-runtime.v1', descriptor, runtime: binding ? publicRuntime(binding) : null };
    if (command === 'resolve-bootstrap') { if (binding) releaseRuntimeBinding(binding); process.stdout.write(JSON.stringify(output) + '\n'); }
    else { const argv = binding?.argv ?? descriptor.argv; const result = spawnSync(argv[0], argv.slice(1), { cwd: process.cwd(), env: binding?.environment ?? BASE_ENV, stdio: 'inherit', shell: false }); if (binding) releaseRuntimeBinding(binding); process.exit(result.status ?? 1); }
  } else throw new Error('validator_runtime_command_invalid');
} catch (error) { fail(error); }
