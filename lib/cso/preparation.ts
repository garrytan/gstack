/** Inert dependency inspection. Nothing in this module invokes a package manager.
 * Commands are descriptions for the constrained runner, never host commands.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export type CsoStack = 'node' | 'bun' | 'python' | 'rails';
export interface PreparationPrerequisite { code: string; message: string; path?: string }
export interface PreparationCommand {
  executable: string;
  args: string[];
  cwd: '/metadata' | '/work' | '/archives';
  env: Record<string, string>;
}
export interface PreparationInput {
  kind: 'public' | 'local';
  name: string;
  version: string;
  url?: string;
  path?: string;
  integrity?: string;
  integritySource?: 'lock' | 'registry-on-acquisition';
  platform?: string;
}
export interface PreparationPlan {
  schemaVersion: 1;
  stack: CsoStack;
  /** Ready means metadata is admissible; runtime and acquisition admission are separate. */
  status: 'ready' | 'prerequisites';
  prerequisites: PreparationPrerequisite[];
  metadata: Array<{ path: string; content: string; sha256: string }>;
  inputs: PreparationInput[];
  acquisition: PreparationCommand[];
  offline: PreparationCommand[];
  registryHosts: string[];
  runtimeProfile: string;
  runtimeRequirements: Record<string, string>;
  transformations: Array<{ path: string; reason: string; phase: 'acquisition' | 'execution' }>;
  database?: { supported: Array<'sqlite' | 'postgresql'>; selected: 'sqlite' | 'postgresql' | null;
    connections: string[]; requiresSyntheticConfiguration: true };
}

const MAX_METADATA = 8 * 1024 * 1024;
const MAX_PACKAGES = 25_000;
const MANIFEST_FIELDS = ['name', 'version', 'private', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'engines', 'os', 'cpu', 'workspaces', 'overrides'] as const;
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const VERSION = /^[0-9][0-9a-zA-Z.+_-]*$/;
const SRI = /^(?:sha512-[A-Za-z0-9+/]{86}==|sha256-[A-Za-z0-9+/]{43}=)$/;
const connectionName = (value: string) => Buffer.byteLength(value) <= 48 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) &&
  !['__proto__', 'prototype', 'constructor'].includes(value);
const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

