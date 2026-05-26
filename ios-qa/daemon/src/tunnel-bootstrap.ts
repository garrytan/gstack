// Bootstrap the CoreDevice tunnel to a connected iPhone running the iOS app
// under test. Orchestrates the full hand-rolled flow we verified end-to-end:
//
//   1. find a paired, connected device via devicectl list devices
//   2. launch the app on it (no-op if already running)
//   3. wait briefly for the in-app StateServer to start
//   4. copy the boot token from the app's sandbox via devicectl copy from
//   5. POST /auth/rotate to swap boot token → fresh in-memory token
//   6. return a DeviceTunnel pointing at the device's IPv6 with the rotated
//      bearer that subsequent proxied requests carry
//
// Step 5 is critical: after rotation, anything scraping os_log or the
// on-disk token file sees a dead credential. The Mac daemon holds the only
// live token, which it scopes per-tailnet-session via /auth/mint.

import { randomBytes } from 'crypto';
import type { DeviceTunnel } from './proxy';
import {
  listDevices,
  resolveTunnelIPv6,
  isAppRunning,
  launchApp,
  copyFileFromAppContainer,
  type SpawnImpl,
  type ResolveImpl,
} from './devicectl';

export interface BootstrapOptions {
  /** Target device UDID. If null, picks the first connected paired device. */
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
  | 'boot_token_unavailable'
  | 'rotate_failed'
  | 'resolve_failed';

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
    : devices.find((d) => d.paired) ?? devices[0];
  if (!target) {
    return { ok: false, error: 'device_not_found', detail: opts.udid };
  }
  if (!target.paired) {
    return {
      ok: false,
      error: 'no_paired_device',
      detail: `device ${target.name} (${target.identifier}) is ${target.state}; run \`xcrun devicectl manage pair --device ${target.identifier}\` and tap Trust on the iPhone`,
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
  const deadline = Date.now() + startupTimeoutMs;
  let healthOK = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetchFn(`http://[${ipv6}]:${port}/healthz`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (r.ok) { healthOK = true; break; }
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 250));
  }
  if (!healthOK) {
    return { ok: false, error: 'state_server_unreachable', detail: `no /healthz response from [${ipv6}]:${port} within ${startupTimeoutMs}ms` };
  }

  const bootToken = copyFileFromAppContainer({
    udid: target.identifier,
    bundleId: opts.bundleId,
    sourceRelativePath: tokenPath,
    spawn,
  });
  if (!bootToken) {
    return { ok: false, error: 'boot_token_unavailable', detail: `couldn't read ${tokenPath} from ${opts.bundleId}` };
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
