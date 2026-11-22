/**
 * restamp-release — the precondition of `gstack-restamp --release` (lib/release-stamp.ts, docs/ship-policy.md#release-stamp):
 * a release stamp runs on a clean checkout of origin/<base> under changelog_fragments, so the release PR carries only the stamp.
 */
import { spawnSync } from 'node:child_process';

const git = (cwd: string, args: string[]) => (spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 }).stdout ?? '').trim();

/** Why a release stamp cannot run here, or null when it can. */
export function releaseRefusal(repoRoot: string, base: string, baseRef: string | undefined, fragDir: string | null): { message: string; fix?: string } | null {
  if (!fragDir) return { message: '--release needs changelog_fragments in the base policy (a release folds the fragments); nothing written' };
  const tip = git(repoRoot, ['rev-parse', '--verify', '--quiet', `${baseRef ?? `origin/${base}`}^{commit}`]);
  if (!tip || git(repoRoot, ['rev-parse', 'HEAD']) !== tip) return { message: `--release runs on a checkout of origin/${base} (${tip.slice(0, 12) || 'unresolved'}), not on ${git(repoRoot, ['rev-parse', '--short', 'HEAD'])}; nothing written`, fix: `git fetch origin ${base} && git checkout --detach origin/${base}` };
  const dirty = git(repoRoot, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty) return { message: `--release needs a clean checkout; commit or stash: ${dirty.split('\n').slice(0, 5).map(l => l.slice(3)).join(', ')}; nothing written` };
  return null;
}
