// Bootstrap the CoreDevice tunnel to a connected iPhone running the iOS app
// under test. Orchestrates the full hand-rolled flow we verified end-to-end:
//
//   1. find a paired, connected device via devicectl list devices
//   2. launch the app on it (no-op if already running)
//   3. wait briefly for the in-app StateServer to start
//   4. copy the boot token from the app's sandbox via devicectl copy from
//      If an earlier daemon already consumed it, relaunch the app once to mint
//      a fresh boot token, then verify the relaunched StateServer again.
//   5. POST /auth/rotate to swap boot token → fresh in-memory token
//   6. return a DeviceTunnel pointing at the device's IPv6 with the rotated
//      bearer that subsequent proxied requests carry
//
// Step 5 is critical: after rotation, anything scraping os_log or the
// on-disk token file sees a dead credential. The Mac daemon holds the only
// live token, which it scopes per-tailnet-session via /auth/mint.

import { randomBytes } from 'crypto';
import { spawnSync } from 'child_process';
import type { DeviceTunnel } from './proxy';
import {
  listDevices,
  resolveTunnelIPv6,
  isAppRunning,
  launchApp,
  copyFileFromAppContainer,
  type DeviceEntry,
  type SpawnImpl,
  type ResolveImpl,
} from './devicectl';

export interface BootstrapOptions {
  /** Target iPhone UDID. If null, picks the best connected paired iPhone. */
  udid?: string;
  /** Bundle ID of the iOS app hosting the StateServer. */
  bundleId: string;
  /** StateServer port. Defaults to 9999. */
  port?: number;
  /** Token-path inside the app sandbox (relative to data container). */
  bootTokenPath?: string;
  /** Max time to wait for the StateServer to start after launch (ms). */
  startupTimeoutMs?: number;
  /** Test injection. */
  spawnImpl?: SpawnImpl;
  resolveImpl?: ResolveImpl;
  fetchImpl?: typeof fetch;
}

export type BootstrapResult =
  | { ok: true; tunnel: DeviceTunnel }
  | { ok: false; error: BootstrapErrorReason; detail?: string };

export type BootstrapErrorReason =
  | 'no_devices'
  | 'no_paired_device'
  | 'device_not_found'
  | 'launch_failed'
  | 'device_locked'
  | 'state_server_unreachable'
  | 'wrong_app'
  | 'boot_token_unavailable'
  | 'rotate_failed'
  | 'resolve_failed';

function isIPhoneDevice(device: DeviceEntry): boolean {
  const platform = device.platform.trim().toLowerCase();
  const deviceType = device.deviceType.trim().toLowerCase();
  const model = device.model.trim().toLowerCase();

  // productType is present even on older CoreDevice versions. Prefer the
  // explicit platform/type fields when available, but retain productType as
  // a compatibility fallback. An explicit non-iOS platform always loses.
  if (platform && platform !== 'ios') return false;
  return deviceType === 'iphone' || model.startsWith('iphone');
}

function isAvailableDevice(device: Pick<DeviceEntry, 'state' | 'transport'>): boolean {
  const state = device.state.trim().toLowerCase();
  const transport = device.transport.trim().toLowerCase();
  // Xcode 26.6 / iOS 27 beta can report a USB-reachable iPhone as
  // tunnelState=disconnected until the next devicectl command establishes
  // the CoreDevice tunnel. The wired transport is the authoritative signal
  // in that transitional state. Stale devices have no wired transport.
  return state === 'connected'
    || state.startsWith('available')
    || (state === 'disconnected' && transport === 'wired');
}

function defaultDeviceRank(device: DeviceEntry): number {
  if (!device.paired || !isIPhoneDevice(device) || !isAvailableDevice(device)) return -1;

  const state = device.state.trim().toLowerCase();
  const transport = device.transport.trim().toLowerCase();
  // Prefer the USB-connected phone the user is actively working with. Then
  // prefer an established CoreDevice tunnel over a merely available device.
  return (transport === 'wired' ? 100 : 0)
    + (state === 'connected' ? 10 : 0)
    + (state.startsWith('available') ? 1 : 0);
}

