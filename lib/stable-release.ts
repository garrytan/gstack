/**
 * stable-release — the newest stable gstack release, and the check that a ship policy's min_gstack_version floor is
 * not above it (GST-1637). A floor above every stable release breaks every stable-channel lane: each one refuses the
 * policy (POLICY_GSTACK_TOO_OLD) and no upgrade can clear it until a later release is cut.
 *
 * A release is an annotated v<VERSION> tag (docs/releases.md), and stable only moves to a tagged release, so the
 * newest one is the highest release tag origin lists (one bounded ls-remote), or, when origin cannot be reached, the
 * higher of the VERSION at the stable ref (origin/stable, then stable) and the highest local release tag. The repo is
 * this gstack's own checkout; GSTACK_STABLE_REPO names another one (a fixture, or a checkout with fresher refs).
 * bin/gstack-doctor-check.sh resolves it the same way in Bash for its floor row.
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { cmpVersion, parseVersion } from './version-source';
import type { PolicyError } from './ship-policy';

export type StableRelease = { version: string; source: string } | { version: null; why: string };

const higher = (a: string | null, b: string | null): string | null => (!a ? b : !b ? a : cmpVersion(parseVersion(a)!, parseVersion(b)!) >= 0 ? a : b);
const highestTag = (names: string[]): string | null => names.map(n => n.trim().replace(/^.*refs\/tags\//, '').replace(/^v/, '')).filter(v => parseVersion(v)).reduce<string | null>(higher, null);

export function newestStableRelease(env: NodeJS.ProcessEnv = process.env): StableRelease {
  const repo = env.GSTACK_STABLE_REPO || path.resolve(import.meta.dir, '..');
  const git = (args: string[], timeout = 15_000) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout, env: { ...env, GIT_TERMINAL_PROMPT: '0' } });
    return r.status === 0 && !r.error ? (r.stdout ?? '') : null;
  };
  const listed = git(['ls-remote', '--tags', '--refs', 'origin', 'v[0-9]*']);
  const remote = listed === null ? null : highestTag(listed.split('\n').filter(Boolean));
  if (remote) return { version: remote, source: `release tag v${remote} on origin` };
  const ref = ['refs/remotes/origin/stable', 'refs/heads/stable'].find(r => git(['rev-parse', '--verify', '--quiet', `${r}^{commit}`]) !== null);
  const atRef = ref ? (git(['show', `${ref}:VERSION`]) ?? '').trim() : '';
  const stable = parseVersion(atRef) ? atRef : null;
  const tag = highestTag((git(['tag', '--list', 'v[0-9]*']) ?? '').split('\n').filter(Boolean));
  const version = higher(stable, tag);
  if (!version) return { version: null, why: `${repo} has no release tag on origin (${listed === null ? 'unreachable' : 'none listed'}), no stable ref and no local v<version> tag` };
  return { version, source: version === stable ? `${ref!.replace(/^refs\/(remotes\/|heads\/)/, '')} VERSION (local; origin ${listed === null ? 'unreachable' : 'lists no release tag'})` : `release tag v${version} (local; origin ${listed === null ? 'unreachable' : 'lists no release tag'})` };
}

/**
 * The floor against the newest stable release: an error naming both when the floor is above it, a warning when the
 * release could not be resolved (the floor is then not compared), or nothing.
 */
export function floorAgainstStable(floor: unknown, release: StableRelease): { error?: PolicyError; warning?: string; stable?: string } {
  if (typeof floor !== 'string' || !parseVersion(floor)) return {};
  if (release.version === null) return { warning: `could not resolve the newest stable gstack release (${release.why}), so min_gstack_version ${floor} was not compared with it; a floor above stable breaks every stable-channel lane (STABLE_RELEASE_UNKNOWN)` };
  if (cmpVersion(parseVersion(floor)!, parseVersion(release.version)!) <= 0) return { stable: release.version };
  return {
    stable: release.version,
    error: { code: 'POLICY_FLOOR_ABOVE_STABLE', path: 'min_gstack_version', message: `min_gstack_version ${floor} is above the newest stable gstack release ${release.version} (${release.source}), so every stable-channel lane refuses this policy and no upgrade clears it until a release at or above ${floor} is cut; set min_gstack_version to ${release.version} or lower, without the keys that need more` },
  };
}
