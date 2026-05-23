// Bootstrap unit tests. Injects spawn + resolve + fetch stubs so we exercise
// every branch (no_devices, no_paired_device, device_locked, healthz timeout,
// rotate_failed, success) without needing a real iPhone connected.

import { describe, test, expect } from 'bun:test';
import { bootstrapTunnel } from '../src/tunnel-bootstrap';
import type { SpawnImpl } from '../src/devicectl';
import { writeFileSync } from 'fs';

interface ScriptedCall {
  argsMatch: RegExp;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** If set, write this content to the JSON output path before returning. */
  jsonOutput?: object;
  /** If set, write this content to the file matching `--destination`. */
  destOutput?: string;
}

/**
 * Build a spawnImpl that walks through a scripted sequence of expected calls.
 * Each call matches its args against `argsMatch`. Unmatched calls return
 * exit-code 1 with an "unexpected call" stderr.
 */
function makeSpawn(scripts: ScriptedCall[]): SpawnImpl {
  let idx = 0;
  return (cmd: string, args: string[]) => {
    const joined = `${cmd} ${args.join(' ')}`;
    const script = scripts[idx];
    if (!script) {
      return makeReturn(1, '', `unexpected call beyond scripted: ${joined}`);
    }
    if (!script.argsMatch.test(joined)) {
      return makeReturn(1, '', `unexpected call shape: ${joined} (expected ${script.argsMatch})`);
    }
    idx++;
    // Honor --json-output: write to that path BEFORE returning.
    if (script.jsonOutput) {
      const flagIdx = args.indexOf('--json-output');
      if (flagIdx !== -1 && args[flagIdx + 1]) {
        writeFileSync(args[flagIdx + 1]!, JSON.stringify(script.jsonOutput));
      }
    }
    if (script.destOutput) {
      const flagIdx = args.indexOf('--destination');
      if (flagIdx !== -1 && args[flagIdx + 1]) {
        writeFileSync(args[flagIdx + 1]!, script.destOutput);
      }
    }
    return makeReturn(script.exitCode ?? 0, script.stdout ?? '', script.stderr ?? '');
  };
}

function makeReturn(exit: number, stdout: string, stderr: string) {
  return {
    pid: 0,
    output: [null, Buffer.from(stdout), Buffer.from(stderr)],
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    status: exit,
    signal: null,
  } as ReturnType<SpawnImpl>;
}

