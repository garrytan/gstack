import { describe, test, expect } from 'bun:test';
import {
  resolveConfigFromEnv,
  type ServerConfig,
  type ServerHandle,
  type Surface,
} from '../src/server';
import { TUNNEL_COMMANDS, canDispatchOverTunnel } from '../src/server';

/**
 * Tests for the factory-export API surface added so gbrowser (phoenix) can
 * consume gstack as a submodule. The full buildFetchHandler hybrid hoist is
 * deferred to a follow-up PR; this test file proves the type contract,
 * resolveConfigFromEnv behavior, and preserved exports.
 */
describe('server.ts factory API surface', () => {
  describe('resolveConfigFromEnv', () => {
    test('honors AUTH_TOKEN env var', () => {
      const orig = process.env.AUTH_TOKEN;
      process.env.AUTH_TOKEN = 'fixed-test-token-abc123';
      try {
        const cfg = resolveConfigFromEnv();
        expect(cfg.authToken).toBe('fixed-test-token-abc123');
      } finally {
        if (orig === undefined) delete process.env.AUTH_TOKEN;
        else process.env.AUTH_TOKEN = orig;
      }
    });

    test('falls back to randomUUID when AUTH_TOKEN env is empty', () => {
      const orig = process.env.AUTH_TOKEN;
      process.env.AUTH_TOKEN = '';
      try {
        const cfg = resolveConfigFromEnv();
        // randomUUID returns a 36-char hex+dash string.
        expect(cfg.authToken).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      } finally {
        if (orig === undefined) delete process.env.AUTH_TOKEN;
        else process.env.AUTH_TOKEN = orig;
      }
    });

    test('falls back to randomUUID when AUTH_TOKEN is whitespace-only', () => {
      const orig = process.env.AUTH_TOKEN;
      process.env.AUTH_TOKEN = '   \t  \n  ';
      try {
        const cfg = resolveConfigFromEnv();
        expect(cfg.authToken).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(cfg.authToken.length).toBe(36);
      } finally {
        if (orig === undefined) delete process.env.AUTH_TOKEN;
        else process.env.AUTH_TOKEN = orig;
      }
    });

    test('AUTH_TOKEN whitespace is stripped (including unicode whitespace)', () => {
      const orig = process.env.AUTH_TOKEN;
      // 22 chars after stripping leading/trailing whitespace including BOM (U+FEFF)
      // and zero-width space (U+200B), so passes the 16-char minimum.
      process.env.AUTH_TOKEN = '﻿  padded-token-abc123xyz  ​';
      try {
        const cfg = resolveConfigFromEnv();
        expect(cfg.authToken).toBe('padded-token-abc123xyz');
      } finally {
        if (orig === undefined) delete process.env.AUTH_TOKEN;
        else process.env.AUTH_TOKEN = orig;
      }
    });

    test('AUTH_TOKEN shorter than 16 chars after stripping falls back to randomUUID', () => {
      const orig = process.env.AUTH_TOKEN;
      // Only 5 chars of content — too short for the 16-char minimum.
      process.env.AUTH_TOKEN = 'short';
      try {
        const cfg = resolveConfigFromEnv();
        // Must be a UUID, not the rejected short token.
        expect(cfg.authToken).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      } finally {
        if (orig === undefined) delete process.env.AUTH_TOKEN;
        else process.env.AUTH_TOKEN = orig;
      }
    });

    test('AUTH_TOKEN of only zero-width unicode whitespace falls back to randomUUID', () => {
      const orig = process.env.AUTH_TOKEN;
      // U+200B (ZWSP), U+FEFF (BOM), U+00A0 (NBSP) — would pass .trim() but not the unicode-aware strip.
      process.env.AUTH_TOKEN = '​﻿ ​';
      try {
        const cfg = resolveConfigFromEnv();
        expect(cfg.authToken).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      } finally {
        if (orig === undefined) delete process.env.AUTH_TOKEN;
        else process.env.AUTH_TOKEN = orig;
      }
    });

    test('reads BROWSE_PORT from env, defaults to 0', () => {
      const orig = process.env.BROWSE_PORT;
      process.env.BROWSE_PORT = '34567';
      try {
        expect(resolveConfigFromEnv().browsePort).toBe(34567);
      } finally {
        if (orig === undefined) delete process.env.BROWSE_PORT;
        else process.env.BROWSE_PORT = orig;
      }
      const origUnset = process.env.BROWSE_PORT;
      delete process.env.BROWSE_PORT;
      try {
        expect(resolveConfigFromEnv().browsePort).toBe(0);
      } finally {
        if (origUnset !== undefined) process.env.BROWSE_PORT = origUnset;
      }
    });

    test('reads BROWSE_IDLE_TIMEOUT from env, defaults to 30 min (1800000ms)', () => {
      const orig = process.env.BROWSE_IDLE_TIMEOUT;
      delete process.env.BROWSE_IDLE_TIMEOUT;
      try {
        expect(resolveConfigFromEnv().idleTimeoutMs).toBe(1800000);
      } finally {
        if (orig !== undefined) process.env.BROWSE_IDLE_TIMEOUT = orig;
      }
    });

    test('returns a populated config object with the expected shape', () => {
      const cfg = resolveConfigFromEnv();
      expect(cfg).toMatchObject({
        authToken: expect.any(String),
        browsePort: expect.any(Number),
        idleTimeoutMs: expect.any(Number),
        config: expect.objectContaining({
          stateDir: expect.any(String),
          stateFile: expect.any(String),
          auditLog: expect.any(String),
        }),
      });
    });
  });

  describe('preserved exports', () => {
    test('TUNNEL_COMMANDS still exported and populated', () => {
      expect(TUNNEL_COMMANDS).toBeInstanceOf(Set);
      expect(TUNNEL_COMMANDS.size).toBeGreaterThan(0);
      expect(TUNNEL_COMMANDS.has('goto')).toBe(true);
      expect(TUNNEL_COMMANDS.has('click')).toBe(true);
    });

    test('canDispatchOverTunnel still exported and functional', () => {
      expect(canDispatchOverTunnel('goto')).toBe(true);
      expect(canDispatchOverTunnel('shutdown')).toBe(false);
      expect(canDispatchOverTunnel(null)).toBe(false);
      expect(canDispatchOverTunnel(undefined)).toBe(false);
      expect(canDispatchOverTunnel('')).toBe(false);
    });
  });

  describe('type surface compiles', () => {
    // Compile-time shape checks. If these break, TypeScript fails to build
    // the test file — which is exactly the API-compat guarantee we want for
    // embedders depending on these types.
    test('Surface type accepts the two known values', () => {
      const local: Surface = 'local';
      const tunnel: Surface = 'tunnel';
      expect(local).toBe('local');
      expect(tunnel).toBe('tunnel');
    });

    test('ServerConfig type accepts the documented minimum-required fields', () => {
      // This compiles only if ServerConfig accepts these field names + types.
      const minimalConfigShape = {
        authToken: 'tok',
        browsePort: 0,
        idleTimeoutMs: 1800000,
        config: { stateDir: '', stateFile: '', consoleLog: '', networkLog: '', dialogLog: '', auditLog: '', projectDir: '' },
        browserManager: {} as any,
        startTime: Date.now(),
      } satisfies Partial<ServerConfig>;
      expect(minimalConfigShape.authToken).toBe('tok');
    });

    test('ServerHandle type exposes the documented surface', () => {
      // Compiles only if these property names exist on ServerHandle.
      type AssertHandleFields = ServerHandle extends {
        fetchLocal: any;
        fetchTunnel: any;
        shutdown: any;
        stopListeners: any;
      } ? true : false;
      const assertion: AssertHandleFields = true;
      expect(assertion).toBe(true);
    });
  });
});
