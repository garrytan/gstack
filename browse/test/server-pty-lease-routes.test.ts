import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// Server-side route shape for the v1.44 lease + restart + dispose +
// lease-refresh wiring. Live route exercises require the terminal-agent
// loopback to be live (e2e-tier); these static-grep tripwires pin the
// load-bearing protocol invariants.

const SERVER_TS = path.resolve(new URL(import.meta.url).pathname, '..', '..', 'src', 'server.ts');

describe('server: PTY lease routes (v1.44+ Commit 2)', () => {
  test('1. /pty-session returns the 4-tuple shape (sessionId, attachToken, leaseExpiresAt)', () => {
    const src = fs.readFileSync(SERVER_TS, 'utf-8');
    const block = sliceBetween(src, "url.pathname === '/pty-session' &&", "url.pathname === '/pty-session/reattach'");
    expect(block).toContain('mintLease()');
    expect(block).toContain('grantPtyToken(minted.token, lease.sessionId)');
    expect(block).toContain('sessionId: lease.sessionId');
    expect(block).toContain('attachToken: minted.token');
    expect(block).toContain('leaseExpiresAt: lease.expiresAt');
    // Backward compat: legacy ptySessionToken alias preserved for one release.
    expect(block).toContain('ptySessionToken: minted.token');
  });

  test('2. /pty-session/reattach validates lease + mints fresh attachToken', () => {
    const src = fs.readFileSync(SERVER_TS, 'utf-8');
    const block = sliceBetween(src, "url.pathname === '/pty-session/reattach'", "url.pathname === '/pty-restart'");
    // Validate-first: rejects unknown/expired sessionId with 410 Gone so
    // the client knows to fall back to a fresh /pty-session.
    expect(block).toContain('validateLease(sessionId)');
    expect(block).toContain('status: 410');
    // Mint fresh token bound to SAME sessionId.
    expect(block).toContain('grantPtyToken(minted.token, sessionId!)');
  });

  test('3. /pty-restart is one transaction — dispose + revoke + fresh mint', () => {
    const src = fs.readFileSync(SERVER_TS, 'utf-8');
    const block = sliceBetween(src, "url.pathname === '/pty-restart'", "url.pathname === '/pty-dispose'");
    // Disposes old session (best-effort — missing sessionId is non-fatal).
    expect(block).toContain('restartPtySession(oldSessionId)');
    expect(block).toContain('revokeLease(oldSessionId)');
    // Then mints fresh sessionId + lease + attachToken in the same handler.
    expect(block).toContain('mintLease()');
    expect(block).toContain('grantPtyToken(minted.token, lease.sessionId)');
    // Returns the same 4-tuple shape so the client doesn't need a
    // separate /pty-session round-trip.
    expect(block).toContain('attachToken: minted.token');
    expect(block).toContain('leaseExpiresAt: lease.expiresAt');
  });

  test('4. /pty-dispose accepts body-token (sendBeacon-compatible)', () => {
    const src = fs.readFileSync(SERVER_TS, 'utf-8');
    const block = sliceBetween(src, "url.pathname === '/pty-dispose'", "url.pathname === '/internal/lease-refresh'");
    // sendBeacon can't set custom headers, so the route MUST accept the
    // auth token in the request body. Otherwise pagehide cleanup fails
    // silently every time the user closes the browser.
    expect(block).toContain('body?.authToken');
    expect(block).toContain('authedByBody');
    // Both auth paths must validate against authToken — never just trust
    // a body-supplied token without the equality check.
    expect(block).toContain('authTokenFromBody === authToken');
  });

  test('5. /internal/lease-refresh resets the daemon idle timer (T6)', () => {
    const src = fs.readFileSync(SERVER_TS, 'utf-8');
    const block = sliceBetween(src, "url.pathname === '/internal/lease-refresh'", '─── /pty-inject-scan');
    expect(block).toContain('refreshLease(sessionId)');
    expect(block).toContain('resetIdleTimer()');
    // Refresh failure (unknown / expired) MUST 410, not 200, so the
    // agent knows to close the WS and force a clean re-auth.
    expect(block).toContain('status: 410');
  });

  test('6. grantPtyToken loopback carries sessionId binding', () => {
    const src = fs.readFileSync(SERVER_TS, 'utf-8');
    expect(src).toMatch(/grantPtyToken\(token: string, sessionId\?: string\)/);
    expect(src).toContain('sessionId ? { token, sessionId } : { token }');
  });

  test('7. restartPtySession helper exists and POSTs the agent /internal/restart', () => {
    const src = fs.readFileSync(SERVER_TS, 'utf-8');
    expect(src).toMatch(/async function restartPtySession\(sessionId: string\)/);
    expect(src).toContain('/internal/restart');
    expect(src).toContain('JSON.stringify({ sessionId })');
  });
});

function sliceBetween(source: string, start: string, end: string): string {
  const i = source.indexOf(start);
  if (i === -1) throw new Error(`marker not found: ${start}`);
  const j = source.indexOf(end, i + start.length);
  if (j === -1) throw new Error(`end marker not found: ${end}`);
  return source.slice(i, j);
}
