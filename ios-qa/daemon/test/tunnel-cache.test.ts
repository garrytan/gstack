// tunnel-cache.test.ts
//
// Regression coverage for the tunnel-cache invalidation policy.
//
// Background: bootstrapTunnel rotates the StateServer boot token and the
// iOS-side StateServer *deletes* the boot-token file on disk immediately
// after handling /auth/rotate. The rotated bearer lives only in the
// daemon's memory. A wall-clock TTL on the tunnel cache therefore caused
// the daemon to re-bootstrap after the TTL window and fail with
// boot_token_unavailable on every subsequent request (observed live on an
// iPhone 12 Pro: first ~30s of /ios-qa worked, then 100% 503s).
//
// Correct policy:
//   - Cache the tunnel for the lifetime of the daemon (no TTL).
//   - Invalidate the cache only when the proxy reports the underlying
//     CoreDevice route is dead (503 device_disconnected).
//
// These tests exercise both legs via the tunnelProvider injection point.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createServer } from 'http';
import type { Server } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startDaemon, type RunningDaemon } from '../src/index';
import type { DeviceTunnel } from '../src/proxy';

interface Stub {
  server: Server;
  port: number;
  alive: { value: boolean };
}

function startStub(): Promise<Stub> {
  const alive = { value: true };
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      // Drop everything on the floor when "dead" to surface ECONNREFUSED
      // semantically. We model the dead state by destroying the socket,
      // which makes Node's http.request emit an error.
      if (!alive.value) {
        req.socket.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/screenshot') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ png_base64: 'abc=' }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port, alive });
    });
  });
}

async function fetchWith(method: string, url: string): Promise<{ status: number; bodyText: string }> {
  const res = await fetch(url, { method });
  return { status: res.status, bodyText: await res.text() };
}

describe('daemon — tunnel cache invalidation', () => {
  let workDir: string;
  let pidPath: string;
  let stub: Stub;
  let daemon: RunningDaemon | null = null;

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'ios-qa-tunnel-cache-'));
    pidPath = join(workDir, 'daemon.pid');
    stub = await startStub();
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.close();
      daemon = null;
    }
    stub.server.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  test('tunnelProvider is called exactly once across many sequential requests (no TTL re-bootstrap)', async () => {
    let bootstrapCount = 0;
    const tunnel: DeviceTunnel = {
      udid: 'STUB-UDID',
      ipv6Addr: '127.0.0.1',
      port: stub.port,
      bootTokenRotated: 'token-after-rotate',
    };

    const d = await startDaemon({
      loopbackPort: 0,
      tailnetEnabled: false,
      pidfilePath: pidPath,
      tunnelProvider: async () => {
        bootstrapCount += 1;
        return tunnel;
      },
    });
    if ('error' in d) throw new Error(d.error);
    daemon = d;

    for (let i = 0; i < 25; i++) {
      const r = await fetchWith('GET', `http://127.0.0.1:${d.loopbackPort}/screenshot`);
      expect(r.status).toBe(200);
    }

    // Bootstrap MUST have run exactly once. The pre-fix 30s TTL would have
    // re-bootstrapped on the first call after the window expired; even
    // ignoring time, this asserts a single bootstrap regardless.
    expect(bootstrapCount).toBe(1);
  });

  test('tunnel cache is dropped when proxy reports device_disconnected, then re-bootstrapped on next call', async () => {
    let bootstrapCount = 0;
    const tunnel: DeviceTunnel = {
      udid: 'STUB-UDID',
      ipv6Addr: '127.0.0.1',
      port: stub.port,
      bootTokenRotated: 'token-after-rotate',
    };

    const d = await startDaemon({
      loopbackPort: 0,
      tailnetEnabled: false,
      pidfilePath: pidPath,
      tunnelProvider: async () => {
        bootstrapCount += 1;
        return tunnel;
      },
    });
    if ('error' in d) throw new Error(d.error);
    daemon = d;

    // First call: bootstrap + 200.
    const r1 = await fetchWith('GET', `http://127.0.0.1:${d.loopbackPort}/screenshot`);
    expect(r1.status).toBe(200);
    expect(bootstrapCount).toBe(1);

    // Kill the upstream so the proxy surfaces ECONNREFUSED → 503 device_disconnected.
    stub.alive.value = false;
    stub.server.close();
    await new Promise((r) => setTimeout(r, 10));

    const r2 = await fetchWith('GET', `http://127.0.0.1:${d.loopbackPort}/screenshot`);
    expect(r2.status).toBe(503);
    expect(JSON.parse(r2.bodyText).error).toBe('device_disconnected');

    // After a device_disconnected, the cached tunnel must have been dropped.
    // Restart the stub on a fresh port and mutate the shared DeviceTunnel; the
    // next call must trigger a fresh tunnelProvider invocation.
    const stub2 = await startStub();
    try {
      tunnel.port = stub2.port;
      const r3 = await fetchWith('GET', `http://127.0.0.1:${d.loopbackPort}/screenshot`);
      expect(r3.status).toBe(200);
      // Critical assertion: the daemon re-bootstrapped after the disconnect.
      expect(bootstrapCount).toBe(2);
    } finally {
      stub2.server.close();
    }
  });
});
