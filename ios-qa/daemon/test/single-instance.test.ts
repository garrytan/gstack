// Single-instance enforcement tests.
//
// Codex-flagged: spawn-race conditions, stale pidfile reclamation, readiness
// protocol timeout.

import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { tryClaim } from '../src/single-instance';

let tmpDir: string;
let pidPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ios-qa-pidfile-'));
  pidPath = join(tmpDir, 'daemon.pid');
});

describe('tryClaim', () => {
  test('first claim succeeds and writes pidfile', async () => {
    const r = await tryClaim({ port: 9099, path: pidPath });
    expect(r.claimed).toBe(true);
    expect(existsSync(pidPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(pidPath, 'utf-8'));
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.port).toBe(9099);
    if (r.claimed) await r.release();
  });

  test('second claim against same live PID returns existing', async () => {
    // Fake a live pidfile pointing to OUR pid (since we definitely exist).
    writeFileSync(pidPath, JSON.stringify({
      pid: process.pid,
      port: 9099,
      startedAt: Date.now(),
    }));
    const r = await tryClaim({ port: 9100, path: pidPath });
    expect(r.claimed).toBe(false);
    if (!r.claimed) {
      expect(r.existing.pid).toBe(process.pid);
      expect(r.existing.port).toBe(9099);
    }
  });

  test('claim reclaims stale pidfile (dead PID)', async () => {
    // PID 1 is init/launchd; pick a PID that doesn't exist. PID 999999 is
    // not assigned in any realistic system.
    writeFileSync(pidPath, JSON.stringify({
      pid: 999999,
      port: 9099,
      startedAt: Date.now() - 60_000,
    }));
    const r = await tryClaim({ port: 9100, path: pidPath });
    expect(r.claimed).toBe(true);
    if (r.claimed) {
      // New pidfile reflects us.
      const parsed = JSON.parse(readFileSync(pidPath, 'utf-8'));
      expect(parsed.pid).toBe(process.pid);
      expect(parsed.port).toBe(9100);
      await r.release();
    }
  });

  test('claim handles unparseable pidfile by reclaiming', async () => {
    writeFileSync(pidPath, 'not json');
    const r = await tryClaim({ port: 9101, path: pidPath });
    expect(r.claimed).toBe(true);
    if (r.claimed) await r.release();
  });

  // Codex-flagged: concurrent spawn race. Multiple invocations must result in
  // exactly one claim winning, with the rest seeing the winner's pidfile.
  test('concurrent claims race deterministically — exactly one wins', async () => {
    // Pre-clean: ensure no pidfile.
    if (existsSync(pidPath)) rmSync(pidPath);
    const N = 10;
    const promises: Promise<{ claimed: boolean }>[] = [];
    for (let i = 0; i < N; i++) {
      promises.push(tryClaim({ port: 9099 + i, path: pidPath }));
    }
    const results = await Promise.all(promises);
    const wins = results.filter(r => r.claimed);
    const losses = results.filter(r => !r.claimed);
    expect(wins.length).toBe(1);
    expect(losses.length).toBe(N - 1);
    // Cleanup the winner.
    const winner = wins[0] as unknown as { claimed: true; release: () => Promise<void> };
    await winner.release();
  });
});

import { afterEach } from 'bun:test';
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});