class MetadataError extends Error {
  constructor(readonly code: string, message: string, readonly path?: string) { super(message); }
}
function fail(code: string, message: string, path?: string): never { throw new MetadataError(code, message, path); }
function contained(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes('\\') || path.includes('\0')) fail('EXTERNAL_PATH', 'Dependency paths must stay within the captured source.', path);
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) fail('EXTERNAL_PATH', 'Dependency path escapes the captured source.', path);
  return full;
}
function read(root: string, path: string, optional = false): string | undefined {
  const full = contained(root, path);
  let stat;
  try { stat = lstatSync(full); } catch (error: any) {
    if (optional && error.code === 'ENOENT') return undefined;
    fail('MISSING_METADATA', 'Required dependency metadata is missing or unreadable.', path);
  }
  const actual = realpathSync(full);
  if (stat!.isSymbolicLink() || actual !== full || !stat!.isFile()) fail('UNSAFE_METADATA', 'Dependency metadata must be a regular file without symlink ancestors.', path);
  if (stat!.size > MAX_METADATA) fail('METADATA_LIMIT', 'Dependency metadata exceeds the 8 MiB inspection limit.', path);
  return readFileSync(full, 'utf8');
}
function json(root: string, path: string, jsonc = false): Record<string, any> {
  try {
    const parsed = jsonc ? Bun.JSONC.parse(read(root, path)!) : JSON.parse(read(root, path)!);
    if (!record(parsed)) fail('INVALID_METADATA', 'Expected a metadata object.', path);
    return parsed;
  } catch (error) {
    if (error instanceof MetadataError) throw error;
    fail('INVALID_METADATA', 'Dependency metadata is not valid JSON.', path);
  }
}
function publicUrl(value: unknown, hosts: string[], path?: string): string {
  if (typeof value !== 'string') fail('UNPINNED_ARCHIVE', 'A public registry archive URL is required.', path);
  let url: URL;
  try { url = new URL(value); } catch { fail('UNSUPPORTED_SOURCE', 'Dependency URL is invalid.', path); }
  if (url!.protocol !== 'https:' || url!.username || url!.password || url!.port || url!.hash || url!.search || !hosts.includes(url!.hostname)) {
    fail('UNSUPPORTED_SOURCE', 'Only credential-free HTTPS URLs on the declared public registry are supported.', path);
  }
  return url!.href;
}
function integrity(value: unknown, path: string): string {
  if (typeof value !== 'string' || !SRI.test(value)) fail('UNPINNED_ARCHIVE', 'A SHA-256 or SHA-512 archive integrity value is required.', path);
  return value;
}
function packageCount(entries: unknown[], path: string) {
  if (entries.length > MAX_PACKAGES) fail('METADATA_LIMIT', 'The lock exceeds the 25,000-package inspection limit.', path);
}
function metadata(plan: PreparationPlan, path: string, value: string | object, reason?: string) {
  const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  plan.metadata.push({ path, content, sha256: sha256(content) });
  if (reason) plan.transformations.push({ path, reason, phase: 'acquisition' });
}
function command(executable: string, args: string[], cwd: PreparationCommand['cwd'], env: Record<string, string> = {}): PreparationCommand {
  return { executable, args, cwd, env };
}
function dependencySpecs(value: unknown, path: string) {
  if (value === undefined) return;
  if (!record(value)) fail('INVALID_METADATA', 'Dependency maps must be objects.', path);
  for (const [name, spec] of Object.entries(value)) {
    if (!NAME.test(name) || typeof spec !== 'string' || spec.length > 256 || /[\r\n\0]/.test(spec)) fail('INVALID_METADATA', 'Invalid dependency name or version constraint.', path);
    if (/^(?:file:|link:|workspace:)/.test(spec)) {
      if (spec.startsWith('workspace:')) continue; // The lock must independently identify a contained workspace.
      const local = spec.replace(/^(file:|link:)/, '');
      if (isAbsolute(local) || local.split(/[\\/]/).includes('..')) fail('EXTERNAL_PATH', 'Local dependency escapes the snapshot.', path);
    } else if (/[/:@]/.test(spec) && !/^npm:(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@[~^*<>=| 0-9a-z.+_-]+$/i.test(spec)) {
      fail('UNSUPPORTED_SOURCE', 'Private, VCS, and arbitrary URL dependencies require explicit provisioning.', path);
    }
  }
}
function rejectConflictingLogicalArchives(inputs: PreparationInput[], path: string): void {
  const identities = new Map<string, string>();
  for (const input of inputs) {
    if (input.kind !== 'public') continue;
    const key = `${input.name.toLowerCase()}\0${input.version}`;
    const archive = JSON.stringify({ url: input.url ?? null, integrity: input.integrity ?? null,
      integritySource: input.integritySource ?? null, platform: input.platform ?? null });
    const prior = identities.get(key);
    if (prior !== undefined && prior !== archive)
      fail('CONFLICTING_LOCK_IDENTITY', `Multiple locked archives disagree for ${input.name}@${input.version}.`, path);
    identities.set(key, archive);
  }
}
function manifest(root: string, path: string, plan: PreparationPlan): Record<string, any> {
  const source = json(root, path);
  for (const field of DEPENDENCY_FIELDS) dependencySpecs(source[field], path);
  if (source.patchedDependencies) fail('UNSUPPORTED_PATCHES', 'Package-manager patches require an explicitly qualified offline preparation profile.', path);
  if (source.overrides && JSON.stringify(source.overrides).match(/(?:https?:|git[+:]|file:|link:)/)) fail('UNSUPPORTED_SOURCE', 'Dependency overrides must resolve to public version constraints.', path);
  if (source.workspaces !== undefined) {
    const workspaces = Array.isArray(source.workspaces) ? source.workspaces : source.workspaces?.packages;
    if (!Array.isArray(workspaces) || workspaces.some((item: unknown) => typeof item !== 'string' || !/^[A-Za-z0-9_.*\/-]+$/.test(item) || item.startsWith('/') || item.split('/').includes('..'))) fail('EXTERNAL_PATH', 'Workspace patterns must remain inside captured source.', path);
  }
  const clean: Record<string, any> = {};
  for (const field of MANIFEST_FIELDS) if (source[field] !== undefined) clean[field] = source[field];
  metadata(plan, path, clean, 'Acquisition manifest omits scripts, package-manager plugins, and target runtime configuration.');
  if (record(source.engines)) for (const key of ['node', 'bun']) if (typeof source.engines[key] === 'string') plan.runtimeRequirements[key] = source.engines[key];
  if (typeof source.packageManager === 'string') plan.runtimeRequirements.packageManager = source.packageManager;
  return clean;
}

function inspectNode(root: string, plan: PreparationPlan) {
  const lockPath = read(root, 'npm-shrinkwrap.json', true) !== undefined ? 'npm-shrinkwrap.json' : 'package-lock.json';
  const lock = json(root, lockPath);
  if (![2, 3].includes(lock.lockfileVersion) || !record(lock.packages)) fail('UNSUPPORTED_LOCK', 'Node preparation requires npm lock/shrinkwrap version 2 or 3.', lockPath);
  manifest(root, 'package.json', plan);
  const entries = Object.entries(lock.packages); packageCount(entries, lockPath);
  const clean = structuredClone(lock);
  // Version-2's redundant dependency tree is accepted only when every resolved URL is safe.
  function validateTree(tree: unknown) {
    if (!record(tree)) return;
    for (const dep of Object.values(tree)) {
      if (!record(dep)) fail('INVALID_METADATA', 'Invalid npm dependency record.', lockPath);
      if (dep.resolved) publicUrl(dep.resolved, ['registry.npmjs.org'], lockPath);
      if (dep.integrity) integrity(dep.integrity, lockPath);
      validateTree(dep.dependencies);
    }
  }
  validateTree(lock.dependencies);
  for (const [path, raw] of entries) {
    if (!record(raw)) fail('INVALID_METADATA', 'Invalid locked npm package.', lockPath);
    if (path) contained(root, path);
    if (!path || !path.split('/').includes('node_modules')) {
      if (path) manifest(root, `${path}/package.json`, plan);
      for (const field of DEPENDENCY_FIELDS) dependencySpecs(raw[field], lockPath);
      delete clean.packages[path].scripts;
      continue;
    }
    if (raw.link === true) {
      const local = String(raw.resolved ?? ''); contained(root, local);
      if (!record(lock.packages[local])) fail('MISSING_LOCAL_PACKAGE', 'Workspace link has no captured lock entry.', lockPath);
      plan.inputs.push({ kind: 'local', name: local, version: String(lock.packages[local].version ?? '0'), path: local });
      continue;
    }
    const name = typeof raw.name === 'string' ? raw.name : path.split('node_modules/').at(-1)!;
    if (!NAME.test(name) || typeof raw.version !== 'string' || !VERSION.test(raw.version)) fail('INVALID_METADATA', 'Locked npm package needs an exact name and version.', lockPath);
    for (const field of DEPENDENCY_FIELDS) dependencySpecs(raw[field], lockPath);
    plan.inputs.push({ kind: 'public', name, version: raw.version, url: publicUrl(raw.resolved, ['registry.npmjs.org'], lockPath), integrity: integrity(raw.integrity, lockPath), integritySource: 'lock' });
    delete clean.packages[path].scripts;
  }
  rejectConflictingLogicalArchives(plan.inputs, lockPath);
  metadata(plan, lockPath, clean, 'Acquisition lock retains resolution and integrity data but omits executable script fields.');
  const acquisition = ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', '/archives/npm', '--userconfig', '/opt/cso/empty-config', '--globalconfig', '/opt/cso/empty-config'];
  const offline = ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', '/work/.cso-npm-cache', '--userconfig', '/opt/cso/empty-config', '--globalconfig', '/opt/cso/empty-config'];
  plan.acquisition.push(command('/usr/local/bin/npm', [...acquisition, '--registry', 'https://registry.npmjs.org'], '/metadata', { NPM_CONFIG_UPDATE_NOTIFIER: 'false' }));
  plan.offline.push(command('/usr/local/bin/npm', [...offline, '--offline'], '/work'));
  plan.offline.push(command('/usr/local/bin/npm', ['rebuild', '--offline', '--no-audit', '--no-fund', '--cache', '/work/.cso-npm-cache', '--userconfig', '/opt/cso/empty-config', '--globalconfig', '/opt/cso/empty-config'], '/work'));
  plan.registryHosts = ['registry.npmjs.org'];
}

function inspectBun(root: string, plan: PreparationPlan) {
  if (read(root, 'bun.lock', true) === undefined) fail('UNSUPPORTED_LOCK', 'Bun preparation requires the text bun.lock format; bun.lockb is not supported.', 'bun.lock');
  const lock = json(root, 'bun.lock', true);
  if (lock.lockfileVersion !== 1 || !record(lock.packages) || !record(lock.workspaces)) fail('UNSUPPORTED_LOCK', 'Unsupported Bun text-lock schema.', 'bun.lock');
  if (lock.patchedDependencies) fail('UNSUPPORTED_PATCHES', 'Bun patched dependencies require an explicitly qualified offline profile.', 'bun.lock');
  const workspacePaths = Object.keys(lock.workspaces); packageCount(workspacePaths, 'bun.lock');
  for (const path of workspacePaths) {
    if (path) contained(root, path);
    manifest(root, path ? `${path}/package.json` : 'package.json', plan);
    for (const field of DEPENDENCY_FIELDS) dependencySpecs(lock.workspaces[path][field], 'bun.lock');
  }
  const entries = Object.entries(lock.packages); packageCount(entries, 'bun.lock');
  for (const [key, raw] of entries) {
    if (!Array.isArray(raw) || typeof raw[0] !== 'string') fail('INVALID_METADATA', 'Invalid Bun package tuple.', 'bun.lock');
    const split = raw[0].lastIndexOf('@');
    const name = raw[0].slice(0, split), version = raw[0].slice(split + 1);
    if (version.startsWith('workspace:')) {
      const path = version.slice(10); contained(root, path);
      if (!workspacePaths.includes(path)) fail('MISSING_LOCAL_PACKAGE', 'Bun workspace is not captured in the lock.', 'bun.lock');
      plan.inputs.push({ kind: 'local', name, version, path }); continue;
    }
    if (!NAME.test(name) || !VERSION.test(version)) fail('UNSUPPORTED_SOURCE', 'Bun package must resolve to an exact public registry version.', 'bun.lock');
    const archiveUrl = raw[1] || `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`;
    publicUrl(archiveUrl, ['registry.npmjs.org'], 'bun.lock');
    if (!record(raw[2])) fail('INVALID_METADATA', 'Bun package metadata must be an object.', 'bun.lock');
    for (const field of DEPENDENCY_FIELDS) dependencySpecs(raw[2][field], 'bun.lock');
    plan.inputs.push({ kind: 'public', name, version, url: archiveUrl, integrity: integrity(raw[3], 'bun.lock'), integritySource: 'lock' });
  }
  rejectConflictingLogicalArchives(plan.inputs, 'bun.lock');
  metadata(plan, 'bun.lock', lock);
  const acquisitionEnv = { BUN_INSTALL_CACHE_DIR: '/metadata/.cso-bun-cache', BUN_CONFIG_NO_CLEAR_TERMINAL: '1', BUN_FEATURE_FLAG_DISABLE_NATIVE_DEPENDENCY_LINKER: '1' };
  const offlineEnv = { ...acquisitionEnv, BUN_INSTALL_CACHE_DIR: '/work/.cso-bun-cache' };
  plan.acquisition.push(command('/usr/local/bin/bun', ['install', '--config=/opt/cso/empty-config', '--frozen-lockfile', '--ignore-scripts', '--no-progress', '--backend=hardlink', '--registry=https://registry.npmjs.org'], '/metadata', acquisitionEnv));
  // The runner enforces network-none; Bun's --offline availability is version-specific.
  plan.offline.push(command('/usr/local/bin/bun', ['install', '--config=/opt/cso/empty-config', '--frozen-lockfile', '--no-progress', '--backend=copyfile'], '/work', offlineEnv));
  plan.registryHosts = ['registry.npmjs.org'];
}

function requirementLines(text: string, plan: PreparationPlan, path: string) {
  const lines = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const hashes = [...line.matchAll(/(?:^|\s)--hash=sha256:([a-f0-9]{64})(?=\s|$)/gi)];
    const requirement = line.replace(/(?:^|\s)--hash=sha256:[a-f0-9]{64}(?=\s|$)/gi, '').trim();
    const match = requirement.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[A-Za-z0-9_,.-]+\])?==([A-Za-z0-9][A-Za-z0-9.!+_-]*)(?:\s*;\s*([A-Za-z0-9_.'" ()<>=!~+,-]+))?$/);
    if (!match || !hashes.length || requirement.includes('--')) fail('UNPINNED_REQUIREMENTS', 'Requirements must contain only exact public package pins with SHA-256 hashes; includes, URLs, editable paths, and index options are unsupported.', path);
    if (match[3]) fail('UNSUPPORTED_MARKER', 'PEP 508 environment markers require a qualified runtime-specific lock export.', path);
    plan.inputs.push({ kind: 'public', name: match[1], version: match[2], integrity: hashes.map(h => `sha256:${h[1].toLowerCase()}`).join(' '), integritySource: 'lock' });
  }
  packageCount(plan.inputs, path);
}
function toml(root: string, path: string): Record<string, any> {
  try {
    const result = Bun.TOML.parse(read(root, path)!);
    if (!record(result)) fail('INVALID_METADATA', 'Expected a TOML object.', path);
    return result;
  } catch (error) {
    if (error instanceof MetadataError) throw error;
    fail('INVALID_METADATA', 'Dependency metadata is not valid TOML.', path);
  }
}
function hasUvEnvironmentMarker(value:unknown,seen=new WeakSet<object>()):boolean{
  if(value===null||typeof value!=='object')return false;
  if(seen.has(value as object))return true;
  seen.add(value as object);
  if(Array.isArray(value))return value.some(item=>hasUvEnvironmentMarker(item,seen));
  for(const [key,item] of Object.entries(value as Record<string,unknown>)){
    if(key==='marker'||key==='resolution-markers'||key==='fork-markers')return true;
    if(hasUvEnvironmentMarker(item,seen))return true;
  }
  return false;
}
function inspectPython(root: string, plan: PreparationPlan) {
  const hasUv = read(root, 'uv.lock', true) !== undefined;
  const acquisitionEnv = { UV_NO_CONFIG: '1', UV_PYTHON_DOWNLOADS: 'never', UV_NO_MANAGED_PYTHON: '1', UV_CACHE_DIR: '/archives/uv', PIP_CONFIG_FILE: '/dev/null', PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_CACHE_DIR: '1' };
  const offlineEnv = { ...acquisitionEnv, UV_CACHE_DIR: '/work/.cso-uv-cache', UV_LINK_MODE: 'copy' };
  let requirementsPath = 'requirements.txt';
  let publicRequirements = '/metadata/requirements.txt';
  const localBuildPaths: string[] = [];
  const buildRequirements = new Set<string>();
  if (hasUv) {
    const lock = toml(root, 'uv.lock');
    if (lock.version !== 1 || !Array.isArray(lock.package)) fail('UNSUPPORTED_LOCK', 'Unsupported uv.lock schema.', 'uv.lock');
    if(hasUvEnvironmentMarker(lock))fail('UNSUPPORTED_MARKER', 'Universal uv locks with environment or resolution markers require a qualified runtime-specific export before automatic preparation.', 'uv.lock');
    packageCount(lock.package, 'uv.lock');
    for (const pkg of lock.package) {
      if (!record(pkg) || !record(pkg.source) || !NAME.test(pkg.name) || !VERSION.test(pkg.version)) fail('INVALID_METADATA', 'Invalid uv locked package.', 'uv.lock');
      if (pkg.source.registry !== undefined) {
        if (Object.keys(pkg.source).length !== 1) fail('UNSUPPORTED_SOURCE', 'Python registry entries cannot contain alternate dependency sources.', 'uv.lock');
        const registry = publicUrl(pkg.source.registry, ['pypi.org'], 'uv.lock');
        if (!['https://pypi.org/simple', 'https://pypi.org/simple/'].includes(registry)) fail('UNSUPPORTED_SOURCE', 'Python acquisition supports the public PyPI simple index only.', 'uv.lock');
        if (!Array.isArray(pkg.wheels) || !pkg.wheels.length) fail('MISSING_PUBLIC_WHEEL', 'A matching public wheel is required; source distributions are never built during acquisition.', 'uv.lock');
        for (const wheel of pkg.wheels) {
          if (!record(wheel) || typeof wheel.hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(wheel.hash)) fail('UNPINNED_ARCHIVE', 'uv wheels require SHA-256 hashes.', 'uv.lock');
          plan.inputs.push({ kind: 'public', name: pkg.name, version: pkg.version, url: publicUrl(wheel.url, ['files.pythonhosted.org'], 'uv.lock'), integrity: wheel.hash, integritySource: 'lock' });
        }
        if (pkg.sdist) {
          publicUrl(pkg.sdist.url, ['files.pythonhosted.org'], 'uv.lock');
          if (!/^sha256:[a-f0-9]{64}$/.test(pkg.sdist.hash ?? '')) fail('UNPINNED_ARCHIVE', 'uv source archive hash is invalid.', 'uv.lock');
        }
      } else {
        const local = pkg.source.editable ?? pkg.source.virtual ?? pkg.source.directory;
        if (typeof local !== 'string' || Object.keys(pkg.source).some(k => !['editable', 'virtual', 'directory'].includes(k))) fail('UNSUPPORTED_SOURCE', 'Private, VCS, and direct-URL Python sources require explicit provisioning.', 'uv.lock');
        contained(root, local);
        plan.inputs.push({ kind: 'local', name: pkg.name, version: pkg.version, path: local });
        if (pkg.source.virtual === undefined) {
          localBuildPaths.push(local);
          const pyprojectPath = local === '.' ? 'pyproject.toml' : `${local}/pyproject.toml`;
          const localProject = read(root, pyprojectPath, true) === undefined ? {} : toml(root, pyprojectPath);
          const build = localProject['build-system'];
          const requirements = build?.requires ?? ['setuptools>=40.8.0'];
          if (!Array.isArray(requirements)) fail('DYNAMIC_BUILD_DEPENDENCIES', 'Local build dependencies must be declared as static package requirements.', pyprojectPath);
          for (const requirement of requirements) {
            if (typeof requirement !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9_,.-]+\])?\s*[A-Za-z0-9.!~<>=+*, -]*$/.test(requirement)) fail('UNSUPPORTED_BUILD_DEPENDENCY', 'Local build dependencies must be public package requirements without URLs or paths.', pyprojectPath);
            buildRequirements.add(requirement.match(/^[A-Za-z0-9][A-Za-z0-9._-]*/)![0].toLowerCase().replace(/[_.]+/g, '-'));
          }
        }
      }
    }
    const project = toml(root, 'pyproject.toml');
    if (!record(project.project)) fail('UNSUPPORTED_METADATA', 'uv export requires static PEP 621 project metadata.', 'pyproject.toml');
    if (project.tool?.uv?.workspace !== undefined || plan.inputs.some(input => input.kind === 'local' && input.path !== '.'))
      fail('UNSUPPORTED_WORKSPACE', 'uv workspace/member metadata is not yet qualified for sanitized automatic preparation.', 'pyproject.toml');
    if (project.project.dynamic?.includes('dependencies')) fail('DYNAMIC_METADATA', 'Dynamic project dependencies require qualified offline build dependencies.', 'pyproject.toml');
    // Only the export process sees this metadata; no build-system or tool.uv sources/config.
    const clean: Record<string, any> = { project: project.project };
    if (project['dependency-groups']) clean['dependency-groups'] = project['dependency-groups'];
    // uv accepts a static pyproject file. Keep original syntax only after excluding every
    // non-project table would require a TOML writer; use JSON-compatible TOML literals.
    metadata(plan, 'pyproject.toml', toToml(clean), 'Acquisition pyproject omits all build backends and tool configuration; local packages are excluded by --no-emit-local.');
    metadata(plan, 'uv.lock', read(root, 'uv.lock')!);
    plan.runtimeRequirements.python = String(lock['requires-python'] ?? project.project['requires-python'] ?? '');
    requirementsPath = 'cso-public-requirements.txt';
    publicRequirements = `/archives/${requirementsPath}`;
    plan.acquisition.push(command('/usr/local/bin/uv', ['export', '--frozen', '--no-emit-local', '--all-packages', '--all-extras', '--all-groups', '--no-config', '--format', 'requirements-txt', '--output-file', publicRequirements], '/metadata', acquisitionEnv));
    plan.offline.push(command('/usr/local/bin/uv', ['export', '--offline', '--frozen', '--no-emit-local', '--all-packages', '--all-extras', '--all-groups', '--no-config', '--format', 'requirements-txt', '--output-file', '/work/.gstack-cso-public-requirements.txt'], '/metadata', offlineEnv));
    plan.offline.push(command('/usr/local/bin/python', ['-I', '-m', 'venv', '--copies', '/work/.venv'], '/work', offlineEnv));
    plan.offline.push(command('/usr/local/bin/uv', ['pip', 'install', '--offline', '--no-config', '--python', '/work/.venv/bin/python', '--link-mode', 'copy', '--no-index', '--find-links', '/archives/wheels', '--require-hashes', '--only-binary', ':all:', '--requirement', '/work/.gstack-cso-public-requirements.txt'], '/work', offlineEnv));
    if (buildRequirements.size) {
      const lines: string[] = [];
      for (const name of buildRequirements) {
        const locked = plan.inputs.filter(input => input.kind === 'public' && input.name.toLowerCase().replace(/[_.]+/g, '-') === name);
        if (!locked.length || new Set(locked.map(input => input.version)).size !== 1) fail('MISSING_BUILD_DEPENDENCY', 'Every local build dependency needs one exact public wheel version in uv.lock.', 'uv.lock');
        lines.push(`${name}==${locked[0].version} ${[...new Set(locked.map(input => input.integrity))].map(hash => `--hash=${hash}`).join(' ')}`);
      }
      metadata(plan, '.gstack-cso/build-requirements.txt', lines.join('\n') + '\n', 'Local build dependencies are acquired only as exact hashed public wheels.');
      plan.acquisition.push(command('/usr/local/bin/python', ['-I', '-m', 'pip', '--isolated', 'download', '--index-url', 'https://pypi.org/simple', '--require-hashes', '--only-binary=:all:', '--dest', '/archives/wheels', '--requirement', '/metadata/.gstack-cso/build-requirements.txt'], '/metadata', acquisitionEnv));
      plan.offline.push(command('/usr/local/bin/uv', ['pip', 'install', '--offline', '--no-config', '--python', '/work/.venv/bin/python', '--link-mode', 'copy', '--no-index', '--find-links', '/archives/wheels', '--require-hashes', '--only-binary', ':all:', '--requirement', '/metadata/.gstack-cso/build-requirements.txt'], '/work', offlineEnv));
    }
    if (localBuildPaths.length) plan.offline.push(command('/usr/local/bin/uv', ['pip', 'install', '--offline', '--no-config', '--python', '/work/.venv/bin/python', '--link-mode', 'copy', '--no-index', '--find-links', '/archives/wheels', '--no-deps', '--no-build-isolation', ...localBuildPaths.map(path => `/work/${path}`)], '/work', offlineEnv));
    plan.offline.push(command('/usr/local/bin/uv', ['pip', 'check', '--offline', '--no-config', '--python', '/work/.venv/bin/python'], '/work', offlineEnv));
  } else {
    const contents = read(root, requirementsPath)!;
    requirementLines(contents, plan, requirementsPath);
    metadata(plan, requirementsPath, contents);
    plan.offline.push(command('/usr/local/bin/python', ['-I', '-m', 'venv', '--copies', '/work/.venv'], '/work', offlineEnv));
    plan.offline.push(command('/work/.venv/bin/python', ['-I', '-m', 'pip', '--isolated', 'install', '--no-index', '--find-links', '/archives/wheels', '--require-hashes', '--only-binary=:all:', '--requirement', '/work/requirements.txt'], '/work', offlineEnv));
    plan.offline.push(command('/work/.venv/bin/python', ['-I', '-m', 'pip', '--isolated', 'check'], '/work', offlineEnv));
  }
  plan.acquisition.push(command('/usr/local/bin/python', ['-I', '-m', 'pip', '--isolated', 'download', '--index-url', 'https://pypi.org/simple', '--require-hashes', '--only-binary=:all:', '--dest', '/archives/wheels', '--requirement', publicRequirements], '/metadata', acquisitionEnv));
  plan.registryHosts = ['pypi.org', 'files.pythonhosted.org'];
}
function toToml(value: Record<string, any>): string {
  const literal = (x: any): string => {
    if (typeof x === 'string' || typeof x === 'boolean' || typeof x === 'number') return JSON.stringify(x);
    if (Array.isArray(x)) return `[${x.map(literal).join(', ')}]`;
    if (record(x)) return `{ ${Object.entries(x).map(([k, v]) => `${JSON.stringify(k)} = ${literal(v)}`).join(', ')} }`;
    fail('INVALID_METADATA', 'Unsupported TOML metadata value.', 'pyproject.toml');
  };
  return Object.entries(value).map(([key, val]) => `${JSON.stringify(key)} = ${literal(val)}`).join('\n') + '\n';
}

