import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { npmVersion, parseVersion } from './version-source';

export type ReleaseMode = 'per_pr' | 'required_on_release' | 'none';
export type ReleaseTitlePolicy = 'version_prefix' | 'conventional' | 'free';
export interface ReleaseProjection {
  path: string;
  format: 'plain_text' | 'json' | 'toml';
  selector: 'whole_file' | '/version' | '/packages//version' | '/project/version';
  value_encoding?: string;
}
export interface TrustedReleaseConfig {
  mode: ReleaseMode;
  title_policy: ReleaseTitlePolicy;
  version_source?: ReleaseProjection;
  version_targets?: ReleaseProjection[];
  changelog_path?: string;
}
export interface LegacyReleasePolicy {
  schema: 'ecpe.release-policy.v1'; source: 'legacy_seam'; bumpMode: 'per_pr'; titlePolicy: 'version_prefix';
}
export interface TrustedReleaseDecision {
  schema: 'ecpe.release-decision.v1'; source: 'trusted_profile'; release_mode: ReleaseMode; title_policy: ReleaseTitlePolicy;
  applicable: boolean; reason: 'applicable' | 'not_release' | 'disabled'; trusted_base_sha: string; live_target_sha: string;
  subject_sha: string; target_ref: string | null; profile_hash: string; version_source: ReleaseProjection | null; version_targets: ReleaseProjection[];
  changelog_path: string | null; trusted_version: string | null; target_version: string | null; current_version: string | null;
}
/** Legacy metadata discovery never acquires trusted-profile provenance. */
export type ReleaseMetadataDecision = Omit<TrustedReleaseDecision, 'source' | 'profile_hash'> & {
  source: 'trusted_profile' | 'legacy_metadata'; profile_hash: string | null; bootstrap_descriptor?: 'portfolioops-first-profile-v1';
  legacy_skipped_lockfiles?: LegacySkippedLockfile[];
};
export interface LegacySkippedLockfile {
  path: string; link_text: string; dev: number; ino: number; mode: number; uid: number; gid: number;
  size: number; mtime_ms: number; ctime_ms: number;
}
interface ResolvedProfileLike {
  mode: 'legacy' | 'profile'; profile_hash: string | null; trusted_merge_base_sha: string;
  trusted_base: { target_ref: string | null; target_sha: string; candidate_sha: string }; effective: { release: TrustedReleaseConfig } | null;
  trusted_release?: TrustedReleaseConfig | null;
}
export interface ResolveReleasePolicyInput {
  resolvedProfile: ResolvedProfileLike; releaseRequested?: boolean; assertReleaseMode?: ReleaseMode; assertTitlePolicy?: ReleaseTitlePolicy; currentVersion?: string; cwd?: string;
  readVersion?: (sha: string, projection: ReleaseProjection) => string;
  readCurrentVersion?: (projection: ReleaseProjection) => string;
}

const LEGACY: LegacyReleasePolicy = Object.freeze({ schema: 'ecpe.release-policy.v1', source: 'legacy_seam', bumpMode: 'per_pr', titlePolicy: 'version_prefix' });

