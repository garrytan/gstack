/**
 * #2709 — two defects, one issue:
 *
 * 1. headlessGpuArgs: on macOS 26 / Apple Silicon the headless GPU process
 *    pegs ~800% CPU after real page work; --disable-gpu alone is not enough.
 *    The flag block is a pure platform-parameterized function so the darwin
 *    behavior (and the GSTACK_DISABLE_GPU=off escape) is testable on any host.
 *
 * 2. reapRecordedChromium: the headless launch has no SingletonLock, so
 *    killOrphanChromium was a structural no-op for it and `browse stop`
 *    reported success while the child spun on. The reap verifies identity two
 *    ways (recorded start time AND a Chromium-looking cmdline) before any
 *    signal — a recycled PID is never killed.
 */
import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { headlessGpuArgs } from '../src/browser-manager';
import { reapRecordedChromium } from '../src/cli';
import { readPidStartTime } from '../src/xvfb';
import { isProcessAlive } from '../src/error-handling';

describe('headlessGpuArgs (#2709)', () => {
  test('darwin gets the validated four-flag set', () => {
    expect(headlessGpuArgs('darwin', {})).toEqual([
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-gpu-compositing',
      '--disable-gpu-watchdog',
    ]);
  });

  test('GSTACK_DISABLE_GPU=off opts out (case-insensitive)', () => {
    expect(headlessGpuArgs('darwin', { GSTACK_DISABLE_GPU: 'off' })).toEqual([]);
    expect(headlessGpuArgs('darwin', { GSTACK_DISABLE_GPU: 'OFF' })).toEqual([]);
  });

  test('non-darwin platforms are untouched', () => {
    expect(headlessGpuArgs('linux', {})).toEqual([]);
    expect(headlessGpuArgs('win32', {})).toEqual([]);
  });
});

// /proc-based identity — Linux-only (CI + this repo's dev boxes); the
// darwin-side behavior is identical code over the same ps/proc helpers.
describe.skipIf(process.platform !== 'linux')('reapRecordedChromium identity gate (#2709)', () => {
  // A script whose PATH carries the chromium shape — `exec -a` renames don't
  // survive this distro's coreutils shebang re-exec, but the interpreter line
  // in /proc/<pid>/cmdline always includes the script path.
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');

  function spawnFakeChromium(): Promise<number> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-test-'));
    const script = path.join(dir, 'headless_shell');
    fs.writeFileSync(script, '#!/bin/bash\nsleep 30 &\nwait\n', { mode: 0o755 });
    return new Promise((resolve, reject) => {
      const child = spawn(script, [], { detached: true, stdio: 'ignore' });
      child.unref();
      child.once('spawn', () => resolve(child.pid!));
      child.once('error', reject);
    });
  }

  test('kills the child when pid + start time + cmdline all match', async () => {
    const pid = await spawnFakeChromium();
    await new Promise(r => setTimeout(r, 100));
    const startTime = readPidStartTime(pid);
    expect(startTime).not.toBe('');
    await reapRecordedChromium({ chromiumPid: pid, chromiumStartTime: startTime });
    expect(isProcessAlive(pid)).toBe(false);
  }, 15_000);

  test('never kills when the recorded start time mismatches (PID reuse)', async () => {
    const pid = await spawnFakeChromium();
    await new Promise(r => setTimeout(r, 100));
    try {
      await reapRecordedChromium({
        chromiumPid: pid,
        chromiumStartTime: 'Mon Jan  1 00:00:00 1990',
      });
      expect(isProcessAlive(pid)).toBe(true);
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }, 15_000);

  test('never kills a non-Chromium process even with a matching start time', async () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    child.unref();
    await new Promise(r => setTimeout(r, 100));
    const pid = child.pid!;
    try {
      const startTime = readPidStartTime(pid);
      await reapRecordedChromium({ chromiumPid: pid, chromiumStartTime: startTime });
      expect(isProcessAlive(pid)).toBe(true);
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }, 15_000);

  test('absent or dead pid is a quiet no-op', async () => {
    await reapRecordedChromium({});
    await reapRecordedChromium({ chromiumPid: 999999999, chromiumStartTime: 'x' });
  });
});

