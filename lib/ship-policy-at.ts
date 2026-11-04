/**
 * ship-policy-at — the ship policy committed at a commit the caller already
 * resolved (docs/ship-policy.md#review-exclude-paths). Unlike
 * loadPolicyFromBase, any git failure is `unavailable`, never a silent
 * default. Callers: lib/review-exclude.ts, lib/ship-receipt-depth.ts,
 * bin/gstack-review-plan.
 */
import { spawnSync } from 'node:child_process';
import { SHIP_POLICY_PATH, finish, type PolicyLoad, type PolicySource } from './ship-policy';

function git(repoRoot: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

/**
 * The policy committed at `sha` (a commit the caller already resolved, labeled `ref`): `cat-file -e` first, and only an
 * `ls-tree` that succeeds with no entry is a missing file (defaults); any git failure, including a `show` failure after
 * the file was found, is `unavailable`, never a silent default.
 */
export function loadPolicyAt(repoRoot: string, sha: string, ref: string): PolicyLoad {
  const label = `${ref}@${sha.slice(0, 12)}`;
  const source: PolicySource = { kind: 'base', ref, sha, label: `${label}:${SHIP_POLICY_PATH}` };
  const spec = `${sha}:${SHIP_POLICY_PATH}`;
  const base = ref.replace(/^origin\//, '');
  if (!git(repoRoot, ['cat-file', '-e', spec]).ok) {
    const tree = git(repoRoot, ['ls-tree', sha, '--', SHIP_POLICY_PATH]);
    if (!tree.ok) return { unavailable: true, base, detail: `git ls-tree ${sha.slice(0, 12)} failed: ${tree.err.split('\n')[0] || 'no detail'}` };
    if (!tree.out) return finish(null, { ...source, kind: 'none', label: `${label} (no ${SHIP_POLICY_PATH})` });
  }
  const show = git(repoRoot, ['show', spec]);
  if (!show.ok) return { unavailable: true, base, detail: `git show ${label}:${SHIP_POLICY_PATH} failed: ${show.err.split('\n')[0] || 'no detail'}` };
  return finish(show.out, source);
}