function pickDefaultDevice(devices: DeviceEntry[]): DeviceEntry | undefined {
  let best: DeviceEntry | undefined;
  let bestRank = -1;
  for (const device of devices) {
    const rank = defaultDeviceRank(device);
    if (rank > bestRank) {
      best = device;
      bestRank = rank;
    }
  }
  return best;
}

const defaultSpawn: SpawnImpl = (cmd, args) => spawnSync(cmd, args, {
  stdio: 'pipe',
  timeout: 60_000,
});

function relaunchApp(
  udid: string,
  bundleId: string,
  spawn: SpawnImpl = defaultSpawn,
): { ok: true } | { ok: false; error: 'device_locked' | 'launch_failed'; detail?: string } {
  const r = spawn('xcrun', [
    'devicectl', 'device', 'process', 'launch',
    '--device', udid,
    '--terminate-existing',
    bundleId,
  ]);
  if (r.status === 0) return { ok: true };

  const detail = `${r.stderr?.toString() ?? ''}${r.stdout?.toString() ?? ''}`.trim();
  if (detail.includes('was not, or could not be, unlocked')) {
    return { ok: false, error: 'device_locked', detail };
  }
  return { ok: false, error: 'launch_failed', detail };
}

/**
 * Bootstrap a real CoreDevice tunnel to an iOS app's StateServer. Used by
 * the daemon's default tunnelProvider when GSTACK_IOS_TARGET_UDID is set
 * (or when the user wants real-device control instead of a stub).
 */
