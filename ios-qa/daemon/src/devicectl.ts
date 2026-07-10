// Thin wrappers around `xcrun devicectl` and DNS resolution. Every function
// here is unit-testable in isolation by injecting a spawnImpl + resolveImpl.
//
// Production code uses the defaults: spawnSync('xcrun', [...]) and
// dns.lookup('<host>.coredevice.local'). Tests inject stubs.

import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export interface DeviceEntry {
  identifier: string;
  name: string;
  model: string;
  state: string; // "connected" | "available" | "available (paired)" | ...
  paired: boolean;
}

export interface SpawnImpl {
  (cmd: string, args: string[]): SpawnSyncReturns<Buffer>;
}

export interface ResolveImpl {
  (hostname: string): Promise<string[]>; // returns IPv6 addresses
}

const defaultSpawn: SpawnImpl = (cmd, args) => spawnSync(cmd, args, { stdio: 'pipe', timeout: 60_000 });

/**
 * Default resolver. Uses `dns.lookup` (getaddrinfo, goes through mDNSResponder
 * on macOS) instead of `dns.resolve6` (libresolv, does NOT consult mDNS on
 * recent macOS — returns ESERVFAIL for `*.coredevice.local`).
 *
 * Prefer the IPv6 record but fall back to whatever getaddrinfo returns.
 */
const defaultResolve: ResolveImpl = async (hostname) => {
  const dns = await import('dns');
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { family: 6, all: true }, (err, addrs) => {
      if (err) { reject(err); return; }
      const ipv6 = (addrs ?? []).filter((a) => a.family === 6).map((a) => a.address);
      if (ipv6.length === 0) { reject(new Error(`no IPv6 records for ${hostname}`)); return; }
      resolve(ipv6);
    });
  });
};

/**
 * Last-resort resolver using `dns.resolve6`. Kept for backwards compatibility
 * and for environments where mDNSResponder is not in the resolver chain. On
 * macOS 26.x (Darwin 25.x) this typically fails with ESERVFAIL — see comment
 * on `defaultResolve` above.
 */
const legacyResolve6: ResolveImpl = async (hostname) => {
  const dns = await import('dns');
  return new Promise((resolve, reject) => {
    dns.resolve6(hostname, (err, addrs) => {
      if (err) reject(err);
      else resolve(addrs);
    });
  });
};

/**
 * List devices currently known to CoreDevice. Includes connected, paired,
 * and pairing-in-progress devices.
 */
