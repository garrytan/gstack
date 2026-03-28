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
  // Test 1: /health response must not leak the auth token
  test('/health response must not contain token field', () => {
    const healthBlock = sliceBetween(SERVER_SRC, "url.pathname === '/health'", "url.pathname === '/refs'");
    // The old pattern was: token: AUTH_TOKEN
    // The new pattern should have a comment indicating token was removed
    expect(healthBlock).not.toContain('token: AUTH_TOKEN');
    expect(healthBlock).toContain('token removed');
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
});
