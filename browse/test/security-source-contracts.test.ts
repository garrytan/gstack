/**
 * Source-level security contracts for the terminal-first sidebar.
 *
 * These checks intentionally cover unexported routing and lifecycle code. The
 * retired one-shot sidebar-agent/chat pipeline is not a fallback architecture:
 * terminal-agent.ts owns shell transport, while server.ts only brokers local
 * PTY sessions and pre-injection scans.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC_DIR = path.join(import.meta.dir, '../src');
const TERMINAL_SRC = fs.readFileSync(path.join(SRC_DIR, 'terminal-agent.ts'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(SRC_DIR, 'server.ts'), 'utf8');

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  if (startIndex < 0) throw new Error(`Missing source contract start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (endIndex < 0) throw new Error(`Missing source contract end: ${end}`);
  return source.slice(startIndex, endIndex);
}

describe('retired sidebar-agent/chat surface', () => {
  test('deleted agent source and dedicated tests stay absent', () => {
    for (const relativePath of [
      'sidebar-agent.ts',
      '../test/sidebar-agent.test.ts',
      '../test/sidebar-agent-roundtrip.test.ts',
    ]) {
      expect(fs.existsSync(path.join(SRC_DIR, relativePath))).toBe(false);
    }
  });

  test('server has no retired chat or agent route handlers', () => {
    expect(SERVER_SRC).not.toMatch(/url\.pathname === ['"]\/sidebar-(?:chat|command)['"]/);
    expect(SERVER_SRC).not.toMatch(/url\.pathname\.startsWith\(['"]\/sidebar-agent\//);
    expect(SERVER_SRC).not.toMatch(/url\.pathname === ['"]\/sidebar-agent\/(?:event|kill|stop)['"]/);
    expect(SERVER_SRC).toContain('chatEnabled: false');
  });

  test('server does not recreate processAgentEvent or spawnClaude', () => {
    expect(SERVER_SRC).not.toMatch(/^\s*(?:async\s+)?function\s+processAgentEvent\s*\(/m);
    expect(SERVER_SRC).not.toMatch(/^\s*(?:async\s+)?function\s+spawnClaude\s*\(/m);
  });
});

describe('terminal-agent transport boundary', () => {
  test('PTY listener is ephemeral and loopback-only', () => {
    const buildServer = section(TERMINAL_SRC, 'function buildServer()', '/internal/grant');
    expect(buildServer).toContain("hostname: '127.0.0.1'");
    expect(buildServer).toContain('port: 0');
    expect(buildServer).not.toContain("hostname: '0.0.0.0'");
  });

  test('internal grants require the per-boot bearer and reject stale generations', () => {
    const auth = section(TERMINAL_SRC, 'function checkInternalAuth', 'async function internalHandler');
    expect(auth).toContain("req.headers.get('authorization')");
    expect(auth).toContain('`Bearer ${INTERNAL_TOKEN}`');
    expect(auth).toContain("req.headers.get('x-browse-gen')");
    expect(auth).toContain('headerGen !== CURRENT_GEN');
    expect(auth).toContain("status: 403");
    expect(auth).toContain("status: 409");

    const grant = section(
      TERMINAL_SRC,
      "if (url.pathname === '/internal/grant'",
      "if (url.pathname === '/internal/revoke'",
    );
    expect(grant).toContain('return internalHandler(req');
    expect(grant).toContain('body.token.length > 16');
    expect(grant).toContain('validTokens.set(body.token, sid)');
  });

  test('WebSocket upgrade enforces extension origin and a granted attach token', () => {
    const wsRoute = section(
      TERMINAL_SRC,
      "if (url.pathname === '/ws')",
      "return new Response('not found'",
    );
    expect(wsRoute).toContain("origin.startsWith('chrome-extension://')");
    expect(wsRoute).toContain('origin !== `chrome-extension://${EXTENSION_ID}`');
    expect(wsRoute).toContain("new Response('forbidden origin', { status: 403 })");
    expect(wsRoute).toContain("req.headers.get('sec-websocket-protocol')");
    expect(wsRoute).toContain("raw.startsWith('gstack-pty.')");
    expect(wsRoute).toContain('validTokens.has(candidate)');
    expect(wsRoute).toContain("name === 'gstack_pty'");
    expect(wsRoute).toContain("new Response('unauthorized', { status: 401 })");
    expect(wsRoute).toContain("'Sec-WebSocket-Protocol': acceptedProtocol");
    expect(wsRoute.indexOf('forbidden origin')).toBeLessThan(wsRoute.indexOf('server.upgrade(req'));
    expect(wsRoute.indexOf("new Response('unauthorized'")).toBeLessThan(wsRoute.indexOf('server.upgrade(req'));
  });

  test('PTY spawn stays lazy and has one production owner', () => {
    const openHandler = section(TERMINAL_SRC, '      open(ws) {', '      message(ws, raw) {');
    const messageHandler = section(TERMINAL_SRC, '      message(ws, raw) {', '      close(ws, code');
    const spawnOwner = section(TERMINAL_SRC, 'function maybeSpawnPty', 'function buildServer');

    expect(openHandler).not.toContain('spawnClaude(');
    expect(messageHandler).toContain("msg?.type === 'start'");
    expect(messageHandler).toContain('maybeSpawnPty(ws, session)');
    expect(messageHandler).toMatch(/if \(!session\.spawned\)[\s\S]*maybeSpawnPty\(ws, session\)/);
    expect(spawnOwner).toContain('if (session.spawned) return true');
    expect(spawnOwner).toContain('spawnClaude(session.cols, session.rows');
    expect(TERMINAL_SRC.match(/\bspawnClaude\s*\(/g)).toHaveLength(2);
  });

  test('session and process cleanup revoke grants and terminate owned PTYs', () => {
    const dispose = section(TERMINAL_SRC, 'function disposeSession', 'function checkInternalAuth');
    expect(dispose).toContain('session.proc?.terminal?.close?.()');
    expect(dispose).toContain("session.proc.kill?.('SIGINT')");
    expect(dispose).toContain("session.proc.kill?.('SIGKILL')");
    expect(dispose).toContain('}, 3000)');

    const closeHandler = section(TERMINAL_SRC, '      close(ws, code', '    },\n  });');
    expect(closeHandler).toContain('sessions.delete(ws)');
    expect(closeHandler).toContain('validTokens.delete(session.cookie)');
    expect(closeHandler).toContain('clearInterval(session.pingInterval)');
    expect(closeHandler).toContain('disposeSession(session)');
    expect(closeHandler).toContain('sessionsById.delete(session.sessionId)');

    const processCleanup = section(TERMINAL_SRC, '  const cleanup = () => {', '// Export the internal token');
    expect(processCleanup).toContain('safeUnlink(PORT_FILE)');
    expect(processCleanup).toContain('clearAgentRecord(dir)');
    expect(processCleanup).toContain("process.on('SIGTERM', cleanup)");
    expect(processCleanup).toContain("process.on('SIGINT', cleanup)");
  });
});

describe('server PTY broker boundary', () => {
  test('session mint is root-authenticated and rolls back failed grants', () => {
    const route = section(
      SERVER_SRC,
      "if (url.pathname === '/pty-session'",
      "if (url.pathname === '/pty-session/reattach'",
    );
    expect(route).toMatch(/if \(!validateAuth\(req\)\)[\s\S]*status: 401/);
    expect(route).toContain('const lease = mintLease()');
    expect(route).toContain('const minted = mintPtySessionToken()');
    expect(route).toContain('grantPtyToken(minted.token, lease.sessionId)');
    expect(route).toContain('revokePtySessionToken(minted.token)');
    expect(route).toContain('revokeLease(lease.sessionId)');
    expect(route).toContain("'Set-Cookie': buildPtySetCookie(minted.token)");
  });

  test('dispose accepts only matching root auth and targets one session', () => {
    const route = section(
      SERVER_SRC,
      "if (url.pathname === '/pty-dispose'",
      "if (url.pathname === '/internal/lease-refresh'",
    );
    expect(route).toContain('headerToken === authToken');
    expect(route).toContain('authTokenFromBody === authToken');
    expect(route).toContain('if (!authedByHeader && !authedByBody)');
    expect(route).toContain('status: 401');
    expect(route).toContain('await restartPtySession(sessionId)');
    expect(route).toContain('revokeLease(sessionId)');
  });

  test('pre-inject scan is root-authenticated, bounded, and fail-warns without L4', () => {
    const route = section(
      SERVER_SRC,
      "if (url.pathname === '/pty-inject-scan'",
      "if (url.pathname === '/connect' && req.method === 'POST')",
    );
    expect(route).toMatch(/if \(!validateAuth\(req\)\)[\s\S]*status: 401/);
    expect(route).toContain("req.headers.get('content-length')");
    expect(route).toContain('contentLength > 64 * 1024');
    expect(route).toContain('status: 413');
    expect(route).toContain('await scanWithSidecar(text');
    expect(route).toContain("lv === 'unsafe'");
    expect(route).toContain("verdict = 'BLOCK'");
    expect(route).toContain("verdict = 'WARN'");
    expect(route).toContain("datamark: '<untrusted-page-content>'");
  });

  test('tunnel filter default-denies all PTY routes before dispatch', () => {
    const tunnelPaths = section(SERVER_SRC, 'const TUNNEL_PATHS', 'export const TUNNEL_COMMANDS');
    for (const route of [
      '/pty-session',
      '/pty-session/reattach',
      '/pty-restart',
      '/pty-dispose',
      '/pty-inject-scan',
      '/internal/lease-refresh',
    ]) {
      expect(tunnelPaths).not.toContain(`'${route}'`);
    }

    const handler = section(SERVER_SRC, "if (surface === 'tunnel')", '// beforeRoute overlay hook');
    expect(handler).toContain("logTunnelDenial(req, url, 'path_not_on_tunnel')");
    expect(handler).toContain("logTunnelDenial(req, url, 'root_token_on_tunnel')");
    expect(handler).toContain("logTunnelDenial(req, url, 'missing_scoped_token')");
    expect(handler).toContain('status: 404');
    expect(handler).toContain('status: 403');
    expect(handler).toContain('status: 401');
    expect(SERVER_SRC.indexOf("if (surface === 'tunnel')")).toBeLessThan(
      SERVER_SRC.indexOf("if (url.pathname === '/pty-session'"),
    );
  });
});
