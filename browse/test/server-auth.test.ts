/**
 * Server auth security tests — verify security remediation in server.ts
 *
 * Tests are source-level: they read server.ts and verify that auth checks,
 * CORS restrictions, and token removal are correctly in place.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const SERVER_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/server.ts'), 'utf-8');

// Helper: extract a block of source between two markers
function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) throw new Error(`Marker not found: ${startMarker}`);
  const endIdx = source.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx === -1) throw new Error(`End marker not found: ${endMarker}`);
  return source.slice(startIdx, endIdx);
}

describe('Server auth security', () => {
  // Test 1: /health must NOT serve the auth token (CSO finding #1 — spoofable Origin)
  // Extension reads token from ~/.gstack/.auth.json instead.
  test('/health does NOT serve auth token', () => {
    const healthBlock = sliceBetween(SERVER_SRC, "url.pathname === '/health'", "url.pathname === '/connect'");
    // Token must not appear in the health response construction
    expect(healthBlock).not.toContain('token: AUTH_TOKEN');
    expect(healthBlock).not.toContain('token: AUTH');
    // Should not expose browsing activity when tunneled
    expect(healthBlock).toContain('not through tunnel');
  });

  // Test 1b: /health strips sensitive fields when tunneled
  test('/health strips currentUrl, agent, session when tunnel is active', () => {
    const healthBlock = sliceBetween(SERVER_SRC, "url.pathname === '/health'", "url.pathname === '/connect'");
    // currentUrl and agent.currentMessage must be gated on !tunnelActive
    expect(healthBlock).toContain('!tunnelActive');
    expect(healthBlock).toContain('currentUrl');
    expect(healthBlock).toContain('currentMessage');
    // Tunnel URL must NOT be exposed in health response
    expect(healthBlock).not.toContain('url: tunnelUrl');
  });

  // Test 1c: newtab must check domain restrictions (CSO finding #5)
  test('newtab enforces domain restrictions', () => {
    const newtabBlock = sliceBetween(SERVER_SRC, "newtab with ownership for scoped tokens", "Block mutation commands while watching");
    expect(newtabBlock).toContain('checkDomain');
    expect(newtabBlock).toContain('Domain not allowed');
  });

  // Test 2: /refs endpoint requires auth via validateAuth
  test('/refs endpoint requires authentication', () => {
    const refsBlock = sliceBetween(SERVER_SRC, "url.pathname === '/refs'", "url.pathname === '/activity/stream'");
    expect(refsBlock).toContain('validateAuth');
  });

  // Test 3: /refs has no wildcard CORS header
  test('/refs has no wildcard CORS header', () => {
    const refsBlock = sliceBetween(SERVER_SRC, "url.pathname === '/refs'", "url.pathname === '/activity/stream'");
    expect(refsBlock).not.toContain("'*'");
  });

  // Test 4: /activity/history requires auth via validateAuth
  test('/activity/history requires authentication', () => {
    const historyBlock = sliceBetween(SERVER_SRC, "url.pathname === '/activity/history'", 'Sidebar endpoints');
    expect(historyBlock).toContain('validateAuth');
  });

  // Test 5: /activity/history has no wildcard CORS header
  test('/activity/history has no wildcard CORS header', () => {
    const historyBlock = sliceBetween(SERVER_SRC, "url.pathname === '/activity/history'", 'Sidebar endpoints');
    expect(historyBlock).not.toContain("'*'");
  });

  // Test 6: /activity/stream requires auth (inline Bearer or ?token= check)
  test('/activity/stream requires authentication with inline token check', () => {
    const streamBlock = sliceBetween(SERVER_SRC, "url.pathname === '/activity/stream'", "url.pathname === '/activity/history'");
    expect(streamBlock).toContain('validateAuth');
    expect(streamBlock).toContain('AUTH_TOKEN');
    // Should not have wildcard CORS for the SSE stream
    expect(streamBlock).not.toContain("Access-Control-Allow-Origin': '*'");
  });

  // Test 7: /command accepts scoped tokens (not just root)
  // This was the Wintermute bug — /command was BELOW the blanket validateAuth gate
  // which only accepts root tokens. Scoped tokens got 401'd before reaching getTokenInfo.
  test('/command endpoint sits ABOVE the blanket root-only auth gate', () => {
    const commandIdx = SERVER_SRC.indexOf("url.pathname === '/command'");
    const blanketGateIdx = SERVER_SRC.indexOf("Auth-required endpoints (root token only)");
    // /command must appear BEFORE the blanket gate in source order
    expect(commandIdx).toBeGreaterThan(0);
    expect(blanketGateIdx).toBeGreaterThan(0);
    expect(commandIdx).toBeLessThan(blanketGateIdx);
  });

  // Test 7b: /command uses getTokenInfo (accepts scoped tokens), not validateAuth (root-only)
  test('/command uses getTokenInfo for auth, not validateAuth', () => {
    const commandBlock = sliceBetween(SERVER_SRC, "url.pathname === '/command'", "Auth-required endpoints");
    expect(commandBlock).toContain('getTokenInfo');
    expect(commandBlock).not.toContain('validateAuth');
  });

  // Test 8: /tunnel/start requires root token
  test('/tunnel/start requires root token', () => {
    const tunnelBlock = sliceBetween(SERVER_SRC, "/tunnel/start", "Refs endpoint");
    expect(tunnelBlock).toContain('isRootRequest');
    expect(tunnelBlock).toContain('Root token required');
  });

  // Test 8b: /tunnel/start checks ngrok native config paths
  test('/tunnel/start reads ngrok native config files', () => {
    const tunnelBlock = sliceBetween(SERVER_SRC, "/tunnel/start", "Refs endpoint");
    expect(tunnelBlock).toContain("'ngrok.yml'");
    expect(tunnelBlock).toContain('authtoken');
  });

  // Test 8c: /tunnel/start returns already_active if tunnel is running
  test('/tunnel/start returns already_active when tunnel exists', () => {
    const tunnelBlock = sliceBetween(SERVER_SRC, "/tunnel/start", "Refs endpoint");
    expect(tunnelBlock).toContain('already_active');
    expect(tunnelBlock).toContain('tunnelActive');
  });

  // Test 9: /pair requires root token
  test('/pair requires root token', () => {
    const pairBlock = sliceBetween(SERVER_SRC, "url.pathname === '/pair'", "/tunnel/start");
    expect(pairBlock).toContain('isRootRequest');
    expect(pairBlock).toContain('Root token required');
  });

  // Test 9b: /pair calls createSetupKey (not createToken)
  test('/pair creates setup keys, not session tokens', () => {
    const pairBlock = sliceBetween(SERVER_SRC, "url.pathname === '/pair'", "/tunnel/start");
    expect(pairBlock).toContain('createSetupKey');
    expect(pairBlock).not.toContain('createToken');
  });

  // Test 10: tab ownership check happens before command dispatch
  test('tab ownership check runs before command dispatch for scoped tokens', () => {
    const handleBlock = sliceBetween(SERVER_SRC, "async function handleCommand", "Block mutation commands while watching");
    expect(handleBlock).toContain('checkTabAccess');
    expect(handleBlock).toContain('Tab not owned by your agent');
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
  test('server passes tokenInfo to handleMetaCommand', () => {
    expect(SERVER_SRC).toContain('handleMetaCommand(command, args, browserManager, shutdown, tokenInfo)');
  });

  // Test 10e: activity attribution includes clientId
  test('activity events include clientId from token', () => {
    const commandStartBlock = sliceBetween(SERVER_SRC, "Activity: emit command_start", "try {");
    expect(commandStartBlock).toContain('clientId: tokenInfo?.clientId');
  });
});
