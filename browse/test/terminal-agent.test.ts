/**
 * Unit tests for the Terminal-tab PTY agent and its server-side glue.
 *
 * Coverage:
 *   - pty-session-cookie module: mint / validate / revoke / TTL pruning.
 *   - source-level guard: /pty-session and /terminal/* are NOT in TUNNEL_PATHS.
 *   - source-level guard: /health does not surface ptyToken.
 *   - source-level guard: terminal-agent binds 127.0.0.1 only.
 *   - source-level guard: terminal-agent enforces Origin AND cookie on /ws.
 *
 * These are read-only checks against source — they prevent silent surface
 * widening during a routine refactor (matches the dual-listener.test.ts
 * pattern). End-to-end behavior (real /bin/bash PTY round-trip,
 * tunnel-surface 404 + denial-log) lives in
 * `browse/test/terminal-agent-integration.test.ts`.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import {
  mintPtySessionToken, validatePtySessionToken, revokePtySessionToken,
  extractPtyCookie, buildPtySetCookie, buildPtyClearCookie,
  PTY_COOKIE_NAME, __resetPtySessions,
} from '../src/pty-session-cookie';

const SERVER_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/server.ts'), 'utf-8');
const AGENT_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/terminal-agent.ts'), 'utf-8');

describe('pty-session-cookie: mint/validate/revoke', () => {
  beforeEach(() => __resetPtySessions());

  test('a freshly minted token validates', () => {
    const { token } = mintPtySessionToken();
    expect(validatePtySessionToken(token)).toBe(true);
  });

  test('null and unknown tokens fail validation', () => {
    expect(validatePtySessionToken(null)).toBe(false);
    expect(validatePtySessionToken(undefined)).toBe(false);
    expect(validatePtySessionToken('')).toBe(false);
    expect(validatePtySessionToken('not-a-real-token')).toBe(false);
  });

  test('revoke makes a token invalid', () => {
    const { token } = mintPtySessionToken();
    expect(validatePtySessionToken(token)).toBe(true);
    revokePtySessionToken(token);
    expect(validatePtySessionToken(token)).toBe(false);
  });

  test('Set-Cookie has HttpOnly + SameSite=Strict + Path=/ + Max-Age', () => {
    const { token } = mintPtySessionToken();
    const cookie = buildPtySetCookie(token);
    expect(cookie).toContain(`${PTY_COOKIE_NAME}=${token}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).toMatch(/Max-Age=\d+/);
    // Secure is intentionally omitted — daemon binds 127.0.0.1 over HTTP.
    expect(cookie).not.toContain('Secure');
  });

  test('clear-cookie has Max-Age=0', () => {
    expect(buildPtyClearCookie()).toContain('Max-Age=0');
  });

  test('extractPtyCookie reads gstack_pty from a Cookie header', () => {
    const { token } = mintPtySessionToken();
    const req = new Request('http://127.0.0.1/ws', {
      headers: { 'cookie': `othercookie=foo; gstack_pty=${token}; baz=qux` },
    });
    expect(extractPtyCookie(req)).toBe(token);
  });

  test('extractPtyCookie returns null when the cookie is missing', () => {
    const req = new Request('http://127.0.0.1/ws', {
      headers: { 'cookie': 'unrelated=value' },
    });
    expect(extractPtyCookie(req)).toBe(null);
  });
});

describe('Source-level guard: /pty-session is not on the tunnel surface', () => {
  test('TUNNEL_PATHS does not include /pty-session or /terminal/*', () => {
    const start = SERVER_SRC.indexOf('const TUNNEL_PATHS = new Set<string>([');
    expect(start).toBeGreaterThan(-1);
    const end = SERVER_SRC.indexOf(']);', start);
    const body = SERVER_SRC.slice(start, end);
    expect(body).not.toContain('/pty-session');
    expect(body).not.toContain('/terminal/');
    expect(body).not.toContain('/terminal-');
  });
});

describe('Source-level guard: /health does NOT surface ptyToken', () => {
  test('/health response body does not include ptyToken', () => {
    const healthIdx = SERVER_SRC.indexOf("url.pathname === '/health'");
    expect(healthIdx).toBeGreaterThan(-1);
    // Slice from /health through the response close-bracket.
    const slice = SERVER_SRC.slice(healthIdx, healthIdx + 2000);
    // The /health JSON.stringify body must not mention the cookie token.
    // It's allowed to include `terminalPort` (a port number, not auth).
    expect(slice).not.toContain('ptyToken');
    expect(slice).not.toContain('gstack_pty');
    expect(slice).toContain('terminalPort');
  });
});

describe('Source-level guard: terminal-agent', () => {
  test('binds 127.0.0.1 only, never 0.0.0.0', () => {
    expect(AGENT_SRC).toContain("hostname: '127.0.0.1'");
    expect(AGENT_SRC).not.toContain("hostname: '0.0.0.0'");
  });

  test('rejects /ws upgrades without chrome-extension:// Origin', () => {
    // The Origin check must run BEFORE the cookie check — otherwise a
    // missing-origin attempt would surface the 401 cookie message and
    // signal to attackers that they need to forge a cookie.
    const wsHandler = AGENT_SRC.slice(AGENT_SRC.indexOf("if (url.pathname === '/ws')"));
    expect(wsHandler).toContain('chrome-extension://');
    expect(wsHandler).toContain('forbidden origin');
  });

  test('validates the session token against an in-memory token set', () => {
    const wsHandler = AGENT_SRC.slice(AGENT_SRC.indexOf("if (url.pathname === '/ws')"));
    // Two transports: Sec-WebSocket-Protocol (preferred for browsers) and
    // Cookie gstack_pty (fallback). Both verify against validTokens.
    expect(wsHandler).toContain('sec-websocket-protocol');
    expect(wsHandler).toContain('gstack_pty');
    expect(wsHandler).toContain('validTokens.has');
  });

  test('Sec-WebSocket-Protocol auth: strips gstack-pty. prefix and echoes back', () => {
    const wsHandler = AGENT_SRC.slice(AGENT_SRC.indexOf("if (url.pathname === '/ws')"));
    // Browsers send `Sec-WebSocket-Protocol: gstack-pty.<token>`. The agent
    // must strip the prefix before checking validTokens, AND echo the
    // protocol back in the upgrade response — without the echo, the
    // browser closes the connection immediately.
    expect(wsHandler).toContain("'gstack-pty.'");
    expect(wsHandler).toContain('Sec-WebSocket-Protocol');
    expect(wsHandler).toContain('acceptedProtocol');
  });

  test('lazy spawn: claude PTY is spawned in message handler, not on upgrade', () => {
    // The whole point of lazy-spawn (codex finding #8) is that the WS
    // upgrade itself does NOT call spawnClaude. Spawn happens on first
    // message frame.
    const upgradeBlock = AGENT_SRC.slice(
      AGENT_SRC.indexOf("if (url.pathname === '/ws')"),
      AGENT_SRC.indexOf("websocket: {"),
    );
    expect(upgradeBlock).not.toContain('spawnClaude(');
    // Spawn must be invoked from the message handler (lazy on first byte).
    const messageHandler = AGENT_SRC.slice(AGENT_SRC.indexOf('message(ws, raw)'));
    expect(messageHandler).toContain('spawnClaude(');
    expect(messageHandler).toContain('!session.spawned');
  });

  test('process.on uncaughtException + unhandledRejection handlers exist', () => {
    expect(AGENT_SRC).toContain("process.on('uncaughtException'");
    expect(AGENT_SRC).toContain("process.on('unhandledRejection'");
  });

  test('cleanup escalates SIGINT to SIGKILL after 3s on close', () => {
    // disposeSession must be idempotent and use a SIGINT-then-SIGKILL pattern.
    const dispose = AGENT_SRC.slice(AGENT_SRC.indexOf('function disposeSession'));
    expect(dispose).toContain("'SIGINT'");
    expect(dispose).toContain("'SIGKILL'");
    expect(dispose).toContain('3000');
  });

  test('tabState frames write tabs.json + active-tab.json', () => {
    expect(AGENT_SRC).toContain("msg?.type === 'tabState'");
    expect(AGENT_SRC).toContain('function handleTabState');
    const fn = AGENT_SRC.slice(AGENT_SRC.indexOf('function handleTabState'));
    // Atomic write via tmp + rename for both files (so claude never reads
    // a half-written JSON document).
    expect(fn).toContain("'tabs.json'");
    expect(fn).toContain("'active-tab.json'");
    expect(fn).toContain('renameSync');
    // Skip chrome:// and chrome-extension:// pages — they're not useful
    // targets for browse commands.
    expect(fn).toContain("startsWith('chrome://')");
    expect(fn).toContain("startsWith('chrome-extension://')");
  });

  test('claude is spawned with --append-system-prompt tab-awareness hint', () => {
    expect(AGENT_SRC).toContain('function buildTabAwarenessHint');
    const hint = AGENT_SRC.slice(AGENT_SRC.indexOf('function buildTabAwarenessHint'));
    // The hint must mention the live state files and the fanout command —
    // those are the two affordances that distinguish a gstack-PTY claude
    // from a plain `claude` session.
    expect(hint).toContain('tabs.json');
    expect(hint).toContain('active-tab.json');
    expect(hint).toContain('tab-each');
    // And it must be passed via --append-system-prompt at spawn time
    // (NOT written into the PTY as user input — that would pollute the
    // visible transcript).
    const spawn = AGENT_SRC.slice(AGENT_SRC.indexOf('function spawnClaude'));
    expect(spawn).toContain("'--append-system-prompt'");
    expect(spawn).toContain('tabHint');
  });
});

describe('Source-level guard: server.ts /pty-session route', () => {
  test('validates AUTH_TOKEN, grants over loopback, returns token + Set-Cookie', () => {
    const route = SERVER_SRC.slice(SERVER_SRC.indexOf("url.pathname === '/pty-session'"));
    // Must check auth before minting.
    const beforeMint = route.slice(0, route.indexOf('mintPtySessionToken'));
    expect(beforeMint).toContain('validateAuth');
    // Must call the loopback grant before responding (otherwise the
    // agent's validTokens Set never sees the token and /ws would 401).
    expect(route).toContain('grantPtyToken');
    // Must return the token in the JSON body for the
    // Sec-WebSocket-Protocol auth path (cross-port cookies don't survive
    // SameSite=Strict from a chrome-extension origin).
    expect(route).toContain('ptySessionToken');
    // Set-Cookie is kept as a fallback for non-browser callers.
    expect(route).toContain('Set-Cookie');
    expect(route).toContain('buildPtySetCookie');
  });
});
