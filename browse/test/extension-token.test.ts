/**
 * Live behavioral tests for the v1.62 token-bootstrap contract:
 *
 *   - GET /health NEVER carries a token — not in headed mode, not for a
 *     chrome-extension:// Origin (the two pre-v1.62 carve-outs). IRON-RULE
 *     regression tests.
 *   - POST /extension-token releases the token ONLY to the pinned extension
 *     Origin (chrome-extension://GSTACK_EXTENSION_ID) with a loopback Host.
 *   - Host arrives with a port ('127.0.0.1:34567') and must be parsed to a
 *     hostname, not compared literally (amendment C9). 'localhost:34567'
 *     is accepted too.
 *   - The tunnel surface 404s /extension-token (not in TUNNEL_PATHS).
 *
 * Uses the buildFetchHandler factory (same pattern as server-factory.test.ts)
 * so no listener/browser is needed. Real-HTTP coverage (Host header set by
 * the network stack) lives in pair-agent-e2e.test.ts.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import * as crypto from 'crypto';
import {
  buildFetchHandler,
  GSTACK_EXTENSION_ID,
  type ServerConfig,
} from '../src/server';
import { __resetRegistry } from '../src/token-registry';
import { BrowserManager } from '../src/browser-manager';
import { resolveConfig } from '../src/config';

const PINNED_ORIGIN = `chrome-extension://${GSTACK_EXTENSION_ID}`;

function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const token = 'ext-token-test-' + crypto.randomBytes(16).toString('hex');
  return {
    authToken: token,
    browsePort: 34567,
    idleTimeoutMs: 1_800_000,
    config: resolveConfig(),
    browserManager: new BrowserManager(),
    startTime: Date.now(),
    ...overrides,
  };
}

function headedBrowserManager(): BrowserManager {
  const bm = new BrowserManager();
  // connectionMode is private; force the headed value the old /health
  // carve-out keyed on.
  (bm as any).connectionMode = 'headed';
  return bm;
}

function tokenRequest(headers: Record<string, string>): Request {
  // Direct handler invocation — no network stack to synthesize Host, so
  // every test sets it explicitly (Bun.serve always delivers one).
  return new Request('http://127.0.0.1:34567/extension-token', {
    method: 'POST',
    headers,
  });
}

describe('GET /health never carries a token (IRON RULE)', () => {
  beforeEach(() => __resetRegistry());

  test('headed mode: no token field in the body', async () => {
    const handle = buildFetchHandler(makeConfig({ browserManager: headedBrowserManager() }));
    const resp = await handle.fetchLocal(new Request('http://127.0.0.1:34567/health'), null);
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.token).toBeUndefined();
    expect(body.mode).toBe('headed');
  });

  test('chrome-extension Origin (even the pinned one): no token field', async () => {
    const handle = buildFetchHandler(makeConfig());
    const resp = await handle.fetchLocal(new Request('http://127.0.0.1:34567/health', {
      headers: { Origin: PINNED_ORIGIN },
    }), null);
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.token).toBeUndefined();
  });

  test('headed mode AND pinned chrome-extension Origin together: still no token', async () => {
    const handle = buildFetchHandler(makeConfig({ browserManager: headedBrowserManager() }));
    const resp = await handle.fetchLocal(new Request('http://127.0.0.1:34567/health', {
      headers: { Origin: PINNED_ORIGIN },
    }), null);
    const body = await resp.json() as any;
    expect(body.token).toBeUndefined();
  });
});

describe('POST /extension-token pinned-origin bootstrap', () => {
  beforeEach(() => __resetRegistry());

  test('pinned Origin + Host with port → 200 with the token', async () => {
    const cfg = makeConfig();
    const handle = buildFetchHandler(cfg);
    const resp = await handle.fetchLocal(tokenRequest({
      Origin: PINNED_ORIGIN,
      Host: '127.0.0.1:34567',
    }), null);
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.token).toBe(cfg.authToken);
  });

  test("Host 'localhost:34567' is accepted too (C9 hostname parse)", async () => {
    const cfg = makeConfig();
    const handle = buildFetchHandler(cfg);
    const resp = await handle.fetchLocal(tokenRequest({
      Origin: PINNED_ORIGIN,
      Host: 'localhost:34567',
    }), null);
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.token).toBe(cfg.authToken);
  });

  test('wrong extension Origin → 403, no token, no detail', async () => {
    const handle = buildFetchHandler(makeConfig());
    const resp = await handle.fetchLocal(tokenRequest({
      Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      Host: '127.0.0.1:34567',
    }), null);
    expect(resp.status).toBe(403);
    const body = await resp.json() as any;
    expect(body.token).toBeUndefined();
    // No detail about WHICH check failed
    expect(JSON.stringify(body)).not.toContain('origin');
    expect(JSON.stringify(body)).not.toContain('host');
  });

  test('missing Origin → 403', async () => {
    const handle = buildFetchHandler(makeConfig());
    const resp = await handle.fetchLocal(tokenRequest({
      Host: '127.0.0.1:34567',
    }), null);
    expect(resp.status).toBe(403);
  });

  test('web-page Origin → 403 (DNS-rebinding page cannot mint a token)', async () => {
    const handle = buildFetchHandler(makeConfig());
    const resp = await handle.fetchLocal(tokenRequest({
      Origin: 'http://evil.example.com',
      Host: '127.0.0.1:34567',
    }), null);
    expect(resp.status).toBe(403);
  });

  test('non-loopback Host → 403 even with the pinned Origin', async () => {
    const handle = buildFetchHandler(makeConfig());
    const resp = await handle.fetchLocal(tokenRequest({
      Origin: PINNED_ORIGIN,
      Host: 'evil.example.com:34567',
    }), null);
    expect(resp.status).toBe(403);
  });

  test('malformed Host → 403, not a crash', async () => {
    const handle = buildFetchHandler(makeConfig());
    const resp = await handle.fetchLocal(tokenRequest({
      Origin: PINNED_ORIGIN,
      Host: ':::not a host:::',
    }), null);
    expect(resp.status).toBe(403);
  });

  test('tunnel surface 404s /extension-token (not in TUNNEL_PATHS)', async () => {
    const handle = buildFetchHandler(makeConfig());
    const resp = await handle.fetchTunnel(tokenRequest({
      Origin: PINNED_ORIGIN,
      Host: '127.0.0.1:34567',
    }), null);
    expect(resp.status).toBe(404);
  });
});