export function listDevices(spawn: SpawnImpl = defaultSpawn): DeviceEntry[] {
  const tmp = join(tmpdir(), `devicectl-list-${process.pid}-${Date.now()}.json`);
  try {
    const r = spawn('xcrun', ['devicectl', 'list', 'devices', '--json-output', tmp]);
    if (r.status !== 0) return [];
    const raw = readFileSync(tmp, 'utf-8');
    const obj = JSON.parse(raw);
    const list = (obj.result?.devices ?? []) as Array<Record<string, unknown>>;
    return list.map((d) => {
      const conn = d.connectionProperties as Record<string, unknown> | undefined;
      const props = d.deviceProperties as Record<string, unknown> | undefined;
      const hw = d.hardwareProperties as Record<string, unknown> | undefined;
      const pairingState = String(conn?.pairingState ?? '');
      return {
        identifier: String(d.identifier ?? ''),
        name: String(props?.name ?? 'unknown'),
        model: String(hw?.productType ?? 'unknown'),
        state: String(conn?.tunnelState ?? 'unknown'),
        paired: pairingState === 'paired',
      };
    });
  } catch {
    return [];
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * Resolve the CoreDevice tunnel's IPv6 address from `devicectl device info
 * details --json-output`. This is the most reliable path on macOS 26.x: the
 * tunnel IPv6 lives in `result.connectionProperties.tunnelIPAddress` and is
 * authoritative (it's what CoreDevice itself uses to route).
 *
 * A side effect of running `devicectl device info details` is that it forces
 * CoreDevice to bring up / refresh the tunnel session, which is why we prefer
 * this over mDNS even on machines where mDNS works.
 *
 * Returns null when the device isn't found, isn't tunneled, or devicectl
 * fails — callers should fall through to mDNS resolution.
 */
export function getDeviceTunnelIPv6FromDevicectl(
  udid: string,
  spawn: SpawnImpl = defaultSpawn,
): string | null {
  const tmp = join(tmpdir(), `devicectl-details-${process.pid}-${Date.now()}.json`);
  try {
    const r = spawn('xcrun', ['devicectl', 'device', 'info', 'details', '--device', udid, '--json-output', tmp]);
    if (r.status !== 0) return null;
    const raw = readFileSync(tmp, 'utf-8');
    const obj = JSON.parse(raw);
    // `result.connectionProperties.tunnelIPAddress` is the canonical location.
    // Some Xcode/CoreDevice versions also surface it under `result.tunnel.ipAddress`
    // — accept either.
    const conn = obj?.result?.connectionProperties as Record<string, unknown> | undefined;
    const tunnel = obj?.result?.tunnel as Record<string, unknown> | undefined;
    const addr = (conn?.tunnelIPAddress ?? tunnel?.ipAddress) as string | undefined;
    if (typeof addr === 'string' && addr.includes(':')) return addr;
    return null;
  } catch {
    return null;
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * Start a periodic devicectl `info details` poll that keeps the CoreDevice
 * tunnel session alive. Xcode 26's CoreDevice only holds the tunnel up while
 * a devicectl command is in-flight or Xcode itself is debugging. Without
 * something poking it, the tunnel IPv6 becomes unroutable within seconds —
 * `curl` to the address times out even though the address looks valid.
 *
 * Implementation note: we chose `device info details` (cheap, ~10ms of CPU
 * per tick, no persistent child process) over `device console` (which would
 * keep the tunnel up continuously but spams stdout, can wedge on backpressure,
 * and is harder to kill cleanly). The 5-second interval is comfortably under
 * the empirically-observed tunnel teardown timeout (~10-15s of idle).
 *
 * Returns a `stop()` function that cancels the timer. Safe to call multiple
 * times.
 */
export function startTunnelKeepalive(
  udid: string,
  opts: { intervalMs?: number; spawn?: SpawnImpl } = {},
): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? 5_000;
  const spawn = opts.spawn ?? defaultSpawn;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    // Fire-and-forget: ignore result, the side-effect of the spawn is what
    // keeps the tunnel up. We deliberately do not use the JSON output here.
    try {
      const tmp = join(tmpdir(), `devicectl-keepalive-${process.pid}-${Date.now()}.json`);
      spawn('xcrun', ['devicectl', 'device', 'info', 'details', '--device', udid, '--json-output', tmp]);
      try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    } catch { /* ignore — next tick will retry */ }
  };
  const handle = setInterval(tick, intervalMs);
  // Don't keep the event loop alive just for this — daemon owns the lifecycle.
  if (typeof handle.unref === 'function') handle.unref();
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(handle);
    },
  };
}

/**
 * Resolve the CoreDevice tunnel's IPv6 address for a device. The hostname is
 * derived from the device name as printed by `devicectl list devices`. The
 * resolved address looks like `fd72:8347:2ead::1` — RFC 4193 ULA, regenerated
 * per session.
 */
export async function getDeviceTunnelIPv6(
  deviceName: string,
  resolve: ResolveImpl = defaultResolve,
): Promise<string | null> {
  // CoreDevice mDNS host: lowercase, spaces and apostrophes → hyphens, plus
  // ".coredevice.local" suffix. Apple normalizes "Garry's Durendal" to
  // "Garrys-Durendal.coredevice.local".
  const slug = deviceName
    .replace(/['']/g, '')           // strip apostrophes
    .replace(/[\s_]+/g, '-')        // spaces/underscores → hyphens
    .replace(/[^a-zA-Z0-9-]/g, '')  // anything else not URL-safe → drop
    + '.coredevice.local';
  try {
    const addrs = await resolve(slug);
    return addrs[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve a device's tunnel IPv6 using every strategy we know, in order of
 * decreasing reliability:
 *
 *   1. `devicectl device info details --json-output` (most reliable on
 *      macOS 26.x; also has the useful side-effect of bumping the tunnel).
 *   2. mDNS via `dns.lookup` (getaddrinfo path — does consult mDNSResponder
 *      on macOS, unlike `dns.resolve6`).
 *   3. mDNS via `dns.resolve6` (legacy path — kept for backwards
 *      compatibility; will ESERVFAIL on recent macOS).
 *
 * Returns the first address that any strategy yields, or null.
 */
export async function resolveTunnelIPv6(opts: {
  udid: string;
  deviceName: string;
  spawn?: SpawnImpl;
  resolve?: ResolveImpl;
  legacyResolve?: ResolveImpl;
}): Promise<string | null> {
  const spawn = opts.spawn ?? defaultSpawn;
  const resolveLookup = opts.resolve ?? defaultResolve;
  const resolveLegacy = opts.legacyResolve ?? legacyResolve6;

  // 1. devicectl-based
  const fromDevicectl = getDeviceTunnelIPv6FromDevicectl(opts.udid, spawn);
  if (fromDevicectl) return fromDevicectl;

  // 2. mDNS via dns.lookup
  const fromLookup = await getDeviceTunnelIPv6(opts.deviceName, resolveLookup);
  if (fromLookup) return fromLookup;

  // 3. last-resort: legacy dns.resolve6
  const fromLegacy = await getDeviceTunnelIPv6(opts.deviceName, resolveLegacy);
  return fromLegacy;
}

/**
 * Check whether a specific bundle ID has a running process on the device.
 */
export function isAppRunning(
  udid: string,
  bundleId: string,
  spawn: SpawnImpl = defaultSpawn,
): boolean {
  const tmp = join(tmpdir(), `devicectl-procs-${process.pid}-${Date.now()}.json`);
  try {
    const r = spawn('xcrun', ['devicectl', 'device', 'info', 'processes', '-d', udid, '--json-output', tmp]);
    if (r.status !== 0) return false;
    const raw = readFileSync(tmp, 'utf-8');
    return raw.includes(`/${bundleId}/`) || raw.includes(`/${bundleId}.app/`);
  } catch {
    return false;
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * Launch an app on the device. Returns true on success, false otherwise.
 * Locked-device errors (the iPhone needs to be unlocked first) are surfaced
 * through the error string.
 */
export function launchApp(
  udid: string,
  bundleId: string,
  spawn: SpawnImpl = defaultSpawn,
): { ok: boolean; error?: string } {
  const r = spawn('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', udid, bundleId]);
  if (r.status === 0) return { ok: true };
  const err = (r.stderr?.toString() ?? '') + (r.stdout?.toString() ?? '');
  if (err.includes('was not, or could not be, unlocked')) {
    return { ok: false, error: 'device_locked' };
  }
  if (err.includes('FBSOpenApplicationServiceErrorDomain')) {
    return { ok: false, error: 'launch_failed' };
  }
  return { ok: false, error: err.split('\n')[0] ?? 'unknown' };
}

/**
 * Copy a file out of an app's data container. Used to scrape the boot token
 * from `tmp/gstack-ios-qa.token` after the StateServer starts.
 */
export function copyFileFromAppContainer(opts: {
  udid: string;
  bundleId: string;
  sourceRelativePath: string;
  spawn?: SpawnImpl;
}): string | null {
  const spawn = opts.spawn ?? defaultSpawn;
  const dir = mkdtempSync(join(tmpdir(), 'gstack-ios-copy-'));
  const dest = join(dir, 'fetched');
  try {
    const r = spawn('xcrun', [
      'devicectl', 'device', 'copy', 'from',
      '--device', opts.udid,
      '--domain-type', 'appDataContainer',
      '--domain-identifier', opts.bundleId,
      '--source', opts.sourceRelativePath,
      '--destination', dest,
    ]);
    if (r.status !== 0) return null;
    return readFileSync(dest, 'utf-8').replace(/[\r\n]+$/, '');
  } catch {
    return null;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Install an .app bundle on the device. The bundle must be signed with a
 * dev/distribution profile that includes the device.
 */
export function installApp(
  udid: string,
  appBundlePath: string,
  spawn: SpawnImpl = defaultSpawn,
): { ok: boolean; error?: string } {
  const r = spawn('xcrun', ['devicectl', 'device', 'install', 'app', '--device', udid, appBundlePath]);
  if (r.status === 0) return { ok: true };
  return { ok: false, error: (r.stderr?.toString() ?? r.stdout?.toString() ?? 'unknown').split('\n')[0] };
}
