/**
 * The `land` block of .gstack/ship-policy.json and its merged-tree run (docs/ship-policy.md#land-direct, GST-1316).
 * When the base moved past a pin's merge base, `gstack-ship-queue land --pin` builds the pin merged onto the base
 * tip in a throwaway worktree and runs `land.merged_checks` there; it lands only when every command passes. A
 * conflict or a failing command refuses. Validated here so lib/ship-policy.ts stays one schema file.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PolicyError } from './ship-policy';

/** A local git (lib/ship-queue-gate's shape) so this module, which lib/ship-policy imports, pulls in no queue code. */
function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string; status: number | null } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? '').replace(/\n$/, ''), err: (r.stderr ?? '').trim(), status: r.status };
}

export interface LandPolicy {
  /** Shell commands run in the pin merged onto the base tip, in order; each must exit 0. */
  merged_checks: string[];
}

const MAX_CHECKS = 16, MAX_COMMAND = 512, CHECK_TIMEOUT_MS = 900_000;

export const LAND_EXPLANATION = '{ merged_checks } or null, read from the base revision only: under merge: direct, when the base moved past a pin\'s merge base, `land --pin` builds the pin merged onto the base tip in a throwaway worktree (the checkout\'s node_modules linked in) and runs each merged_checks command there (at most 16, 512 characters each, 15 minutes each); it lands only when every one exits 0, and refuses on a conflict (QUEUE_LAND_NOT_CLEAN) or a failure (QUEUE_LAND_MERGED_CHECKS). null refuses every stale base (QUEUE_LAND_STALE_BASE).';

export function landPolicyErrors(raw: unknown): PolicyError[] {
  const l = raw as Record<string, unknown> | null;
  if (!l || typeof l !== 'object' || Array.isArray(l)) return [{ code: 'POLICY_INVALID', path: 'land', message: 'must be { merged_checks } or null' }];
  const out: PolicyError[] = Object.keys(l).filter(k => k !== 'merged_checks').map(k => ({ code: 'POLICY_INVALID', path: `land.${k}`, message: 'unknown key' }));
  const c = l.merged_checks;
  if (!Array.isArray(c) || !c.length || c.length > MAX_CHECKS) return [...out, { code: 'POLICY_INVALID', path: 'land.merged_checks', message: `must list 1 to ${MAX_CHECKS} commands` }];
  c.forEach((cmd, i) => {
    if (typeof cmd !== 'string' || !cmd.trim()) out.push({ code: 'POLICY_INVALID', path: `land.merged_checks[${i}]`, message: 'must be a non-empty command' });
    else if (cmd.length > MAX_COMMAND || /[\0\r\n]/.test(cmd)) out.push({ code: 'POLICY_CONTAINMENT', path: `land.merged_checks[${i}]`, message: `must be one line of at most ${MAX_COMMAND} characters` });
  });
  return out;
}

export type MergedRun = { ok: true; tree: string } | { ok: false; conflict: boolean; tree?: string; detail: string };

/** Run `checks` in `pin` merged onto `base`, in a throwaway worktree of `root` that is always removed. */
export function runMergedChecks(root: string, base: string, pin: string, checks: string[]): MergedRun {
  const mt = git(root, ['merge-tree', '--write-tree', '--name-only', base, pin]);
  const [tree = '', ...rest] = mt.out.split('\n');
  if (!mt.ok) return { ok: false, conflict: mt.status === 1, detail: mt.status === 1 ? `the pin conflicts with ${base.slice(0, 12)} in ${rest.slice(0, rest.indexOf('') < 0 ? undefined : rest.indexOf('')).join(', ') || 'files git did not name'}` : `git merge-tree failed: ${mt.err.split('\n')[0]}` };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-land-merged-'));
  try {
    const add = git(root, ['worktree', 'add', '-q', '--detach', dir, base]);
    if (!add.ok) return { ok: false, conflict: false, tree, detail: `cannot build the merged tree: ${add.err.split('\n')[0]}` };
    const read = git(dir, ['read-tree', '--reset', '-u', tree]);
    if (!read.ok) return { ok: false, conflict: false, tree, detail: `cannot check out the merged tree ${tree.slice(0, 12)}: ${read.err.split('\n')[0]}` };
    const deps = path.join(root, 'node_modules');
    if (fs.existsSync(deps) && !fs.existsSync(path.join(dir, 'node_modules'))) fs.symlinkSync(deps, path.join(dir, 'node_modules'));
    for (const cmd of checks) {
      const r = spawnSync('sh', ['-c', cmd], { cwd: dir, encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
      if (r.status === 0) continue;
      const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n').slice(-6).join('\n');
      return { ok: false, conflict: false, tree, detail: `\`${cmd}\` ${r.error ? `did not finish (${r.error.message})` : `exited ${r.status ?? r.signal}`} on the merged tree ${tree.slice(0, 12)}${tail ? `:\n${tail}` : ''}` };
    }
    return { ok: true, tree };
  } finally {
    git(root, ['worktree', 'remove', '--force', dir]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
