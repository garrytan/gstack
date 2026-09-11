import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalGithubRemote } from './release-queue';
import { extractReleaseProjection, resolveReleasePolicy, type ReleaseProjection, type ReleaseMetadataDecision, type LegacySkippedLockfile } from './release-policy';
import { npmVersion, parseVersion } from './version-source';
import type { ResolvedWorkProfile } from './trusted-base';

const SEED = '.gstack/work-profile.yaml';
const SEED_PATHS = new Set(['.gitignore', SEED, 'docs/LOCAL_DEVELOPMENT.md', 'docs/00_START_HERE.md']);
const OVERLAYS = ['VERSION', 'pyproject.toml', 'CHANGELOG.md'];
function git(root: string, args: string[], missing = false): Buffer | null {
  const child = spawnSync('/usr/bin/git', args, { cwd: root, encoding: 'buffer', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' } });
  if (child.status !== 0) { if (missing) return null; throw new Error('release_legacy_resolution_failed'); }
  return child.stdout;
}
function read(root: string, file: string): Buffer {
  if (path.isAbsolute(file) || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new Error('release_projection_path_invalid');
  let cursor = root;
  for (const part of file.split('/')) { cursor = path.join(cursor, part); if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('release_projection_file_invalid'); }
  if (!fs.lstatSync(cursor).isFile()) throw new Error('release_projection_file_invalid');
  return fs.readFileSync(cursor);
}
function pin(root: string, name: string, fallback: string): string {
  const file = `.gstack/${name}`;
  return fs.existsSync(path.join(root, file)) ? read(root, file).toString('utf8').split('\n')[0].trim() || fallback : fallback;
}

/** Inspect link metadata only: never resolve or open a skipped lock's target. */
export function inspectSkippedLegacyLockfile(root: string, file: string): LegacySkippedLockfile | null {
  if (path.isAbsolute(file) || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') || !['package-lock.json', 'npm-shrinkwrap.json'].includes(path.posix.basename(file))) throw new Error('release_projection_path_invalid');
  let cursor = root;
  for (const part of file.split('/').slice(0, -1)) {
    cursor = path.join(cursor, part);
    let parent: fs.Stats;
    try { parent = fs.lstatSync(cursor); } catch (error: any) { if (error?.code === 'ENOENT') return null; throw error; }
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('release_projection_file_invalid');
  }
  const target = path.join(root, file);
  let info: fs.Stats;
  try { info = fs.lstatSync(target); } catch (error: any) { if (error?.code === 'ENOENT') return null; throw error; }
  if (!info.isSymbolicLink()) return null;
  return { path: file, link_text: fs.readlinkSync(target), dev: info.dev, ino: info.ino, mode: info.mode, uid: info.uid, gid: info.gid,
    size: info.size, mtime_ms: info.mtimeMs, ctime_ms: info.ctimeMs };
}

/** The candidate supplies a seed, never policy or additional metadata paths. */
export function isPortfolioOpsSeedCandidate(root: string, profile: ResolvedWorkProfile): boolean {
  if (profile.mode !== 'legacy' || !fs.existsSync(path.join(root, SEED))) return false;
  try { return canonicalGithubRemote(root).selector.toLowerCase() === 'github.com/konghak/portfolioops'; } catch { return false; }
}
export function portfolioOpsBootstrap(root: string, profile: ResolvedWorkProfile, before: Map<string, Buffer> = new Map(), ownedAfter: Map<string, Buffer> = new Map()): boolean {
  if (!isPortfolioOpsSeedCandidate(root, profile)) return false;
  const base = profile.trusted_merge_base_sha;
  if (git(root, ['ls-tree', base, '--', SEED])!.length) throw new Error('release_bootstrap_seed_invalid');
  read(root, SEED);
  const staged = git(root, ['diff', '--cached', '--no-renames', '--name-only', '-z', base])!.toString().split('\0').filter(Boolean);
  const index = git(root, ['ls-files', '--stage', '-z'])!.toString().split('\0').filter(Boolean);
  // The index is an independent candidate surface. A restored worktree must
  // never hide a forbidden staged path, executable bit, or distinct blob.
  for (const file of staged) {
    if (!SEED_PATHS.has(file) && !OVERLAYS.includes(file)) throw new Error('release_bootstrap_index_forbidden');
    const entries = index.filter(row => row.slice(row.indexOf('\t') + 1) === file);
    if (entries.length !== 1) throw new Error('release_bootstrap_index_forbidden');
    const entry = /^100644 ([0-9a-f]{40,64}) 0\t/.exec(entries[0]);
    if (!entry) throw new Error('release_bootstrap_index_forbidden');
    const content = git(root, ['cat-file', 'blob', entry[1]])!;
    if (OVERLAYS.includes(file)) {
      const original = git(root, ['show', `${base}:${file}`], true);
      const expected = ownedAfter.get(file);
      if (!original || (!content.equals(original) && (!expected || !content.equals(expected)))) throw new Error('release_bootstrap_index_overlay_unowned');
    }
  }
  const changed = new Set([
    ...git(root, ['diff', '--name-only', '-z', base])!.toString().split('\0'),
    ...git(root, ['ls-files', '--others', '--exclude-standard', '-z'])!.toString().split('\0'),
  ].filter(Boolean));
  // The seed may be intentionally unignored only by its accompanying .gitignore.
  changed.add(SEED);
  for (const file of changed) {
    if (!SEED_PATHS.has(file) && !OVERLAYS.includes(file)) throw new Error('release_bootstrap_diff_forbidden');
    const current = read(root, file), info = fs.lstatSync(path.join(root, file));
    if ((info.mode & 0o111) !== 0) throw new Error('release_bootstrap_diff_forbidden');
    if (OVERLAYS.includes(file)) {
      const original = git(root, ['show', `${base}:${file}`], true);
      if (!original || !(before.get(file) ?? current).equals(original)) throw new Error('release_bootstrap_overlay_unowned');
    }
  }
  // Existing metadata is mandatory; current TOML must exactly agree with base
  // before any allocation. Recovery substitutes only the durable owner's bytes.
  for (const file of ['VERSION', 'pyproject.toml']) {
    const original = git(root, ['show', `${base}:${file}`], true);
    if (!original || !(before.get(file) ?? read(root, file)).equals(original)) throw new Error('release_bootstrap_overlay_unowned');
  }
  return true;
}

export function resolveLegacyReleaseDecision(root: string, profile: ResolvedWorkProfile, before: Map<string, Buffer> = new Map(), ownedAfter: Map<string, Buffer> = new Map()): ReleaseMetadataDecision {
  if (resolveReleasePolicy({ resolvedProfile: profile }).source !== 'legacy_seam') throw new Error('release_legacy_resolution_failed');
  const bootstrap = portfolioOpsBootstrap(root, profile, before, ownedAfter);
  const sourcePath = bootstrap ? 'VERSION' : pin(root, 'version-path', 'VERSION');
  const source: ReleaseProjection = { path: sourcePath, format: /\.json$/i.test(sourcePath) ? 'json' : 'plain_text', selector: /\.json$/i.test(sourcePath) ? '/version' : 'whole_file' };
  const bytes = (file: string) => before.get(file) ?? read(root, file);
  const parsedJson = new Map<string, any>();
  const json = (file: string): any => {
    if (!parsedJson.has(file)) {
      try { parsedJson.set(file, JSON.parse(bytes(file).toString('utf8'))); } catch { throw new Error('release_legacy_json_invalid'); }
    }
    return parsedJson.get(file);
  };
  const value = (projection: ReleaseProjection): string => {
    if (projection.format !== 'json') return extractReleaseProjection(bytes(projection.path).toString('utf8'), projection);
    const parsed = json(projection.path);
    const result = projection.selector === '/version' ? parsed?.version : parsed?.packages?.['']?.version;
    if (typeof result !== 'string') throw new Error('release_version_source_invalid');
    return result;
  };
  const current = value(source);
  const at = (sha: string) => extractReleaseProjection(git(root, ['show', `${sha}:${sourcePath}`])!.toString('utf8'), source);
  const trusted = at(profile.trusted_merge_base_sha), target = at(profile.trusted_base.target_sha);
  if (![current, trusted, target].every(version => parseVersion(version))) throw new Error('release_version_source_invalid');
  const targets: ReleaseProjection[] = [{ ...source, value_encoding: 'exact' }];
  const skipped: LegacySkippedLockfile[] = [];
  if (bootstrap) {
    const toml: ReleaseProjection = { path: 'pyproject.toml', format: 'toml', selector: '/project/version', value_encoding: 'exact' };
    if (value(toml) !== current || current !== trusted) throw new Error('release_bootstrap_version_drift');
    targets.push(toml);
  } else {
    const pkg = source.format === 'json' ? sourcePath : pin(root, 'package-json-path', 'package.json');
    if (source.format !== 'json' && fs.existsSync(path.join(root, pkg))) targets.push({ path: pkg, format: 'json', selector: '/version', value_encoding: 'npm_semver' });
    // JSON source locks are beside that source; plain VERSION uses the pinned
    // manifest's directory, retaining the pre-profile discovery contract.
    const directory = path.posix.dirname(pkg);
    for (const name of ['package-lock.json', 'npm-shrinkwrap.json']) {
      const file = path.posix.join(directory, name);
      const link = inspectSkippedLegacyLockfile(root, file);
      if (link) { skipped.push(link); continue; }
      if (!fs.existsSync(path.join(root, file))) continue;
      const parsed = json(file);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('release_legacy_lock_invalid');
      const fields: Array<[ReleaseProjection['selector'], unknown]> = [];
      if (Object.hasOwn(parsed, 'version')) fields.push(['/version', parsed.version]);
      if (parsed.packages !== undefined && (!parsed.packages || typeof parsed.packages !== 'object' || Array.isArray(parsed.packages))) throw new Error('release_legacy_lock_invalid');
      const rootPackage = parsed.packages?.[''];
      if (rootPackage !== undefined && (!rootPackage || typeof rootPackage !== 'object' || Array.isArray(rootPackage))) throw new Error('release_legacy_lock_invalid');
      if (rootPackage && Object.hasOwn(rootPackage, 'version')) fields.push(['/packages//version', rootPackage.version]);
      if (new Set(fields.map(([, version]) => version)).size > 1) throw new Error('release_legacy_lock_drift');
      for (const [selector, version] of fields) {
        if (typeof version !== 'string' || (version !== npmVersion(current) && version !== current)) throw new Error('release_legacy_lock_drift');
        targets.push({ path: file, format: 'json', selector, value_encoding: source.format === 'json' ? 'exact' : 'npm_semver' });
      }
    }
  }
  for (const projection of targets) if (value(projection) !== current && value(projection) !== (projection.value_encoding === 'npm_semver' ? npmVersion(current) : current)) throw new Error('release_version_target_drift');
  return { schema: 'ecpe.release-decision.v1', source: 'legacy_metadata', profile_hash: null, release_mode: 'per_pr', title_policy: 'version_prefix', applicable: true, reason: 'applicable',
    trusted_base_sha: profile.trusted_merge_base_sha, live_target_sha: profile.trusted_base.target_sha, subject_sha: profile.trusted_base.candidate_sha, target_ref: profile.trusted_base.target_ref,
    version_source: source, version_targets: targets, changelog_path: fs.existsSync(path.join(root, 'CHANGELOG.md')) ? 'CHANGELOG.md' : null,
    trusted_version: trusted, target_version: target, current_version: current, ...(bootstrap ? { bootstrap_descriptor: 'portfolioops-first-profile-v1' as const } : {}),
    ...(skipped.length ? { legacy_skipped_lockfiles: skipped } : {}) };
}