// ─── Source pins: the #2709 pieces stay WIRED ────────────────────────────
// The unit tests above prove headlessGpuArgs and reapRecordedChromium behave;
// these pins prove the daemon persists the child's identity, the CLI reaps on
// every stop/stale-cleanup path, and the GPU flags only ever reach a headless
// launch. Anchored to function names and call expressions, never line numbers.
describe('stop-reap wiring pins (#2709)', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const SRC = path.resolve(import.meta.dir, '..', 'src');
  const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf-8');

  test('server.ts persists chromiumPid/chromiumStartTime from getChromiumProcInfo() into the state file', () => {
    const src = read('server.ts');
    const stateStart = src.indexOf('const state: Record<string, unknown> = {');
    expect(stateStart, 'state-object literal not found in server.ts').toBeGreaterThan(-1);
    // The object literal ends where the daemon serializes it and renames the
    // tmp file into place — identity must be INSIDE what gets persisted.
    const stateEnd = src.indexOf('fs.renameSync(tmpFile, config.stateFile)', stateStart);
    expect(stateEnd, 'state-file rename not found after the state object').toBeGreaterThan(stateStart);
    const stateObj = src.slice(stateStart, stateEnd);
    expect(stateObj).toContain('browserManager.getChromiumProcInfo()');
    expect(stateObj).toContain('chromiumPid: info.pid');
    expect(stateObj).toContain('chromiumStartTime: info.startTime');
  });

  test('cli.ts reaps on every stop + stale-state path (>=5 call sites)', () => {
    const src = read('cli.ts');
    // Every call site awaits; the only other occurrence is the definition.
    expect(src).toContain('export async function reapRecordedChromium(');
    const callSites = src.split('await reapRecordedChromium(').length - 1;
    expect(callSites, 'a reap call site was removed — every stop/stale path must reap').toBeGreaterThanOrEqual(5);

    const between = (from: string, to: string) => {
      const a = src.indexOf(from);
      expect(a, `anchor not found in cli.ts: ${from}`).toBeGreaterThan(-1);
      const b = src.indexOf(to, a);
      expect(b, `anchor not found after "${from}": ${to}`).toBeGreaterThan(a);
      return src.slice(a, b);
    };

    // 1. Dead-daemon stop branch: reap BEFORE destroying the state file — the
    //    state file is the only carrier of the child's identity.
    const deadDaemon = between(
      '!isProcessAlive(stopState.pid) && !(await isServerHealthy(stopState.port))',
      'No daemon running (cleaned stale state)',
    );
    expect(deadDaemon).toMatch(
      /await reapRecordedChromium\(stopState\);[\s\S]*safeUnlinkQuiet\(config\.stateFile\);/,
    );

    // 2. Force-stop on a live daemon (stop --force-restart short-circuit).
    const forceStop = between(
      'isProcessAlive(stopState.pid) && globalFlags.forceRestart',
      'Daemon stopped (forced',
    );
    expect(forceStop).toContain('await reapRecordedChromium(stopState);');

    // 3. startServer stale-state cleanup, before safeUnlink(config.stateFile).
    const startServer = between('async function startServer(', 'safeUnlink(config.stateFile);');
    expect(startServer).toMatch(
      /const staleState = readState\(\);\s*\n\s*if \(staleState\) await reapRecordedChromium\(staleState\);/,
    );

    // 4. Headed-connect stale path: reap sits between killOrphanChromium()
    //    (which cannot see the lock-less headless child) and the unlink.
    const connect = between("if (command === 'connect')", 'Launching headed Chromium');
    expect(connect).toMatch(
      /await killOrphanChromium\(\);[\s\S]*if \(staleState\) await reapRecordedChromium\(staleState\);[\s\S]*safeUnlinkQuiet\(config\.stateFile\);/,
    );

    // 5. Post-graceful-stop: the daemon closed Chromium via Playwright, but a
    //    surviving GPU process must still be reaped after sendCommand('stop').
    const postStop = between('await sendCommand(state, command, commandArgs);', "if (command === 'focus')");
    expect(postStop).toMatch(
      /if \(command === 'stop'\) \{\s*\n\s*await reapRecordedChromium\(state\);/,
    );
  });

  test('browser-manager.ts pushes headlessGpuArgs only under the headless launch guard', () => {
    const src = read('browser-manager.ts');
    // Exactly one call site (the exported definition aside) — a second,
    // unguarded push would strip the GPU from headed/GBrowser sessions.
    const calls = src.match(/headlessGpuArgs\(process\.platform, process\.env\)/g) ?? [];
    expect(calls.length).toBe(1);
    // And that one call site is guarded by the headless flag: the extensions
    // path above it forces useHeadless = false, so extension-loaded and headed
    // launches never receive the GPU-disable flags.
    expect(src).toMatch(
      /if \(useHeadless\) \{\s*\n\s*launchArgs\.push\(\.\.\.headlessGpuArgs\(process\.platform, process\.env\)\);\s*\n\s*\}/,
    );
  });
});
