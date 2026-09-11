import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalProviderRemote, type ProviderRemote } from './provider-access';
import { applyGitInsteadOf, resolveStaticSshHostname } from './git-transport-policy';

export interface ProjectIdentity {
  schema_version: 1;
  repo_id: string;
  write_slug: string;
  read_slugs: string[];
  raw_branch: string;
  write_branch: string;
  read_branches: string[];
  head_sha?: string;
  provider?: {
    kind: 'github';
    host: string;
    name_with_owner: string;
  };
}

export interface RemoteResolutionOptions {
  insteadOf?: Array<{ prefix: string; replacement: string }>;
  sshConfig?: string;
}

export interface CanonicalRepositoryIdentity {
  repo_id: string;
  remote: ProviderRemote;
  name_with_owner: string;
}

interface RegistryEntry {
  id: string;
  path: string;
  kind: string;
  active?: boolean;
  aliases?: string[];
  remote_required?: boolean;
  trusted_base_ref?: string;
}

interface LoadedRegistry {
  root: string;
  path: string;
  entries: RegistryEntry[];
}

export interface WorkspaceGovernanceLocation {
  code_root: string;
  workspace_root: string;
  common_directory: string;
  registry_path: string;
}

export interface ProjectIdentityOptions {
  mode?: 'legacy' | 'profile';
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function git(cwd: string, args: string[]): string | undefined {
  const result = spawnSync('/usr/bin/git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
    env: { PATH: '/usr/bin:/bin', HOME: os.homedir(), LC_ALL: 'C' },
  });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

export function encodeIdentityComponent(value: string): string {
  let encoded = '';
  for (const byte of new TextEncoder().encode(value)) {
    const literal =
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      byte === 0x2e ||
      byte === 0x5f;
    encoded += literal ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  if (!encoded) throw new Error('project_identity_component_empty');
  return encoded;
}

export function canonicalizeRepositoryRemote(
  raw: string,
  options: RemoteResolutionOptions = {},
): CanonicalRepositoryIdentity {
  if (/^(?:file|git|ext)::?/i.test(raw) || /^[A-Za-z][A-Za-z0-9+.-]*::/.test(raw)) {
    throw new Error('git_transport_unsupported');
  }
  let resolved = applyGitInsteadOf(raw, options.insteadOf ?? []);
  const scp = resolved.match(/^([^@]+)@([^:]+):(.+)$/);
  if (scp && scp[2].toLowerCase() !== 'github.com') {
    const hostname = resolveStaticSshHostname(scp[2], options.sshConfig ?? '');
    if (!hostname) throw new Error('git_ssh_alias_unresolved');
    resolved = `${scp[1]}@${hostname}:${scp[3]}`;
  }
  const remote = canonicalProviderRemote(resolved);
  if (remote.host !== 'github.com') throw new Error('provider_remote_unsupported');
  return {
    repo_id: remote.comparisonKey,
    remote,
    name_with_owner: `${remote.owner}/${remote.repository}`,
  };
}

function trustedSshConfig(): string {
  const candidate = path.join(os.homedir(), '.ssh', 'config');
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.geteuid() || (stat.mode & 0o022) !== 0) {
      throw new Error('git_ssh_config_untrusted');
    }
    return fs.readFileSync(candidate, 'utf8');
  } catch (error) {
    if (error instanceof Error && error.message === 'git_ssh_config_untrusted') throw error;
    return '';
  }
}

function insteadOfRules(cwd: string): Array<{ prefix: string; replacement: string }> {
  const output = git(cwd, ['config', '--local', '--get-regexp', '^url\\..*\\.insteadof$']) ?? '';
  const rules: Array<{ prefix: string; replacement: string }> = [];
  for (const line of output.split('\n')) {
    const separator = line.indexOf(' ');
    if (separator < 0) continue;
    const key = line.slice(0, separator);
    const prefix = line.slice(separator + 1).trim();
    const match = key.match(/^url\.(.+)\.insteadof$/i);
    if (match && prefix) rules.push({ prefix, replacement: match[1] });
  }
  return rules;
}

