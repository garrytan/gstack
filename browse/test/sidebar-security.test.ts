/**
 * Current terminal-sidepanel security boundary.
 *
 * Detailed PTY lifecycle behavior has dedicated tests. These source contracts
 * instead pin the cross-process handoff: the extension trades the daemon root
 * token for a session-scoped attach token, and only the loopback terminal agent
 * accepts that token from a Chrome extension origin.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const TERMINAL_AGENT_PATH = path.join(ROOT, 'browse', 'src', 'terminal-agent.ts');
const SERVER_PATH = path.join(ROOT, 'browse', 'src', 'server.ts');
const LEGACY_AGENT_PATH = path.join(ROOT, 'browse', 'src', 'sidebar-agent.ts');
const TERMINAL_CLIENT_PATH = path.join(ROOT, 'extension', 'sidepanel-terminal.js');
const SIDEPANEL_PATH = path.join(ROOT, 'extension', 'sidepanel.js');
const BACKGROUND_PATH = path.join(ROOT, 'extension', 'background.js');

const TERMINAL_AGENT_SRC = fs.readFileSync(TERMINAL_AGENT_PATH, 'utf8');
const SERVER_SRC = fs.readFileSync(SERVER_PATH, 'utf8');
const TERMINAL_CLIENT_SRC = fs.readFileSync(TERMINAL_CLIENT_PATH, 'utf8');
const SIDEPANEL_SRC = fs.readFileSync(SIDEPANEL_PATH, 'utf8');
const BACKGROUND_SRC = fs.readFileSync(BACKGROUND_PATH, 'utf8');

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`Missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end === -1) throw new Error(`Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

describe('terminal sidepanel security boundary', () => {
  test('PTY transport stays on loopback and sends attach auth outside the URL', () => {
    expect(TERMINAL_AGENT_SRC).toContain("hostname: '127.0.0.1'");
    expect(TERMINAL_AGENT_SRC).not.toContain("hostname: '0.0.0.0'");

    const socketCalls = [...TERMINAL_CLIENT_SRC.matchAll(/new WebSocket\(([\s\S]*?)\);/g)]
      .map((match) => match[1]);
    expect(socketCalls.length).toBeGreaterThan(0);
    for (const call of socketCalls) {
      expect(call).toContain('ws://127.0.0.1:${terminalPort}/ws');
      expect(call).toContain('gstack-pty.${');
      expect(call).not.toContain('/ws?');
      expect(call).not.toContain('authToken');
    }
  });

  test('WebSocket upgrade requires extension Origin plus an in-memory session token', () => {
    expect(TERMINAL_AGENT_SRC).toContain('const validTokens = new Map<string, string | null>()');
    const wsRoute = sliceBetween(
      TERMINAL_AGENT_SRC,
      "if (url.pathname === '/ws')",
      "return new Response('not found'",
    );

    const originGate = wsRoute.indexOf("origin.startsWith('chrome-extension://')");
    const tokenGate = wsRoute.indexOf('validTokens.has(candidate)');
    const upgrade = wsRoute.indexOf('server.upgrade(req');
    expect(originGate).toBeGreaterThan(-1);
    expect(tokenGate).toBeGreaterThan(originGate);
    expect(upgrade).toBeGreaterThan(tokenGate);
    expect(wsRoute).toContain('forbidden origin');
    expect(wsRoute).toContain("req.headers.get('sec-websocket-protocol')");
    expect(wsRoute).not.toContain("searchParams.get('token')");
  });

  test('/pty-session authenticates the daemon token then mints a session-scoped attach', () => {
    const route = sliceBetween(
      SERVER_SRC,
      "if (url.pathname === '/pty-session' && req.method === 'POST')",
      "if (url.pathname === '/pty-session/reattach'",
    );
    expect(route.indexOf('validateAuth(req)')).toBeLessThan(route.indexOf('mintLease()'));
    expect(route).toContain('grantPtyToken(minted.token, lease.sessionId)');
    expect(route).toContain('sessionId: lease.sessionId');
    expect(route).toContain('attachToken: minted.token');

    const clientMint = sliceBetween(
      TERMINAL_CLIENT_SRC,
      'async function mintSession()',
      'function startReattachLoop',
    );
    expect(clientMint).toContain('/pty-session`');
    expect(clientMint).toContain("'Authorization': `Bearer ${token}`");
    expect(clientMint).not.toContain('?token=');
  });

  test('/pty-dispose authenticates and tears down only the named session', () => {
    const route = sliceBetween(
      SERVER_SRC,
      "if (url.pathname === '/pty-dispose'",
      "if (url.pathname === '/internal/lease-refresh'",
    );
    expect(route).toContain('authTokenFromBody === authToken');
    expect(route).toContain("body?.sessionId === 'string'");
    expect(route).toContain('restartPtySession(sessionId)');
    expect(route).toContain('revokeLease(sessionId)');

    const pagehide = SIDEPANEL_SRC.slice(SIDEPANEL_SRC.indexOf("addEventListener('pagehide'"));
    expect(TERMINAL_CLIENT_SRC).toContain('window.gstackPtySession = currentSessionId');
    expect(pagehide).toContain('JSON.stringify({ sessionId, authToken })');
    expect(pagehide).toContain('/pty-dispose`');
    expect(pagehide).not.toContain('/pty-dispose?');
  });

  test('background token bootstrap rejects foreign and content-script requesters', () => {
    const listener = sliceBetween(
      BACKGROUND_SRC,
      'chrome.runtime.onMessage.addListener((msg, sender, sendResponse)',
      "if (msg.type === 'fetchRefs')",
    );
    expect(listener).toContain('sender.id !== chrome.runtime.id');

    const getToken = listener.slice(listener.indexOf("if (msg.type === 'getToken')"));
    expect(getToken).toContain('if (sender.tab)');
    expect(getToken).toContain('sendResponse({ token: null })');
    expect(getToken).toContain('sendResponse({ token: authToken })');
  });

  test('interactive prompt path replaces the retired sidebar agent and routes', () => {
    expect(fs.existsSync(LEGACY_AGENT_PATH)).toBe(false);
    expect(SERVER_SRC).not.toMatch(/url\.pathname\s*===\s*['"]\/sidebar-/);
    expect(SERVER_SRC).not.toMatch(/url\.pathname\.startsWith\(\s*['"]\/sidebar-/);
    expect(SERVER_SRC).toContain('chatEnabled: false');

    const spawn = sliceBetween(TERMINAL_AGENT_SRC, 'function spawnClaude', '/** Cleanup a PTY session');
    expect(spawn).toContain("[claudePath, '--append-system-prompt', tabHint]");
    expect(spawn).not.toMatch(/claudePath,\s*['"](?:-p|--print)['"]/);
  });
});
