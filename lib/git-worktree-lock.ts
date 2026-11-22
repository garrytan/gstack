/**
 * gstack's own `git worktree add` and removal run one at a time per
 * repository. While git adds a worktree it reads every sibling's commondir,
 * and a concurrent add leaves its own commondir empty for an instant, so the
 * other add dies with "failed to read .git/worktrees/<name>/commondir:
 * Success". Two gate-ahead preparations for one PR are concurrent by design
 * and hit this on CI (test/gstack-ship-queue.test.ts, Trunk e3ed3abf).
 *
 * The lock is a pid file in the repository's git common dir, published with a
 * hard link so it is never seen half-written; a dead holder's lock is taken
 * over, and a live one is waited on for at most WAIT_MS.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from './spawn-sync';

const WAIT_MS = 120_000;
const LOCK_NAME = 'gstack-worktree.lock';

type GitResult = { ok: boolean; out: string; err: string; status: number | null };

function git(cwd: string, args: string[]): GitResult {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 });
  return { ok: r.status === 0, out: (r.stdout ?? '').replace(/\n$/, ''), err: (r.stderr ?? '').trim(), status: r.status };
}

function holderAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

export function withWorktreeLock<T>(repoRoot: string, fn: () => T): T {
  const common = git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common.ok) return fn();
  const lock = path.join(common.out, LOCK_NAME);
  const staged = `${lock}.${process.pid}`;
  fs.writeFileSync(staged, String(process.pid));
  const deadline = Date.now() + WAIT_MS;
  try {
    for (;;) {
      try { fs.linkSync(staged, lock); break; } catch (e: any) { if (e?.code !== 'EEXIST') throw e; }
      let holder = 0;
      try { holder = Number(fs.readFileSync(lock, 'utf8')); } catch { continue; }
      if (!holderAlive(holder)) { fs.rmSync(lock, { force: true }); continue; }
      if (Date.now() >= deadline) throw new Error(`another gstack worktree command (pid ${holder}) has held ${lock} for ${WAIT_MS / 1000} s`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  } finally { fs.rmSync(staged, { force: true }); }
  try { return fn(); } finally {
    try { if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.rmSync(lock, { force: true }); } catch { /* already gone */ }
  }
}

export function addWorktree(repoRoot: string, dir: string, commit: string): GitResult {
  return withWorktreeLock(repoRoot, () => git(repoRoot, ['worktree', 'add', '--detach', '-q', dir, commit]));
}

export function removeWorktree(repoRoot: string, dir: string): void {
  withWorktreeLock(repoRoot, () => git(repoRoot, ['worktree', 'remove', '--force', dir]));
  fs.rmSync(dir, { recursive: true, force: true });
  withWorktreeLock(repoRoot, () => git(repoRoot, ['worktree', 'prune']));
}
