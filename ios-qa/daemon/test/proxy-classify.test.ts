// Tailnet endpoint allowlist + capability tier classification tests.
//
// Codex flagged: "tailnet listener allowlist is too broad. Remote agents
// should not get /state/* by default. Split capabilities: observe, interact,
// mutate state, restore state."

import { describe, test, expect } from 'bun:test';
import { classifyRoute, proxyToDevice } from '../src/proxy';
import { createServer } from 'http';
import type { IncomingMessage } from 'http';

describe('classifyRoute', () => {
  test('healthz, screenshot, elements, snapshot are observe-tier', () => {
    expect(classifyRoute('GET', '/healthz').requiredCapability).toBe('observe');
    expect(classifyRoute('GET', '/screenshot').requiredCapability).toBe('observe');
    expect(classifyRoute('GET', '/elements').requiredCapability).toBe('observe');
    expect(classifyRoute('GET', '/state/snapshot').requiredCapability).toBe('observe');
    expect(classifyRoute('GET', '/state/anyKey').requiredCapability).toBe('observe');
  });

  test('tap, swipe, type, session ops are interact-tier', () => {
    expect(classifyRoute('POST', '/tap').requiredCapability).toBe('interact');
    expect(classifyRoute('POST', '/swipe').requiredCapability).toBe('interact');
    expect(classifyRoute('POST', '/type').requiredCapability).toBe('interact');
    expect(classifyRoute('POST', '/session/acquire').requiredCapability).toBe('interact');
    expect(classifyRoute('POST', '/session/release').requiredCapability).toBe('interact');
    expect(classifyRoute('POST', '/session/heartbeat').requiredCapability).toBe('interact');
  });

  test('arbitrary state writes are mutate-tier', () => {
    expect(classifyRoute('POST', '/state/userIsLoggedIn').requiredCapability).toBe('mutate');
    expect(classifyRoute('POST', '/state/anyField').requiredCapability).toBe('mutate');
  });

  test('state/restore is restore-tier (highest)', () => {
    expect(classifyRoute('POST', '/state/restore').requiredCapability).toBe('restore');
  });

  test('mint endpoint is observe-tier (minimum bar to attempt mint)', () => {
    expect(classifyRoute('POST', '/auth/mint').requiredCapability).toBe('observe');
  });

  test('non-allowlisted endpoints return allowed=false', () => {
    expect(classifyRoute('POST', '/auth/sessions').allowed).toBe(false);
    expect(classifyRoute('GET', '/random').allowed).toBe(false);
    expect(classifyRoute('DELETE', '/anything').allowed).toBe(false);
    expect(classifyRoute('GET', '/auth/sessions').allowed).toBe(false); // loopback-only
  });
});

describe('proxyToDevice failure bounds and bundle assertions', () => {
  test('a suspended/non-responsive app returns a bounded 504', async () => {
    const server = createServer(() => {
      // Deliberately keep the connection open without headers or a body. This
      // is the observable shape of a CoreDevice route to a suspended app.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const started = Date.now();
    try {
      const result = await proxyToDevice({
        inbound: {
          method: 'GET',
          url: '/screenshot',
          headers: { 'content-type': 'application/json' },
        } as IncomingMessage,
        body: Buffer.alloc(0),
        tunnel: {
          udid: 'CORE-1',
          ipv6Addr: '127.0.0.1',
          port,
          bootTokenRotated: 'rotated-token',
        },
        sessionId: null,
        timeoutMs: 40,
      });
      expect(result.status).toBe(504);
      expect(JSON.parse(result.body.toString())).toEqual({ error: 'upstream_timeout' });
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('coordinate actions carry the expected active bundle assertion', async () => {
    let expectedBundleHeader: string | undefined;
    const server = createServer((req, res) => {
      expectedBundleHeader = req.headers['x-gstack-expected-bundle-id'] as string | undefined;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const result = await proxyToDevice({
        inbound: {
          method: 'POST',
          url: '/tap',
          headers: { 'content-type': 'application/json' },
        } as IncomingMessage,
        body: Buffer.from('{"x":10,"y":20}'),
        tunnel: {
          udid: 'CORE-1',
          bundleId: 'com.gstack.fixture',
          ipv6Addr: '127.0.0.1',
          port,
          bootTokenRotated: 'rotated-token',
        },
        sessionId: 'session-1',
      });
      expect(result.status).toBe(200);
      expect(expectedBundleHeader).toBe('com.gstack.fixture');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
