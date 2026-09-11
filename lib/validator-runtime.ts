import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveInstalledRuntimeRoot } from './toolchain-policy';

const PROTECTED = ['PYTHON_BIN', 'PYTHONPATH', 'PYTHONPYCACHEPREFIX', 'PYTEST_ADDOPTS', 'COVERAGE_FILE', 'MYPY_CACHE_DIR', 'RUFF_CACHE_DIR', 'PIP_CACHE_DIR', 'XDG_CACHE_HOME', 'TMPDIR'];
type Binding = { mode: 'argv0' } | { mode: 'env'; name: string };
type RuntimeBindingInput = { repositoryRoot: string; binding: Binding; argv: string[]; sourceRoots: string[] };

function contained(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('runtime_path_invalid');
  const result = path.resolve(root, relative);
  if (result !== root && !result.startsWith(`${root}${path.sep}`)) throw new Error('runtime_path_invalid');
  return result;
}
function fileHash(file: string): string { return new Bun.CryptoHasher('sha256').update(fs.readFileSync(file)).digest('hex'); }
function executable(file: string, code: string): string {
  let info: fs.Stats; try { info = fs.lstatSync(file); } catch { throw new Error(code); }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0) throw new Error(code);
  return fs.realpathSync(file);
}

function buildRuntimeBinding(input: RuntimeBindingInput & { interpreter: string; locks: Array<{ path: string; sha256: string }>; libraryPaths?: string[]; runtimeIdentity?: unknown }) {
  const root = fs.realpathSync(input.repositoryRoot);
  const interpreter = executable(input.interpreter, 'runtime_interpreter_invalid');
  const roots = [...new Set(input.sourceRoots)].sort().map((relative) => {
    const source = contained(root, relative);
    if (!fs.existsSync(source) || !fs.lstatSync(source).isDirectory()) throw new Error('runtime_input_missing');
    return fs.realpathSync(source);
  });
  const libraries = [...new Set(input.libraryPaths ?? [])].sort().map((library) => {
    if (!path.isAbsolute(library)) throw new Error('registered_runtime_manifest_invalid');
    let info: fs.Stats; try { info = fs.lstatSync(library); } catch { throw new Error('registered_runtime_attestation_failed'); }
    if (!info.isDirectory() || info.isSymbolicLink() || ![0, process.geteuid()].includes(info.uid) || (info.mode & 0o022) !== 0) throw new Error('registered_runtime_attestation_failed');
    return fs.realpathSync(library);
  });
  if (!input.argv.length || ['sh', 'bash', 'zsh', 'cmd', 'powershell', 'pwsh'].includes(input.argv[0]) || input.argv.some((arg) => ['-c', '-lc'].includes(arg))) throw new Error('runtime_argv_invalid');
  if (input.binding.mode === 'argv0' && input.argv[0] !== 'python') throw new Error('runtime_binding_argv0_invalid');
  if (input.binding.mode === 'env' && !/^(?:PYTHON_BIN|[A-Z][A-Z0-9_]*_PYTHON_BIN)$/.test(input.binding.name)) throw new Error('runtime_binding_env_invalid');
  const lease = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-validator-runtime-')); fs.chmodSync(lease, 0o700);
  const wrapper = path.join(lease, 'python');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec '${interpreter.replaceAll("'", "'\\''")}' -S "$@"\n`, { mode: 0o700 });
  const cache = path.join(lease, 'cache'); fs.mkdirSync(cache, { mode: 0o700 });
  const environment: Record<string, string> = Object.create(null);
  for (const name of PROTECTED) environment[name] = name === 'PYTEST_ADDOPTS' ? '-p no:cacheprovider' : name === 'PYTHONPATH' ? [...roots, ...libraries].join(path.delimiter) : name === 'PYTHON_BIN' ? wrapper : path.join(cache, name.toLowerCase());
  Object.assign(environment, { PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PATH: '/usr/bin:/bin', LC_ALL: 'C' });
  if (input.binding.mode === 'env') environment[input.binding.name] = wrapper;
  const argv = input.binding.mode === 'argv0' ? [wrapper, ...input.argv.slice(1)] : [...input.argv];
  const fingerprint = new Bun.CryptoHasher('sha256').update(JSON.stringify({ interpreter: fileHash(interpreter), locks: input.locks, roots: input.sourceRoots, libraries, runtime: input.runtimeIdentity ?? null })).digest('hex');
  return { interpreter, wrapper, lease_root: lease, cache_root: cache, environment, argv, fingerprint };
}

export function resolveRuntimeBinding(input: RuntimeBindingInput & { interpreterRelpath: string; lockfiles: string[] }) {
  const root = fs.realpathSync(input.repositoryRoot);
  const interpreter = contained(root, input.interpreterRelpath);
  try { executable(interpreter, 'runtime_interpreter_invalid'); } catch (error) { if (!fs.existsSync(interpreter)) throw new Error('runtime_input_missing'); throw error; }
  const locks = [...new Set(input.lockfiles)].sort().map((relative) => {
    const file = contained(root, relative); let stat: fs.Stats;
    try { stat = fs.lstatSync(file); } catch { throw new Error('runtime_input_missing'); }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('runtime_input_invalid');
    return { path: relative, sha256: fileHash(file) };
  });
  return buildRuntimeBinding({ repositoryRoot: root, interpreter, locks, sourceRoots: input.sourceRoots, binding: input.binding, argv: input.argv });
}

interface RegisteredRuntimeEntry { runtime_id?: unknown; realpath?: unknown; owner_uid?: unknown; mode?: unknown; sha256?: unknown; version?: unknown; purelib?: unknown; platlib?: unknown; packages?: unknown }

export function resolveRegisteredRuntimeBinding(input: RuntimeBindingInput & { runtimeId: 'harness_test_python' | 'cdo_preview_python'; manifestPath?: string }) {
  const selectedManifest = input.manifestPath ?? (process.env.ECPE_TESTING === '1' ? process.env.ECPE_TEST_RUNTIME_MANIFEST : undefined) ?? path.join(resolveInstalledRuntimeRoot(), '.ecpe-installed-runtime.json');
  const manifestPath = path.resolve(selectedManifest);
  let manifestInfo: fs.Stats; try { manifestInfo = fs.lstatSync(manifestPath); } catch { throw new Error('registered_runtime_manifest_missing'); }
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || (manifestInfo.mode & 0o022) !== 0) throw new Error('registered_runtime_manifest_invalid');
  let manifest: { schema?: unknown; execution_environment?: { runtimes?: Record<string, RegisteredRuntimeEntry> } };
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { throw new Error('registered_runtime_manifest_invalid'); }
  const entry = manifest.execution_environment?.runtimes?.[input.runtimeId];
  if (manifest.schema !== 'ecpe.gstack-runtime.v1' || !entry || entry.runtime_id !== input.runtimeId || typeof entry.realpath !== 'string' || !path.isAbsolute(entry.realpath) || typeof entry.owner_uid !== 'number' || typeof entry.mode !== 'number' || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) || typeof entry.version !== 'string' || typeof entry.purelib !== 'string' || typeof entry.platlib !== 'string' || !entry.packages || typeof entry.packages !== 'object' || Array.isArray(entry.packages)) throw new Error('registered_runtime_manifest_invalid');
  for (const [name, value] of Object.entries(entry.packages as Record<string, unknown>)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name) || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('registered_runtime_manifest_invalid');
    const row = value as Record<string, unknown>;
    if (Object.keys(row).sort().join(',') !== 'fingerprint,version' || typeof row.version !== 'string' || !row.version || typeof row.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.fingerprint)) throw new Error('registered_runtime_manifest_invalid');
  }
  let info: fs.Stats; try { info = fs.lstatSync(entry.realpath); } catch { throw new Error('registered_runtime_attestation_failed'); }
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== entry.owner_uid || (info.mode & 0o777) !== entry.mode || (info.mode & 0o022) !== 0) throw new Error('registered_runtime_attestation_failed');
  try {
    if (fs.realpathSync(entry.realpath) !== entry.realpath || fileHash(entry.realpath) !== entry.sha256) throw new Error('registered_runtime_attestation_failed');
  } catch { throw new Error('registered_runtime_attestation_failed'); }
  const probe = spawnSync(entry.realpath, ['-S', '-c', 'import platform;print(platform.python_version())'], { encoding: 'utf8', shell: false, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', PYTHONNOUSERSITE: '1' }, timeout: 10_000 });
  if (probe.status !== 0 || probe.stdout.trim() !== entry.version) throw new Error('registered_runtime_attestation_failed');
  return buildRuntimeBinding({ ...input, interpreter: entry.realpath, locks: [], libraryPaths: [entry.purelib, entry.platlib], runtimeIdentity: entry });
}

export function releaseRuntimeBinding(binding: { lease_root: string }): void {
  const root = path.resolve(binding.lease_root);
  if (path.basename(root).startsWith('gstack-validator-runtime-') && path.dirname(root) === path.resolve(os.tmpdir())) fs.rmSync(root, { recursive: true, force: true });
}
