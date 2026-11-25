/**
 * Server auth security tests.
 *
 * Route auth is asserted behaviorally: requests go through a real
 * buildFetchHandler() (makeServer) or through one route's real handler with a
 * stub RouteContext (callRoute), so the tests pin what each route does, not
 * where its code sits. The remaining source-level checks cover code with no
 * behavioral seam (command-pipeline internals, cli.ts, the cookie-picker UI,
 * the constant-time compare, the ngrok authtoken file lookup).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { buildHeadedServerEnv } from '../src/cli';
import { GSTACK_EXTENSION_ID } from '../src/server';
import { DEFAULT_PAIR_SCOPES, createToken } from '../src/token-registry';
import { getActivityHistory } from '../src/activity';
import { makeServer, stubRouteContext, callRoute, fakeTunnel, type TestServer } from './route-test-harness';

const SERVER_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/server.ts'), 'utf-8');
const CLI_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/cli.ts'), 'utf-8');

// Helper: extract a block of source between two markers
function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) throw new Error(`Marker not found: ${startMarker}`);
  const endIdx = source.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx === -1) throw new Error(`End marker not found: ${endMarker}`);
  return source.slice(startIdx, endIdx);
}

const UNAUTHORIZED = { status: 401, body: { error: 'Unauthorized' } };
const ROOT_REQUIRED = { status: 403, body: { error: 'Root token required' } };

async function statusAndJson(resp: Response): Promise<{ status: number; body: any }> {
  const text = await resp.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}
  return { status: resp.status, body };
}

let server: TestServer;
let scoped = '';
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const savedPairAgent = process.env.GSTACK_PAIR_AGENT;

beforeAll(() => {
  server = makeServer();
  scoped = server.scopedToken('auth-suite-agent');
});
afterAll(() => {
  server.cleanup();
  if (savedPairAgent === undefined) delete process.env.GSTACK_PAIR_AGENT;
  else process.env.GSTACK_PAIR_AGENT = savedPairAgent;
});

describe('Server auth security', () => {
  // Test 1a: the pinned-origin bootstrap endpoint releases the token only to
  // the exact extension Origin with a loopback Host (parsed from host:port,
  // never compared literally against the raw header).
  test('POST /extension-token gates on pinned Origin and loopback Host', async () => {
    const pinned = `chrome-extension://${GSTACK_EXTENSION_ID}`;
    const post = (headers: Record<string, string>) => server.local('/extension-token', { method: 'POST', headers });
    for (const host of ['127.0.0.1:34567', 'localhost:34567']) {
      const ok = await statusAndJson(await post({ Origin: pinned, Host: host }));
      expect(ok).toEqual({ status: 200, body: { token: server.rootToken } });
    }
    for (const headers of [
      { Origin: pinned, Host: 'evil.example:34567' },
      { Origin: pinned },
      { Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', Host: '127.0.0.1:34567' },
      { Host: '127.0.0.1:34567', ...bearer(server.rootToken) },
    ]) {
      const denied = await statusAndJson(await post(headers));
      expect(denied).toEqual({ status: 403, body: { error: 'Forbidden' } });
    }
  });

  // Test 1c: newtab must check domain restrictions (security audit finding #5)
  // Domain check for newtab is now unified with goto in the scope check section:
  // (command === 'goto' || command === 'newtab') && args[0] → checkDomain
  test('newtab enforces domain restrictions', () => {
    const scopeBlock = sliceBetween(SERVER_SRC, "Scope check (for scoped tokens)", "Pin to a specific tab");
    expect(scopeBlock).toContain("command === 'newtab'");
    expect(scopeBlock).toContain('checkDomain');
    expect(scopeBlock).toContain('Domain not allowed');
  });

  // Test 1d: validateAuth compares the bearer token in CONSTANT TIME with a
  // length gate. A revert to `header === \`Bearer ${authToken}\`` keeps
  // accept/reject behavior identical (functional tests still pass) but silently
  // reintroduces the byte-by-byte timing side-channel; dropping the length gate
  // makes timingSafeEqual throw RangeError (500 instead of 401) on a wrong-length
  // token. Pin both properties, mirroring the token-registry sibling guard.
  test('validateAuth uses constant-time comparison with a length gate', () => {
    const authBlock = sliceBetween(SERVER_SRC, 'function validateAuth(req: Request): boolean {', '// Factory-scoped shutdown');
    expect(authBlock).toContain('crypto.timingSafeEqual');
    expect(authBlock).toContain('got.length === want.length');
    // The null-header guard must remain (Buffer.from(null) would otherwise throw).
    expect(authBlock).toContain('header === null');
    // The raw === comparison of the header against the bearer string must be gone.
    expect(authBlock).not.toContain('header === `Bearer ${authToken}`');
  });

  // Tests 2-5: /refs and /activity/history require the root bearer and never
  // send a wildcard CORS header, on the denial or the success path.
  for (const route of ['/refs', '/activity/history']) {
    test(`${route} endpoint requires authentication`, async () => {
      expect(await statusAndJson(await server.local(route))).toEqual(UNAUTHORIZED);
      expect(await statusAndJson(await server.local(route, { headers: bearer(scoped) }))).toEqual(UNAUTHORIZED);
      expect((await server.local(route, { headers: bearer(server.rootToken) })).status).toBe(200);
    });

    test(`${route} has no wildcard CORS header`, async () => {
      for (const headers of [{}, bearer(server.rootToken)]) {
        const resp = await server.local(route, { headers: { Origin: 'https://evil.example', ...headers } });
        expect(resp.headers.get('access-control-allow-origin')).toBeNull();
      }
    });
  }

  // Test 6: /activity/stream requires auth via Bearer OR view-only session cookie
  // (N1: ?token= query param was dropped in v1.6.0.0 — URLs leak to logs/referer)
  test('/activity/stream requires authentication with inline token check', async () => {
    expect(await statusAndJson(await server.local('/activity/stream'))).toEqual(UNAUTHORIZED);
    const viaQuery = await server.local(`/activity/stream?token=${server.rootToken}`);
    expect(await statusAndJson(viaQuery)).toEqual(UNAUTHORIZED);

    const viaBearer = await server.local('/activity/stream', { headers: bearer(server.rootToken) });
    expect(viaBearer.status).toBe(200);
    expect(viaBearer.headers.get('access-control-allow-origin')).toBeNull();
    await viaBearer.body?.cancel();

    const minted = await server.local('/sse-session', { method: 'POST', headers: bearer(server.rootToken) });
    const cookie = (minted.headers.get('set-cookie') ?? '').split(';')[0];
    expect(cookie).toStartWith('gstack_sse=');
    const viaCookie = await server.local('/activity/stream', { headers: { Cookie: cookie } });
    expect(viaCookie.status).toBe(200);
    expect(viaCookie.headers.get('access-control-allow-origin')).toBeNull();
    await viaCookie.body?.cancel();
  });

  // Test 7: /command accepts scoped tokens (not just root). This was the
  // Wintermute bug — /command sat below the blanket root-only check, so scoped
  // tokens got 401'd before reaching getTokenInfo.
  test('/command endpoint sits ABOVE the blanket root-only auth gate', async () => {
    const resp = await statusAndJson(await server.local('/command', {
      method: 'POST', headers: bearer(scoped), body: JSON.stringify({ command: '__auth_suite_unknown__' }),
    }));
    expect(resp.status).not.toBe(401);
    expect(resp.body).not.toEqual({ error: 'Unauthorized' });
  });

  // Test 7b: /command authenticates with getTokenInfo (root or scoped), so an
  // unknown bearer is still rejected.
  test('/command uses getTokenInfo for auth, not validateAuth', async () => {
    const body = JSON.stringify({ command: '__auth_suite_unknown__' });
    expect(await statusAndJson(await server.local('/command', { method: 'POST', body }))).toEqual(UNAUTHORIZED);
    expect(await statusAndJson(await server.local('/command', {
      method: 'POST', body, headers: bearer('gsk_sess_not-a-real-token'),
    }))).toEqual(UNAUTHORIZED);
    expect((await server.local('/command', { method: 'POST', body, headers: bearer(server.rootToken) })).status).not.toBe(401);
  });

  // Test 8: /tunnel/start requires root token
  test('/tunnel/start requires root token', async () => {
    for (const headers of [{}, bearer(scoped)]) {
      expect(await statusAndJson(await server.local('/tunnel/start', { method: 'POST', headers }))).toEqual(ROOT_REQUIRED);
    }
  });

  // Test 8b: the ngrok authtoken lookup reads ngrok's native config files, and
  // /tunnel/start asks for it only after the cached-tunnel check. The file
  // lookup (resolveNgrokAuthtoken in server.ts) has no seam without a real
  // ngrok config, so that half stays a source check.
  test('/tunnel/start reads ngrok native config files', async () => {
    const lookup = sliceBetween(SERVER_SRC, 'function resolveNgrokAuthtoken', 'async function closeTunnel');
    expect(lookup).toContain("'ngrok.yml'");
    expect(lookup).toContain('authtoken');

    process.env.GSTACK_PAIR_AGENT = 'on';
    const inactive = { active: false, url: null, hasListener: false };
    const missing = await statusAndJson(await callRoute('POST', '/tunnel/start', stubRouteContext({
      tunnel: { state: () => inactive, close: async () => {}, resolveAuthtoken: () => null, start: async () => { throw new Error('must not start'); } },
    })));
    expect(missing).toEqual({ status: 400, body: { error: 'No ngrok authtoken found', hint: 'Run: ngrok config add-authtoken YOUR_TOKEN' } });

    const started: string[] = [];
    const ok = await statusAndJson(await callRoute('POST', '/tunnel/start', stubRouteContext({
      tunnel: {
        state: () => inactive, close: async () => {}, resolveAuthtoken: () => 'ngrok-token-from-config',
        start: async (authtoken) => { started.push(authtoken); return { ok: true, url: 'https://fresh.ngrok.example' }; },
      },
    })));
    expect(ok).toEqual({ status: 200, body: { url: 'https://fresh.ngrok.example' } });
    expect(started).toEqual(['ngrok-token-from-config']);
  });

  // Test 8c: /tunnel/start returns already_active if the cached tunnel answers
  test('/tunnel/start returns already_active when tunnel exists', async () => {
    process.env.GSTACK_PAIR_AGENT = 'on';
    const tunnel = fakeTunnel(200);
    try {
      const resp = await statusAndJson(await callRoute('POST', '/tunnel/start', stubRouteContext({
        tunnel: {
          state: () => ({ active: true, url: tunnel.url, hasListener: true }),
          close: async () => { throw new Error('a live tunnel must not be closed'); },
          resolveAuthtoken: () => { throw new Error('a live tunnel must not be restarted'); },
          start: async () => { throw new Error('a live tunnel must not be restarted'); },
        },
      })));
      expect(resp).toEqual({ status: 200, body: { url: tunnel.url, already_active: true } });
      expect(tunnel.hits).toEqual(['GET /connect']);
    } finally { tunnel.stop(); }
  });

  // Test 9: /pair requires root token
  test('/pair requires root token', async () => {
    for (const headers of [{}, bearer(scoped)]) {
      expect(await statusAndJson(await server.local('/pair', { method: 'POST', headers, body: '{}' }))).toEqual(ROOT_REQUIRED);
    }
  });

  // Test 9b: /pair mints a one-time setup key (pending until /connect), never a
  // session token a caller could use directly.
  test('/pair creates setup keys, not session tokens', async () => {
    const pair = await statusAndJson(await server.local('/pair', {
      method: 'POST', headers: bearer(server.rootToken), body: JSON.stringify({ clientId: 'pair-setup-check' }),
    }));
    expect(pair.status).toBe(200);
    expect(pair.body.setup_key).toStartWith('gsk_setup_');
    const agents = await statusAndJson(await server.local('/agents', { headers: bearer(server.rootToken) }));
    expect(agents.body.agents.find((a: any) => a.clientId === 'pair-setup-check')?.pending).toBe(true);
    const exchanged = await statusAndJson(await server.local('/connect', {
      method: 'POST', body: JSON.stringify({ setup_key: pair.body.setup_key }),
    }));
    expect(exchanged.status).toBe(200);
    expect(exchanged.body.token).toStartWith('gsk_sess_');
  });

  // Test 10: tab ownership check happens before command dispatch
  test('tab ownership check runs before command dispatch for scoped tokens', () => {
    const handleBlock = sliceBetween(SERVER_SRC, "async function handleCommand", "Block mutation commands while watching");
    expect(handleBlock).toContain('checkTabAccess');
    expect(handleBlock).toContain('Tab not owned by your agent');
  });

  // Test 10a: tab gate is gated on own-only, not on isWrite
  // Regression test for v1.20.0.0 footgun fix. Pre-fix the gate fired for
  // any write command from any non-root token, which 403'd local skill
  // spawns trying to drive the user's natural (unowned) tabs. The bundled
  // hackernews-frontpage skill failed identically. The fix narrows the
  // gate to `tabPolicy === 'own-only'` so pair-agent tunnel tokens stay
  // strict while local shared-policy tokens (skill spawns) get unblocked.
  test('tab gate predicate is own-only-scoped, not write-scoped', () => {
    const handleBlock = sliceBetween(SERVER_SRC, "async function handleCommand", "Block mutation commands while watching");
    // The gate condition must include the own-only check.
    expect(handleBlock).toContain("tabPolicy === 'own-only'");
    // It must NOT depend on WRITE_COMMANDS in the gate predicate (only inside
    // the checkTabAccess call's isWrite arg, which is informational). The
    // surrounding `if (...) {` for the gate must use `tabPolicy === 'own-only'`
    // as the trigger, not `WRITE_COMMANDS.has(command) || ...`.
    const gateLine = handleBlock.split('\n').find(l =>
      l.includes("command !== 'newtab'") &&
      l.includes('tokenInfo') &&
      l.includes('tabPolicy')
    );
    expect(gateLine).toBeTruthy();
    expect(gateLine).not.toMatch(/WRITE_COMMANDS\.has\(command\)\s*\|\|/);
  });

  // Test 10b: chain command pre-validates subcommand scopes
  test('chain handler checks scope for each subcommand before dispatch', () => {
    const metaSrc = fs.readFileSync(path.join(import.meta.dir, '../src/meta-commands.ts'), 'utf-8');
    const chainBlock = metaSrc.slice(
      metaSrc.indexOf("case 'chain':"),
      metaSrc.indexOf("case 'diff':")
    );
    expect(chainBlock).toContain('checkScope');
    expect(chainBlock).toContain('Chain rejected');
    expect(chainBlock).toContain('tokenInfo');
  });

  // Test 10c: handleMetaCommand accepts tokenInfo parameter
  test('handleMetaCommand accepts tokenInfo for chain scope checking', () => {
    const metaSrc = fs.readFileSync(path.join(import.meta.dir, '../src/meta-commands.ts'), 'utf-8');
    const sig = metaSrc.slice(
      metaSrc.indexOf('export async function handleMetaCommand'),
      metaSrc.indexOf('): Promise<string>')
    );
    expect(sig).toContain('tokenInfo');
  });

  // Test 10d: server passes tokenInfo to handleMetaCommand
  // v1.35.0.0: shutdown is now factory-scoped; the call site uses shutdownFn,
  // a thin wrapper that delegates to activeShutdown (set by buildFetchHandler).
  test('server passes tokenInfo to handleMetaCommand', () => {
    expect(SERVER_SRC).toContain('handleMetaCommand(command, args, browserManager, shutdownFn, tokenInfo,');
  });

  // Test 10e: activity attribution includes clientId
  test('activity events include clientId from token', () => {
    const commandStartBlock = sliceBetween(SERVER_SRC, "Activity: emit command_start", "try {");
    expect(commandStartBlock).toContain('clientId: tokenInfo?.clientId');
  });

  // ─── Tunnel liveness verification ─────────────────────────────

  // Tests 11a/11b: /pair probes the tunnel before reporting tunnel_url, tears
  // the tunnel down when the probe fails, and never reports a raw
  // tunnelActive flag.
  test('/pair verifies tunnel is alive before returning tunnel_url', async () => {
    for (const [status, expectUrl] of [[200, true], [503, false]] as const) {
      const tunnel = fakeTunnel(status);
      let closed = 0;
      try {
        const resp = await statusAndJson(await callRoute('POST', '/pair', stubRouteContext({
          tunnel: {
            state: () => ({ active: true, url: tunnel.url, hasListener: true }),
            close: async () => { closed++; },
            resolveAuthtoken: () => null, start: async () => { throw new Error('unused'); },
          },
        }), { body: {} }));
        expect(resp.status).toBe(200);
        expect(resp.body.tunnel_url).toBe(expectUrl ? tunnel.url : null);
        expect(tunnel.hits).toEqual(['GET /connect']);
        expect(closed).toBe(expectUrl ? 0 : 1);
      } finally { tunnel.stop(); }
    }
  });

  test('/pair returns verified tunnel URL, not raw tunnelActive flag', async () => {
    const resp = await statusAndJson(await callRoute('POST', '/pair', stubRouteContext({
      tunnel: {
        state: () => ({ active: true, url: 'http://127.0.0.1:1', hasListener: true }),
        close: async () => {}, resolveAuthtoken: () => null, start: async () => { throw new Error('unused'); },
      },
    }), { body: {} }));
    expect(resp.status).toBe(200);
    expect(resp.body.tunnel_url).toBeNull();
    const inactive = await statusAndJson(await callRoute('POST', '/pair', stubRouteContext({
      tunnel: {
        state: () => ({ active: false, url: null, hasListener: false }),
        close: async () => { throw new Error('nothing to close'); },
        resolveAuthtoken: () => null, start: async () => { throw new Error('unused'); },
      },
    }), { body: {} }));
    expect(inactive.body.tunnel_url).toBeNull();
    expect(inactive.body.server_url).toBe('http://127.0.0.1:34567');
  });

  // Test 11c: /tunnel/start probes the cached tunnel before returning
  // already_active; a dead one is torn down and restarted.
  test('/tunnel/start verifies cached tunnel is alive before returning already_active', async () => {
    process.env.GSTACK_PAIR_AGENT = 'on';
    const tunnel = fakeTunnel(502);
    const calls: string[] = [];
    try {
      const resp = await statusAndJson(await callRoute('POST', '/tunnel/start', stubRouteContext({
        tunnel: {
          state: () => ({ active: true, url: tunnel.url, hasListener: true }),
          close: async () => { calls.push('close'); },
          resolveAuthtoken: () => { calls.push('resolve'); return 'ngrok-token'; },
          start: async () => { calls.push('start'); return { ok: true, url: 'https://restarted.ngrok.example' }; },
        },
      })));
      expect(resp).toEqual({ status: 200, body: { url: 'https://restarted.ngrok.example' } });
      expect(calls).toEqual(['close', 'resolve', 'start']);
      expect(tunnel.hits).toEqual(['GET /connect']);
    } finally { tunnel.stop(); }
  });

  // Test 11d: CLI verifies tunnel_url from server before printing instruction block
  test('CLI probes tunnel_url before using it in instruction block', () => {
    const pairSection = sliceBetween(CLI_SRC, 'Determine the URL to use', 'local HOST: write config');
    // Must probe the tunnel URL
    expect(pairSection).toContain('cliProbe');
    expect(pairSection).toContain('Tunnel unreachable from CLI');
    // Must fall through to restart logic on failure
    expect(pairSection).toContain('attempting restart');
  });

  // ─── Batch endpoint security ─────────────────────────────────

  // Tests 12a/12b: /batch accepts root and scoped tokens (like /command) and
  // rejects an unknown bearer.
  test('/batch endpoint sits ABOVE the blanket root-only auth gate', async () => {
    const resp = await statusAndJson(await server.local('/batch', {
      method: 'POST', headers: bearer(scoped), body: JSON.stringify({ commands: [] }),
    }));
    expect(resp).toEqual({ status: 400, body: { error: '"commands" must be a non-empty array' } });
  });

  test('/batch uses getTokenInfo for auth, not validateAuth', async () => {
    const body = JSON.stringify({ commands: [] });
    expect(await statusAndJson(await server.local('/batch', { method: 'POST', body }))).toEqual(UNAUTHORIZED);
    expect(await statusAndJson(await server.local('/batch', {
      method: 'POST', body, headers: bearer('gsk_sess_not-a-real-token'),
    }))).toEqual(UNAUTHORIZED);
    expect((await server.local('/batch', { method: 'POST', body, headers: bearer(server.rootToken) })).status).toBe(400);
  });

  function batchContext(calls: Array<{ body: any; opts: any }>) {
    return stubRouteContext({
      browserManager: { getCurrentUrl: () => 'about:blank', getTabCount: () => 1, getConnectionMode: () => 'launched' } as any,
      resetIdleTimer: () => {},
      commands: {
        handle: async () => { throw new Error('/batch must not use the single-command wrapper'); },
        handleInternal: async (body, _tokenInfo, opts) => { calls.push({ body, opts }); return { status: 200, result: 'ok' }; },
      },
    });
  }

  // Test 12c: /batch enforces max command limit
  test('/batch enforces max 50 commands per batch', async () => {
    const calls: Array<{ body: any; opts: any }> = [];
    const commands = Array.from({ length: 51 }, () => ({ command: 'url' }));
    const resp = await statusAndJson(await callRoute('POST', '/batch', batchContext(calls), { body: { commands } }));
    expect(resp).toEqual({ status: 400, body: { error: 'Max 50 commands per batch' } });
    expect(calls).toEqual([]);
  });

  // Test 12d: /batch rejects nested batches
  test('/batch rejects nested batch commands', async () => {
    const calls: Array<{ body: any; opts: any }> = [];
    const resp = await statusAndJson(await callRoute('POST', '/batch', batchContext(calls), {
      body: { commands: [{ command: 'batch', args: [] }, { command: 'url' }] },
    }));
    expect(resp.status).toBe(200);
    expect(resp.body.results[0]).toMatchObject({ index: 0, status: 400, command: 'batch' });
    expect(JSON.parse(resp.body.results[0].result)).toEqual({ error: 'Nested batch commands are not allowed' });
    expect(calls.map(c => c.body.command)).toEqual(['url']);
  });

  // Tests 12e/12f/12h: each sub-command runs through handleCommandInternal
  // with per-command rate limiting and activity suppressed, tabId passed
  // through, and one batch-level command_start/command_end pair emitted.
  test('/batch skips per-command rate limiting', async () => {
    const calls: Array<{ body: any; opts: any }> = [];
    await callRoute('POST', '/batch', batchContext(calls), { body: { commands: [{ command: 'url' }, { command: 'text' }] } });
    expect(calls.map(c => c.opts.skipRateCheck)).toEqual([true, true]);
  });

  test('/batch emits batch-level activity, not per-command', async () => {
    const calls: Array<{ body: any; opts: any }> = [];
    const before = getActivityHistory(1000).totalAdded;
    await callRoute('POST', '/batch', batchContext(calls), {
      body: { commands: [{ command: 'url' }, { command: 'text' }] },
      tokenInfo: { clientId: 'batch-activity-agent' } as any,
    });
    expect(calls.map(c => c.opts.skipActivity)).toEqual([true, true]);
    const { entries, totalAdded } = getActivityHistory(1000);
    const added = entries.slice(-(totalAdded - before));
    expect(added.map(e => [e.type, e.command, e.clientId])).toEqual([
      ['command_start', 'batch', 'batch-activity-agent'],
      ['command_end', 'batch', 'batch-activity-agent'],
    ]);
  });

  // Test 12g: /batch validates command field in each command
  test('/batch validates each command has a command field', async () => {
    const calls: Array<{ body: any; opts: any }> = [];
    const resp = await statusAndJson(await callRoute('POST', '/batch', batchContext(calls), {
      body: { commands: [{}, { command: 42 }] },
    }));
    expect(resp.body.results.map((r: any) => [r.status, JSON.parse(r.result).error])).toEqual([
      [400, 'Missing "command" field'],
      [400, 'Missing "command" field'],
    ]);
    expect(calls).toEqual([]);
  });

  test('/batch passes tabId to handleCommandInternal for multi-tab support', async () => {
    const calls: Array<{ body: any; opts: any }> = [];
    const resp = await statusAndJson(await callRoute('POST', '/batch', batchContext(calls), {
      body: { commands: [{ command: 'url', tabId: 7 }, { command: 'text', args: ['x'], tabId: 9 }] },
    }));
    expect(calls.map(c => c.body)).toEqual([
      { command: 'url', args: undefined, tabId: 7 },
      { command: 'text', args: ['x'], tabId: 9 },
    ]);
    expect(resp.body.results.map((r: any) => r.tabId)).toEqual([7, 9]);
  });

  // ─── Pair-agent regression tests ──────────────────────────

  // Regression: connect command crashed with "domains is not defined" because
  // a stray `domains,` variable was in the status fetch body (cli.ts:852).
  test('connect command status fetch body has no undefined variable references', () => {
    const connectBlock = sliceBetween(CLI_SRC, 'Launching headed Chromium', 'Terminal agent started');
    // The status fetch should use a clean JSON body
    expect(connectBlock).toContain("command: 'status'");
    // Must NOT contain a bare `domains` reference in the fetch body
    // (it would be `domains,` on its own line, not part of a key like `domains:`)
    const bodyMatch = connectBlock.match(/body:\s*JSON\.stringify\(\{([^}]+)\}\)/);
    expect(bodyMatch).not.toBeNull();
    if (bodyMatch) {
      // The body should only contain command and args, no stray variables
      expect(bodyMatch[1]).not.toMatch(/\bdomains\b/);
    }
  });

  // Regression: pair-agent server died 15s after CLI exited because the server
  // monitored the connect subprocess PID. pair-agent must set BROWSE_PARENT_PID=0
  // to disable self-termination.
  test('pair-agent disables parent PID monitoring via BROWSE_PARENT_PID=0', () => {
    const pairBlock = sliceBetween(CLI_SRC, 'Ensure headed mode', 'handlePairAgent');
    // The connect subprocess env must override BROWSE_PARENT_PID
    expect(pairBlock).toContain("BROWSE_PARENT_PID");
    expect(pairBlock).toContain("'0'");
    // The connect command starts its server with buildHeadedServerEnv, the
    // same env the --supervise respawn uses, and that env disables the
    // parent-PID watchdog.
    const connectBlock = sliceBetween(CLI_SRC, 'Launching headed Chromium', 'Terminal agent started');
    expect(connectBlock).toContain('startServer(buildHeadedServerEnv(globalFlags))');
    expect(buildHeadedServerEnv({ proxyUrl: null, configHash: '', explicitDirect: false }).BROWSE_PARENT_PID).toBe('0');
  });

  // Regression: newtab returned 403 for scoped tokens because the tab ownership
  // check ran before the newtab handler, checking the active tab (owned by root).
  test('newtab is excluded from tab ownership check', () => {
    const ownershipBlock = sliceBetween(SERVER_SRC, 'Tab ownership check (own-only tokens / pair-agent isolation)', 'newtab with ownership for scoped tokens');
    // The ownership check condition must exclude newtab
    expect(ownershipBlock).toContain("command !== 'newtab'");
  });

  // CVE fix: cookie-picker HTML must NOT inline the auth token.
  // getCookiePickerHTML() must not accept an authToken parameter.
  test('cookie-picker UI does not accept or inline auth token', () => {
    const uiSrc = fs.readFileSync(path.join(import.meta.dir, '../src/cookie-picker-ui.ts'), 'utf-8');
    // Function signature must not include authToken
    expect(uiSrc).not.toMatch(/getCookiePickerHTML\([^)]*authToken/);
    // No AUTH_TOKEN interpolation in template
    expect(uiSrc).not.toContain("AUTH_TOKEN = '${authToken");
    expect(uiSrc).not.toContain("AUTH_TOKEN = '${auth");
  });

  // CVE fix: cookie-picker route handler uses one-time code exchange, not open access.
  test('cookie-picker HTML route requires code or session cookie', () => {
    const routeSrc = fs.readFileSync(path.join(import.meta.dir, '../src/cookie-picker-routes.ts'), 'utf-8');
    // Must have code validation
    expect(routeSrc).toContain('pendingCodes');
    expect(routeSrc).toContain('validSessions');
    // Must NOT pass authToken to getCookiePickerHTML
    expect(routeSrc).not.toMatch(/getCookiePickerHTML\([^)]*authToken/);
    // Must set HttpOnly session cookie
    expect(routeSrc).toContain('HttpOnly');
    expect(routeSrc).toContain('SameSite=Strict');
  });
});

describe('Pair scope defaults and revocation surface', () => {
  // Regression: the CLI only sent scopes when --restrict was passed, so the
  // effective pairing default lived in two places (CLI omission + server
  // fallback) and could silently drift. Both sides must use the shared
  // DEFAULT_PAIR_SCOPES constant, and the CLI must send scopes
  // unconditionally (the old conditional-spread shape is banned).
  test('/pair default and CLI pairing body share DEFAULT_PAIR_SCOPES', async () => {
    const pair = await statusAndJson(await server.local('/pair', {
      method: 'POST', headers: bearer(server.rootToken), body: '{}',
    }));
    expect(pair.status).toBe(200);
    expect(pair.body.scopes).toEqual([...DEFAULT_PAIR_SCOPES]);
    const cliBlock = sliceBetween(CLI_SRC, 'async function handlePairAgent', 'Determine the URL to use');
    // Match the CODE shape, not a comment: a bare toContain('DEFAULT_PAIR_SCOPES')
    // is satisfied by the explanatory comment and passes vacuously on a revert.
    expect(cliBlock).toMatch(/scopes:\s*restrict\s*\?[\s\S]{0,200}?:\s*\[\.\.\.DEFAULT_PAIR_SCOPES\]/);
    expect(cliBlock).not.toMatch(/\.\.\.\(restrict\s*\?/);
  });

  // control is the only scope behind an explicit flag; a scopes list must
  // not be able to smuggle it into a pairing grant.
  test('/pair rejects control inside a scopes list without the control flag', async () => {
    const pair = (body: unknown) => server.local('/pair', {
      method: 'POST', headers: bearer(server.rootToken), body: JSON.stringify(body),
    });
    expect(await statusAndJson(await pair({ scopes: ['read', 'control'] }))).toEqual({
      status: 400,
      body: { error: 'The control scope requires the control flag (--control); it cannot be granted via a scopes list.' },
    });
    const flagged = await statusAndJson(await pair({ control: true }));
    expect(flagged.status).toBe(200);
    expect(flagged.body.scopes).toContain('control');
  });

  // CLI-encoded clientIds (spaces, UTF-8) must round-trip through the revoke
  // route; slicing the raw pathname 404s on every encoded name.
  test('DELETE /token decodes the clientId path segment', async () => {
    createToken({ clientId: 'encoded agent é', scopes: ['read'] });
    const resp = await statusAndJson(await server.local(`/token/${encodeURIComponent('encoded agent é')}`, {
      method: 'DELETE', headers: bearer(server.rootToken),
    }));
    expect(resp).toEqual({ status: 200, body: { revoked: 'encoded agent é', tokens_deleted: 1, tabs_released: 0 } });
    const malformed = await statusAndJson(await server.local('/token/%E0%A4%A', {
      method: 'DELETE', headers: bearer(server.rootToken),
    }));
    expect(malformed).toEqual({ status: 400, body: { error: 'Malformed client ID encoding' } });
  });
});
