/**
 * Unit tests for browse/src/session-cookie-store.ts — the factory behind
 * pty-session-cookie.ts and sse-session-cookie.ts.
 *
 * sse-session-cookie.test.ts pins the SSE instantiation (flags, entropy,
 * cross-endpoint isolation). This file tests the FACTORY's own contract with
 * custom options the instantiations never vary: the cookieName knob in
 * extract/buildSetCookie, the ttlMs knob in expiry and Max-Age, the
 * maxSessions hard cap, and isolation between independently created stores.
 *
 * The store is purely in-memory (a Map keyed by token) — there is no on-disk
 * state, so no temp dirs or permission cases apply.
 */
import { describe, test, expect } from 'bun:test';
import { createSessionCookieStore } from '../src/session-cookie-store';

const NAME = 'gstack_test_session';

function makeStore(opts: Partial<Parameters<typeof createSessionCookieStore>[0]> = {}) {
  return createSessionCookieStore({ cookieName: NAME, ttlMs: 60_000, ...opts });
}

function requestWithCookies(cookieHeader: string | null): Request {
  return new Request('http://127.0.0.1/sse', {
    headers: cookieHeader === null ? {} : { cookie: cookieHeader },
  });
}

describe('session-cookie-store: mint + validate round-trip', () => {
  test('a minted token validates until revoked', () => {
    const store = makeStore();
    const { token, expiresAt } = store.mint();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url, no padding
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(store.validate(token)).toBe(true);
    store.revoke(token);
    expect(store.validate(token)).toBe(false);
  });

  test('unknown, null, undefined, and empty tokens never validate', () => {
    const store = makeStore();
    store.mint();
    expect(store.validate('forged-token')).toBe(false);
    expect(store.validate(null)).toBe(false);
    expect(store.validate(undefined)).toBe(false);
    expect(store.validate('')).toBe(false);
  });

  test('revoke of an unknown/null token is a no-op, not an error', () => {
    const store = makeStore();
    const { token } = store.mint();
    expect(() => store.revoke('never-minted')).not.toThrow();
    expect(() => store.revoke(null)).not.toThrow();
    expect(() => store.revoke(undefined)).not.toThrow();
    expect(store.validate(token)).toBe(true); // untouched
  });

  test('a token expires after ttlMs and validate deletes it', async () => {
    const store = makeStore({ ttlMs: 5 });
    const { token, expiresAt } = store.mint();
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(5);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(store.validate(token)).toBe(false);
    expect(store.validate(token)).toBe(false); // still gone after deletion
  });

  test('two stores are fully isolated — a token minted in one never validates in the other', () => {
    const a = makeStore();
    const b = makeStore();
    const { token } = a.mint();
    expect(b.validate(token)).toBe(false);
    expect(a.validate(token)).toBe(true);
  });

  test('__reset clears every session', () => {
    const store = makeStore();
    const first = store.mint().token;
    const second = store.mint().token;
    store.__reset();
    expect(store.validate(first)).toBe(false);
    expect(store.validate(second)).toBe(false);
  });
});

describe('session-cookie-store: maxSessions hard cap', () => {
  test('minting past the cap evicts the oldest sessions', () => {
    const store = makeStore({ maxSessions: 3 });
    const tokens = Array.from({ length: 5 }, () => store.mint().token);
    // Insertion order eviction: the two oldest are gone, the newest three live.
    expect(store.validate(tokens[0])).toBe(false);
    expect(store.validate(tokens[1])).toBe(false);
    expect(store.validate(tokens[2])).toBe(true);
    expect(store.validate(tokens[3])).toBe(true);
    expect(store.validate(tokens[4])).toBe(true);
  });
});

describe('session-cookie-store: extract (cookie header parsing)', () => {
  test('finds the configured cookie among others, with surrounding whitespace', () => {
    const store = makeStore();
    const req = requestWithCookies(`other=1;  ${NAME}=tok-value ; trailing=2`);
    // Each `name=value` part is trimmed as a whole before splitting.
    expect(store.extract(req)).toBe('tok-value');
  });

  test('a cookie value containing = survives intact', () => {
    const store = makeStore();
    const req = requestWithCookies(`${NAME}=abc=def==`);
    expect(store.extract(req)).toBe('abc=def==');
  });

  test('only the EXACT cookie name matches — no prefix/suffix confusion', () => {
    const store = makeStore();
    expect(store.extract(requestWithCookies(`x${NAME}=evil`))).toBeNull();
    expect(store.extract(requestWithCookies(`${NAME}x=evil`))).toBeNull();
  });

  test('missing header and empty value both yield null', () => {
    const store = makeStore();
    expect(store.extract(requestWithCookies(null))).toBeNull();
    expect(store.extract(requestWithCookies(`${NAME}=`))).toBeNull();
    expect(store.extract(requestWithCookies('unrelated=1'))).toBeNull();
  });

  test('two stores with different cookie names read different cookies from one header', () => {
    const ptyLike = createSessionCookieStore({ cookieName: 'pty_session', ttlMs: 1000 });
    const sseLike = createSessionCookieStore({ cookieName: 'sse_session', ttlMs: 1000 });
    const req = requestWithCookies('pty_session=pty-tok; sse_session=sse-tok');
    expect(ptyLike.extract(req)).toBe('pty-tok');
    expect(sseLike.extract(req)).toBe('sse-tok');
  });
});

describe('session-cookie-store: buildSetCookie', () => {
  test('emits the exact security flags with Max-Age derived from ttlMs', () => {
    const store = makeStore({ ttlMs: 90_500 }); // floor(90.5s) = 90
    expect(store.buildSetCookie('tok123')).toBe(
      `${NAME}=tok123; HttpOnly; SameSite=Strict; Path=/; Max-Age=90`,
    );
  });

  test('never emits Secure — the daemon serves plain HTTP on loopback', () => {
    const store = makeStore();
    expect(store.buildSetCookie('t')).not.toContain('Secure');
  });

  test('a minted token round-trips: Set-Cookie → request header → extract → validate', () => {
    const store = makeStore();
    const { token } = store.mint();
    const setCookie = store.buildSetCookie(token);
    // The browser echoes back only the name=value pair.
    const pair = setCookie.split(';')[0];
    const req = requestWithCookies(pair);
    const extracted = store.extract(req);
    expect(extracted).toBe(token);
    expect(store.validate(extracted)).toBe(true);
  });
});
