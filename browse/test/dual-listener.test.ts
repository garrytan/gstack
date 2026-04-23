/**
 * Dual-listener source-level guards.
 *
 * Verifies the F1 refactor: the server binds TWO Bun.serve listeners (local
 * bootstrap + tunnel surface), the tunnel surface has a closed path allowlist,
 * root tokens are rejected on the tunnel, and the command allowlist restricts
 * which browser operations remote paired agents can invoke.
 *
 * These are source-level assertions — they keep future contributors from
 * silently widening the tunnel surface during a routine refactor.  Behavioral
 * integration tests live in the E2E suite (browse/test/pair-agent-e2e.test.ts,
 * added in a later wave commit).
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const SERVER_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/server.ts'), 'utf-8');

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
    expect(SERVER_SRC).toContain("export type Surface = 'local' | 'tunnel'");
  });

  test('tunnelServer state variable exists alongside tunnelActive/tunnelUrl/tunnelListener', () => {
    // The boolean tunnelActive stays for external consumers (idle check, watchdog, SIGTERM).
    // tunnelServer is the new Bun.serve listener reference.
    expect(SERVER_SRC).toMatch(/let\s+tunnelServer:\s*ReturnType<typeof\s+Bun\.serve>\s*\|\s*null\s*=\s*null/);
  });
});

describe('Tunnel path allowlist', () => {
  test('TUNNEL_PATHS is a closed set containing exactly /connect, /command, /sidebar-chat', () => {
    const paths = extractSetContents(SERVER_SRC, 'TUNNEL_PATHS');
    expect(paths).toEqual(new Set(['/connect', '/command', '/sidebar-chat']));
  });

  test('TUNNEL_PATHS does NOT contain bootstrap or admin paths', () => {
    const paths = extractSetContents(SERVER_SRC, 'TUNNEL_PATHS');
    // These must never be on the tunnel surface
    const forbidden = [
      '/health', '/welcome', '/cookie-picker',
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
  test('TUNNEL_COMMANDS is a closed set of browser-driving commands only', () => {
    const cmds = extractSetContents(SERVER_SRC, 'TUNNEL_COMMANDS');
    // Must include the core browser-driving commands
    const required = [
      'goto', 'click', 'text', 'screenshot', 'html', 'links',
      'forms', 'accessibility', 'attrs', 'media', 'data',
      'scroll', 'press', 'type', 'select', 'wait', 'eval',
    ];
    for (const c of required) {
      expect(cmds.has(c)).toBe(true);
    }
  });

  test('TUNNEL_COMMANDS does NOT include daemon-configuration or bootstrap commands', () => {
    const cmds = extractSetContents(SERVER_SRC, 'TUNNEL_COMMANDS');
    const forbidden = [
      'launch', 'launch-browser', 'connect', 'disconnect',
      'restart', 'stop', 'tunnel-start', 'tunnel-stop',
      'token-mint', 'token-revoke', 'cookie-picker', 'cookie-import',
      'inspector-pick',
    ];
    for (const c of forbidden) {
      expect(cmds.has(c)).toBe(false);
    }
  });
});

describe('Request handler factory', () => {
  test('makeFetchHandler takes a Surface parameter and closes over it', () => {
    expect(SERVER_SRC).toContain('makeFetchHandler = (surface: Surface)');
  });

  test('Bun.serve local listener uses makeFetchHandler with "local" surface', () => {
    expect(SERVER_SRC).toContain("fetch: makeFetchHandler('local')");
  });

  test('Tunnel listener bind uses makeFetchHandler with "tunnel" surface', () => {
    const occurrences = SERVER_SRC.match(/makeFetchHandler\('tunnel'\)/g);
    expect(occurrences).not.toBeNull();
    // Must appear at least twice: once in /tunnel/start, once in BROWSE_TUNNEL=1 startup
    expect(occurrences!.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Tunnel surface filter', () => {
  test('tunnel surface filter runs before route dispatch', () => {
    // The filter must appear inside makeFetchHandler BEFORE the first route
    // handler (/cookie-picker is the earliest route).
    const fetchBody = sliceBetween(
      SERVER_SRC,
      'makeFetchHandler = (surface: Surface)',
      "url.pathname.startsWith('/cookie-picker')"
    );
    expect(fetchBody).toContain("surface === 'tunnel'");
    expect(fetchBody).toContain('path_not_on_tunnel');
    expect(fetchBody).toContain('root_token_on_tunnel');
    expect(fetchBody).toContain('missing_scoped_token');
  });

  test('tunnel surface 404s paths not on allowlist', () => {
    const filterBlock = sliceBetween(
      SERVER_SRC,
      "surface === 'tunnel'",
      "if (url.pathname === '/connect' && req.method === 'GET')"
    );
    expect(filterBlock).toContain('TUNNEL_PATHS.has');
    expect(filterBlock).toContain('status: 404');
  });

  test('tunnel surface 403s root token bearers with clear hint', () => {
    const filterBlock = sliceBetween(
      SERVER_SRC,
      "surface === 'tunnel'",
      "if (url.pathname === '/connect' && req.method === 'GET')"
    );
    expect(filterBlock).toContain('isRootRequest(req)');
    expect(filterBlock).toContain('Root token rejected on tunnel surface');
    expect(filterBlock).toContain('pair via /connect');
    expect(filterBlock).toContain('status: 403');
  });

  test('tunnel surface 401s when non-/connect request lacks scoped token', () => {
    const filterBlock = sliceBetween(
      SERVER_SRC,
      "surface === 'tunnel'",
      "if (url.pathname === '/connect' && req.method === 'GET')"
    );
    expect(filterBlock).toContain("url.pathname !== '/connect'");
    expect(filterBlock).toContain('getTokenInfo(req)');
    expect(filterBlock).toContain('status: 401');
  });
});

describe('GET /connect alive probe', () => {
  test('GET /connect returns {alive: true} unauth on both surfaces', () => {
    const getConnect = sliceBetween(
      SERVER_SRC,
      "if (url.pathname === '/connect' && req.method === 'GET')",
      "// Cookie picker routes"
    );
    expect(getConnect).toContain('alive: true');
    expect(getConnect).toContain('status: 200');
  });
});

describe('/command tunnel command allowlist', () => {
  test('/command handler checks TUNNEL_COMMANDS when surface is tunnel', () => {
    const commandBlock = sliceBetween(
      SERVER_SRC,
      "url.pathname === '/command' && req.method === 'POST'",
      'return handleCommand(body, tokenInfo)'
    );
    expect(commandBlock).toContain("surface === 'tunnel'");
    expect(commandBlock).toContain('TUNNEL_COMMANDS.has');
    expect(commandBlock).toContain('disallowed_command');
    expect(commandBlock).toContain('is not allowed over the tunnel surface');
    expect(commandBlock).toContain('status: 403');
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

  test('/tunnel/start binds the tunnel listener on an ephemeral port', () => {
    const startBlock = sliceBetween(
      SERVER_SRC,
      "url.pathname === '/tunnel/start' && req.method === 'POST'",
      "url.pathname === '/refs'"
    );
    expect(startBlock).toContain('Bun.serve');
    expect(startBlock).toContain('port: 0');
    expect(startBlock).toContain("makeFetchHandler('tunnel')");
    expect(startBlock).toContain("addr: tunnelPort");
  });

  test('/tunnel/start hard-fails on tunnel listener bind error (no local fallback)', () => {
    const startBlock = sliceBetween(
      SERVER_SRC,
      "url.pathname === '/tunnel/start' && req.method === 'POST'",
      "url.pathname === '/refs'"
    );
    // Must return 500 on bind failure, not silently continue
    expect(startBlock).toContain('Failed to bind tunnel listener');
    expect(startBlock).toContain('status: 500');
  });

  test('/tunnel/start probes the cached tunnel via GET /connect, not /health', () => {
    const startBlock = sliceBetween(
      SERVER_SRC,
      "url.pathname === '/tunnel/start' && req.method === 'POST'",
      "url.pathname === '/refs'"
    );
    expect(startBlock).toContain('${tunnelUrl}/connect');
    expect(startBlock).toContain("method: 'GET'");
    // The old /health probe must NOT reappear
    expect(startBlock).not.toContain('${tunnelUrl}/health');
  });

  test('/tunnel/start tears down tunnel listener when ngrok.forward fails', () => {
    const startBlock = sliceBetween(
      SERVER_SRC,
      "url.pathname === '/tunnel/start' && req.method === 'POST'",
      "url.pathname === '/refs'"
    );
    // boundTunnel.stop(true) must be called on ngrok error
    expect(startBlock).toContain('boundTunnel.stop(true)');
    expect(startBlock).toContain('Failed to open ngrok tunnel');
  });

  test('BROWSE_TUNNEL=1 startup uses dual-listener pattern', () => {
    const startupBlock = sliceBetween(
      SERVER_SRC,
      "process.env.BROWSE_TUNNEL === '1'",
      'start().catch'
    );
    expect(startupBlock).toContain('Bun.serve');
    expect(startupBlock).toContain('port: 0');
    expect(startupBlock).toContain("makeFetchHandler('tunnel')");
    expect(startupBlock).toContain('addr: tunnelPort');
    // Must NOT forward ngrok at the local port
    expect(startupBlock).not.toContain('addr: port,');
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
  test('/welcome validates GSTACK_SLUG against ^[a-z0-9_-]+$ before interpolating into path', () => {
    const welcomeBlock = sliceBetween(
      SERVER_SRC,
      "url.pathname === '/welcome'",
      'if (fs.existsSync(projectWelcome)) return projectWelcome;'
    );
    // Must validate the slug before using it in a path
    expect(welcomeBlock).toMatch(/\/\^\[a-z0-9_-\]\+\$\/\.test\(rawSlug\)/);
    // Must fall back to a safe default when the slug fails validation
    expect(welcomeBlock).toContain("'unknown'");
  });
});
