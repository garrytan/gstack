/**
 * Unit tests for the view-only SSE session cookie module.
 *
 * Verifies the registry lifecycle (mint/validate/expire), cookie flag
 * invariants (HttpOnly, SameSite=Strict, no Secure), token entropy, and
 * that scope is implicit (the registry has no cross-endpoint footprint
 * that could be used to escalate the cookie to a scoped token).
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import {
  mintSseSessionToken, validateSseSessionToken, extractSseCookie,
  buildSseSetCookie, buildSseClearCookie, SSE_COOKIE_NAME,
  __resetSseSessions,
} from '../src/sse-session-cookie';

const MODULE_SRC = fs.readFileSync(
  path.join(import.meta.dir, '../src/sse-session-cookie.ts'), 'utf-8'
);

beforeEach(() => __resetSseSessions());

describe('SSE session cookie: mint + validate', () => {
  test('mint returns a token and an expiry', () => {
    const { token, expiresAt } = mintSseSessionToken();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(20);
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  test('mint uses 32 random bytes (256-bit entropy)', () => {
    // base64url of 32 bytes is 43 chars (no padding)
    const { token } = mintSseSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('two mint calls produce different tokens', () => {
    const a = mintSseSessionToken();
    const b = mintSseSessionToken();
    expect(a.token).not.toBe(b.token);
  });

  test('validate returns true for a just-minted token', () => {
    const { token } = mintSseSessionToken();
    expect(validateSseSessionToken(token)).toBe(true);
  });

  test('validate returns false for an unknown token', () => {
    expect(validateSseSessionToken('not-a-real-token')).toBe(false);
  });

  test('validate returns false for null/undefined/empty', () => {
    expect(validateSseSessionToken(null)).toBe(false);
    expect(validateSseSessionToken(undefined)).toBe(false);
    expect(validateSseSessionToken('')).toBe(false);
  });
});

describe('SSE session cookie: TTL enforcement', () => {
  test('TTL is 30 minutes', () => {
    // Assert via source — the actual constant is module-private
    expect(MODULE_SRC).toContain('const TTL_MS = 30 * 60 * 1000');
  });

  test('a token with artificially rewound expiry is rejected', () => {
    // Mint a token, then monkey-patch Date.now to simulate 31 minutes elapsed.
    const { token, expiresAt } = mintSseSessionToken();
    const originalNow = Date.now;
    try {
      Date.now = () => expiresAt + 1;
      expect(validateSseSessionToken(token)).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });
});

describe('SSE session cookie: cookie flag invariants', () => {
  test('Set-Cookie is HttpOnly', () => {
    const { token } = mintSseSessionToken();
    expect(buildSseSetCookie(token)).toContain('HttpOnly');
  });

  test('Set-Cookie is SameSite=Strict', () => {
    const { token } = mintSseSessionToken();
    expect(buildSseSetCookie(token)).toContain('SameSite=Strict');
  });

  test('Set-Cookie includes the token value', () => {
    const { token } = mintSseSessionToken();
    expect(buildSseSetCookie(token)).toContain(`${SSE_COOKIE_NAME}=${token}`);
  });

  test('Set-Cookie Max-Age matches TTL', () => {
    const { token } = mintSseSessionToken();
    // 30 minutes = 1800 seconds
    expect(buildSseSetCookie(token)).toContain('Max-Age=1800');
  });

  test('Set-Cookie does NOT set Secure (local HTTP daemon)', () => {
    const { token } = mintSseSessionToken();
    // Adding Secure would block the browser from ever sending the cookie
    // back to a 127.0.0.1 daemon over HTTP. If gstack ever moves to HTTPS,
    // add Secure then.
    expect(buildSseSetCookie(token)).not.toContain('Secure');
  });

  test('Clear-Cookie has Max-Age=0', () => {
    expect(buildSseClearCookie()).toContain('Max-Age=0');
    expect(buildSseClearCookie()).toContain('HttpOnly');
  });
});

describe('SSE session cookie: extract from request', () => {
  function mockReq(cookieHeader: string | null): Request {
    const headers = new Headers();
    if (cookieHeader !== null) headers.set('cookie', cookieHeader);
    return new Request('http://127.0.0.1/activity/stream', { headers });
  }

  test('extracts the token when cookie is present', () => {
    const req = mockReq(`${SSE_COOKIE_NAME}=abc123`);
    expect(extractSseCookie(req)).toBe('abc123');
  });

  test('returns null when no cookie header', () => {
    const req = mockReq(null);
    expect(extractSseCookie(req)).toBeNull();
  });

  test('returns null when cookie header has no gstack_sse', () => {
    const req = mockReq('other=x; unrelated=y');
    expect(extractSseCookie(req)).toBeNull();
  });

  test('extracts gstack_sse from a multi-cookie header', () => {
    const req = mockReq(`other=x; ${SSE_COOKIE_NAME}=real-token; trailing=y`);
    expect(extractSseCookie(req)).toBe('real-token');
  });

  test('handles tokens with base64url padding-like chars', () => {
    // real tokens contain A-Z, a-z, 0-9, _, -
    const req = mockReq(`${SSE_COOKIE_NAME}=AbCd-_xyz`);
    expect(extractSseCookie(req)).toBe('AbCd-_xyz');
  });
});

describe('SSE session cookie: scope isolation (prior learning cookie-picker-auth-isolation)', () => {
  test('the module exposes ONLY view-only functions, no scoped-token hooks', () => {
    // This is a contract guard: if someone later makes SSE session tokens
    // valid as scoped tokens (e.g., by exporting a helper that registers
    // them in the main token registry), a leaked cookie could execute
    // /command. The module must not import from token-registry.
    expect(MODULE_SRC).not.toContain("from './token-registry'");
    expect(MODULE_SRC).not.toContain('createToken');
    expect(MODULE_SRC).not.toContain('initRegistry');
  });
});
