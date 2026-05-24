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

const defaultResolve: ResolveImpl = async (hostname) => {
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
