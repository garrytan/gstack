// Session-cache unit tests. The daemon persists the rotated bearer it obtains
// from a one-time boot-token rotate so that subsequent bootstraps (30s tunnel
// refresh, daemon restart, a new /ios-qa session) REUSE that bearer instead of
// re-copying the now-deleted single-use boot token. Without this, the second
// bootstrap after the first /auth/rotate fails with boot_token_unavailable
// (the StateServer deletes + invalidates the boot token on rotate), so a real
// device can be driven exactly once per app launch.
//
// All decision-logic tests inject cache + resolve + probe + bootstrap stubs so
// no real device / filesystem is needed. The round-trip tests use a temp file.

import { describe, test, expect, afterEach } from 'bun:test';
import {
  readSessionCache,
  writeSessionCache,
  clearSessionCache,
  acquireTunnel,
  type SessionCache,
} from '../src/session-cache';
import type { BootstrapResult } from '../src/tunnel-bootstrap';
import { mkdtempSync, rmSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmpFiles: string[] = [];
function tmpCachePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gstack-sc-'));
  const p = join(dir, 'ios-qa-session.json');
  tmpFiles.push(dir);
  return p;
}
afterEach(() => {
  while (tmpFiles.length) {
    const d = tmpFiles.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const SAMPLE: SessionCache = {
  udid: 'UDID-1',
  bundleId: 'com.test.app',
  port: 9999,
  rotatedToken: 'ROTATED-ABC-123',
  ipv6: 'fd00::1',
  createdAt: 1_700_000_000_000,
};

function okBootstrap(token = 'FRESH-ROTATED-999', ipv6 = 'fd00::2', udid = 'UDID-1'): () => Promise<BootstrapResult> {
  return async () => ({ ok: true, tunnel: { udid, ipv6Addr: ipv6, port: 9999, bootTokenRotated: token } });
}

describe('session cache file I/O', () => {
  test('write then read round-trips the cache', () => {
    const p = tmpCachePath();
    writeSessionCache(SAMPLE, p);
    const got = readSessionCache(p);
    expect(got).toEqual(SAMPLE);
  });

  test('writes the cache file with 0600 perms (owner-only)', () => {
    const p = tmpCachePath();
    writeSessionCache(SAMPLE, p);
    const mode = statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('read returns null for a missing file', () => {
    expect(readSessionCache(join(tmpdir(), 'definitely-missing-xyz.json'))).toBeNull();
  });

  test('clear removes the file and read then returns null', () => {
    const p = tmpCachePath();
    writeSessionCache(SAMPLE, p);
    expect(existsSync(p)).toBe(true);
    clearSessionCache(p);
    expect(existsSync(p)).toBe(false);
    expect(readSessionCache(p)).toBeNull();
  });
});

describe('acquireTunnel — reuse path', () => {
  test('reuses the cached rotated token when the probe succeeds (no bootstrap, no boot-token copy)', async () => {
    let bootstrapCalled = false;
    const tunnel = await acquireTunnel({
      bundleId: 'com.test.app',
      port: 9999,
      readCacheImpl: () => SAMPLE,
      writeCacheImpl: () => {},
      clearCacheImpl: () => {},
      resolveIPv6Impl: () => 'fd00::1',
      probeImpl: async () => 200,
      bootstrapImpl: async () => { bootstrapCalled = true; return { ok: false, error: 'no_devices' }; },
    });
    expect(bootstrapCalled).toBe(false);
    expect(tunnel).not.toBeNull();
    expect(tunnel!.bootTokenRotated).toBe('ROTATED-ABC-123');
    expect(tunnel!.udid).toBe('UDID-1');
  });

  test('reuse picks up a refreshed tunnel IPv6 and rewrites the cache', async () => {
    let written: SessionCache | null = null;
    const tunnel = await acquireTunnel({
      bundleId: 'com.test.app',
      port: 9999,
      readCacheImpl: () => SAMPLE, // cached ipv6 fd00::1
      writeCacheImpl: (c) => { written = c; },
      clearCacheImpl: () => {},
      resolveIPv6Impl: () => 'fd00::beef', // device now on a different tunnel addr
      probeImpl: async () => 200,
      bootstrapImpl: okBootstrap(),
    });
    expect(tunnel!.ipv6Addr).toBe('fd00::beef');
    expect(tunnel!.bootTokenRotated).toBe('ROTATED-ABC-123'); // token unchanged
    expect(written).not.toBeNull();
    expect(written!.ipv6).toBe('fd00::beef');
  });
});

describe('acquireTunnel — bootstrap path', () => {
  test('with no cache, runs a full bootstrap and persists the rotated token', async () => {
    let written: SessionCache | null = null;
    let probeCalled = false;
    const tunnel = await acquireTunnel({
      bundleId: 'com.test.app',
      port: 9999,
      readCacheImpl: () => null,
      writeCacheImpl: (c) => { written = c; },
      clearCacheImpl: () => {},
      resolveIPv6Impl: () => 'fd00::1',
      probeImpl: async () => { probeCalled = true; return 200; },
      bootstrapImpl: okBootstrap('FRESH-ROTATED-999', 'fd00::2', 'UDID-1'),
    });
    expect(probeCalled).toBe(false); // no cached token to probe
    expect(tunnel!.bootTokenRotated).toBe('FRESH-ROTATED-999');
    expect(written).not.toBeNull();
    expect(written!.rotatedToken).toBe('FRESH-ROTATED-999');
    expect(written!.ipv6).toBe('fd00::2');
  });

  test('when the cached token is rejected (401), clears cache then re-bootstraps', async () => {
    let cleared = false;
    let bootstrapCalled = false;
    let written: SessionCache | null = null;
    const tunnel = await acquireTunnel({
      bundleId: 'com.test.app',
      port: 9999,
      readCacheImpl: () => SAMPLE,
      writeCacheImpl: (c) => { written = c; },
      clearCacheImpl: () => { cleared = true; },
      resolveIPv6Impl: () => 'fd00::1',
      probeImpl: async () => 401, // app was relaunched → old rotated token dead
      bootstrapImpl: async () => { bootstrapCalled = true; return (await okBootstrap('NEW-TOKEN')()); },
    });
    expect(cleared).toBe(true);
    expect(bootstrapCalled).toBe(true);
    expect(tunnel!.bootTokenRotated).toBe('NEW-TOKEN');
    expect(written!.rotatedToken).toBe('NEW-TOKEN');
  });

  test('ignores a cache whose udid does not match an explicitly requested udid', async () => {
    let bootstrapCalled = false;
    const tunnel = await acquireTunnel({
      udid: 'UDID-OTHER',
      bundleId: 'com.test.app',
      port: 9999,
      readCacheImpl: () => SAMPLE, // cache is for UDID-1
      writeCacheImpl: () => {},
      clearCacheImpl: () => {},
      resolveIPv6Impl: () => 'fd00::1',
      probeImpl: async () => 200,
      bootstrapImpl: async () => { bootstrapCalled = true; return (await okBootstrap('X', 'fd00::9', 'UDID-OTHER')()); },
    });
    expect(bootstrapCalled).toBe(true);
    expect(tunnel!.udid).toBe('UDID-OTHER');
  });
});

describe('acquireTunnel — transient + failure handling', () => {
  test('returns null WITHOUT clearing the cache when the probe hits a connection error', async () => {
    let cleared = false;
    let bootstrapCalled = false;
    const tunnel = await acquireTunnel({
      bundleId: 'com.test.app',
      port: 9999,
      readCacheImpl: () => SAMPLE,
      writeCacheImpl: () => {},
      clearCacheImpl: () => { cleared = true; },
      resolveIPv6Impl: () => 'fd00::1',
      probeImpl: async () => 0, // connection refused / device momentarily unreachable
      bootstrapImpl: async () => { bootstrapCalled = true; return { ok: false, error: 'no_devices' }; },
    });
    expect(tunnel).toBeNull();
    expect(cleared).toBe(false); // do NOT destroy a good token on a transient blip
    expect(bootstrapCalled).toBe(false);
  });

  test('returns null and does not write cache when bootstrap fails', async () => {
    let written = false;
    const tunnel = await acquireTunnel({
      bundleId: 'com.test.app',
      port: 9999,
      readCacheImpl: () => null,
      writeCacheImpl: () => { written = true; },
      clearCacheImpl: () => {},
      resolveIPv6Impl: () => null,
      probeImpl: async () => 200,
      bootstrapImpl: async () => ({ ok: false, error: 'boot_token_unavailable', detail: 'gone' }),
    });
    expect(tunnel).toBeNull();
    expect(written).toBe(false);
  });
});

describe('acquireTunnel — diagnostics', () => {
  test('surfaces the bootstrap failure reason via logImpl', async () => {
    const logs: string[] = [];
    await acquireTunnel({
      bundleId: 'com.test.app',
      port: 9999,
      readCacheImpl: () => null,
      writeCacheImpl: () => {},
      clearCacheImpl: () => {},
      resolveIPv6Impl: () => null,
      probeImpl: async () => 200,
      bootstrapImpl: async () => ({ ok: false, error: 'boot_token_unavailable', detail: 'gone' }),
      logImpl: (m) => logs.push(m),
    });
    expect(logs.some((l) => l.includes('boot_token_unavailable'))).toBe(true);
  });

  test('logs that it reused a cached session token (no app relaunch needed)', async () => {
    const logs: string[] = [];
    await acquireTunnel({
      bundleId: 'com.test.app',
      port: 9999,
      readCacheImpl: () => SAMPLE,
      writeCacheImpl: () => {},
      clearCacheImpl: () => {},
      resolveIPv6Impl: () => 'fd00::1',
      probeImpl: async () => 200,
      bootstrapImpl: okBootstrap(),
      logImpl: (m) => logs.push(m),
    });
    expect(logs.some((l) => /reus/i.test(l))).toBe(true);
  });
});
