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
const CLI_SRC = fs.readFileSync(path.join(import.meta.dir, '../src/cli.ts'), 'utf-8');

// Helper: extract a block of source between two markers
function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) throw new Error(`Marker not found: ${startMarker}`);
  const endIdx = source.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx === -1) throw new Error(`End marker not found: ${endMarker}`);
  return source.slice(startIdx, endIdx);
}

describe('Server auth security', () => {
  // Test 1: /health serves token conditionally (headed mode or chrome extension only)
  test('/health serves token only in headed mode or to chrome extensions', () => {
    const healthBlock = sliceBetween(SERVER_SRC, "url.pathname === '/health'", "url.pathname === '/connect'");
    // Token must be conditional, not unconditional
    expect(healthBlock).toContain('AUTH_TOKEN');
    expect(healthBlock).toContain('headed');
    expect(healthBlock).toContain('chrome-extension://');
  });

  // Test 1b: /health does not expose sensitive browsing state
  test('/health does not expose currentUrl or currentMessage', () => {
    const healthBlock = sliceBetween(SERVER_SRC, "url.pathname === '/health'", "url.pathname === '/connect'");
    expect(healthBlock).not.toContain('currentUrl');
    expect(healthBlock).not.toContain('currentMessage');
  });

  // Test 1c: newtab must check domain restrictions (CSO finding #5)
  // Domain check for newtab is now unified with goto in the scope check section:
  // (command === 'goto' || command === 'newtab') && args[0] → checkDomain
  test('newtab enforces domain restrictions', () => {
    const scopeBlock = sliceBetween(SERVER_SRC, "Scope check (for scoped tokens)", "Pin to a specific tab");
    expect(scopeBlock).toContain("command === 'newtab'");
    expect(scopeBlock).toContain('checkDomain');
    expect(scopeBlock).toContain('Domain not allowed');
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
    expect(SERVER_SRC).toContain('handleMetaCommand(command, args, browserManager, shutdown, tokenInfo,');
  });

  // Test 10e: activity attribution includes clientId
  test('activity events include clientId from token', () => {
    const commandStartBlock = sliceBetween(SERVER_SRC, "Activity: emit command_start", "try {");
    expect(commandStartBlock).toContain('clientId: tokenInfo?.clientId');
  });

  // ─── Tunnel liveness verification ─────────────────────────────

  // Test 11a: /pair endpoint probes tunnel before returning tunnel_url
  test('/pair verifies tunnel is alive before returning tunnel_url', () => {
    const pairBlock = sliceBetween(SERVER_SRC, "url.pathname === '/pair'", "url.pathname === '/tunnel/start'");
    // Must probe the tunnel URL
    expect(pairBlock).toContain('verifiedTunnelUrl');
    expect(pairBlock).toContain('Tunnel probe failed');
    expect(pairBlock).toContain('marking tunnel as dead');
    // Must reset tunnel state on failure
    expect(pairBlock).toContain('tunnelActive = false');
    expect(pairBlock).toContain('tunnelUrl = null');
  });

  // Test 11b: /pair returns null tunnel_url when tunnel is dead
  test('/pair returns verified tunnel URL, not raw tunnelActive flag', () => {
    const pairBlock = sliceBetween(SERVER_SRC, "url.pathname === '/pair'", "url.pathname === '/tunnel/start'");
    // Should use verifiedTunnelUrl (probe result), not raw tunnelUrl
    expect(pairBlock).toContain('tunnel_url: verifiedTunnelUrl');
    // Must NOT use raw tunnelActive check for the response
    expect(pairBlock).not.toContain('tunnel_url: tunnelActive ? tunnelUrl');
  });

  // Test 11c: /tunnel/start probes cached tunnel before returning already_active
  test('/tunnel/start verifies cached tunnel is alive before returning already_active', () => {
    const tunnelBlock = sliceBetween(SERVER_SRC, "url.pathname === '/tunnel/start'", "url.pathname === '/refs'");
    // Must probe before returning cached URL
    expect(tunnelBlock).toContain('Cached tunnel is dead');
    expect(tunnelBlock).toContain('tunnelActive = false');
    // Must fall through to restart when dead
    expect(tunnelBlock).toContain('restarting');
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

  // Test 12a: /batch endpoint sits ABOVE the blanket root-only auth gate (same as /command)
  test('/batch endpoint sits ABOVE the blanket root-only auth gate', () => {
    const batchIdx = SERVER_SRC.indexOf("url.pathname === '/batch'");
    const blanketGateIdx = SERVER_SRC.indexOf("Auth-required endpoints (root token only)");
    expect(batchIdx).toBeGreaterThan(0);
    expect(blanketGateIdx).toBeGreaterThan(0);
    expect(batchIdx).toBeLessThan(blanketGateIdx);
  });

  // Test 12b: /batch uses getTokenInfo (accepts scoped tokens), not validateAuth (root-only)
  test('/batch uses getTokenInfo for auth, not validateAuth', () => {
    const batchBlock = sliceBetween(SERVER_SRC, "url.pathname === '/batch'", "url.pathname === '/command'");
    expect(batchBlock).toContain('getTokenInfo');
    expect(batchBlock).not.toContain('validateAuth');
  });

  // Test 12c: /batch enforces max command limit
  test('/batch enforces max 50 commands per batch', () => {
    const batchBlock = sliceBetween(SERVER_SRC, "url.pathname === '/batch'", "url.pathname === '/command'");
    expect(batchBlock).toContain('commands.length > 50');
    expect(batchBlock).toContain('Max 50 commands per batch');
  });

  // Test 12d: /batch rejects nested batches
  test('/batch rejects nested batch commands', () => {
    const batchBlock = sliceBetween(SERVER_SRC, "url.pathname === '/batch'", "url.pathname === '/command'");
    expect(batchBlock).toContain("cmd.command === 'batch'");
    expect(batchBlock).toContain('Nested batch commands are not allowed');
  });

  // Test 12e: /batch skips per-command rate limiting (batch counts as 1 request)
  test('/batch skips per-command rate limiting', () => {
    const batchBlock = sliceBetween(SERVER_SRC, "url.pathname === '/batch'", "url.pathname === '/command'");
    expect(batchBlock).toContain('skipRateCheck: true');
  });

  // Test 12f: /batch skips per-command activity events (emits batch-level events)
  test('/batch emits batch-level activity, not per-command', () => {
    const batchBlock = sliceBetween(SERVER_SRC, "url.pathname === '/batch'", "url.pathname === '/command'");
    expect(batchBlock).toContain('skipActivity: true');
    // Should emit batch-level start and end events
    expect(batchBlock).toContain("command: 'batch'");
  });

  // Test 12g: /batch validates command field in each command
  test('/batch validates each command has a command field', () => {
    const batchBlock = sliceBetween(SERVER_SRC, "url.pathname === '/batch'", "url.pathname === '/command'");
    expect(batchBlock).toContain("typeof cmd.command !== 'string'");
    expect(batchBlock).toContain('Missing "command" field');
  });

  // Test 12h: /batch passes tabId through to handleCommandInternal
  test('/batch passes tabId to handleCommandInternal for multi-tab support', () => {
    const batchBlock = sliceBetween(SERVER_SRC, "url.pathname === '/batch'", "url.pathname === '/command'");
    expect(batchBlock).toContain('tabId: cmd.tabId');
    expect(batchBlock).toContain('handleCommandInternal');
  });

  // ─── Pair-agent regression tests ──────────────────────────

  // Regression: connect command crashed with "domains is not defined" because
  // a stray `domains,` variable was in the status fetch body (cli.ts:852).
  test('connect command status fetch body has no undefined variable references', () => {
    const connectBlock = sliceBetween(CLI_SRC, 'Launching headed Chromium', 'Sidebar agent started');
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
    // The connect command must propagate BROWSE_PARENT_PID=0 to serverEnv
    const connectBlock = sliceBetween(CLI_SRC, 'Launching headed Chromium', 'Sidebar agent started');
    expect(connectBlock).toContain("BROWSE_PARENT_PID");
    expect(connectBlock).toContain("serverEnv.BROWSE_PARENT_PID");
  });

  // Regression: newtab returned 403 for scoped tokens because the tab ownership
  // check ran before the newtab handler, checking the active tab (owned by root).
  test('newtab is excluded from tab ownership check', () => {
    const ownershipBlock = sliceBetween(SERVER_SRC, 'Tab ownership check (for scoped tokens)', 'newtab with ownership for scoped tokens');
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

// ─── Tunnel security policy tests ──────────────────────────────────────────
//
// These tests verify the fix for: when BROWSE_TUNNEL=1 is set, the server is
// reachable from the public internet despite binding to 127.0.0.1.  Any endpoint
// that relied on "localhost = trusted" was exposed as a remote attack surface.
//
// Root cause: three bootstrapping paths (Origin forgery on /health, /cookie-picker
// HTML embedding the token, headed-mode /health check) were designed for the local
// trust context and silently became internet-exposed under the tunnel.
//
// Fix architecture: single enforceTunnelPolicy() function runs before every route
// handler and rejects unauthenticated requests in tunnel mode.  A minimal allowlist
// names the only endpoints that legitimately need pre-auth access (/connect, which
// is the remote pairing ceremony).  Per-endpoint hardening (cookie-picker 403,
// inspector auth gate) provides defense-in-depth.
//
// Tests 13a–13h verify the fix is in place and document which attack scenario each
// test guards against.

describe('Tunnel security policy', () => {
  // Test 13a: allowlist contains exactly /connect — not /token, not /health,
  // not /cookie-picker.  /token has its own isRootRequest() internal guard and
  // must NOT appear here (whitelist entries must justify internet exposure).
  test('TUNNEL_UNAUTHENTICATED_ALLOWLIST contains /connect and nothing else sensitive', () => {
    const allowlistBlock = sliceBetween(
      SERVER_SRC,
      'TUNNEL_UNAUTHENTICATED_ALLOWLIST = new Set([',
      ']);',
    );
    expect(allowlistBlock).toContain("'/connect'");
    // /token is root-only via isRootRequest() — it must NOT be in the allowlist
    expect(allowlistBlock).not.toContain("'/token'");
    // Health and cookie-picker must never be open to unauthenticated tunnel callers
    expect(allowlistBlock).not.toContain("'/health'");
    expect(allowlistBlock).not.toContain("'/cookie-picker'");
  });

  // Test 13b: enforceTunnelPolicy is invoked before any route handler.
  // If it moves below a route, that route becomes unguarded in tunnel mode.
  test('enforceTunnelPolicy fires before the first route handler', () => {
    const gateIdx = SERVER_SRC.indexOf('const tunnelBlock = enforceTunnelPolicy(req, url)');
    const firstRouteIdx = SERVER_SRC.indexOf("url.pathname === '/health'");
    expect(gateIdx).toBeGreaterThan(0);
    expect(firstRouteIdx).toBeGreaterThan(0);
    expect(gateIdx).toBeLessThan(firstRouteIdx);
  });

  // Test 13c: enforceTunnelPolicy returns 401 (not 403 or 200) with a
  // machine-readable JSON body so agents can detect tunnel auth failure.
  test('enforceTunnelPolicy responds 401 with pairing hint', () => {
    const policyFn = sliceBetween(SERVER_SRC, 'function enforceTunnelPolicy', 'function wrapError');
    expect(policyFn).toContain('status: 401');
    expect(policyFn).toContain('Tunnel mode: authentication required');
    expect(policyFn).toContain('gstack browse --pair');
  });

  // Test 13d: Attack scenario — F-1/F-3: Origin forgery or headed-mode flag used
  // to extract AUTH_TOKEN from /health over the public tunnel.
  // Fix: token delivery is gated behind !tunnelActive.
  test('/health delivers AUTH_TOKEN only when the tunnel is NOT active', () => {
    const healthBlock = sliceBetween(
      SERVER_SRC,
      "url.pathname === '/health'",
      "url.pathname === '/connect'",
    );
    // The !tunnelActive guard must appear in the health block
    expect(healthBlock).toContain('!tunnelActive');
    // token: AUTH_TOKEN must appear AFTER the !tunnelActive condition
    const tunnelGuardIdx = healthBlock.indexOf('!tunnelActive');
    const tokenIdx = healthBlock.indexOf('token: AUTH_TOKEN');
    expect(tunnelGuardIdx).toBeGreaterThan(-1);
    expect(tokenIdx).toBeGreaterThan(-1);
    expect(tokenIdx).toBeGreaterThan(tunnelGuardIdx);
  });

  // Test 13e: Attack scenario — F-1 continued: when tunnel is active and a Chrome
  // extension Origin is forged, the server must return a hint instead of the token.
  test('/health returns extensionUnavailable hint in tunnel mode', () => {
    const healthBlock = sliceBetween(
      SERVER_SRC,
      "url.pathname === '/health'",
      "url.pathname === '/connect'",
    );
    expect(healthBlock).toContain('extensionUnavailable: true');
    // The hint must direct remote callers to the correct pairing flow
    expect(healthBlock).toContain('/connect');
  });

  // Test 13f: Attack scenario — F-2: GET /cookie-picker had no auth check and
  // embedded AUTH_TOKEN in the served HTML, readable by any caller with the
  // ngrok URL.  In tunnel mode the endpoint must be fully blocked.
  test('/cookie-picker returns 403 in tunnel mode', () => {
    const cookieBlock = sliceBetween(
      SERVER_SRC,
      "url.pathname.startsWith('/cookie-picker')",
      'handleCookiePickerRoute',
    );
    expect(cookieBlock).toContain('tunnelActive');
    expect(cookieBlock).toContain('status: 403');
    expect(cookieBlock).toContain('Cookie picker is not available in tunnel mode');
  });

  // Test 13g: /inspector endpoints had no auth gate (localhost-only assumption).
  // The auth block must appear before /inspector/pick in source order.
  test('/inspector auth gate appears before /inspector/pick handler', () => {
    const authGateIdx = SERVER_SRC.indexOf("Inspector endpoints — auth required on all sub-paths");
    const pickHandlerIdx = SERVER_SRC.indexOf("POST /inspector/pick");
    expect(authGateIdx).toBeGreaterThan(0);
    expect(pickHandlerIdx).toBeGreaterThan(0);
    expect(authGateIdx).toBeLessThan(pickHandlerIdx);
  });

  // Test 13h: /inspector auth gate checks BOTH validateAuth (root token) and
  // getTokenInfo (scoped token) so inspector is accessible to legitimate agents.
  test('/inspector auth gate accepts both root and scoped tokens', () => {
    const inspectorBlock = sliceBetween(
      SERVER_SRC,
      "Inspector endpoints — auth required on all sub-paths",
      "POST /inspector/pick",
    );
    expect(inspectorBlock).toContain('validateAuth(req)');
    expect(inspectorBlock).toContain('getTokenInfo(req)');
    expect(inspectorBlock).toContain('Unauthorized');
  });
});
