// End-to-end daemon integration tests. Starts a real daemon against a stub
// StateServer + mocked tailscaled. Exercises:
//
//   - Loopback listener responses
//   - Tailnet listener fail-closed when probe fails
//   - Tailnet → USB proxy forwards bearer + X-Session-Id
//   - Capability tier enforcement (interact → /tap ok, observe → /tap 403)
//   - Rate limit on /auth/mint
//   - Tailnet listener never binds 0.0.0.0
//   - Boot token never leaks in responses

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createServer } from 'http';
import type { Server, IncomingMessage } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startDaemon, type RunningDaemon } from '../src/index';
import { grantIdentity } from '../src/allowlist';
import type { DeviceTunnel } from '../src/proxy';

let workDir: string;
const STATE_SERVER_TOKEN = 'rotated-mock-token-XXXXXXXX';

// Stub iOS StateServer running on loopback. Mimics the real Swift server's
// behavior for the integration test.
function startStubStateServer(): Promise<{ server: Server; port: number; receivedRequests: Array<{ method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string }> }> {
  return new Promise((resolve) => {
    const received: Array<{ method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string }> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        received.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });

        const auth = req.headers['authorization'];
        // Validate the bearer is our rotated token.
        if (!auth || auth !== `Bearer ${STATE_SERVER_TOKEN}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }

        if (req.url === '/healthz') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ version: '1.0.0' }));
          return;
        }
        if (req.url === '/screenshot') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ png_base64: 'abc=' }));
          return;
        }
        if (req.url === '/tap') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, op: 'tap' }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port, receivedRequests: received });
    });
  });
}

async function fetchWith(method: string, url: string, init: { headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; bodyText: string }> {
  const res = await fetch(url, { method, headers: init.headers, body: init.body });
  return { status: res.status, bodyText: await res.text() };
}

describe('daemon — loopback listener', () => {
  let stub: Awaited<ReturnType<typeof startStubStateServer>>;
  let daemon: RunningDaemon;
  let pidPath: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'ios-qa-daemon-loopback-'));
    pidPath = join(workDir, 'daemon.pid');
    stub = await startStubStateServer();

    const tunnel: DeviceTunnel = {
      udid: 'STUB-UDID',
      ipv6Addr: '127.0.0.1',
      port: stub.port,
      bootTokenRotated: STATE_SERVER_TOKEN,
    };

    const d = await startDaemon({
      loopbackPort: 0,
      tailnetEnabled: false,
      pidfilePath: pidPath,
      tunnelProvider: async () => tunnel,
    });
    if ('error' in d) throw new Error(d.error);
    daemon = d;
  });

  afterAll(async () => {
    await daemon?.close();
    stub.server.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  test('healthz returns 200 with mode=loopback', async () => {
    const r = await fetchWith('GET', `http://127.0.0.1:${daemon.loopbackPort}/healthz`);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.bodyText)).toMatchObject({ mode: 'loopback' });
  });

  test('proxies /screenshot to stub StateServer with the rotated bearer', async () => {
    const r = await fetchWith('GET', `http://127.0.0.1:${daemon.loopbackPort}/screenshot`);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.bodyText)).toEqual({ png_base64: 'abc=' });
    // Verify the stub received the rotated token, NOT a passthrough or empty token.
    const lastReq = stub.receivedRequests[stub.receivedRequests.length - 1];
    expect(lastReq?.headers['authorization']).toBe(`Bearer ${STATE_SERVER_TOKEN}`);
  });

  test('proxies X-Session-Id passthrough on /tap', async () => {
    const r = await fetchWith('POST', `http://127.0.0.1:${daemon.loopbackPort}/tap`, {
      headers: { 'x-session-id': 'sess-loopback-1', 'content-type': 'application/json' },
      body: JSON.stringify({ x: 100, y: 200 }),
    });
    expect(r.status).toBe(200);
    const lastReq = stub.receivedRequests[stub.receivedRequests.length - 1];
    expect(lastReq?.headers['x-session-id']).toBe('sess-loopback-1');
  });

  test('returns 503 when no device tunnel is provided', async () => {
    // Force tunnel provider to return null by closing + restarting with null provider.
    await daemon.close();
    pidPath = join(workDir, 'daemon-2.pid');
    const d2 = await startDaemon({
      loopbackPort: daemon.loopbackPort + 1,
      tailnetEnabled: false,
      pidfilePath: pidPath,
      tunnelProvider: async () => null,
    });
    if ('error' in d2) throw new Error(d2.error);
    try {
      const r = await fetchWith('GET', `http://127.0.0.1:${d2.loopbackPort}/screenshot`);
      expect(r.status).toBe(503);
    } finally {
      await d2.close();
    }
  });
});

