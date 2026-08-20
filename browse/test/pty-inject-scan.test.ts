/**
 * Tests for the /pty-inject-scan endpoint (#1370).
 *
 * Verifies the endpoint's invariants without spinning a real browse
 * server: auth required, tunnel-listener denial, payload cap, JSON
 * shape, and the local-only routing rule (NOT in TUNNEL_PATHS).
 *
 * Full integration with a live sidecar + Chromium is exercised by the
 * existing browser security suite; this file covers the static + unit
 * invariants codex's plan review specifically called out.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SERVER_SRC = readFileSync(
  join(import.meta.dir, '..', 'src', 'server.ts'),
  'utf-8',
);

describe('/pty-inject-scan — server.ts static invariants', () => {
  test('endpoint is defined as a POST handler', () => {
    expect(SERVER_SRC).toContain(
      "url.pathname === '/pty-inject-scan' && req.method === 'POST'",
    );
  });

  test('endpoint requires auth (validateAuth gate)', () => {
    // Find the endpoint block, verify it calls validateAuth before doing
    // any work.
    const start = SERVER_SRC.indexOf("'/pty-inject-scan'");
    expect(start).toBeGreaterThan(-1);
    const blockEnd = SERVER_SRC.indexOf("\n      // ─", start);
    const block = SERVER_SRC.slice(start, blockEnd > start ? blockEnd : start + 5000);
    expect(block).toContain('validateAuth(req)');
    expect(block).toContain('401');
  });

  test('endpoint caps payload at 64KB', () => {
    const start = SERVER_SRC.indexOf("'/pty-inject-scan'");
    const block = SERVER_SRC.slice(start, start + 5000);
    expect(block).toContain('64 * 1024');
    expect(block).toContain('payload-too-large');
    expect(block).toContain('413');
  });

  test('endpoint is NOT in the tunnel listener allowlist', () => {
    const tunnelBlockStart = SERVER_SRC.indexOf('const TUNNEL_PATHS = new Set<string>([');
    expect(tunnelBlockStart).toBeGreaterThan(-1);
    const tunnelBlockEnd = SERVER_SRC.indexOf(']);', tunnelBlockStart);
    const tunnelAllowlist = SERVER_SRC.slice(tunnelBlockStart, tunnelBlockEnd);
    expect(tunnelAllowlist).not.toContain('/pty-inject-scan');
  });

  test('response goes through sanitizeReplacer (Unicode egress hardening)', () => {
    const start = SERVER_SRC.indexOf("'/pty-inject-scan'");
    const block = SERVER_SRC.slice(start, start + 5000);
    expect(block).toContain('sanitizeReplacer');
  });

  test('endpoint surfaces l4 availability shape for D7 degrade-to-WARN path', () => {
    const start = SERVER_SRC.indexOf("'/pty-inject-scan'");
    const block = SERVER_SRC.slice(start, start + 5000);
    expect(block).toContain('isSidecarAvailable');
    expect(block).toContain('available');
  });

  test('endpoint uses the sidecar client, not direct security-classifier import', () => {
    // Static check that server.ts imports from security-sidecar-client.ts,
    // NOT from security-classifier.ts directly (would brick the compiled
    // binary per CLAUDE.md).
    expect(SERVER_SRC).toContain("from './security-sidecar-client'");
    expect(SERVER_SRC).not.toContain("from './security-classifier'");
  });
});
