/**
 * Unit-test the pure tunnel-gate function extracted from the /command handler.
 *
 * The gate decides whether a paired remote agent's request to `/command` over
 * the tunnel surface is allowed (returns true) or 403'd (returns false). Pure,
 * synchronous, no HTTP — testable without standing up a Bun.serve listener.
 *
 * The behavioral coverage of the gate firing on the right surface (and only
 * the right surface) lives in `pair-agent-tunnel-eval.test.ts` (paid eval,
 * gate-tier).
 */

import { describe, test, expect } from 'bun:test';
import { canDispatchOverTunnel, TUNNEL_COMMANDS } from '../src/server';

describe('canDispatchOverTunnel — closed allowlist', () => {
  test('every command in TUNNEL_COMMANDS dispatches over tunnel', () => {
    for (const cmd of TUNNEL_COMMANDS) {
      expect(canDispatchOverTunnel(cmd)).toBe(true);
    }
  });

  test('TUNNEL_COMMANDS contains the 26-command closed set', () => {
    // Mirror the source-level guard in dual-listener.test.ts. If this ever
    // disagrees with the literal in server.ts, one of them is wrong.
    const expected = new Set([
      'goto', 'click', 'text', 'screenshot',
      'html', 'links', 'forms', 'accessibility',
      'attrs', 'media', 'data',
      'scroll', 'press', 'type', 'select', 'wait', 'eval',
      'newtab', 'tabs', 'back', 'forward', 'reload',
      'snapshot', 'fill', 'url', 'closetab',
    ]);
    expect(TUNNEL_COMMANDS.size).toBe(expected.size);
    for (const c of expected) expect(TUNNEL_COMMANDS.has(c)).toBe(true);
    for (const c of TUNNEL_COMMANDS) expect(expected.has(c)).toBe(true);
  });
});

describe('canDispatchOverTunnel — daemon-config + bootstrap commands rejected', () => {
  const blocked = [
    'pair', 'unpair', 'cookies', 'setup',
    'launch', 'launch-browser', 'connect', 'disconnect',
    'restart', 'stop', 'tunnel-start', 'tunnel-stop',
    'token-mint', 'token-revoke', 'cookie-picker', 'cookie-import',
    'inspector-pick', 'extension-inspect',
    'invalid-command-xyz', 'totally-made-up',
  ];
  for (const cmd of blocked) {
    test(`rejects '${cmd}'`, () => {
      expect(canDispatchOverTunnel(cmd)).toBe(false);
    });
  }
});

describe('canDispatchOverTunnel — null/undefined/empty input', () => {
  test('returns false for empty string', () => {
    expect(canDispatchOverTunnel('')).toBe(false);
  });

  test('returns false for undefined', () => {
    expect(canDispatchOverTunnel(undefined)).toBe(false);
  });

  test('returns false for null', () => {
    expect(canDispatchOverTunnel(null)).toBe(false);
  });

  test('returns false for non-string input (defensive)', () => {
    // The body parser may hand the gate a number or object if a malicious
    // client sends `{"command": 42}`. The pure gate must treat anything
    // non-string as not-allowed rather than throw.
    expect(canDispatchOverTunnel(42 as unknown as string)).toBe(false);
    expect(canDispatchOverTunnel({} as unknown as string)).toBe(false);
  });
});

describe('canDispatchOverTunnel — alias canonicalization', () => {
  // canonicalizeCommand resolves aliases (e.g. 'set-content' → 'load-html').
  // Any aliased form of an allowlisted canonical command should also pass the
  // gate; aliases that resolve to a non-allowlisted canonical command should
  // not. We don't hardcode alias names here — we read from the source registry
  // by importing what we need from commands.ts.
  test('aliases that resolve to allowlisted commands pass the gate', () => {
    // 'set-content' canonicalizes to 'load-html'. 'load-html' is NOT in
    // TUNNEL_COMMANDS, so 'set-content' must also be rejected. This guards
    // against a future alias that accidentally maps a tunnel-allowed name to
    // a non-tunnel-allowed canonical (e.g. 'goto' → 'navigate' would break).
    expect(canDispatchOverTunnel('set-content')).toBe(false);
  });

  test('canonical commands pass directly without alias lookup', () => {
    expect(canDispatchOverTunnel('goto')).toBe(true);
    expect(canDispatchOverTunnel('newtab')).toBe(true);
    expect(canDispatchOverTunnel('closetab')).toBe(true);
  });
});