function inspectRails(root: string, plan: PreparationPlan) {
  const contents = read(root, 'Gemfile.lock')!;
  read(root, 'Gemfile'); // Presence only; never parse/evaluate Ruby during acquisition.
  let section = '', sawPublicRemote = false;
  const checksums = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    if (/^[A-Z][A-Z ]+$/.test(line)) {
      section = line;
      if (!['GEM', 'PLATFORMS', 'DEPENDENCIES', 'RUBY VERSION', 'BUNDLED WITH', 'CHECKSUMS'].includes(section)) fail('UNSUPPORTED_SOURCE', 'Gemfile.lock contains a non-public source or unsupported section.', 'Gemfile.lock');
      continue;
    }
    if (!line.trim()) continue;
    if (section === 'GEM' && line.startsWith('  remote: ')) {
      const remote = publicUrl(line.slice(10), ['rubygems.org'], 'Gemfile.lock');
      if (remote !== 'https://rubygems.org/') fail('UNSUPPORTED_SOURCE', 'Ruby acquisition supports the public RubyGems root only.', 'Gemfile.lock');
      sawPublicRemote = true;
    } else if (section === 'GEM' && /^    \S/.test(line)) {
      const match = line.match(/^    ([A-Za-z0-9][A-Za-z0-9_.-]*) \(([0-9]+(?:\.[0-9A-Za-z]+)*)(?:-([A-Za-z0-9][A-Za-z0-9_.-]*))?\)$/);
      if (!match) fail('INVALID_METADATA', 'Invalid exact Ruby gem lock entry.', 'Gemfile.lock');
      plan.inputs.push({ kind: 'public', name: match[1], version: match[2], platform: match[3] || 'ruby', integritySource: 'registry-on-acquisition' });
    } else if (section === 'CHECKSUMS') {
      const match = line.match(/^  ([A-Za-z0-9][A-Za-z0-9_.-]*) \(([^)]+)\) sha256=([a-f0-9]{64})$/);
      if (!match) fail('INVALID_METADATA', 'Unsupported RubyGems checksum entry.', 'Gemfile.lock');
      checksums.set(`${match[1]}@${match[2]}`, `sha256:${match[3]}`);
    } else if (section === 'RUBY VERSION') {
      const match = line.trim().match(/^ruby ([0-9]+\.[0-9]+\.[0-9]+)(?:p[0-9]+)?$/);
      if (!match) fail('UNSUPPORTED_RUNTIME', 'Unsupported Ruby runtime declaration.', 'Gemfile.lock');
      plan.runtimeRequirements.ruby = match[1];
    } else if (section === 'BUNDLED WITH') {
      const version = line.trim();
      if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) fail('UNSUPPORTED_RUNTIME', 'Bundler must be pinned to an exact version.', 'Gemfile.lock');
      plan.runtimeRequirements.bundler = version;
    }
  }
  if (!sawPublicRemote) fail('UNSUPPORTED_SOURCE', 'Gemfile.lock needs an explicit public RubyGems source.', 'Gemfile.lock');
  if (!plan.runtimeRequirements.bundler) fail('UNSUPPORTED_RUNTIME', 'Gemfile.lock must record BUNDLED WITH.', 'Gemfile.lock');
  packageCount(plan.inputs, 'Gemfile.lock');
  for (const input of plan.inputs) {
    const key = `${input.name}@${input.version}${input.platform === 'ruby' ? '' : `-${input.platform}`}`;
    const hash = checksums.get(key);
    if (hash) { input.integrity = hash; input.integritySource = 'lock'; }
    // gem fetch downloads without evaluating a Gemfile/gemspec or building extensions.
    plan.acquisition.push(command('/usr/local/bin/gem', ['fetch', input.name, '--version', input.version, '--platform', input.platform!, '--clear-sources', '--source', 'https://rubygems.org', '--norc'], '/archives'));
  }
  metadata(plan, 'Gemfile.lock', contents);
  const env = { RAILS_ENV: 'test', RACK_ENV: 'test', SECRET_KEY_BASE: 'cso-synthetic-test-key-never-a-production-credential', BUNDLE_PATH: '/work/vendor/bundle', BUNDLE_FROZEN: 'true', BUNDLE_DEPLOYMENT: 'true', BUNDLE_DISABLE_SHARED_GEMS: 'true', BUNDLE_IGNORE_CONFIG: 'true', BUNDLE_ALLOW_OFFLINE_INSTALL: 'true', BUNDLE_CACHE_PATH: '/archives', BUNDLE_USER_HOME: '/work/.cso-bundle' };
  plan.offline.push(command('/usr/local/bin/bundle', ['install', '--local', '--jobs', '2', '--retry', '0'], '/work', env));
  plan.registryHosts = ['rubygems.org', 'index.rubygems.org'];
  const declared = railsDatabaseConfiguration(read(root, 'config/database.yml', true));
  const supported: Array<'sqlite' | 'postgresql'> = [];
  if (plan.inputs.some(input => input.name === 'sqlite3')) supported.push('sqlite');
  if (plan.inputs.some(input => input.name === 'pg')) supported.push('postgresql');
  if (!supported.length) fail('MISSING_DATABASE_ADAPTER', 'Rails automatic preparation requires a locked sqlite3 or pg adapter.', 'Gemfile.lock');
  const declaredSupported = [...declared.adapters].filter(adapter => supported.includes(adapter));
  const selected = supported.length === 1 ? supported[0] : declaredSupported.length === 1 ? declaredSupported[0] : null;
  plan.database = { supported, selected, connections: declared.connections, requiresSyntheticConfiguration: true };
}

