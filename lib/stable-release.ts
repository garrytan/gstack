/**
 * stable-release — the newest stable gstack release, and the check that a ship policy's min_gstack_version floor is
 * not above it (GST-1637). A floor above every stable release breaks every stable-channel lane: each one refuses the
 * policy (POLICY_GSTACK_TOO_OLD) and no upgrade can clear it until a later release is cut.
 *
 * A release is an annotated v<VERSION> tag (docs/releases.md), and stable only moves to a tagged release, but a tag
 * can exist before stable reaches it (a cut that stopped half-way), so the newest one is the highest release tag at
 * origin's stable commit (one bounded ls-remote; the highest tag origin lists when it has no stable branch), or, when
 * origin cannot be reached, the VERSION at the stable ref (origin/stable, then stable), else the highest local release
 * tag. The repo is
 * this gstack's own checkout; GSTACK_STABLE_REPO names another one (a fixture, or a checkout with fresher refs). A root
 * that is not the top of its own git checkout (a vendored copy with no .git inside a project) resolves nothing, so the
 * project's own release tags never stand in for gstack's.
 * bin/gstack-doctor-check.sh resolves it the same way in Bash for its floor row.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
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
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return null; } };
  const top = git(['rev-parse', '--show-toplevel'])?.trim();
  if (!top || real(top) !== real(repo)) return { version: null, why: `${repo} is not a gstack checkout of its own (${top ? `git resolves it to ${top}` : 'no git repository'})` };
  const listed = git(['ls-remote', 'origin', 'refs/heads/stable', 'refs/tags/v[0-9]*']);
  const rows = (listed ?? '').split('\n').filter(Boolean).map(l => l.split('\t'));
  const stableSha = rows.find(([, r]) => r === 'refs/heads/stable')?.[0];
  const tagAt = new Map<string, string>();
  for (const [sha, r] of rows) {
    const m = /^refs\/tags\/(v.+?)(\^\{\})?$/.exec(r ?? '');
    if (m && (m[2] || !tagAt.has(m[1]))) tagAt.set(m[1], sha);
  }
  const remote = highestTag([...tagAt].filter(([, sha]) => !stableSha || sha === stableSha).map(([name]) => name));
  if (remote) return { version: remote, source: stableSha ? `release tag v${remote} at origin's stable` : `release tag v${remote} on origin` };
  const origin = listed === null ? 'unreachable' : stableSha ? 'lists no release tag at its stable' : 'lists no release tag';
  const ref = ['refs/remotes/origin/stable', 'refs/heads/stable'].find(r => git(['rev-parse', '--verify', '--quiet', `${r}^{commit}`]) !== null);
  const atRef = ref ? (git(['show', `${ref}:VERSION`]) ?? '').trim() : '';
  if (parseVersion(atRef)) return { version: atRef, source: `${ref!.replace(/^refs\/(remotes\/|heads\/)/, '')} VERSION (local; origin ${origin})` };
  const tag = highestTag((git(['tag', '--list', 'v[0-9]*']) ?? '').split('\n').filter(Boolean));
  if (!tag) return { version: null, why: `${repo} has no release tag on origin (${listed === null ? 'unreachable' : 'none listed'}), no stable ref and no local v<version> tag` };
  return { version: tag, source: `release tag v${tag} (local; origin ${origin})` };
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
