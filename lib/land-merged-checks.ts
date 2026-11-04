/**
 * The `land` block of .gstack/ship-policy.json and its merged-tree run (docs/ship-policy.md#land-direct, GST-1316).
 * When the base moved past a pin's merge base, `gstack-ship-queue land --pin` builds the pin merged onto the base
 * tip in a throwaway worktree and runs `land.merged_checks` there; it lands only when every command passes. A
 * conflict or a failing command refuses; with no key, land warns and merges as before. The commands are repo commands
 * (the merged tree's package.json decides what `bun run` does), so they run only under --allow-repo-commands, never
 * under --dry-run, with an environment that keeps PATH and locale only and a throwaway HOME. Validated here so
 * lib/ship-policy.ts stays one schema file.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PolicyError } from './ship-policy';

/** A local git (lib/ship-queue-gate's shape) so this module, which lib/ship-policy imports, pulls in no queue code. */
function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): { ok: boolean; out: string; err: string; status: number | null } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000, env: env ?? process.env, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? '').replace(/\n$/, ''), err: (r.stderr ?? '').trim(), status: r.status };
}

export interface LandPolicy {
  /** Shell commands run in the pin merged onto the base tip, in order; each must exit 0. */
  merged_checks: string[];
}

const MAX_CHECKS = 16, MAX_COMMAND = 512, CHECK_TIMEOUT_MS = 900_000;
const KEPT_ENV = ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR'];
/** No hook or fsmonitor from the repository's config or the merged tree runs in the git calls around the checks. */
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

export const LAND_EXPLANATION = '{ merged_checks } or null, read from the base revision only: under merge: direct, when the base moved past a pin\'s merge base, `land --pin` builds the pin merged onto the base tip in a throwaway worktree (the checkout\'s node_modules linked in) and runs each merged_checks command there (at most 16, 512 characters each, 15 minutes each); it lands only when every one exits 0, and refuses on a conflict (QUEUE_LAND_NOT_CLEAN) or a failure (QUEUE_LAND_MERGED_CHECKS). They are repo commands: land runs them only with --allow-repo-commands (else REPO_COMMANDS_NOT_ALLOWED), never under --dry-run, with PATH and locale as the only environment and a throwaway HOME. null lands a stale base unchecked with a STALE_BASE: warn line.';

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

/** `setup`: land could not run the checks at all (git failed, or the merged tree's dependencies differ from the linked node_modules): the lane's code is not at fault. */
export type MergedRun = { ok: true; tree: string } | { ok: false; conflict: boolean; setup?: boolean; tree?: string; detail: string };
const LOCKFILES = ['bun.lock', 'bun.lockb', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];
const DEP_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'workspaces', 'overrides'];
const read = (file: string): string | null => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const deps = (file: string): string => { try { const p = JSON.parse(read(file) ?? 'null') ?? {}; return JSON.stringify(DEP_KEYS.map(k => p[k] ?? null)); } catch { return 'unreadable'; } };

/** Run `checks` on a throwaway commit of `pin` merged onto `base` (HEAD is that commit), in a worktree of `root` that is always removed, with a scrubbed environment; a check that does not finish (its whole process group is killed), moves HEAD or changes a tracked file fails, and a merged tree whose dependencies differ from the checkout's is refused before any check runs. */
export function runMergedChecks(root: string, base: string, pin: string, checks: string[], timeoutMs = CHECK_TIMEOUT_MS): MergedRun {
  const mt = git(root, ['merge-tree', '--write-tree', '--name-only', base, pin]);
  const [tree = '', ...rest] = mt.out.split('\n');
  if (!mt.ok) return { ok: false, conflict: mt.status === 1, setup: mt.status !== 1, detail: mt.status === 1 ? `the pin conflicts with ${base.slice(0, 12)} in ${rest.slice(0, rest.indexOf('') < 0 ? undefined : rest.indexOf('')).join(', ') || 'files git did not name'}` : `git merge-tree failed: ${mt.err.split('\n')[0]}` };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-land-merged-'));
  const dir = path.join(scratch, 'tree'), home = path.join(scratch, 'home');
  fs.mkdirSync(home);
  const env: NodeJS.ProcessEnv = { HOME: home, ...Object.fromEntries(KEPT_ENV.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])) };
  try {
    const who = { GIT_AUTHOR_NAME: 'gstack land', GIT_AUTHOR_EMAIL: 'land@gstack.invalid', GIT_COMMITTER_NAME: 'gstack land', GIT_COMMITTER_EMAIL: 'land@gstack.invalid' };
    const commit = git(root, ['commit-tree', tree, '-p', base, '-p', pin, '-m', 'gstack land: merged-tree check'], { ...process.env, ...who });
    const add = commit.ok ? git(root, [...NO_HOOKS, 'worktree', 'add', '-q', '--detach', dir, commit.out]) : commit;
    if (!add.ok) return { ok: false, conflict: false, setup: true, tree, detail: `cannot build the merged tree ${tree.slice(0, 12)}: ${add.err.split('\n')[0]}` };
    const drift = [...LOCKFILES.filter(l => read(path.join(root, l)) !== read(path.join(dir, l))), ...(deps(path.join(root, 'package.json')) !== deps(path.join(dir, 'package.json')) ? ['package.json dependencies'] : [])];
    if (drift.length) return { ok: false, conflict: false, setup: true, tree, detail: `the merged tree's ${drift.join(', ')} differ from this checkout's, so its node_modules cannot vouch for the merged tree` };
    const modules = path.join(root, 'node_modules');
    if (fs.existsSync(modules) && !fs.existsSync(path.join(dir, 'node_modules'))) fs.symlinkSync(modules, path.join(dir, 'node_modules'));
    for (const cmd of checks) {
      const group = process.platform !== 'win32';
      const log = path.join(scratch, 'check.log');
      const fd = fs.openSync(log, 'w');
      const opts = { cwd: dir, env, stdio: ['ignore', fd, fd] as ['ignore', number, number], timeout: timeoutMs, killSignal: 'SIGKILL' as const, detached: group };
      const r = spawnSync('sh', ['-c', cmd], opts);
      fs.closeSync(fd);
      if (group && r.pid) try { process.kill(-r.pid, 'SIGKILL'); } catch {}
      if (r.status === 0 && !r.error) continue;
      const tail = fs.readFileSync(log, 'utf8').trim().split('\n').slice(-6).join('\n');
      return { ok: false, conflict: false, tree, detail: `\`${cmd}\` ${r.error ? `did not finish (${r.error.message})` : `exited ${r.status ?? r.signal}`} on the merged tree ${tree.slice(0, 12)}${tail ? `:\n${tail}` : ''}` };
    }
    if (git(dir, [...NO_HOOKS, 'rev-parse', 'HEAD']).out !== commit.out) return { ok: false, conflict: false, tree, detail: `the checks moved HEAD off the merged commit ${commit.out.slice(0, 12)}, so it was not the tree they passed` };
    const changed = git(dir, [...NO_HOOKS, 'status', '--porcelain', '--untracked-files=no']);
    if (!changed.ok) return { ok: false, conflict: false, setup: true, tree, detail: `git status failed on the merged tree ${tree.slice(0, 12)}: ${changed.err.split('\n')[0]}` };
    if (changed.out) return { ok: false, conflict: false, tree, detail: `the checks changed tracked files on the merged tree ${tree.slice(0, 12)}, so it was not the tree they passed: ${changed.out.split('\n').slice(0, 6).join(', ')}` };
    return { ok: true, tree };
  } finally {
    git(root, [...NO_HOOKS, 'worktree', 'remove', '--force', dir]);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
