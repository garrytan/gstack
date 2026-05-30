// Rotated-token session cache + reuse. This is the Mac-side half of the
// "bootstrap once per app launch" contract that SKILL.md Phase 0 (warm-start)
// describes but the daemon never implemented.
//
// WHY this exists: the in-app StateServer boot token is single-use. The first
// POST /auth/rotate sets bootTokenValid=false AND deletes the on-disk token
// file. The daemon, however, re-runs the full bootstrap (copy boot token +
// rotate) on every tunnel-cache refresh, daemon restart, and new /ios-qa
// session. The second bootstrap then finds the token file gone ->
// `boot_token_unavailable`, so a real device can be driven exactly once per
// app launch. Persisting the rotated bearer the daemon already holds, and
// reusing it after a cheap authenticated probe, makes re-bootstrap unnecessary.
//
// SECURITY: this changes nothing on the device. The StateServer stays
// loopback-only, every endpoint still requires the rotated bearer, and the boot
// token stays single-use. The only new artifact is a Mac-side 0600 cache file
// holding the rotated bearer (the same value SKILL.md Phase 0 already specifies
// the session cache holds), valid only while the app stays launched — a probe
// that returns 401 means the app was relaunched, so we drop the stale token and
// re-bootstrap from a freshly written boot token.

import { readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { bootstrapTunnel, type BootstrapOptions } from './tunnel-bootstrap';
import { getDeviceTunnelIPv6FromDevicectl, type SpawnImpl, type ResolveImpl } from './devicectl';
import type { DeviceTunnel } from './proxy';

export interface SessionCache {
  udid: string;
  bundleId: string;
  port: number;
  rotatedToken: string;
  ipv6: string;
  createdAt: number;
}

export function defaultSessionCachePath(): string {
  return process.env.GSTACK_IOS_SESSION_CACHE
    ?? join(homedir(), '.gstack', 'ios-qa-session.json');
}

/** Read the session cache. Returns null on missing/unreadable/corrupt file. */
export function readSessionCache(path: string = defaultSessionCachePath()): SessionCache | null {
  try {
    const obj = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SessionCache>;
    if (
      obj && typeof obj.udid === 'string' && typeof obj.bundleId === 'string'
      && typeof obj.port === 'number' && typeof obj.rotatedToken === 'string'
      && typeof obj.ipv6 === 'string' && typeof obj.createdAt === 'number'
    ) {
      return obj as SessionCache;
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist the session cache with owner-only (0600) perms. */
export function writeSessionCache(cache: SessionCache, path: string = defaultSessionCachePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cache), { mode: 0o600 });
  // writeFileSync's mode only applies on create; force 0600 on overwrite too.
  chmodSync(path, 0o600);
}

/** Remove the session cache (best-effort). */
export function clearSessionCache(path: string = defaultSessionCachePath()): void {
  try { rmSync(path, { force: true }); } catch { /* ignore */ }
}

export interface AcquireTunnelOptions {
  udid?: string;
  bundleId: string;
  port: number;
  /** Env vars to set if a cold-start bootstrap has to launch the app. */
  launchEnv?: Record<string, string>;
  // Injection seams (real defaults wire the production impls).
  cachePath?: string;
  readCacheImpl?: (path?: string) => SessionCache | null;
  writeCacheImpl?: (cache: SessionCache, path?: string) => void;
  clearCacheImpl?: (path?: string) => void;
  resolveIPv6Impl?: (udid: string) => string | null | Promise<string | null>;
  probeImpl?: (ipv6: string, port: number, token: string) => Promise<number>;
  bootstrapImpl?: (opts: BootstrapOptions) => Promise<import('./tunnel-bootstrap').BootstrapResult>;
  /** Diagnostic sink (defaults to no-op; the CLI wires it to stderr). */
  logImpl?: (msg: string) => void;
  // Pass-throughs to the underlying bootstrap.
  spawnImpl?: SpawnImpl;
  resolveImpl?: ResolveImpl;
  fetchImpl?: typeof fetch;
}

/**
 * Acquire a usable DeviceTunnel, reusing a cached rotated bearer when the
 * device still honors it and only falling back to a full boot-token bootstrap
 * when there is no usable cache or the cached bearer is rejected (app
 * relaunched). Returns null on a transient device-unreachable condition (cache
 * preserved) or a failed bootstrap.
 */
export async function acquireTunnel(opts: AcquireTunnelOptions): Promise<DeviceTunnel | null> {
  const cachePath = opts.cachePath;
  const readCache = opts.readCacheImpl ?? readSessionCache;
  const writeCache = opts.writeCacheImpl ?? writeSessionCache;
  const clearCache = opts.clearCacheImpl ?? clearSessionCache;
  const resolveIPv6 = opts.resolveIPv6Impl ?? ((udid: string) => getDeviceTunnelIPv6FromDevicectl(udid, opts.spawnImpl));
  const probe = opts.probeImpl ?? defaultProbe(opts.fetchImpl);
  const bootstrap = opts.bootstrapImpl ?? bootstrapTunnel;
  const log = opts.logImpl ?? (() => {});

  const cache = readCache(cachePath);
  const cacheUsable = !!cache
    && cache.bundleId === opts.bundleId
    && cache.port === opts.port
    && (!opts.udid || cache.udid === opts.udid);

  if (cache && cacheUsable) {
    const ipv6 = await resolveIPv6(cache.udid);
    if (!ipv6) { log('device unresolvable; keeping cached session token, will retry'); return null; }
    const status = await probe(ipv6, cache.port, cache.rotatedToken);
    if (status === 200) {
      if (ipv6 !== cache.ipv6) writeCache({ ...cache, ipv6 }, cachePath);
      log(`reusing cached session token for ${cache.udid} (no app relaunch needed)`);
      return { udid: cache.udid, ipv6Addr: ipv6, port: cache.port, bootTokenRotated: cache.rotatedToken };
    }
    if (status === 401 || status === 403) {
      log(`cached session token rejected (HTTP ${status}); app was relaunched — re-bootstrapping`);
      clearCache(cachePath); // app relaunched -> stale rotated token; re-bootstrap below
    } else {
      log(`device unreachable during token probe (HTTP ${status}); keeping cached token, will retry`);
      return null; // 0 (connection error) / 5xx — transient; do not discard a good token
    }
  }

  const result = await bootstrap({
    udid: opts.udid,
    bundleId: opts.bundleId,
    port: opts.port,
    launchEnv: opts.launchEnv,
    spawnImpl: opts.spawnImpl,
    resolveImpl: opts.resolveImpl,
    fetchImpl: opts.fetchImpl,
  });
  if (!result.ok) {
    log(`bootstrap error: ${result.error}${result.detail ? ' — ' + result.detail : ''}`);
    return null;
  }
  log(`bootstrapped fresh session token for ${result.tunnel.udid}`);

  writeCache({
    udid: result.tunnel.udid,
    bundleId: opts.bundleId,
    port: opts.port,
    rotatedToken: result.tunnel.bootTokenRotated,
    ipv6: result.tunnel.ipv6Addr,
    createdAt: Date.now(),
  }, cachePath);
  return result.tunnel;
}

function defaultProbe(fetchFn: typeof fetch = fetch) {
  return async (ipv6: string, port: number, token: string): Promise<number> => {
    const isIPv6 = (ipv6.match(/:/g)?.length ?? 0) >= 2;
    const host = isIPv6 ? `[${ipv6}]` : ipv6;
    try {
      const r = await fetchFn(`http://${host}:${port}/state/snapshot`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(4_000),
      });
      return r.status;
    } catch {
      return 0; // connection refused / timeout / tunnel down
    }
  };
}