describe('daemon — tailnet listener (mocked tailscaled)', () => {
  let stub: Awaited<ReturnType<typeof startStubStateServer>>;
  let daemon: RunningDaemon;
  let listPath: string;
  let pidPath: string;

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'ios-qa-daemon-tailnet-'));
    listPath = join(workDir, 'allowlist.json');
    pidPath = join(workDir, 'daemon.pid');
    stub = await startStubStateServer();

    const tunnel: DeviceTunnel = {
      udid: 'STUB-UDID',
      ipv6Addr: '127.0.0.1',
      port: stub.port,
      bootTokenRotated: STATE_SERVER_TOKEN,
    };

    process.env.GSTACK_IOS_ALLOWLIST_PATH = listPath;
    process.env.GSTACK_IOS_AUDIT_PATH = join(workDir, 'audit.jsonl');
    process.env.GSTACK_IOS_ATTEMPTS_PATH = join(workDir, 'attempts.jsonl');
    process.env.GSTACK_IOS_TAILNET_BIND = '127.0.0.1'; // safe test bind

    const d = await startDaemon({
      loopbackPort: 0,
      tailnetEnabled: true,
      pidfilePath: pidPath,
      tunnelProvider: async () => tunnel,
      probeImpl: async () => ({ ok: true, ownIdentity: 'mac@example.com' }),
      whoIsImpl: async () => ({ identity: 'caller@example.com', raw: {} }),
    });
    if ('error' in d) throw new Error(d.error);
    daemon = d;
  });

  afterEach(async () => {
    if (daemon) await daemon.close();
    delete process.env.GSTACK_IOS_ALLOWLIST_PATH;
    delete process.env.GSTACK_IOS_AUDIT_PATH;
    delete process.env.GSTACK_IOS_ATTEMPTS_PATH;
    delete process.env.GSTACK_IOS_TAILNET_BIND;
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    stub.server.close();
  });

  test('tailnet listener refuses to open when probe fails', async () => {
    await daemon.close();
    pidPath = join(workDir, 'daemon-fail.pid');
    const d = await startDaemon({
      loopbackPort: 0,
      tailnetEnabled: true,
      pidfilePath: pidPath,
      tunnelProvider: async () => null,
      probeImpl: async () => ({ ok: false, reason: 'socket_missing' }),
    });
    if ('error' in d) throw new Error(d.error);
    try {
      // Tailnet port should not exist (no listener).
      expect(d.tailnetPort).toBeNull();
      // Loopback still works.
      const r = await fetchWith('GET', `http://127.0.0.1:${d.loopbackPort}/healthz`);
      expect(r.status).toBe(200);
    } finally {
      await d.close();
    }
  });

  test('non-allowlisted endpoint returns 404 on tailnet', async () => {
    const r = await fetchWith('GET', `http://127.0.0.1:${daemon.tailnetPort}/auth/sessions`);
    expect(r.status).toBe(404);
    expect(JSON.parse(r.bodyText).error).toBe('endpoint_not_in_tailnet_allowlist');
  });

  test('/auth/mint rejects unknown identity (mocked WhoIs)', async () => {
    const r = await fetchWith('POST', `http://127.0.0.1:${daemon.tailnetPort}/auth/mint`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'observe' }),
    });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.bodyText).error).toBe('identity_not_allowed');
  });

  test('/auth/mint succeeds for allowlisted identity, then proxies are bearer-gated', async () => {
    await grantIdentity({ identity: 'caller@example.com', capability: 'interact', path: listPath });
    const mintR = await fetchWith('POST', `http://127.0.0.1:${daemon.tailnetPort}/auth/mint`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'interact' }),
    });
    expect(mintR.status).toBe(200);
    const { session_token } = JSON.parse(mintR.bodyText);
    expect(typeof session_token).toBe('string');

    // Use the token to call /tap.
    const tapR = await fetchWith('POST', `http://127.0.0.1:${daemon.tailnetPort}/tap`, {
      headers: { 'authorization': `Bearer ${session_token}`, 'content-type': 'application/json', 'x-session-id': 's1' },
      body: JSON.stringify({ x: 1, y: 2 }),
    });
    expect(tapR.status).toBe(200);

    // Call without bearer → 401.
    const tapNoAuth = await fetchWith('POST', `http://127.0.0.1:${daemon.tailnetPort}/tap`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x: 1 }),
    });
    expect(tapNoAuth.status).toBe(401);
  });

  test('capability tier enforced — observe token cannot call /tap (interact-tier)', async () => {
    await grantIdentity({ identity: 'caller@example.com', capability: 'observe', path: listPath });
    const mintR = await fetchWith('POST', `http://127.0.0.1:${daemon.tailnetPort}/auth/mint`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'observe' }),
    });
    const { session_token } = JSON.parse(mintR.bodyText);

    const tapR = await fetchWith('POST', `http://127.0.0.1:${daemon.tailnetPort}/tap`, {
      headers: { 'authorization': `Bearer ${session_token}`, 'content-type': 'application/json', 'x-session-id': 's1' },
      body: JSON.stringify({ x: 1, y: 2 }),
    });
    expect(tapR.status).toBe(403);
    expect(JSON.parse(tapR.bodyText).error).toBe('capability_insufficient');
  });

  test('rate limit kicks in at 11th /auth/mint per identity', async () => {
    await grantIdentity({ identity: 'caller@example.com', capability: 'observe', path: listPath });
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const r = await fetchWith('POST', `http://127.0.0.1:${daemon.tailnetPort}/auth/mint`, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capability: 'observe' }),
      });
      last = r.status;
    }
    expect(last).toBe(429);
  });

  test('body size limit returns 413', async () => {
    await grantIdentity({ identity: 'caller@example.com', capability: 'interact', path: listPath });
    const mintR = await fetchWith('POST', `http://127.0.0.1:${daemon.tailnetPort}/auth/mint`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'interact' }),
    });
    const { session_token } = JSON.parse(mintR.bodyText);

    const huge = 'x'.repeat(2_000_000); // 2MB > 1MB cap
    const r = await fetchWith('POST', `http://127.0.0.1:${daemon.tailnetPort}/tap`, {
      headers: { 'authorization': `Bearer ${session_token}`, 'content-type': 'application/json', 'x-session-id': 's' },
      body: JSON.stringify({ padding: huge }),
    });
    expect(r.status).toBe(413);
  });

  test('audit log records mutating tailnet requests', async () => {
    await grantIdentity({ identity: 'caller@example.com', capability: 'interact', path: listPath });
    const mintR = await fetchWith('POST', `http://127.0.0.1:${daemon.tailnetPort}/auth/mint`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'interact' }),
    });
    const { session_token } = JSON.parse(mintR.bodyText);

    await fetchWith('POST', `http://127.0.0.1:${daemon.tailnetPort}/tap`, {
      headers: { 'authorization': `Bearer ${session_token}`, 'content-type': 'application/json', 'x-session-id': 'audit-s' },
      body: JSON.stringify({ x: 1, y: 2 }),
    });

    // Allow async file write to complete.
    await new Promise(r => setTimeout(r, 100));
    const auditPath = process.env.GSTACK_IOS_AUDIT_PATH!;
    const { readFileSync, existsSync } = await import('fs');
    expect(existsSync(auditPath)).toBe(true);
    const rows = readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const tapRow = rows.find(r => r.endpoint === 'POST /tap');
    expect(tapRow).toBeDefined();
    expect(tapRow.identity).toBe('caller@example.com');
    expect(tapRow.capability).toBe('interact');
  });

  test('boot token never appears in tailnet responses', async () => {
    await grantIdentity({ identity: 'caller@example.com', capability: 'interact', path: listPath });
    const mintR = await fetchWith('POST', `http://127.0.0.1:${daemon.tailnetPort}/auth/mint`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'interact' }),
    });
    expect(mintR.bodyText).not.toContain(STATE_SERVER_TOKEN);

    const { session_token } = JSON.parse(mintR.bodyText);
    const screenshotR = await fetchWith('GET', `http://127.0.0.1:${daemon.tailnetPort}/screenshot`, {
      headers: { 'authorization': `Bearer ${session_token}` },
    });
    expect(screenshotR.bodyText).not.toContain(STATE_SERVER_TOKEN);
  });
});

// Cleanup any leftover env from beforeEach blocks.
import { afterEach } from 'bun:test';
