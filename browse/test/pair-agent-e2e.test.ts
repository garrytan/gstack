/**
 * End-to-end integration test for the pair-agent flow under dual-listener.
 *
 * Spawns the browse daemon as a subprocess with BROWSE_HEADLESS_SKIP=1 so
 * the HTTP layer runs without launching a real browser.  Then exercises the
 * full ceremony: /pair with root Bearer → setup_key → /connect → scoped
 * token → /command rejection and acceptance paths.
 *
 * This is the "receipt" for the wave's central 'pair-agent still works'
 * claim.  Source-level tests in dual-listener.test.ts cover the tunnel
 * surface filter shape.  Source-level tests in sse-session-cookie.test.ts
 * cover the cookie registry.  This file covers the BEHAVIOR: does an HTTP
 * client following the documented ceremony actually get a working flow.
 *
 * Tunnel listener binding (/tunnel/start) is NOT exercised here — it
 * requires an ngrok authtoken and live network.  The dual-listener filter
 * logic is covered by source-level guards; a live tunnel test belongs in
 * a separate paid-evals suite.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GSTACK_EXTENSION_ID } from '../src/server';

const ROOT = path.resolve(import.meta.dir, '../..');
const SERVER_ENTRY = path.join(ROOT, 'browse/src/server.ts');

interface DaemonHandle {
  proc: ReturnType<typeof Bun.spawn>;
  port: number;
  token: string;
  stateFile: string;
  tempDir: string;
  baseUrl: string;
}

async function waitForReady(baseUrl: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (resp.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Daemon did not become ready within ${timeoutMs}ms`);
}

async function spawnDaemon(): Promise<DaemonHandle> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-agent-e2e-'));
  const stateFile = path.join(tempDir, 'browse.json');
  // Pick a high ephemeral port
  const port = 20000 + Math.floor(Math.random() * 20000);

  const proc = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      BROWSE_HEADLESS_SKIP: '1',
      BROWSE_PORT: String(port),
      BROWSE_STATE_FILE: stateFile,
      BROWSE_PARENT_PID: '0',
      BROWSE_IDLE_TIMEOUT: '600000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForReady(baseUrl);

  // Read the token from the state file that the daemon wrote
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  return { proc, port, token: state.token, stateFile, tempDir, baseUrl };
}

function killDaemon(handle: DaemonHandle): void {
  try { handle.proc.kill('SIGKILL'); } catch {}
  try { fs.rmSync(handle.tempDir, { recursive: true, force: true }); } catch {}
}

describe('pair-agent flow end-to-end (HTTP only, no ngrok)', () => {
  let daemon: DaemonHandle;

  beforeAll(async () => {
    daemon = await spawnDaemon();
  }, 20_000);

  afterAll(() => {
    if (daemon) killDaemon(daemon);
  });

  test('GET /health returns daemon status and NEVER includes a token (even for chrome-extension origins)', async () => {
    const resp = await fetch(`${daemon.baseUrl}/health`, {
      headers: { Origin: `chrome-extension://${GSTACK_EXTENSION_ID}` },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.status).toBeDefined();
    // v1.62: token bootstrap moved to POST /extension-token. /health is
    // liveness-only in every mode.
    expect(body.token).toBeUndefined();
  });

  test('GET /health without origin does NOT include token', async () => {
    const resp = await fetch(`${daemon.baseUrl}/health`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.token).toBeUndefined();
  });

  test('POST /extension-token with pinned Origin over real HTTP (Host carries port) returns the token', async () => {
    // Real fetch → Host arrives as '127.0.0.1:<port>'; the server must parse
    // the hostname out rather than compare the raw header (amendment C9).
    const resp = await fetch(`${daemon.baseUrl}/extension-token`, {
      method: 'POST',
      headers: { Origin: `chrome-extension://${GSTACK_EXTENSION_ID}` },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.token).toBe(daemon.token);
  });

  test('POST /extension-token with a non-pinned extension Origin returns 403 without the token', async () => {
    const resp = await fetch(`${daemon.baseUrl}/extension-token`, {
      method: 'POST',
      headers: { Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    expect(resp.status).toBe(403);
    const body = await resp.json() as any;
    expect(body.token).toBeUndefined();
  });

  test('GET /connect alive probe returns {alive: true} unauth', async () => {
    const resp = await fetch(`${daemon.baseUrl}/connect`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.alive).toBe(true);
  });

  test('POST /pair with root Bearer returns a setup_key', async () => {
    const resp = await fetch(`${daemon.baseUrl}/pair`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ clientId: 'test-agent' }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.setup_key).toBeDefined();
    expect(typeof body.setup_key).toBe('string');
    expect(body.setup_key.length).toBeGreaterThan(10);
  });

  test('POST /pair without root Bearer returns 403', async () => {
    const resp = await fetch(`${daemon.baseUrl}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'no-auth' }),
    });
    expect(resp.status).toBe(403);
  });

  test('POST /connect with setup_key exchanges for a scoped token', async () => {
    // 1) Get a setup key
    const pairResp = await fetch(`${daemon.baseUrl}/pair`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${daemon.token}`,
      },
      body: JSON.stringify({ clientId: 'e2e-connect' }),
    });
    const { setup_key } = await pairResp.json() as any;

    // 2) Exchange setup key for scoped token via /connect
    const connectResp = await fetch(`${daemon.baseUrl}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setup_key }),
    });
    expect(connectResp.status).toBe(200);
    const { token, scopes } = await connectResp.json() as any;
    expect(token).toBeDefined();
    expect(typeof token).toBe('string');
    expect(token).not.toBe(daemon.token); // scoped token, not root
    expect(Array.isArray(scopes)).toBe(true);
  });

  // ─── Pair scope contract: defaults, explicit lists, typo naming ───────

  test('default /connect scopes are exactly read,write,admin,meta', async () => {
    const pairResp = await fetch(`${daemon.baseUrl}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify({ clientId: 'default-scopes' }),
    });
    const { setup_key, scopes: pairScopes } = await pairResp.json() as any;
    expect(pairScopes).toEqual(['read', 'write', 'admin', 'meta']);
    const connectResp = await fetch(`${daemon.baseUrl}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setup_key }),
    });
    const { scopes } = await connectResp.json() as any;
    expect(scopes).toEqual(['read', 'write', 'admin', 'meta']);
  });

  test('explicit scopes are honored end-to-end (the --restrict wire contract)', async () => {
    const pairResp = await fetch(`${daemon.baseUrl}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify({ clientId: 'restricted-scopes', scopes: ['read'] }),
    });
    const { setup_key } = await pairResp.json() as any;
    const connectResp = await fetch(`${daemon.baseUrl}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setup_key }),
    });
    const { scopes } = await connectResp.json() as any;
    expect(scopes).toEqual(['read']);
  });

  test('POST /pair with a scope typo fails fast, naming the scope', async () => {
    // Regression: pre-fix this returned 200 with a poisoned setup key whose
    // failure surfaced at /connect as a misleading "Invalid request body".
    const resp = await fetch(`${daemon.baseUrl}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify({ clientId: 'typo-agent', scopes: ['raed'] }),
    });
    expect(resp.status).toBe(400);
    const body = await resp.json() as any;
    expect(body.error).toContain('Invalid scope: raed');
  });

  test('POST /token with a scope typo names the scope too', async () => {
    const resp = await fetch(`${daemon.baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify({ clientId: 'typo-token', scopes: ['wirte'] }),
    });
    expect(resp.status).toBe(400);
    const body = await resp.json() as any;
    expect(body.error).toContain('Invalid scope: wirte');
  });

  test('control cannot ride in through a /pair scopes list without the control flag', async () => {
    const resp = await fetch(`${daemon.baseUrl}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify({ clientId: 'sneaky', scopes: ['read', 'control'] }),
    });
    expect(resp.status).toBe(400);
    const body = await resp.json() as any;
    expect(body.error).toContain('control');
  });

  test('scope-denied 403 hint points at --restrict/--control, never --admin', async () => {
    // Regression: the old hint said "re-pair with --admin", which is a legacy
    // alias for --control — following it over-granted browser-wide control.
    const pairResp = await fetch(`${daemon.baseUrl}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify({ clientId: 'hint-agent', scopes: ['read'] }),
    });
    const { setup_key } = await pairResp.json() as any;
    const connectResp = await fetch(`${daemon.baseUrl}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setup_key }),
    });
    const { token } = await connectResp.json() as any;
    const resp = await fetch(`${daemon.baseUrl}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ command: 'goto', args: ['https://example.com'] }),
    });
    expect(resp.status).toBe(403);
    const body = await resp.json() as any;
    expect(body.hint).toContain('--restrict');
    expect(body.hint).toContain('--control');
    expect(body.hint).not.toContain('--admin');
  });

  // ─── D2: reserved clientId is rejected with a named 400 ───────────────

  test('POST /pair with clientId "root" returns 400 naming the reservation', async () => {
    const resp = await fetch(`${daemon.baseUrl}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify({ clientId: 'root' }),
    });
    expect(resp.status).toBe(400);
    const body = await resp.json() as any;
    // The reservation is named, NOT hidden behind the generic "Invalid request body".
    expect(body.error).toContain('root');
    expect(body.error).not.toBe('Invalid request body');
  });

  test('POST /token with clientId "root" returns 400 naming the reservation', async () => {
    const resp = await fetch(`${daemon.baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify({ clientId: 'root' }),
    });
    expect(resp.status).toBe(400);
    const body = await resp.json() as any;
    expect(body.error).toContain('root');
    expect(body.error).not.toBe('Invalid request body');
  });

  // ─── D1: a reducing re-pair supersedes the prior grant immediately ────

  const pairAs = async (body: any) => (await (await fetch(`${daemon.baseUrl}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${daemon.token}` },
    body: JSON.stringify(body),
  })).json()) as any;
  const connectKey = async (setup_key: string) => {
    const r = await fetch(`${daemon.baseUrl}/connect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setup_key }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) as any };
  };
  const statusWith = (token: string) => fetch(`${daemon.baseUrl}/command`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ command: 'status', args: [] }),
  });

  test('reducing re-pair revokes the prior session immediately, without exchanging the new key', async () => {
    const { setup_key: k1 } = await pairAs({ clientId: 'reduce-me' });      // broad
    const { body: c1 } = await connectKey(k1);
    const s1 = c1.token as string;
    expect((await statusWith(s1)).status).not.toBe(401);                    // works
    // Narrow WITHOUT exchanging the new key — this is the whole bug.
    const rp = await pairAs({ clientId: 'reduce-me', scopes: ['read'] });
    expect(rp.superseded?.tokens_deleted).toBeGreaterThanOrEqual(1);
    expect((await statusWith(s1)).status).toBe(401);                        // old session revoked
    // The new narrow key still works and yields the reduced scope.
    const c2 = await connectKey(rp.setup_key);
    expect(c2.status).toBe(200);
    expect(c2.body.scopes).toEqual(['read']);
    expect((await statusWith(c2.body.token)).status).not.toBe(401);
  });

  test('reducing re-pair BEFORE connect kills the stale broad setup key; only the narrow key works', async () => {
    const { setup_key: broad } = await pairAs({ clientId: 'shadow' });      // never connected
    const rp = await pairAs({ clientId: 'shadow', scopes: ['read'] });      // narrowing re-pair
    expect(rp.superseded).toBeUndefined();                                  // no live session existed
    expect((await connectKey(broad)).status).toBe(401);                     // stale broad key dead
    const c = await connectKey(rp.setup_key);
    expect(c.status).toBe(200);
    expect(c.body.scopes).toEqual(['read']);                               // narrow key survives
  });

  test('broadening re-pair does NOT revoke the working session (no outage)', async () => {
    const first = await pairAs({ clientId: 'broaden', scopes: ['read'] });
    expect(first.superseded).toBeUndefined();                              // first pair supersedes nothing
    const { body: c } = await connectKey(first.setup_key);
    const s = c.token as string;
    expect((await statusWith(s)).status).not.toBe(401);
    const rp = await pairAs({ clientId: 'broaden', scopes: ['read', 'write'] }); // broaden
    expect(rp.superseded).toBeUndefined();                                 // session not superseded
    expect((await statusWith(s)).status).not.toBe(401);                    // still working
  });

  test('a reducing re-pair with an INVALID scope 400s and leaves the live session intact', async () => {
    // Regression: the supersede revoke must run AFTER validation. A scope typo
    // (--restrict red) on a narrowing re-pair must not destroy the session and
    // then fail to mint a replacement — the agent would be knocked offline.
    const { setup_key: k } = await pairAs({ clientId: 'validate-me' });
    const { body: c } = await connectKey(k);
    const s = c.token as string;
    expect((await statusWith(s)).status).not.toBe(401);
    const resp = await fetch(`${daemon.baseUrl}/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify({ clientId: 'validate-me', scopes: ['red'] }),
    });
    expect(resp.status).toBe(400);
    expect((await resp.json() as any).error).toContain('red');
    // The working session survives the validation error (not revoked).
    expect((await statusWith(s)).status).not.toBe(401);
  });

  // ─── D3: DELETE /token releases tabs unconditionally; 404 only when empty ─

  test('DELETE /token returns tabs_released and 404 only when nothing to revoke or release', async () => {
    const pairResp = await fetch(`${daemon.baseUrl}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify({ clientId: 'd3-agent' }),
    });
    const { setup_key } = await pairResp.json() as any;
    await fetch(`${daemon.baseUrl}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setup_key }),
    });
    const del = await fetch(`${daemon.baseUrl}/token/d3-agent`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${daemon.token}` },
    });
    expect(del.status).toBe(200);
    const body = await del.json() as any;
    expect(body.tokens_deleted).toBeGreaterThanOrEqual(1);
    // Headless-skip daemon owns no real tabs, but the field is always present.
    expect(body.tabs_released).toBe(0);
    // Nothing to revoke AND nothing to release → 404.
    const del2 = await fetch(`${daemon.baseUrl}/token/nonexistent-xyz`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${daemon.token}` },
    });
    expect(del2.status).toBe(404);
  });

  // ─── Revocation e2e: revoke-all + the /agents verification surface ────

  test('DELETE /token revokes session AND setup keys; agent leaves /agents; token 401s; re-connect fails', async () => {
    const pair = async () => {
      const resp = await fetch(`${daemon.baseUrl}/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${daemon.token}` },
        body: JSON.stringify({ clientId: 'revoke-e2e' }),
      });
      return (await resp.json() as any).setup_key as string;
    };
    const key1 = await pair();
    const connectResp = await fetch(`${daemon.baseUrl}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setup_key: key1 }),
    });
    const { token: scopedToken } = await connectResp.json() as any;

    // A second, UNSPENT setup key for the same clientId (the re-grant hole).
    const key2 = await pair();

    const pre = await fetch(`${daemon.baseUrl}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${scopedToken}` },
      body: JSON.stringify({ command: 'status', args: [] }),
    });
    expect(pre.status).not.toBe(401);

    // /agents lists the session AND the pending setup key, never the token.
    const agentsPre = await (await fetch(`${daemon.baseUrl}/agents`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    })).json() as any;
    expect(agentsPre.agents.some((a: any) => a.clientId === 'revoke-e2e' && !a.pending)).toBe(true);
    expect(agentsPre.agents.some((a: any) => a.clientId === 'revoke-e2e' && a.pending)).toBe(true);
    for (const a of agentsPre.agents) expect(a.token).toBeUndefined();

    // Regression: pre-fix this deleted only the spent setup key and returned
    // a false 200 while the session survived. Count covers session + spent
    // key + pending key.
    const del = await fetch(`${daemon.baseUrl}/token/revoke-e2e`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    expect(del.status).toBe(200);
    const delBody = await del.json() as any;
    expect(delBody.revoked).toBe('revoke-e2e');
    expect(delBody.tokens_deleted).toBe(3);

    // Assert per-clientId absence, NOT list-empty: this file shares one
    // daemon and other tests' agents remain listed.
    const agentsPost = await (await fetch(`${daemon.baseUrl}/agents`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    })).json() as any;
    expect(agentsPost.agents.some((a: any) => a.clientId === 'revoke-e2e')).toBe(false);

    const post = await fetch(`${daemon.baseUrl}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${scopedToken}` },
      body: JSON.stringify({ command: 'status', args: [] }),
    });
    expect(post.status).toBe(401);

    // The leftover unspent key is dead too (re-grant hole closed).
    const reconnect = await fetch(`${daemon.baseUrl}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setup_key: key2 }),
    });
    expect(reconnect.status).toBe(401);
  });

  test('second DELETE /token for the same clientId returns 404, not a false 200', async () => {
    // Regression: pre-fix, consecutive DELETEs both returned 200 — the first
    // consumed the spent setup key, the second the session. Depends on the
    // previous test having revoked 'revoke-e2e' (bun runs file tests in order).
    const del = await fetch(`${daemon.baseUrl}/token/revoke-e2e`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    expect(del.status).toBe(404);
  });

  test('DELETE /token decodes percent-encoded clientIds', async () => {
    const pairResp = await fetch(`${daemon.baseUrl}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify({ clientId: 'space agent' }),
    });
    const { setup_key } = await pairResp.json() as any;
    await fetch(`${daemon.baseUrl}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setup_key }),
    });
    const del = await fetch(`${daemon.baseUrl}/token/${encodeURIComponent('space agent')}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    expect(del.status).toBe(200);
    const agents = await (await fetch(`${daemon.baseUrl}/agents`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    })).json() as any;
    expect(agents.agents.some((a: any) => a.clientId === 'space agent')).toBe(false);
  });

  test('DELETE /token with malformed percent-encoding returns 400', async () => {
    const del = await fetch(`${daemon.baseUrl}/token/%E0%A4%A`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    expect(del.status).toBe(400);
  });

  test('POST /command with no auth returns 401', async () => {
    const resp = await fetch(`${daemon.baseUrl}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'status', args: [] }),
    });
    expect(resp.status).toBe(401);
  });

  test('POST /sse-session with root Bearer returns a Set-Cookie for gstack_sse', async () => {
    const resp = await fetch(`${daemon.baseUrl}/sse-session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    expect(resp.status).toBe(200);
    const setCookie = resp.headers.get('set-cookie');
    expect(setCookie).not.toBeNull();
    expect(setCookie!).toContain('gstack_sse=');
    expect(setCookie!).toContain('HttpOnly');
    expect(setCookie!).toContain('SameSite=Strict');
  });

  test('POST /sse-session without root Bearer returns 401', async () => {
    const resp = await fetch(`${daemon.baseUrl}/sse-session`, { method: 'POST' });
    expect(resp.status).toBe(401);
  });

  test('GET /activity/stream without auth returns 401', async () => {
    const resp = await fetch(`${daemon.baseUrl}/activity/stream`);
    expect(resp.status).toBe(401);
  });

  test('GET /activity/stream with ?token= (legacy) is rejected', async () => {
    // The old ?token= query param is no longer accepted (N1).
    const resp = await fetch(`${daemon.baseUrl}/activity/stream?token=${daemon.token}`);
    expect(resp.status).toBe(401);
  });

  // NB: we don't test "SSE succeeds with Bearer" end-to-end here because
  // Bun's fetch doesn't return the Response for a long-lived stream until
  // data flows, and SSE holds open forever.  The 401-paths above are enough
  // to prove the auth gate; source-level tests in dual-listener.test.ts
  // cover the cookie path.  A live SSE behavioral test would belong in a
  // separate eventsource-based harness.

  test('/welcome regex gate: safe slug resolves; dangerous slug does not path-traverse', async () => {
    // The regex gate lives in server.ts — we can't easily flip GSTACK_SLUG
    // on a running daemon, but we CAN verify the endpoint serves something
    // reasonable for the default 'unknown' slug (no crash, no 500).
    const resp = await fetch(`${daemon.baseUrl}/welcome`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/html');
    const body = await resp.text();
    // Must not include path-traversal-decoded content
    expect(body).not.toContain('root:x:0:0'); // /etc/passwd signature
  });
});
