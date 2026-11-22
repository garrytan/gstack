/**
 * gstack-restamp's and the gate-ahead queue's `git worktree add` and removal run
 * one at a time per repository. While git adds a worktree it reads every
 * sibling's commondir, and a concurrent add leaves its own commondir empty for
 * an instant, so the other add dies with "failed to read
 * .git/worktrees/<name>/commondir: Success". Two gate-ahead preparations for one
 * PR are concurrent by design and hit this on CI (test/gstack-ship-queue.test.ts,
 * Trunk e3ed3abf). Other worktree callers in crew/lib run one at a time inside
 * their own command and do not take this lock.
 *
 * The lock is a pid file in the repository's git common dir, published with a
 * hard link so it is never seen half-written. Every hold is one git call with a
 * 60 s timeout, so a lock whose holder is dead, or one older than STALE_MS (a
 * killed holder's pid can be reused after a restart), is taken over: it is
 * renamed aside and removed only if it is still the file that was judged stale.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from './spawn-sync';

const STALE_MS = 120_000;
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
  try {
    for (;;) {
      try { fs.linkSync(staged, lock); break; } catch (e: any) { if (e?.code !== 'EEXIST') throw e; }
      let held: { ino: number; mtimeMs: number; pid: number };
      try {
        const fd = fs.openSync(lock, 'r');
        try { const st = fs.fstatSync(fd); held = { ino: st.ino, mtimeMs: st.mtimeMs, pid: Number(fs.readFileSync(fd, 'utf8')) }; } finally { fs.closeSync(fd); }
      } catch { continue; }
      if (holderAlive(held.pid) && Date.now() - held.mtimeMs < STALE_MS) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); continue; }
      const aside = `${lock}.stale.${process.pid}`;
      try { fs.renameSync(lock, aside); } catch { continue; }
      if (fs.statSync(aside).ino !== held.ino) { try { fs.linkSync(aside, lock); } catch { /* a newer holder already took it */ } }
      fs.rmSync(aside, { force: true });
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