export function extractReleaseProjection(text:string,projection:ReleaseProjection):string{
  if (projection.format === 'plain_text' && projection.selector === 'whole_file') return text.trim();
  if (projection.format === 'json' && projection.selector === '/version') {
    let value: unknown; try { value = JSON.parse(text); } catch { throw new Error('release_version_source_invalid'); }
    const version = (value as { version?: unknown })?.version;
    if (typeof version !== 'string') throw new Error('release_version_source_invalid');
    return version.trim();
  }
  if (projection.format === 'json' && projection.selector === '/packages//version') {
    let value: unknown; try { value = JSON.parse(text); } catch { throw new Error('release_version_source_invalid'); }
    const packages = (value as { packages?: unknown })?.packages;
    if (!packages || typeof packages !== 'object' || Array.isArray(packages)) throw new Error('release_version_source_invalid');
    const version = ((packages as Record<string, unknown>)[''] as { version?: unknown } | undefined)?.version;
    if (typeof version !== 'string') throw new Error('release_version_source_invalid');
    return version.trim();
  }
  if (projection.format === 'toml' && projection.selector === '/project/version') {
    let value: unknown;
    try { value = (Bun as any).TOML.parse(text); } catch { throw new Error('release_version_source_invalid'); }
    const version = (value as { project?: { version?: unknown } })?.project?.version;
    if (typeof version !== 'string') throw new Error('release_version_source_invalid');
    return version.trim();
  }
  throw new Error('release_version_source_unsupported');
}
function readProjectionAt(cwd: string, sha: string, projection: ReleaseProjection): string {
  const child = spawnSync('/usr/bin/git', ['show', `${sha}:${projection.path}`], { cwd, encoding: 'utf8', shell: false, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
  if (child.status !== 0) throw new Error('release_version_source_unreadable');
  return extractReleaseProjection(child.stdout,projection);
}
function readProjectionFromWorktree(cwd:string,projection:ReleaseProjection):string{
  try {
    const root=fs.realpathSync(path.resolve(cwd));const target=path.resolve(root,projection.path);
    if(!target.startsWith(`${root}${path.sep}`))throw new Error('release_version_source_unreadable');
    let cursor=root;
    for(const part of path.relative(root,target).split(path.sep)){
      cursor=path.join(cursor,part);const info=fs.lstatSync(cursor);
      if(info.isSymbolicLink())throw new Error('release_version_source_unreadable');
    }
    const info=fs.lstatSync(target);if(!info.isFile())throw new Error('release_version_source_unreadable');
    return extractReleaseProjection(fs.readFileSync(target,'utf8'),projection);
  } catch(error) {
    if(error instanceof Error && error.message==='release_version_source_unreadable') throw error;
    throw new Error('release_version_source_unreadable');
  }
}

export function resolveReleasePolicy(): LegacyReleasePolicy;
export function resolveReleasePolicy(input: ResolveReleasePolicyInput): LegacyReleasePolicy | TrustedReleaseDecision;
export function resolveReleasePolicy(input?: ResolveReleasePolicyInput): LegacyReleasePolicy | TrustedReleaseDecision {
  if (!input) return LEGACY;
  if (input.resolvedProfile.mode === 'legacy') {
    if (input.assertTitlePolicy && input.assertTitlePolicy !== LEGACY.titlePolicy) throw new Error('release_title_policy_assertion_mismatch');
    return LEGACY;
  }
  const resolved = input.resolvedProfile;
  const release = resolved.trusted_release ?? resolved.effective?.release;
  if (!release || !resolved.profile_hash) throw new Error('trusted_release_policy_missing');
  if (input.assertReleaseMode && input.assertReleaseMode !== release.mode) throw new Error('release_mode_assertion_mismatch');
  if (input.assertTitlePolicy && input.assertTitlePolicy !== release.title_policy) throw new Error('release_title_policy_assertion_mismatch');
  const applicable = release.mode === 'per_pr' || (release.mode === 'required_on_release' && input.releaseRequested === true);
  const reason: TrustedReleaseDecision['reason'] = release.mode === 'none' ? 'disabled' : applicable ? 'applicable' : 'not_release';
  const base = {
    schema: 'ecpe.release-decision.v1' as const, source: 'trusted_profile' as const, release_mode: release.mode, title_policy: release.title_policy,
    applicable, reason, trusted_base_sha: resolved.trusted_merge_base_sha, live_target_sha: resolved.trusted_base.target_sha,
    subject_sha: resolved.trusted_base.candidate_sha, target_ref: resolved.trusted_base.target_ref, profile_hash: resolved.profile_hash, version_source: release.version_source ?? null,
    version_targets: release.version_targets ?? [], changelog_path: release.changelog_path ?? null,
  };
  if (!applicable) return Object.freeze({ ...base, trusted_version: null, target_version: null, current_version: null });
  if (!release.version_source || !release.version_targets?.length) throw new Error('trusted_release_metadata_missing');
  const readVersion = input.readVersion ?? ((sha: string, projection: ReleaseProjection) => readProjectionAt(input.cwd ?? process.cwd(), sha, projection));
  const readCurrentVersion=input.readCurrentVersion??((projection:ReleaseProjection)=>readProjectionFromWorktree(input.cwd??process.cwd(),projection));
  const trustedVersion = readVersion(resolved.trusted_merge_base_sha, release.version_source);
  const targetVersion = readVersion(resolved.trusted_base.target_sha, release.version_source);
  const currentVersion = readCurrentVersion(release.version_source);
  if (!parseVersion(trustedVersion) || !parseVersion(targetVersion) || !parseVersion(currentVersion)) throw new Error('release_version_source_invalid');
  if (input.currentVersion !== undefined && input.currentVersion !== currentVersion) throw new Error('release_current_version_mismatch');
  const projectionKey = (projection: ReleaseProjection) => `${projection.path}\0${projection.format}\0${projection.selector}`;
  const sourceKey = projectionKey(release.version_source);
  for (const target of release.version_targets) {
    if (projectionKey(target) === sourceKey) continue;
    const mirror = readCurrentVersion(target);
    const expected = target.value_encoding === 'npm_semver' ? npmVersion(currentVersion) : currentVersion;
    if (!parseVersion(mirror) || mirror !== expected) throw new Error('release_version_target_drift');
  }
  return Object.freeze({ ...base, trusted_version: trustedVersion, target_version: targetVersion, current_version: currentVersion });
}
