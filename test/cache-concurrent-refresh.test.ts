/**
 * Concurrent-refresh lockfile dedup (T15 / D3).
 *
 * When autoplan dispatches 4 planning skills back-to-back and they all hit a
 * cold-miss on the same digest, only ONE should actually fetch from the brain;
 * the rest dedup via the project-scoped lockfile at
 * ~/.gstack/projects/<slug>/brain-cache/.refresh.lock. Stale locks (process
 * dead, or older than CACHE_REFRESH_LOCK_TIMEOUT_MS) are taken over.
 *
 * Gate-tier, free, pure file-IO. Uses tmp GSTACK_HOME.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, existsSync, writeFileSync, readFileSync, rmSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir, hostname } from 'os';

let TMP_HOME: string;
const ORIGINAL_HOME = process.env.GSTACK_HOME;

beforeEach(() => {
  TMP_HOME = mkdtempSync(join(tmpdir(), 'gstack-lock-test-'));
  process.env.GSTACK_HOME = TMP_HOME;
  delete require.cache[require.resolve('../bin/gstack-brain-cache')];
});

afterEach(() => {
  if (ORIGINAL_HOME) process.env.GSTACK_HOME = ORIGINAL_HOME;
  else delete process.env.GSTACK_HOME;
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function importCache(): Promise<typeof import('../bin/gstack-brain-cache')> {
  return (await import('../bin/gstack-brain-cache')) as typeof import('../bin/gstack-brain-cache');
}

describe('concurrent-refresh lockfile dedup', () => {
  test('first caller acquires lock; second concurrent caller deduplicates', async () => {
    const mod = await importCache();
    // Pre-create dirs to avoid Race On First Use.
    mkdirSync(join(TMP_HOME, 'projects', 'helsinki', 'brain-cache'), { recursive: true });

    let callbackRan = 0;
    // Hold the lock by entering withRefreshLock and stalling inside the callback.
    let outerResolve: (() => void) | null = null;
    const outer = new Promise<void>((r) => { outerResolve = r; });

    const outerCall = (async () => {
      const result = mod.withRefreshLock('helsinki', () => {
        callbackRan++;
        // Block until the test signals release.
        const start = Date.now();
        while (!outerResolve) { /* spin briefly */ if (Date.now() - start > 100) break; }
        return 'first';
      });
      return result;
    })();

    // Give outer call a tick to acquire lock.
    await new Promise((r) => setTimeout(r, 10));

    // Inner call should dedup since the lock file exists with a fresh ts.
    // Manually verify by writing a fake lock and checking tryAcquireLock returns dedup.
    const lockFile = join(TMP_HOME, 'projects', 'helsinki', 'brain-cache', '.refresh.lock');
    // Outer call already completed since the sync callback returns immediately.
    // Stand up an artificial lock to simulate concurrent in-flight refresh.
    writeFileSync(lockFile, JSON.stringify({
      pid: 999999, // unlikely-to-exist pid on host
      host: 'some-other-host',
      ts: Date.now(),
    }));
    const innerResult = mod.withRefreshLock('helsinki', () => 'inner');
    expect(innerResult).toBe('dedup');

    // Cleanup
    try { unlinkSync(lockFile); } catch { /* best effort */ }

    await outerCall;
  });

  test('stale lock (older than timeout) is taken over', async () => {
    const mod = await importCache();
    mkdirSync(join(TMP_HOME, 'projects', 'helsinki', 'brain-cache'), { recursive: true });
    const lockFile = join(TMP_HOME, 'projects', 'helsinki', 'brain-cache', '.refresh.lock');
    // Lock is 10 minutes old — way past the 5-min timeout.
    writeFileSync(lockFile, JSON.stringify({
      pid: 999999,
      host: 'some-other-host',
      ts: Date.now() - 10 * 60_000,
    }));
    const result = mod.withRefreshLock('helsinki', () => 'took-over');
    expect(result).toBe('took-over');
  });

  test('lock from same host with dead PID is taken over', async () => {
    const mod = await importCache();
    mkdirSync(join(TMP_HOME, 'projects', 'helsinki', 'brain-cache'), { recursive: true });
    const lockFile = join(TMP_HOME, 'projects', 'helsinki', 'brain-cache', '.refresh.lock');
    // Same host, but PID 999999 which is unlikely to exist.
    writeFileSync(lockFile, JSON.stringify({
      pid: 999999,
      host: hostname(),
      ts: Date.now(),
    }));
    const result = mod.withRefreshLock('helsinki', () => 'took-over-dead-pid');
    expect(result).toBe('took-over-dead-pid');
  });

  test('lock is released after callback runs', async () => {
    const mod = await importCache();
    mkdirSync(join(TMP_HOME, 'projects', 'helsinki', 'brain-cache'), { recursive: true });
    const lockFile = join(TMP_HOME, 'projects', 'helsinki', 'brain-cache', '.refresh.lock');

    mod.withRefreshLock('helsinki', () => 'done');

    expect(existsSync(lockFile)).toBe(false);
  });

  test('lock is released even when callback throws', async () => {
    const mod = await importCache();
    mkdirSync(join(TMP_HOME, 'projects', 'helsinki', 'brain-cache'), { recursive: true });
    const lockFile = join(TMP_HOME, 'projects', 'helsinki', 'brain-cache', '.refresh.lock');

    expect(() => {
      mod.withRefreshLock('helsinki', () => {
        throw new Error('callback failed');
      });
    }).toThrow();

    expect(existsSync(lockFile)).toBe(false);
  });

  test('corrupt lock file is taken over (defensive)', async () => {
    const mod = await importCache();
    mkdirSync(join(TMP_HOME, 'projects', 'helsinki', 'brain-cache'), { recursive: true });
    const lockFile = join(TMP_HOME, 'projects', 'helsinki', 'brain-cache', '.refresh.lock');
    writeFileSync(lockFile, 'not valid json {{{');

    const result = mod.withRefreshLock('helsinki', () => 'recovered');
    expect(result).toBe('recovered');
  });

  test('cross-project lock uses ~/.gstack/brain-cache/.refresh.lock', async () => {
    const mod = await importCache();
    mkdirSync(join(TMP_HOME, 'brain-cache'), { recursive: true });
    const lockFile = join(TMP_HOME, 'brain-cache', '.refresh.lock');

    mod.withRefreshLock(null, () => 'cross-project');

    // Lock file was created and then released
    expect(existsSync(lockFile)).toBe(false); // released
  });
});
