import { describe, test, expect } from 'bun:test';
import * as net from 'net';
import * as path from 'path';

const polyfillPath = path.resolve(import.meta.dir, '../src/bun-polyfill.cjs');

// Helper: bind a port and hold it open, returning a cleanup function
function occupyPort(port: number): Promise<() => Promise<void>> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => {
      resolve(() => new Promise<void>((r) => srv.close(() => r())));
    });
  });
}

// Helper: find a known-free port by binding to 0
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

describe('findPort / isPortAvailable', () => {

  test('isPortAvailable returns true for a free port', async () => {
    // Use the same isPortAvailable logic from server.ts
    const port = await getFreePort();

    const available = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(port, '127.0.0.1', () => {
        srv.close(() => resolve(true));
      });
    });

    expect(available).toBe(true);
  });

  test('isPortAvailable returns false for an occupied port', async () => {
    const port = await getFreePort();
    const release = await occupyPort(port);

    try {
      const available = await new Promise<boolean>((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.listen(port, '127.0.0.1', () => {
          srv.close(() => resolve(true));
        });
      });

      expect(available).toBe(false);
    } finally {
      await release();
    }
  });

  test('port is actually free after isPortAvailable returns true', async () => {
    // This is the core race condition test: after isPortAvailable says
    // a port is free, can we IMMEDIATELY bind to it?
    const port = await getFreePort();

    // Simulate isPortAvailable
    const isFree = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(port, '127.0.0.1', () => {
        srv.close(() => resolve(true));
      });
    });

    expect(isFree).toBe(true);

    // Now immediately try to bind — this would fail with the old
    // Bun.serve() polyfill approach because the test server's
    // listen() would still be pending
    const canBind = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(port, '127.0.0.1', () => {
        srv.close(() => resolve(true));
      });
    });

    expect(canBind).toBe(true);
  });

  test('polyfill Bun.serve stop() is fire-and-forget (async)', async () => {
    // Verify that the polyfill's stop() does NOT wait for the socket
    // to actually close — this is the root cause of the race condition.
    // On macOS/Linux the OS reclaims the port fast enough that the race
    // rarely manifests, but on Windows TIME_WAIT makes it 100% repro.
    const result = Bun.spawnSync(['node', '-e', `
      require('${polyfillPath}');
      const net = require('net');

      async function test() {
        const port = 10000 + Math.floor(Math.random() * 50000);

        const testServer = Bun.serve({
          port,
          hostname: '127.0.0.1',
          fetch: () => new Response('ok'),
        });

        // stop() returns undefined — it does NOT return a Promise,
        // so callers cannot await socket teardown
        const retval = testServer.stop();
        console.log(typeof retval === 'undefined' ? 'FIRE_AND_FORGET' : 'AWAITABLE');
      }

      test();
    `], { stdout: 'pipe', stderr: 'pipe' });

    const output = result.stdout.toString().trim();
    // Confirms the polyfill's stop() is fire-and-forget — callers
    // cannot wait for the port to be released, hence the race
    expect(output).toBe('FIRE_AND_FORGET');
  });

  test('net.createServer approach does not have the race condition', async () => {
    // Prove the fix: net.createServer with proper async bind/close
    // releases the port cleanly
    const result = Bun.spawnSync(['node', '-e', `
      const net = require('net');

      async function testFix() {
        const port = 10000 + Math.floor(Math.random() * 50000);

        // Simulate the NEW isPortAvailable: proper async bind/close
        const isFree = await new Promise((resolve) => {
          const srv = net.createServer();
          srv.once('error', () => resolve(false));
          srv.listen(port, '127.0.0.1', () => {
            srv.close(() => resolve(true));
          });
        });

        if (!isFree) {
          console.log('PORT_BUSY');
          return;
        }

        // Immediately try to bind — should succeed because close()
        // completed before the Promise resolved
        const canBind = await new Promise((resolve) => {
          const srv = net.createServer();
          srv.once('error', () => resolve(false));
          srv.listen(port, '127.0.0.1', () => {
            srv.close(() => resolve(true));
          });
        });

        console.log(canBind ? 'FIX_WORKS' : 'FIX_BROKEN');
      }

      testFix();
    `], { stdout: 'pipe', stderr: 'pipe' });

    const output = result.stdout.toString().trim();
    expect(output).toBe('FIX_WORKS');
  });

  test('isPortAvailable handles rapid sequential checks', async () => {
    // Stress test: check the same port multiple times in sequence
    const port = await getFreePort();
    const results: boolean[] = [];

    for (let i = 0; i < 5; i++) {
      const available = await new Promise<boolean>((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.listen(port, '127.0.0.1', () => {
          srv.close(() => resolve(true));
        });
      });
      results.push(available);
    }

    // All 5 checks should succeed — no leaked sockets
    expect(results).toEqual([true, true, true, true, true]);
  });
});
