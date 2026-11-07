/**
 * Dual-listener guards.
 *
 * Verifies the F1 refactor: the server binds TWO Bun.serve listeners (local
 * bootstrap + tunnel surface), the tunnel surface has a closed path allowlist,
 * root tokens are rejected on the tunnel, and the command allowlist restricts
 * which browser operations remote paired agents can invoke.
 *
 * Tunnel-surface behavior is asserted through a real buildFetchHandler() and
 * the route handlers; the remaining source-level assertions cover listener
 * wiring in start() and the tunnel helpers, which have no seam without ngrok.
 * Real-HTTP integration lives in browse/test/pair-agent-e2e.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TUNNEL_COMMANDS } from '../src/server';
import { __resetConnectRateLimit } from '../src/token-registry';
import { makeServer, stubRouteContext, callRoute, fakeTunnel, type TestServer } from './route-test-harness';
import { usePrivateStateRoot } from '../../test/helpers/private-state-root';
import { __resetTunnelDenialLog, logTunnelDenial } from '../src/tunnel-denial-log';

const SERVER_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/server.ts'), 'utf-8');
const TABLE_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/routes/table.ts'), 'utf-8');

const stateRoot = usePrivateStateRoot();
let server: TestServer;
let scoped = '';
const overlayCalls: string[] = [];
beforeAll(() => {
  server = makeServer({ beforeRoute: async (req, surface) => { overlayCalls.push(`${surface} ${new URL(req.url).pathname}`); return null; } });
  scoped = server.scopedToken('dual-listener-agent');
});
const savedPairAgent = process.env.GSTACK_PAIR_AGENT;
const restorePairAgent = () => {
  if (savedPairAgent === undefined) delete process.env.GSTACK_PAIR_AGENT;
  else process.env.GSTACK_PAIR_AGENT = savedPairAgent;
};
afterAll(() => server.cleanup());
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
async function statusAndJson(resp: Response): Promise<{ status: number; body: any }> {
  return { status: resp.status, body: await resp.json() };
}

function sliceBetween(source: string, start: string, end: string): string {
  const s = source.indexOf(start);
  if (s === -1) throw new Error(`Marker not found: ${start}`);
  const e = source.indexOf(end, s + start.length);
  if (e === -1) throw new Error(`End marker not found: ${end}`);
  return source.slice(s, e);
}

function extractSetContents(source: string, constName: string): Set<string> {
  const start = source.indexOf(`const ${constName} = new Set<string>([`);
  if (start === -1) throw new Error(`Set not found: ${constName}`);
  const end = source.indexOf(']);', start);
  const body = source.slice(start, end);
  const matches = body.matchAll(/'([^']+)'/g);
  return new Set([...matches].map(m => m[1]));
}

describe('Dual-listener surface types', () => {
  test('Surface type is a union of local and tunnel', () => {
    // Types have no runtime seam; the owner moved to the route table and
    // server.ts re-exports it.
    expect(TABLE_SRC).toContain("export type Surface = 'local' | 'tunnel'");
    expect(SERVER_SRC).toContain('export type { Surface };');
  });

  test('tunnelServer state variable exists alongside tunnelActive/tunnelUrl/tunnelListener', () => {
    // The boolean tunnelActive stays for external consumers (idle check, watchdog, SIGTERM).
    // tunnelServer is the new Bun.serve listener reference.
    expect(SERVER_SRC).toMatch(/let\s+tunnelServer:\s*ReturnType<typeof\s+Bun\.serve>\s*\|\s*null\s*=\s*null/);
  });
});

describe('Tunnel path allowlist', () => {
  test('TUNNEL_PATHS is a closed set containing exactly /connect, /command', () => {
    // /sidebar-chat sat in this set long after the endpoint was deleted with
    // the chat-queue path — a stale entry in the audited tunnel attack
    // surface. The set is exactly the pair ceremony + command endpoint.
    const paths = extractSetContents(SERVER_SRC, 'TUNNEL_PATHS');
    expect(paths).toEqual(new Set(['/connect', '/command']));
  });

  test('TUNNEL_PATHS does NOT contain bootstrap or admin paths', () => {
    const paths = extractSetContents(SERVER_SRC, 'TUNNEL_PATHS');
    // These must never be on the tunnel surface
    const forbidden = [
      '/health', '/extension-token', '/welcome', '/cookie-picker',
      '/inspector', '/inspector/pick', '/inspector/events', '/inspector/style',
      '/tunnel/start', '/tunnel/stop',
      '/pair', '/token', '/refs',
      '/activity/stream', '/activity/history',
    ];
    for (const p of forbidden) {
      expect(paths.has(p)).toBe(false);
    }
  });
});

describe('Tunnel command allowlist', () => {
  // The full closed set of commands reachable over the tunnel surface. Adding
  // or removing a command here means changing the literal in server.ts AND
  // updating this list — that double-edit is the point. A single-source
  // "include the items in the source" assertion would silently widen the
  // surface during a refactor that adds a command to server.ts without test
  // review. The exact-set match catches it.
  const EXPECTED_TUNNEL_COMMANDS = new Set([
    // Original 17
    'goto', 'click', 'text', 'screenshot',
    'html', 'links', 'forms', 'accessibility',
    'attrs', 'media', 'data',
    'scroll', 'press', 'type', 'select', 'wait',
    // Tab + navigation primitives operator docs and CLI hints already promised
    'newtab', 'tabs', 'back', 'forward', 'reload',
    // Read/inspect/write operators paired agents need to be useful
    'snapshot', 'fill', 'url', 'closetab',
  ]);

  test('TUNNEL_COMMANDS literal matches the closed allowlist exactly (catches additions/removals without test update)', () => {
    const cmds = new Set(TUNNEL_COMMANDS);
    // Both directions: anything in the source must be expected, and anything
    // expected must be in the source. The intersection-only style of the old
    // must-include / must-exclude tests let new commands sneak into the source
    // without a corresponding test update.
    for (const c of cmds) {
      expect(EXPECTED_TUNNEL_COMMANDS.has(c)).toBe(true);
    }
    for (const c of EXPECTED_TUNNEL_COMMANDS) {
      expect(cmds.has(c)).toBe(true);
    }
    expect(cmds.size).toBe(EXPECTED_TUNNEL_COMMANDS.size);
  });

  test('TUNNEL_COMMANDS does NOT include daemon-configuration or bootstrap commands', () => {
    const cmds = TUNNEL_COMMANDS;
    const forbidden = [
      'launch', 'launch-browser', 'connect', 'disconnect',
      'restart', 'stop', 'tunnel-start', 'tunnel-stop',
      'token-mint', 'token-revoke', 'cookie-picker', 'cookie-import',
      'inspector-pick', 'pair', 'unpair', 'cookies', 'setup',
    ];
    for (const c of forbidden) {
      expect(cmds.has(c)).toBe(false);
    }
  });

  test('newtab ownership exemption preserved (catches refactors that re-introduce the catch-22)', () => {
    // The /command handler must skip the per-tab ownership check when the
    // command is `newtab`, otherwise paired agents have no way to create their
    // own tab — every other write command requires an owned tab, and you can't
    // own a tab you haven't created. The string `command !== 'newtab'` is the
    // contract that breaks the catch-22.
    expect(SERVER_SRC).toMatch(/command\s*!==\s*['"]newtab['"]/);
  });
});

describe('Request handler factory', () => {
  test('makeFetchHandler takes a Surface parameter and closes over it', () => {
    expect(SERVER_SRC).toContain('makeFetchHandler = (surface: Surface)');
  });

  test('Bun.serve local listener uses handle.fetchLocal from buildFetchHandler', () => {
    // v1.35.0.0: factory returns handle.fetchLocal; start() binds Bun.serve with it.
    expect(SERVER_SRC).toContain("fetch: handle.fetchLocal");
  });

  test('Tunnel listener bind uses handle.fetchTunnel from buildFetchHandler', () => {
    // v1.35.0.0: factory returns handle.fetchTunnel; tunnel start sites use it.
    // The BROWSE_TUNNEL=1 startup passes it to the shared startTunnel() helper
    // (which owns the Bun.serve bind); the BROWSE_TUNNEL_LOCAL_ONLY=1 test path
    // binds its own listener with it directly.
    // The /tunnel/start handler INSIDE the factory still uses makeFetchHandler('tunnel')
    // because it has the local helper in closure scope.
    expect(SERVER_SRC).toContain('fetchHandler: handle.fetchTunnel');
    expect(SERVER_SRC).toContain('fetch: handle.fetchTunnel');
    // The factory's internal makeFetchHandler('tunnel') still appears at least
    // once for the /tunnel/start route's startTunnel call + the factory's return.
    const internalOccurrences = SERVER_SRC.match(/makeFetchHandler\('tunnel'\)/g);
    expect(internalOccurrences).not.toBeNull();
  });
});

describe('Tunnel surface filter', () => {
  const NOT_FOUND = { status: 404, body: { error: 'Not found' } };

  test('tunnel surface filter runs before route dispatch', async () => {
    // Denied tunnel requests never reach the beforeRoute overlay or a route.
    overlayCalls.length = 0;
    expect(await statusAndJson(await server.tunnel('/health'))).toEqual(NOT_FOUND);
    expect((await server.tunnel('/command', { method: 'POST', headers: bearer(server.rootToken), body: '{}' })).status).toBe(403);
    expect((await server.tunnel('/command', { method: 'POST', body: '{}' })).status).toBe(401);
    expect(overlayCalls).toEqual([]);
    __resetConnectRateLimit();
    await server.tunnel('/connect');
    expect(overlayCalls).toEqual(['tunnel /connect']);
  });

  test('tunnel surface 404s paths not on allowlist', async () => {
    for (const p of ['/health', '/pty-session', '/extension-token', '/inspector', '/token', '/no-such-route']) {
      for (const headers of [{}, bearer(scoped)]) {
        expect(await statusAndJson(await server.tunnel(p, { method: 'POST', headers }))).toEqual(NOT_FOUND);
      }
    }
  });

  test('tunnel surface 403s root token bearers with clear hint', async () => {
    for (const p of ['/connect', '/command']) {
      const resp = await statusAndJson(await server.tunnel(p, { method: 'POST', headers: bearer(server.rootToken), body: '{}' }));
      expect(resp.status).toBe(403);
      expect(resp.body.error).toBe('Root token rejected on tunnel surface');
      expect(resp.body.hint).toContain('pair via /connect');
    }
  });

  test('tunnel surface 401s when non-/connect request lacks scoped token', async () => {
    const denied = await statusAndJson(await server.tunnel('/command', { method: 'POST', body: '{}' }));
    expect(denied).toEqual({ status: 401, body: { error: 'Unauthorized' } });
    __resetConnectRateLimit();
    const connect = await statusAndJson(await server.tunnel('/connect', { method: 'POST', body: '{}' }));
    expect(connect).toEqual({ status: 400, body: { error: 'Missing setup_key' } });
  });
});

describe('GET /connect alive probe', () => {
  test('GET /connect returns {alive: true} unauth on both surfaces', async () => {
    for (const call of [server.local, server.tunnel]) {
      __resetConnectRateLimit();
      expect(await statusAndJson(await call('/connect'))).toEqual({ status: 200, body: { alive: true } });
    }
  });
});

describe('/command tunnel command allowlist', () => {
  test('/command handler delegates to canDispatchOverTunnel when surface is tunnel', async () => {
    // Args-aware since the --out (disk write) tunnel ban: the dispatch gate
    // takes both the command and its args.
    for (const body of [{ command: 'launch' }, { command: 'eval', args: ['--out', '/tmp/dual-listener-out', '1'] }]) {
      const resp = await statusAndJson(await server.tunnel('/command', {
        method: 'POST', headers: bearer(scoped), body: JSON.stringify(body),
      }));
      expect(resp.status).toBe(403);
      expect(resp.body.error).toBe(`Command '${body.command}' is not allowed over the tunnel surface`);
      expect(resp.body.hint).toContain('Tunnel commands: ');
    }
  });

  const guarded = [
    { command: 'goto', args: ['file://./.env'] },
    { command: 'newtab', args: ['file:///tmp/page.html'] },
    { command: 'eval', args: ['script.js'] },
    { command: 'screenshot', args: ['assets/logo.png'] },
    { command: 'snapshot', args: ['-a', '-o', 'annotated.png'] },
    { command: 'screenshot', args: [] },
    { command: 'screenshot', args: ['--selector', '.hero'] },
    { command: 'snapshot', args: ['-a'] },
    { command: 'snapshot', args: ['-H', '{"@e1":"green"}'] },
  ];
  function recordingCtx(handled: unknown[]) {
    return stubRouteContext({
      resetIdleTimer: () => {},
      commands: {
        handle: async (body) => { handled.push(body); return new Response('{"ok":true}'); },
        handleInternal: async () => { throw new Error('unexpected handleInternal'); },
      },
    });
  }

  test('tunnel surface refuses non-web navigation, eval, and screenshot output paths before dispatch', async () => {
    const handled: unknown[] = [];
    for (const body of guarded) {
      const resp = await statusAndJson(await callRoute('POST', '/command', recordingCtx(handled), { surface: 'tunnel', body }));
      expect(resp.status).toBe(403);
      expect(resp.body.error).toBe(`Command '${body.command}' is not allowed over the tunnel surface`);
    }
    expect(handled).toEqual([]);
  });

  test('local surface dispatches the same commands unchanged', async () => {
    const handled: unknown[] = [];
    for (const body of guarded) {
      const resp = await callRoute('POST', '/command', recordingCtx(handled), { surface: 'local', body });
      expect(resp.status).toBe(200);
    }
    expect(handled).toEqual(guarded);
  });

  test('a screenshot with no args field is gated like args: [] (tunnel refuses, local dispatches)', async () => {
    const handled: unknown[] = [];
    const body = { command: 'screenshot' };
    const tunnel = await statusAndJson(await callRoute('POST', '/command', recordingCtx(handled), { surface: 'tunnel', body }));
    expect(tunnel.status).toBe(403);
    expect(tunnel.body.error).toBe(`Command 'screenshot' is not allowed over the tunnel surface`);
    expect(handled).toEqual([]);
    const local = await callRoute('POST', '/command', recordingCtx(handled), { surface: 'local', body });
    expect(local.status).toBe(200);
    expect(handled).toEqual([body]);
  });

  test('tunnel surface still dispatches web navigation and path-free screenshots', async () => {
    const handled: unknown[] = [];
    const allowed = [
      { command: 'goto', args: ['https://example.com'] },
      { command: 'newtab', args: ['http://localhost:3000/'] },
      { command: 'screenshot', args: ['--base64'] },
      { command: 'screenshot', args: ['--base64', '--selector', '.hero'] },
      { command: 'snapshot', args: ['-i'] },
    ];
    for (const body of allowed) {
      const resp = await callRoute('POST', '/command', recordingCtx(handled), { surface: 'tunnel', body });
      expect(resp.status).toBe(200);
    }
    expect(handled).toEqual(allowed);
  });
});

describe('Tunnel listener lifecycle', () => {
  test('closeTunnel() helper tears down both ngrok and the tunnel Bun.serve listener', () => {
    const helperBlock = sliceBetween(
      SERVER_SRC,
      'async function closeTunnel()',
      'tunnelActive = false;'
    );
    expect(helperBlock).toContain('tunnelListener.close()');
    expect(helperBlock).toContain('tunnelServer.stop');
  });

  test('/tunnel/start binds the tunnel listener on an ephemeral port (via startTunnel)', () => {
    // The route calls ctx.tunnel.start (server-auth.test.ts pins that call);
    // the factory wires it to the shared startTunnel() helper with the
    // factory-scoped tunnel-surface handler.
    const startBlock = sliceBetween(SERVER_SRC, 'start: (authtoken) => startTunnel({', 'commands: {');
    expect(startBlock).toContain("makeFetchHandler('tunnel')");
    // The helper owns the ephemeral bind and points ngrok at the TUNNEL
    // port — never the local daemon port.
    const helperBlock = sliceBetween(
      SERVER_SRC,
      'async function startTunnel(',
      'Module-level validateAuth deleted'
    );
    expect(helperBlock).toContain('Bun.serve');
    expect(helperBlock).toContain('port: 0');
    expect(helperBlock).toContain("addr: tunnelPort");
  });

  function startCtx(result: { ok: false; stage: 'bind' | 'ngrok'; error: Error }) {
    return stubRouteContext({
      tunnel: {
        state: () => ({ active: false, url: null, hasListener: false }),
        close: async () => {}, resolveAuthtoken: () => 'ngrok-token', start: async () => result,
      },
    });
  }

  test('/tunnel/start hard-fails on tunnel listener bind error (no local fallback)', async () => {
    process.env.GSTACK_PAIR_AGENT = 'on';
    try {
      const resp = await callRoute('POST', '/tunnel/start', startCtx({ ok: false, stage: 'bind', error: new Error('EADDRINUSE') }));
      expect(await statusAndJson(resp)).toEqual({ status: 500, body: { error: 'Failed to bind tunnel listener: EADDRINUSE' } });
    } finally { restorePairAgent(); }
  });

  test('/tunnel/start probes the cached tunnel via GET /connect, not /health', async () => {
    process.env.GSTACK_PAIR_AGENT = 'on';
    const tunnel = fakeTunnel(200);
    try {
      await callRoute('POST', '/tunnel/start', stubRouteContext({
        tunnel: {
          state: () => ({ active: true, url: tunnel.url, hasListener: true }),
          close: async () => {}, resolveAuthtoken: () => null, start: async () => { throw new Error('unused'); },
        },
      }));
      expect(tunnel.hits).toEqual(['GET /connect']);
    } finally { tunnel.stop(); restorePairAgent(); }
  });

  test('/tunnel/start tears down tunnel listener when ngrok.forward fails', async () => {
    // startTunnel owns the error-path teardown: boundTunnel.stop(true) plus
    // the ngrok listener close must both run on any post-bind failure, so a
    // failed start can't leak sockets or an active ngrok session.
    const helperBlock = sliceBetween(
      SERVER_SRC,
      'async function startTunnel(',
      'Module-level validateAuth deleted'
    );
    expect(helperBlock).toContain('boundTunnel.stop(true)');
    expect(helperBlock).toContain('tunnelListener.close()');
    // ...and the route maps that failure to the 500 response.
    process.env.GSTACK_PAIR_AGENT = 'on';
    try {
      const resp = await callRoute('POST', '/tunnel/start', startCtx({ ok: false, stage: 'ngrok', error: new Error('forward refused') }));
      expect(await statusAndJson(resp)).toEqual({ status: 500, body: { error: 'Failed to open ngrok tunnel: forward refused' } });
    } finally { restorePairAgent(); }
  });

  test('BROWSE_TUNNEL=1 startup uses dual-listener pattern', () => {
    const startupBlock = sliceBetween(
      SERVER_SRC,
      "process.env.BROWSE_TUNNEL === '1'",
      'start().catch'
    );
    // v1.35.0.0: start() refactored to use handle.fetchTunnel from the factory.
    // The ephemeral-port bind + ngrok forward now live in the shared
    // startTunnel() helper the startup path delegates to.
    expect(startupBlock).toContain('startTunnel(');
    expect(startupBlock).toContain('handle.fetchTunnel');
    // Must NOT forward ngrok at the local port — neither at the call site
    // nor inside the helper, which binds port: 0 and forwards at tunnelPort.
    expect(startupBlock).not.toContain('addr: port,');
    const helperBlock = sliceBetween(
      SERVER_SRC,
      'async function startTunnel(',
      'Module-level validateAuth deleted'
    );
    expect(helperBlock).toContain('port: 0');
    expect(helperBlock).toContain('addr: tunnelPort');
    expect(helperBlock).not.toContain('addr: port,');
  });
});

describe('Rate limit + denial log wiring', () => {
  test('logTunnelDenial is imported and invoked on every denial path', () => {
    expect(SERVER_SRC).toContain("import { logTunnelDenial } from './tunnel-denial-log'");
    // Must be called on each of the three denial reasons
    expect(SERVER_SRC).toContain("logTunnelDenial(req, url, 'path_not_on_tunnel')");
    expect(SERVER_SRC).toContain("logTunnelDenial(req, url, 'root_token_on_tunnel')");
    expect(SERVER_SRC).toContain("logTunnelDenial(req, url, 'missing_scoped_token')");
  });

  test('a denial is logged under the state root current at write time (#2895)', async () => {
    __resetTunnelDenialLog();
    const url = new URL('http://127.0.0.1/command');
    logTunnelDenial(new Request(url), url, 'missing_scoped_token');
    const log = path.join(stateRoot.dir, 'security', 'attempts.jsonl');
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(log) && Date.now() < deadline) await Bun.sleep(10);
    expect(fs.readFileSync(log, 'utf8')).toContain('missing_scoped_token');
  });

  test('/connect rate limit was loosened from 3/min to 300/min', () => {
    const registrySrc = fs.readFileSync(
      path.join(import.meta.dir, '../src/token-registry.ts'),
      'utf-8'
    );
    expect(registrySrc).toMatch(/CONNECT_RATE_LIMIT\s*=\s*300/);
    expect(registrySrc).not.toMatch(/CONNECT_RATE_LIMIT\s*=\s*3\s*;/);
  });
});

describe('E3: /welcome GSTACK_SLUG path traversal gate', () => {
  test('/welcome validates GSTACK_SLUG against ^[a-z0-9_-]+$ before interpolating into path', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-welcome-slug-'));
    const page = (slug: string) => path.join(home, '.gstack/projects', slug, 'designs/welcome-page-20260331/finalized.html');
    for (const [slug, body] of [['unknown', 'UNKNOWN-SLUG-PAGE'], ['good-slug_1', 'GOOD-SLUG-PAGE']]) {
      fs.mkdirSync(path.dirname(page(slug)), { recursive: true });
      fs.writeFileSync(page(slug), body);
    }
    const saved = { HOME: process.env.HOME, GSTACK_SLUG: process.env.GSTACK_SLUG, GSTACK_HOME: process.env.GSTACK_HOME };
    try {
      process.env.HOME = home;
      delete process.env.GSTACK_HOME;
      process.env.GSTACK_SLUG = 'good-slug_1';
      expect(await (await server.local('/welcome')).text()).toBe('GOOD-SLUG-PAGE');
      // A traversal slug (and any slug outside the charset) falls back to 'unknown'.
      for (const slug of ['../../good-slug_1', 'Good-Slug', 'a/b']) {
        process.env.GSTACK_SLUG = slug;
        expect(await (await server.local('/welcome')).text()).toBe('UNKNOWN-SLUG-PAGE');
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