function railsDatabaseConfiguration(contents: string | undefined): { connections: string[]; adapters: Set<'sqlite' | 'postgresql'> } {
  if (contents === undefined) return { connections: ['primary'], adapters: new Set() };
  if (contents.includes('\t')) fail('DYNAMIC_DATABASE_CONFIG', 'Database configuration must use spaces for bounded inert parsing.', 'config/database.yml');
  // ERB is never evaluated. It may supply scalar values, but dynamic YAML structure is unsupported.
  let safe = contents.replace(/<%=[\s\S]*?%>/g, 'CSO_REDACTED_ERB');
  if (safe.includes('<%')) fail('DYNAMIC_DATABASE_CONFIG', 'Database configuration uses structural ERB; supply explicit synthetic connection names.', 'config/database.yml');
  // Stock Rails uses one inert `default` anchor. Remove only that exact merge
  // syntax before parsing so the YAML implementation never expands aliases.
  safe = safe.split(/\r?\n/).map(line => {
    if (/^default:\s*&default\s*(?:#.*)?$/.test(line)) return 'default:';
    if (/^\s+<<:\s*\*default\s*(?:#.*)?$/.test(line)) return line.replace(/<<:[\s\S]*$/, '# cso: inert default merge');
    return line;
  }).join('\n');
  if (/(^|[\s\[{,])(?:[&*][A-Za-z0-9_-]+|!\S+)/m.test(safe))
    fail('DYNAMIC_DATABASE_CONFIG', 'Only the stock Rails default anchor and merge are accepted by the trusted readiness parser.', 'config/database.yml');
  let parsed: any;
  try { parsed = Bun.YAML.parse(safe); } catch { fail('DYNAMIC_DATABASE_CONFIG', 'Database connection names could not be read without evaluating ERB.', 'config/database.yml'); }
  if (!record(parsed)) fail('INVALID_DATABASE_CONFIG', 'Database configuration must be a mapping.', 'config/database.yml');
  const connections = new Set<string>(), adapters = new Set<'sqlite' | 'postgresql'>();
  const recordAdapter = (config: Record<string, any>) => {
    if (config.adapter === 'sqlite3') adapters.add('sqlite');
    if (config.adapter === 'postgresql' || config.adapter === 'postgres') adapters.add('postgresql');
  };
  for (const [environment, config] of Object.entries(parsed)) {
    if (!record(config)) continue;
    recordAdapter(config);
    if (environment === 'default') continue;
    if ('adapter' in config || 'url' in config || 'database' in config) { connections.add('primary'); continue; }
    for (const [name, connection] of Object.entries(config)) {
      if (!connectionName(name) || name.includes('CSO_REDACTED_ERB') || !record(connection)) fail('DYNAMIC_DATABASE_CONFIG', 'Database connection names must be static identifiers.', 'config/database.yml');
      recordAdapter(connection);
      connections.add(name);
    }
  }
  return { connections: connections.size ? [...connections].sort() : ['primary'], adapters };
}

/** Synthetic files are declared execution transformations; a boundary-changing target is blocked by the runner. */
export function railsTestConfiguration(connections: string[], adapter: 'sqlite' | 'postgresql'): Array<{ path: string; content: string }> {
  if (!connections.length || connections.some(name => !connectionName(name))) throw new Error('Invalid Rails connection names');
  const database: Record<string, any> = { test: {} };
  for (const name of connections) database.test[name] = adapter === 'sqlite'
    ? { adapter: 'sqlite3', database: `/work/tmp/cso-${name}.sqlite3`, pool: 3 }
    : { adapter: 'postgresql', host: '127.0.0.1', port: 5432, username: 'cso', password: 'cso-disposable-test', database: `cso_${name}`, pool: 3 };
  return [
    // JSON is valid YAML; no interpolation, anchors, inherited URLs, or production connections.
    { path: 'config/database.yml', content: JSON.stringify(database, null, 2) + '\n' },
    { path: 'config/initializers/zzzz_cso_test.rb', content: `# Trusted synthetic test environment; recorded in the transformation manifest.\nraise "CSO requires test environment" unless Rails.env.test?\nRails.application.config.secret_key_base = ENV.fetch("SECRET_KEY_BASE")\nRails.application.config.active_storage.service = :cso_test if defined?(ActiveStorage)\nRails.application.config.active_job.queue_adapter = :test if defined?(ActiveJob)\nRails.application.config.action_mailer.delivery_method = :test if defined?(ActionMailer)\nRails.application.config.action_mailer.perform_deliveries = false if defined?(ActionMailer)\nRails.application.config.after_initialize do\n  ActiveJob::Base.queue_adapter = :test if defined?(ActiveJob::Base)\n  ActionMailer::Base.delivery_method = :test if defined?(ActionMailer::Base)\nend\n` },
    { path: 'config/storage.yml', content: JSON.stringify({ cso_test: { service: 'Disk', root: '/work/tmp/cso-storage' } }, null, 2) + '\n' },
  ];
}

export function inspectPreparation(snapshotPath: string, stack?: CsoStack): PreparationPlan {
  const root = resolve(snapshotPath);
  const plan: PreparationPlan = { schemaVersion: 1, stack: stack ?? 'python', status: 'ready', prerequisites: [], metadata: [], inputs: [], acquisition: [], offline: [], registryHosts: [], runtimeProfile: stack ?? 'python', runtimeRequirements: {}, transformations: [] };
  try {
    const detectedStacks:CsoStack[]=[];
    const hasBun=read(root,'bun.lock',true)!==undefined||read(root,'bun.lockb',true)!==undefined;if(hasBun)detectedStacks.push('bun');
    if(read(root,'package-lock.json',true)!==undefined||read(root,'npm-shrinkwrap.json',true)!==undefined||(!hasBun&&read(root,'package.json',true)!==undefined))detectedStacks.push('node');
    if(read(root,'Gemfile.lock',true)!==undefined||read(root,'Gemfile',true)!==undefined)detectedStacks.push('rails');
    if(read(root,'uv.lock',true)!==undefined||read(root,'requirements.txt',true)!==undefined||read(root,'pyproject.toml',true)!==undefined)detectedStacks.push('python');
    if(!stack&&detectedStacks.length>1)fail('MULTIPLE_STACKS',`Multiple executable stacks were detected (${detectedStacks.join(', ')}); verification must select a matching qualified runtime.`);
    const detected = stack ?? detectedStacks[0] ?? 'python';
    plan.stack = detected; plan.runtimeProfile = detected;
    if (!['node', 'bun', 'python', 'rails'].includes(detected)) fail('UNSUPPORTED_STACK', 'Supported runtime stacks are Node, Bun, Python, and Rails.');
    ({ node: inspectNode, bun: inspectBun, python: inspectPython, rails: inspectRails }[detected])(root, plan);
  } catch (error) {
    plan.status = 'prerequisites';
    plan.prerequisites.push(error instanceof MetadataError
      ? { code: error.code, message: error.message, path: error.path }
      : { code: 'INVALID_METADATA', message: 'Dependency metadata could not be inspected safely.' });
    // Never execute a partially validated acquisition plan.
    plan.acquisition = []; plan.offline = []; plan.metadata = [];
  }
  return plan;
}
