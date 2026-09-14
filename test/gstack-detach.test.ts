/**
 * gstack-detach — the eval-infra robustness guard. Pins the four killer fixes:
 *   1. SIGTERM-proof detachment (runs in a different process group, outlives the launcher)
 *   2. run-scoped default log path (no shared-/tmp collision between worktrees)
 *   3. watchdog --timeout (no silent hang) + guaranteed EXIT sentinel
 *   4. machine-wide --lock serialization (no cross-worktree API saturation)
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const DETACH = path.join(ROOT, 'bin', 'gstack-detach');

function ownPgid(): string {
  return (spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf-8', timeout: 30_000 }).stdout || '').trim();
}
function waitFor(pred: () => boolean, ms: number): boolean {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    spawnSync('sleep', ['0.2'], { timeout: 30_000 });
  }
  return pred();
}
function logHas(p: string, needle: string): boolean {
  try { return fs.readFileSync(p, 'utf-8').includes(needle); } catch { return false; }
}

describe('gstack-detach', () => {
  test('detaches (different pgid), returns immediately, completes, writes EXIT sentinel', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-'));
    const log = path.join(dir, 'run.log');
    try {
      const t0 = Date.now();
      const r = spawnSync(DETACH, ['--log', log, '--', 'bash', '-c', 'sleep 2; echo body-ran'], { encoding: 'utf-8', timeout: 10000 });
      const elapsed = Date.now() - t0;
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`gstack-detach LOG ${log}`);
      expect(elapsed).toBeLessThan(1500);                         // non-blocking
      expect(waitFor(() => logHas(log, '### gstack-detach EXIT=0 ###'), 8000)).toBe(true);
      expect(logHas(log, 'body-ran')).toBe(true);                 // ran to completion after launcher returned
      const m = fs.readFileSync(log, 'utf-8').match(/pgid=(\d+)/);
      expect(m).not.toBeNull();
      expect(m![1]).not.toBe(ownPgid());                          // detached into its own group
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 15000);

  test('default log is run-scoped under ~/.gstack-dev/eval-runs (no shared /tmp)', () => {
    const r = spawnSync(DETACH, ['--label', 'unittest', '--', 'true'], { encoding: 'utf-8', timeout: 10000 });
    const log = (r.stdout.match(/gstack-detach LOG (\S+)/) || [])[1];
    try {
      expect(log).toContain('/.gstack-dev/eval-runs/');
      expect(path.basename(log)).toContain('unittest-');
      expect(path.basename(log)).toMatch(/-\d+\.log$/);            // pid-unique
      waitFor(() => logHas(log, '### gstack-detach EXIT=0 ###'), 6000);
    } finally { if (log) fs.rmSync(log, { force: true }); }
  }, 12000);

  test('watchdog kills a stalled run and records EXIT=timeout (no silent hang)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-'));
    const log = path.join(dir, 'run.log');
    try {
      spawnSync(DETACH, ['--log', log, '--timeout', '1', '--', 'sleep', '60'], { encoding: 'utf-8', timeout: 10000 });
      expect(waitFor(() => logHas(log, '### gstack-detach EXIT=timeout ###'), 12000)).toBe(true);
      expect(logHas(log, 'WATCHDOG fired')).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 16000);

  test('watchdog group-SIGKILLs TERM-immune grandchildren (no orphan survives)', () => {
    // Regression pin for the 2026-08 escalation change: the watchdog used to
    // follow its killpg(SIGTERM) + 5s grace with a DIRECT proc.kill() — a
    // grandchild that ignores TERM survived and burned cores/API for hours
    // (the observed 15-hour-orphan class). Now the grace escalates to
    // killpg(SIGKILL). The child here traps TERM and spawns a TERM-immune
    // grandchild; only a GROUP SIGKILL clears both. Markers are per-run
    // unique (pid) so concurrent worktree suites can't cross-kill.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-'));
    const log = path.join(dir, 'run.log');
    const g1 = `6091.${process.pid}`;
    const g2 = `6092.${process.pid}`;
    const alive = (m: string) => spawnSync('pgrep', ['-f', `sleep ${m.replace('.', '\\.')}`], { stdio: 'pipe', timeout: 5_000 }).status === 0;
    try {
      spawnSync(DETACH, ['--log', log, '--timeout', '1', '--', 'bash', '-c',
        `trap '' TERM; (trap '' TERM; sleep ${g1}) & exec sleep ${g2}`],
        { encoding: 'utf-8', timeout: 10000 });
      expect(waitFor(() => logHas(log, '### gstack-detach EXIT=timeout ###'), 15000)).toBe(true);
      // Grace is 5s after the TERM that both processes ignore — the SIGKILL
      // escalation must clear the whole group shortly after the sentinel.
      expect(waitFor(() => !alive(g1) && !alive(g2), 10000),
        'TERM-immune child/grandchild survived the watchdog — killpg(SIGKILL) escalation regressed').toBe(true);
    } finally {
      spawnSync('pkill', ['-9', '-f', `sleep 609[12]\\.${process.pid}`], { stdio: 'ignore', timeout: 5_000 });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test('watchdog kills the grandchild even when the LEADER dies on the SIGTERM', () => {
    // The pgid-after-grace bug: killpg(getpgid(proc.pid), SIGKILL) raised
    // ESRCH once the leader had honored the TERM, and the except fell back
    // to proc.kill() on a corpse — the TERM-immune grandchild lived forever.
    // The fix captures the pgid AT SPAWN. This variant is the one the
    // TERM-immune-leader test above cannot see.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-'));
    const log = path.join(dir, 'run.log');
    const g = `6093.${process.pid}`;
    const alive = () => spawnSync('pgrep', ['-f', `sleep ${g.replace('.', '\\.')}`], { stdio: 'pipe', timeout: 5_000 }).status === 0;
    try {
      // Leader: no trap — dies on the watchdog's SIGTERM. Grandchild:
      // TERM-immune, same group — only a saved-pgid SIGKILL reaches it.
      spawnSync(DETACH, ['--log', log, '--timeout', '1', '--', 'bash', '-c',
        `(trap '' TERM; sleep ${g}) & sleep 60`],
        { encoding: 'utf-8', timeout: 10000 });
      expect(waitFor(() => logHas(log, '### gstack-detach EXIT=timeout ###'), 15000)).toBe(true);
      expect(waitFor(() => !alive(), 10000),
        'grandchild survived a dead leader — the pgid must be captured at spawn, not resolved after the grace').toBe(true);
    } finally {
      spawnSync('pkill', ['-9', '-f', `sleep 6093\\.${process.pid}`], { stdio: 'ignore', timeout: 5_000 });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test('machine --lock serializes concurrent runs (second WAITS for the first)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-'));
    const lock = `gstack-detach-test-${process.pid}`;
    const logA = path.join(dir, 'a.log');
    const logB = path.join(dir, 'b.log');
    try {
      // First holds the lock for ~3s; second must wait then acquire.
      spawnSync(DETACH, ['--log', logA, '--lock', lock, '--', 'sleep', '3'], { encoding: 'utf-8', timeout: 10000 });
      waitFor(() => logHas(logA, "ACQUIRED"), 4000);
      spawnSync(DETACH, ['--log', logB, '--lock', lock, '--', 'echo', 'second-ran'], { encoding: 'utf-8', timeout: 10000 });
      // Second should report WAITING (first still holds it) then ACQUIRE after release.
      expect(waitFor(() => logHas(logB, 'WAITING for lock'), 4000)).toBe(true);
      expect(waitFor(() => logHas(logB, '### gstack-detach EXIT=0 ###'), 12000)).toBe(true);
      expect(logHas(logB, 'second-ran')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(path.join(os.homedir(), '.gstack', 'locks', `${lock}.lock`), { force: true });
    }
  }, 20000);

  test('rejects missing command (exit 2)', () => {
    const r = spawnSync(DETACH, ['--label', 'x'], { encoding: 'utf-8', timeout: 30_000 });
    expect(r.status).toBe(2);
  });
});