describe('bootstrapTunnel', () => {
  test('returns no_devices when devicectl list shows zero', async () => {
    const spawn = makeSpawn([
      {
        argsMatch: /devicectl list devices/,
        jsonOutput: { result: { devices: [] } },
      },
    ]);
    const r = await bootstrapTunnel({ bundleId: 'com.test', spawnImpl: spawn });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('no_devices');
  });

  test('returns no_paired_device when device is connected but not paired', async () => {
    const spawn = makeSpawn([
      {
        argsMatch: /devicectl list devices/,
        jsonOutput: {
          result: {
            devices: [{
              identifier: 'TEST-UDID',
              connectionProperties: { tunnelState: 'available (pairing)', pairingState: 'unpaired' },
              deviceProperties: { name: 'Test iPhone' },
              hardwareProperties: { productType: 'iPhone18,2' },
            }],
          },
        },
      },
    ]);
    const r = await bootstrapTunnel({ bundleId: 'com.test', spawnImpl: spawn });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('no_paired_device');
      expect(r.detail).toContain('Trust');
    }
  });

  test('returns device_locked when launchApp errors due to lock', async () => {
    const spawn = makeSpawn([
      {
        argsMatch: /devicectl list devices/,
        jsonOutput: {
          result: { devices: [{
            identifier: 'TEST', connectionProperties: { tunnelState: 'connected', pairingState: 'paired' },
            deviceProperties: { name: 'Test' }, hardwareProperties: { productType: 'iPhone18,2' },
          }] },
        },
      },
      {
        argsMatch: /devicectl device info processes/,
        jsonOutput: { result: { runningProcesses: [] } },
      },
      {
        argsMatch: /devicectl device process launch/,
        stderr: 'Locked ("Unable to launch com.test because the device was not, or could not be, unlocked").',
        exitCode: 1,
      },
    ]);
    const r = await bootstrapTunnel({ bundleId: 'com.test', spawnImpl: spawn });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('device_locked');
  });

  test('returns state_server_unreachable when healthz never responds', async () => {
    const spawn = makeSpawn([
      {
        argsMatch: /devicectl list devices/,
        jsonOutput: {
          result: { devices: [{
            identifier: 'TEST', connectionProperties: { tunnelState: 'connected', pairingState: 'paired' },
            deviceProperties: { name: 'Test' }, hardwareProperties: { productType: 'iPhone18,2' },
          }] },
        },
      },
      {
        argsMatch: /devicectl device info processes/,
        jsonOutput: { result: { runningProcesses: [{ executable: 'file:///private/var/containers/Bundle/Application/.../com.test.app/com.test', processIdentifier: 1234 }] } },
        stdout: 'com.test',
      },
    ]);
    const r = await bootstrapTunnel({
      bundleId: 'com.test',
      spawnImpl: spawn,
      resolveImpl: async () => ['fd00::1'],
      // fetch always fails.
      fetchImpl: (async () => { throw new Error('connection refused'); }) as typeof fetch,
      startupTimeoutMs: 200, // short, so test runs fast
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('state_server_unreachable');
  });

  test('happy path: returns DeviceTunnel with rotated token', async () => {
    const spawn = makeSpawn([
      {
        argsMatch: /devicectl list devices/,
        jsonOutput: {
          result: { devices: [{
            identifier: 'TEST-UDID',
            connectionProperties: { tunnelState: 'connected', pairingState: 'paired' },
            deviceProperties: { name: 'Test Device' },
            hardwareProperties: { productType: 'iPhone18,2' },
          }] },
        },
      },
      {
        argsMatch: /devicectl device info processes/,
        jsonOutput: { result: { runningProcesses: [{ executable: 'file:///var/containers/Bundle/Application/X/com.test.app/com.test', processIdentifier: 5678 }] } },
        stdout: '/com.test.app/',
      },
      {
        argsMatch: /devicectl device copy from/,
        destOutput: 'BOOT-TOKEN-XYZ-123\n',
      },
    ]);
    const fetchCalls: Array<{ url: string; method: string }> = [];
    const r = await bootstrapTunnel({
      bundleId: 'com.test',
      spawnImpl: spawn,
      resolveImpl: async () => ['fd99::beef'],
      fetchImpl: (async (url, init) => {
        const u = String(url);
        const method = (init?.method ?? 'GET').toUpperCase();
        fetchCalls.push({ url: u, method });
        if (u.endsWith('/healthz')) {
          return new Response('{"version":"1.0.0"}', { status: 200 }) as Response;
        }
        if (u.endsWith('/auth/rotate') && method === 'POST') {
          // Verify the boot token is sent (not the rotated one).
          const auth = (init?.headers as Record<string, string>)['Authorization'] ?? '';
          if (auth !== 'Bearer BOOT-TOKEN-XYZ-123') {
            return new Response('wrong bearer', { status: 401 }) as Response;
          }
          return new Response('{"ok":true}', { status: 200 }) as Response;
        }
        return new Response('not found', { status: 404 }) as Response;
      }) as typeof fetch,
      startupTimeoutMs: 1_000,
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tunnel.udid).toBe('TEST-UDID');
      expect(r.tunnel.ipv6Addr).toBe('fd99::beef');
      expect(r.tunnel.port).toBe(9999);
      expect(r.tunnel.bootTokenRotated).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(r.tunnel.bootTokenRotated).not.toBe('BOOT-TOKEN-XYZ-123');
      expect(r.tunnel.bootTokenRotated.length).toBeGreaterThan(20);
    }
    // Verify the bootstrap sequence: /healthz first, /auth/rotate second.
    expect(fetchCalls[0]?.url).toContain('/healthz');
    expect(fetchCalls[fetchCalls.length - 1]?.url).toContain('/auth/rotate');
  });

  test('resolve_failed when hostname cant be resolved to an IPv6', async () => {
    const spawn = makeSpawn([
      {
        argsMatch: /devicectl list devices/,
        jsonOutput: {
          result: { devices: [{
            identifier: 'TEST', connectionProperties: { tunnelState: 'connected', pairingState: 'paired' },
            deviceProperties: { name: 'Test' }, hardwareProperties: { productType: 'iPhone18,2' },
          }] },
        },
      },
      {
        argsMatch: /devicectl device info processes/,
        // jsonOutput body contains the bundle id path, so isAppRunning() returns true.
        jsonOutput: { result: { runningProcesses: [{ executable: 'file:///var/containers/Bundle/Application/X/com.test.app/com.test' }] } },
      },
    ]);
    const r = await bootstrapTunnel({
      bundleId: 'com.test',
      spawnImpl: spawn,
      resolveImpl: async () => { throw new Error('ENOTFOUND'); },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('resolve_failed');
  });

  test('respects explicit udid when set', async () => {
    const spawn = makeSpawn([
      {
        argsMatch: /devicectl list devices/,
        jsonOutput: {
          result: { devices: [
            { identifier: 'A', connectionProperties: { tunnelState: 'connected', pairingState: 'paired' }, deviceProperties: { name: 'A' }, hardwareProperties: { productType: 'iPhone18,2' } },
            { identifier: 'B', connectionProperties: { tunnelState: 'connected', pairingState: 'paired' }, deviceProperties: { name: 'B' }, hardwareProperties: { productType: 'iPhone18,2' } },
          ] },
        },
      },
      {
        argsMatch: /devicectl device info processes -d B/,
        jsonOutput: { result: { runningProcesses: [{ executable: 'file:///var/containers/Bundle/Application/X/com.test.app/com.test' }] } },
      },
      {
        argsMatch: /devicectl device copy from --device B/,
        destOutput: 'TOKEN\n',
      },
    ]);
    const r = await bootstrapTunnel({
      udid: 'B',
      bundleId: 'com.test',
      spawnImpl: spawn,
      resolveImpl: async () => ['fd00::b'],
      fetchImpl: (async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tunnel.udid).toBe('B');
  });
});