function registryCandidates(cwd: string, repositoryRoot: string): string[] {
  const starts = unique([path.resolve(cwd), path.resolve(repositoryRoot)]);
  const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common) starts.push(path.resolve(common, '..'));
  const candidates: string[] = [];
  for (const start of starts) {
    let current = start;
    while (true) {
      candidates.push(path.join(current, 'config', 'workspace-registry.toml'));
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return unique(candidates);
}

function loadRegistry(cwd: string, repositoryRoot: string): LoadedRegistry | undefined {
  const registryPath = registryCandidates(cwd, repositoryRoot).find((candidate) => fs.existsSync(candidate));
  if (!registryPath) return undefined;
  const parsed = Bun.TOML.parse(fs.readFileSync(registryPath, 'utf8')) as {
    registry?: { version?: unknown };
    entry?: RegistryEntry[];
  };
  if (parsed.registry?.version !== 2 || !Array.isArray(parsed.entry)) throw new Error('workspace_registry_invalid');
  const claimed = new Map<string, string>();
  for (const entry of parsed.entry) {
    if (!entry.id || !entry.path || !entry.kind) throw new Error('workspace_registry_invalid');
    for (const name of [entry.id, ...(entry.aliases ?? [])]) {
      const previous = claimed.get(name);
      if (previous && previous !== entry.id) throw new Error('workspace_registry_alias_collision');
      claimed.set(name, entry.id);
    }
  }
  return { root: path.dirname(path.dirname(registryPath)), path: registryPath, entries: parsed.entry };
}

export function resolveWorkspaceGovernanceLocation(startCwd = process.cwd()): WorkspaceGovernanceLocation {
  const absolute = fs.realpathSync(path.resolve(startCwd));
  const repositoryRoot = git(absolute, ['rev-parse', '--show-toplevel']);
  if (!repositoryRoot) throw new Error('project_identity_git_root_missing');
  const registry = loadRegistry(absolute, repositoryRoot);
  if (!registry) throw new Error('workspace_registry_missing');
  const codeRoot = fs.realpathSync(registry.root);
  const codeGitRoot = git(codeRoot, ['rev-parse', '--show-toplevel']);
  const common = git(codeRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!codeGitRoot || fs.realpathSync(codeGitRoot) !== codeRoot || !common) throw new Error('workspace_governance_root_invalid');
  const commonDirectory = fs.realpathSync(common);
  const workspaceRoot = fs.realpathSync(path.dirname(commonDirectory));
  const primaryCommon = git(workspaceRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!primaryCommon || fs.realpathSync(primaryCommon) !== commonDirectory) throw new Error('workspace_governance_common_dir_mismatch');
  const registryPath = fs.realpathSync(registry.path);
  if (registryPath !== path.join(codeRoot, 'config', 'workspace-registry.toml')) throw new Error('workspace_registry_location_invalid');
  return { code_root: codeRoot, workspace_root: workspaceRoot, common_directory: commonDirectory, registry_path: registryPath };
}

function canonicalEntryTarget(registry: LoadedRegistry, entry: RegistryEntry): string | undefined {
  const candidate = path.resolve(registry.root, entry.path);
  try { return fs.realpathSync(candidate); } catch { return undefined; }
}

function registeredEntry(cwd: string, registry: LoadedRegistry): RegistryEntry | undefined {
  const realCwd = fs.realpathSync(cwd);
  const matches = registry.entries
    .filter((entry) => entry.active !== false)
    .map((entry) => ({ entry, target: canonicalEntryTarget(registry, entry) }))
    .filter((value): value is { entry: RegistryEntry; target: string } => Boolean(value.target))
    .filter(({ target }) => realCwd === target || realCwd.startsWith(`${target}${path.sep}`))
    .sort((a, b) => b.target.length - a.target.length);
  if (matches.length > 1 && matches[0].target.length === matches[1].target.length) {
    throw new Error('workspace_registry_ambiguous');
  }
  return matches[0]?.entry;
}

function localIdentity(
  cwd: string,
  repositoryRoot: string,
  registry: LoadedRegistry | undefined,
  mode: 'legacy' | 'profile',
): { repoId: string; aliases: string[] } {
  if (registry) {
    const entry = registeredEntry(cwd, registry);
    if (entry) return { repoId: entry.id, aliases: entry.aliases ?? [] };
  }
  if (mode === 'profile') throw new Error('local_project_registry_missing');
  return { repoId: path.basename(repositoryRoot), aliases: [] };
}

function legacyRemoteSlugs(raw: string): string[] {
  const scp = raw.match(/^[^@]+@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/);
  if (!scp) return [];
  const owner = scp[1];
  const repository = scp[2].replace(/\.git$/, '');
  return unique([`${owner}-${repository}`, repository, `${owner}-${repository}`.toLowerCase(), repository.toLowerCase()]);
}

export function resolveProjectIdentity(cwd: string, options: ProjectIdentityOptions = {}): ProjectIdentity {
  const mode = options.mode ?? 'legacy';
  const absolute = fs.realpathSync(path.resolve(cwd));
  const repositoryRoot = git(absolute, ['rev-parse', '--show-toplevel']);
  if (!repositoryRoot) throw new Error('project_identity_git_root_missing');
  const rawBranch = git(absolute, ['branch', '--show-current']) || 'detached';
  const headSha = git(absolute, ['rev-parse', 'HEAD']);
  const registry = loadRegistry(absolute, repositoryRoot);
  const entry = registry && registeredEntry(absolute, registry);
  const remoteRaw = git(absolute, ['remote', 'get-url', 'origin']);

  if (remoteRaw && entry?.kind !== 'root-managed-project' && !path.isAbsolute(remoteRaw) && !remoteRaw.startsWith('file:')) {
    let canonical: CanonicalRepositoryIdentity;
    try {
      canonical = canonicalizeRepositoryRemote(remoteRaw, {
        insteadOf: insteadOfRules(absolute),
        sshConfig: trustedSshConfig(),
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'git_ssh_alias_unresolved' || mode === 'profile') throw error;
      const local = localIdentity(absolute, repositoryRoot, registry, mode);
      return {
        schema_version: 1,
        repo_id: local.repoId,
        write_slug: encodeIdentityComponent(local.repoId),
        read_slugs: unique([encodeIdentityComponent(local.repoId), local.repoId, ...legacyRemoteSlugs(remoteRaw), ...local.aliases]),
        raw_branch: rawBranch,
        write_branch: encodeURIComponent(rawBranch),
        read_branches: unique([encodeURIComponent(rawBranch), rawBranch.replaceAll('/', '-'), rawBranch.replaceAll('/', '')]),
        ...(headSha ? { head_sha: headSha } : {}),
      };
    }
    const components = canonical.repo_id.split('/');
    const legacy = [
      `${canonical.remote.owner}-${canonical.remote.repository}`,
      canonical.remote.repository,
      `${canonical.remote.owner}-${canonical.remote.repository}`.toLowerCase(),
      canonical.remote.repository.toLowerCase(),
      ...(entry?.aliases ?? []),
    ];
    return {
      schema_version: 1,
      repo_id: canonical.repo_id,
      write_slug: components.map(encodeIdentityComponent).join('--'),
      read_slugs: unique([components.map(encodeIdentityComponent).join('--'), ...legacy]),
      raw_branch: rawBranch,
      write_branch: encodeURIComponent(rawBranch),
      read_branches: unique([encodeURIComponent(rawBranch), rawBranch.replaceAll('/', '-'), rawBranch.replaceAll('/', '')]),
      ...(headSha ? { head_sha: headSha } : {}),
      provider: { kind: 'github', host: canonical.remote.host, name_with_owner: canonical.name_with_owner },
    };
  }

  const local = localIdentity(absolute, repositoryRoot, registry, mode);
  return {
    schema_version: 1,
    repo_id: local.repoId,
    write_slug: encodeIdentityComponent(local.repoId),
    read_slugs: unique([encodeIdentityComponent(local.repoId), local.repoId, ...local.aliases]),
    raw_branch: rawBranch,
    write_branch: encodeURIComponent(rawBranch),
    read_branches: unique([encodeURIComponent(rawBranch), rawBranch.replaceAll('/', '-'), rawBranch.replaceAll('/', '')]),
    ...(headSha ? { head_sha: headSha } : {}),
  };
}

export function resolveRegisteredProjectIdentity(registryId: string, startCwd = process.cwd()): ProjectIdentity {
  const absolute = fs.realpathSync(path.resolve(startCwd));
  const repositoryRoot = git(absolute, ['rev-parse', '--show-toplevel']);
  if (!repositoryRoot) throw new Error('project_identity_git_root_missing');
  const registry = loadRegistry(absolute, repositoryRoot);
  if (!registry) throw new Error('workspace_registry_missing');
  const entry = registry.entries.find((candidate) => candidate.active !== false && candidate.id === registryId);
  if (!entry) throw new Error('registered_project_identity_missing');
  const target = canonicalEntryTarget(registry, entry);
  if (!target) throw new Error('registered_project_identity_missing');
  const identity = resolveProjectIdentity(target, { mode: 'profile' });
  if (identity.repo_id !== entry.id) throw new Error('registered_project_identity_mismatch');
  return identity;
}

export function resolveRegisteredProjectLocation(registryId: string, startCwd = process.cwd()): { root: string; identity: ProjectIdentity } {
  const absolute = fs.realpathSync(path.resolve(startCwd));
  const repositoryRoot = git(absolute, ['rev-parse', '--show-toplevel']);
  if (!repositoryRoot) throw new Error('project_identity_git_root_missing');
  const registry = loadRegistry(absolute, repositoryRoot);
  if (!registry) throw new Error('workspace_registry_missing');
  const entry = registry.entries.find((candidate) => candidate.active !== false && candidate.id === registryId);
  if (!entry) throw new Error('registered_project_identity_missing');
  const target = canonicalEntryTarget(registry, entry);
  if (!target) throw new Error('registered_project_identity_missing');
  const identity = resolveProjectIdentity(target, { mode: 'profile' });
  if (identity.repo_id !== entry.id) throw new Error('registered_project_identity_mismatch');
  return { root: target, identity };
}

export function resolveTrustedLocalBase(cwd: string, assertTargetSha?: string): {
  registry_id: string;
  trusted_base_ref: string;
  target_sha: string;
} {
  const absolute = fs.realpathSync(path.resolve(cwd));
  const repositoryRoot = git(absolute, ['rev-parse', '--show-toplevel']);
  if (!repositoryRoot) throw new Error('project_identity_git_root_missing');
  const registry = loadRegistry(absolute, repositoryRoot);
  const entry = registry && registeredEntry(absolute, registry);
  if (!entry) throw new Error('local_project_registry_missing');
  if (!['repository', 'docs-repository'].includes(entry.kind) || entry.remote_required !== false) {
    throw new Error('local_trusted_base_ineligible');
  }
  const trustedRef = entry.trusted_base_ref;
  if (!trustedRef) throw new Error('local_trusted_base_unconfigured');
  if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(trustedRef) || trustedRef.includes('..') || trustedRef.includes('//') || trustedRef.endsWith('/') || trustedRef.endsWith('.lock')) {
    throw new Error('local_trusted_base_invalid');
  }
  const commonDir = git(absolute, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!commonDir) throw new Error('local_trusted_base_common_dir_missing');
  let commonStat: fs.Stats;
  try { commonStat = fs.lstatSync(commonDir); } catch { throw new Error('local_trusted_base_common_dir_missing'); }
  if (!commonStat.isDirectory() || commonStat.isSymbolicLink()) throw new Error('local_trusted_base_common_dir_mismatch');
  const targetSha = git(absolute, ['rev-parse', '--verify', `${trustedRef}^{commit}`]);
  if (!targetSha || !/^[0-9a-f]{40}$/i.test(targetSha)) throw new Error('local_trusted_base_missing');
  if (assertTargetSha !== undefined && (!/^[0-9a-f]{40}$/i.test(assertTargetSha) || assertTargetSha.toLowerCase() !== targetSha.toLowerCase())) {
    throw new Error('local_trusted_base_target_mismatch');
  }
  return { registry_id: entry.id, trusted_base_ref: trustedRef, target_sha: targetSha.toLowerCase() };
}

export function ledgerCandidates(
  identity: ProjectIdentity,
  kind: 'reviews' | 'evidence' | 'timeline',
  gstackHome: string,
): string[] {
  const projects = path.resolve(gstackHome, 'projects');
  if (kind === 'timeline') return identity.read_slugs.map((slug) => path.join(projects, slug, 'timeline.jsonl'));
  const suffix = kind === 'reviews' ? 'reviews' : 'evidence';
  return identity.read_slugs.flatMap((slug) =>
    identity.read_branches.map((branch) => path.join(projects, slug, `${branch}-${suffix}.jsonl`)),
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function readJsonlUnion<T>(paths: string[]): T[] {
  const rows: T[] = [];
  const seen = new Set<string>();
  for (const candidate of unique(paths)) {
    let content: string;
    try { content = fs.readFileSync(candidate, 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as T & { run_id?: unknown };
        const key = typeof value.run_id === 'string' && value.run_id
          ? `run:${value.run_id}`
          : `legacy:${new Bun.CryptoHasher('sha256').update(canonicalJson(value)).digest('hex')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(value);
      } catch {
        // Corrupt legacy rows are ignored, never rewritten.
      }
    }
  }
  return rows.sort((a, b) => {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    return String(left.timestamp ?? left.ts ?? '').localeCompare(String(right.timestamp ?? right.ts ?? ''));
  });
}