export async function bootstrapTunnel(opts: BootstrapOptions): Promise<BootstrapResult> {
  const port = opts.port ?? 9999;
  const tokenPath = opts.bootTokenPath ?? 'tmp/gstack-ios-qa.token';
  const startupTimeoutMs = opts.startupTimeoutMs ?? 5_000;
  const spawn = opts.spawnImpl;
  const resolve = opts.resolveImpl;
  const fetchFn = opts.fetchImpl ?? fetch;

  // Step 1: pick a device
  const devices = listDevices(spawn);
  if (devices.length === 0) {
    return { ok: false, error: 'no_devices' };
  }
  const target = opts.udid
    ? devices.find((d) => d.identifier === opts.udid)
    : pickDefaultDevice(devices);
  if (!target) {
    if (opts.udid) {
      return { ok: false, error: 'device_not_found', detail: opts.udid };
    }
    const pairedIPhone = devices.find((d) => d.paired && isIPhoneDevice(d));
    if (pairedIPhone) {
      return {
        ok: false,
        error: 'device_not_found',
        detail: `paired iPhone ${pairedIPhone.name} (${pairedIPhone.identifier}) is ${pairedIPhone.state}; connect it over USB and unlock it`,
      };
    }
    const firstIPhone = devices.find(isIPhoneDevice);
    if (!firstIPhone) {
      return {
        ok: false,
        error: 'device_not_found',
        detail: 'no iPhone is connected; non-iOS devices are not eligible for iOS QA',
      };
    }
    return {
      ok: false,
      error: 'no_paired_device',
      detail: `device ${firstIPhone.name} (${firstIPhone.identifier}) is ${firstIPhone.state}; run \`xcrun devicectl manage pair --device ${firstIPhone.identifier}\` and tap Trust on the iPhone`,
    };
  }
  if (!isIPhoneDevice(target)) {
    return {
      ok: false,
      error: 'device_not_found',
      detail: `device ${target.name} (${target.identifier}) is ${target.platform || target.model}, not an iPhone`,
    };
  }
  if (!target.paired) {
    return {
      ok: false,
      error: 'no_paired_device',
      detail: `device ${target.name} (${target.identifier}) is ${target.state}; run \`xcrun devicectl manage pair --device ${target.identifier}\` and tap Trust on the iPhone`,
    };
  }
  if (!isAvailableDevice(target)) {
    return {
      ok: false,
      error: 'device_not_found',
      detail: `device ${target.name} (${target.identifier}) is ${target.state}; connect it over USB and unlock it`,
    };
  }

  // Step 2: launch app (idempotent — devicectl returns success if already running)
  if (!isAppRunning(target.identifier, opts.bundleId, spawn)) {
    const launched = launchApp(target.identifier, opts.bundleId, spawn);
    if (!launched.ok) {
      return { ok: false, error: launched.error === 'device_locked' ? 'device_locked' : 'launch_failed', detail: launched.error };
    }
  }

  // Step 3: resolve tunnel IPv6. Try devicectl `info details` first (most
  // reliable on macOS 26.x), fall through to mDNS via dns.lookup, then
  // dns.resolve6 as a last-ditch fallback. See devicectl.ts:resolveTunnelIPv6
  // for the rationale.
  // When tests inject `resolve`, use it for both the mDNS-lookup path AND the
  // legacy resolve6 path — otherwise the legacy path would make a real DNS
  // call. In production, only `resolve` is set (to the dns.lookup-based
  // default) and the legacy path uses the real dns.resolve6.
  const ipv6 = await resolveTunnelIPv6({
    udid: target.identifier,
    deviceName: target.name,
    spawn,
    resolve,
    legacyResolve: resolve,
  });
  if (!ipv6) {
    return { ok: false, error: 'resolve_failed', detail: target.name };
  }

  // Step 4: wait for StateServer to become reachable, then scrape boot token.
  // Probe /healthz with retries (the listener can take a moment to bind).
  const waitForStateServer = async (): Promise<BootstrapResult | null> => {
    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const r = await fetchFn(`http://[${ipv6}]:${port}/healthz`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (r.ok) {
          const health = await r.json().catch(() => null) as { bundle_id?: string } | null;
          // Older bridges did not identify their bundle. Preserve compatibility,
          // but reject an explicit mismatch from current bridges: another debug
          // app already owns the fixed StateServer port on this device.
          if (health?.bundle_id && health.bundle_id !== opts.bundleId) {
            return {
              ok: false,
              error: 'wrong_app',
              detail: `expected ${opts.bundleId} but StateServer port ${port} belongs to ${health.bundle_id}; terminate the other debug app`,
            };
          }
          return null;
        }
      } catch { /* retry */ }
      await new Promise((res) => setTimeout(res, 250));
    }
    return {
      ok: false,
      error: 'state_server_unreachable',
      detail: `no /healthz response from [${ipv6}]:${port} within ${startupTimeoutMs}ms`,
    };
  };

  const healthFailure = await waitForStateServer();
  if (healthFailure) return healthFailure;

  const readBootToken = () => copyFileFromAppContainer({
    udid: target.identifier,
    bundleId: opts.bundleId,
    sourceRelativePath: tokenPath,
    spawn,
  });

  let bootToken = readBootToken();
  if (!bootToken) {
    // A healthy running app can lack a boot token when an earlier daemon
    // already rotated it. A new daemon has no way to recover that in-memory
    // bearer, so restart exactly once to make StateServer mint a fresh one.
    // The explicit bundle check above prevents disrupting an unrelated app
    // that happens to own the fixed StateServer port.
    const relaunched = relaunchApp(target.identifier, opts.bundleId, spawn);
    if (!relaunched.ok) {
      return { ok: false, error: relaunched.error, detail: relaunched.detail };
    }

    // The token is written before StateServer opens its listener. Waiting for
    // it first prevents a stale response from the terminating process from
    // being mistaken for readiness of the replacement process.
    const tokenDeadline = Date.now() + startupTimeoutMs;
    while (!bootToken && Date.now() < tokenDeadline) {
      bootToken = readBootToken();
      if (!bootToken) await new Promise((res) => setTimeout(res, 250));
    }
    if (!bootToken) {
      return {
        ok: false,
        error: 'boot_token_unavailable',
        detail: `couldn't read ${tokenPath} from ${opts.bundleId} after relaunch`,
      };
    }

    const relaunchedHealthFailure = await waitForStateServer();
    if (relaunchedHealthFailure) return relaunchedHealthFailure;
  }

  // Step 5: rotate the boot token to a fresh in-memory-only one.
  const rotatedToken = randomBytes(32).toString('base64url');
  try {
    const r = await fetchFn(`http://[${ipv6}]:${port}/auth/rotate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${bootToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ new_token: rotatedToken }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) {
      return { ok: false, error: 'rotate_failed', detail: `HTTP ${r.status}` };
    }
  } catch (err) {
    return { ok: false, error: 'rotate_failed', detail: (err as Error).message };
  }

  return {
    ok: true,
    tunnel: {
      udid: target.identifier,
      ipv6Addr: ipv6,
      port,
      bootTokenRotated: rotatedToken,
    },
  };
}
