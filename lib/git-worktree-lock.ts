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
 * hard link so it is never seen half-written and dated the moment it is
 * published. Every hold is one git call with a 60 s timeout, so a lock whose
 * holder is dead, whose pid is this process's own, or that is older than STALE_MS (a
 * killed holder's pid can be reused after a restart) is stale. Only one waiter
 * at a time may remove a stale lock (the takeover directory), and it removes the
 * lock only if the file there is still the one it judged stale and still stale.
 * The lock only narrows a race: when it cannot be taken (no hard links, an
 * unwritable common dir, or 3 x STALE_MS of waiting) the command runs unlocked,
 * as it did before the lock existed, instead of failing.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from './spawn-sync';

const STALE_MS = 120_000;
const TAKEOVER_STALE_MS = 10_000;
const LOCK_NAME = 'gstack-worktree.lock';

type GitResult = { ok: boolean; out: string; err: string; status: number | null };
type Held = { ino: number; mtimeMs: number; pid: number };

function git(cwd: string, args: string[]): GitResult {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 });
  return { ok: r.status === 0, out: (r.stdout ?? '').replace(/\n$/, ''), err: (r.stderr ?? '').trim(), status: r.status };
}

function holderAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

function readHeld(lock: string): Held | null {
  try {
    const fd = fs.openSync(lock, 'r');
    try { const st = fs.fstatSync(fd); return { ino: st.ino, mtimeMs: st.mtimeMs, pid: Number(fs.readFileSync(fd, 'utf8')) }; } finally { fs.closeSync(fd); }
  } catch { return null; }
}

const isStale = (h: Held) => h.pid === process.pid || !holderAlive(h.pid) || Date.now() - h.mtimeMs >= STALE_MS;
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);

function takeOverStale(lock: string, judged: Held): void {
  const gate = `${lock}.takeover`;
  try { fs.mkdirSync(gate); } catch (e: any) {
    if (e?.code !== 'EEXIST') throw e;
    try { if (Date.now() - fs.statSync(gate).mtimeMs >= TAKEOVER_STALE_MS) fs.rmSync(gate, { recursive: true, force: true }); } catch { /* gone */ }
    pause();
    return;
  }
  try {
    const now = readHeld(lock);
    if (now && now.ino === judged.ino && isStale(now)) fs.rmSync(lock, { force: true });
  } finally { fs.rmSync(gate, { recursive: true, force: true }); }
}

export function withWorktreeLock<T>(repoRoot: string, fn: () => T): T {
  const common = git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common.ok) return fn();
  const lock = path.join(common.out, LOCK_NAME);
  const mine = acquire(lock);
  if (mine === null) return fn();
  try { return fn(); } finally {
    try { if (fs.statSync(lock).ino === mine) fs.rmSync(lock, { force: true }); } catch { /* already gone */ }
  }
}

function acquire(lock: string): number | null {
  const staged = `${lock}.${process.pid}`;
  const giveUpAt = Date.now() + 3 * STALE_MS;
  try {
    fs.writeFileSync(staged, String(process.pid));
    for (;;) {
      const now = new Date();
      fs.utimesSync(staged, now, now);
      try { fs.linkSync(staged, lock); return fs.statSync(lock).ino; } catch (e: any) {
        if (e?.code !== 'EEXIST' || Date.now() >= giveUpAt) return null;
      }
      const held = readHeld(lock);
      if (held && isStale(held)) takeOverStale(lock, held); else pause();
    }
  } catch { return null; } finally {
    try { fs.rmSync(staged, { force: true }); } catch { /* not ours to remove */ }
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
