// Unit tests for SessionTokenStore.
//
// Codex flagged: TTL semantics, capability tier enforcement, rate limiting,
// token expiry, identity-scoped revoke.

import { describe, test, expect } from 'bun:test';
import { SessionTokenStore } from '../src/session-tokens';
import { capabilityCovers } from '../src/types';

describe('SessionTokenStore', () => {
  test('mint returns a token with default 1h TTL', () => {
    const now = 1_000_000;
    const store = new SessionTokenStore(() => now);
    const result = store.mint({
      identity: 'user@example.com',
      capability: 'interact',
      origin: 'self_service',
    });
    expect(result).toMatchObject({
      identity: 'user@example.com',
      capability: 'interact',
      origin: 'self_service',
    });
    if ('error' in result) throw new Error('unexpected error');
    expect(result.expires_at).toBe(now + 60 * 60 * 1000);
  });

  test('mint caps TTL at 24h', () => {
    const now = 1_000_000;
    const store = new SessionTokenStore(() => now);
    const result = store.mint({
      identity: 'u',
      capability: 'observe',
      ttlMs: 1_000_000_000, // way over 24h
      origin: 'self_service',
    });
    if ('error' in result) throw new Error('unexpected error');
    expect(result.expires_at).toBe(now + 24 * 60 * 60 * 1000);
  });

  test('validate returns ok for fresh token at the required tier', () => {
    const store = new SessionTokenStore();
    const result = store.mint({ identity: 'u', capability: 'mutate', origin: 'owner_granted' });
    if ('error' in result) throw new Error('unexpected error');
    const v = store.validate(result.token, 'observe');
    expect(v.ok).toBe(true);
  });

  test('validate rejects null/empty/unknown tokens', () => {
    const store = new SessionTokenStore();
    expect(store.validate(null, 'observe')).toEqual({ ok: false, reason: 'no_token' });
    expect(store.validate('', 'observe')).toEqual({ ok: false, reason: 'no_token' });
    expect(store.validate('bogus-token', 'observe')).toEqual({ ok: false, reason: 'invalid_token' });
  });

  test('validate rejects expired tokens', () => {
    let now = 1_000_000;
    const store = new SessionTokenStore(() => now);
    const result = store.mint({ identity: 'u', capability: 'observe', origin: 'self_service' });
    if ('error' in result) throw new Error('unexpected error');
    now += 25 * 60 * 60 * 1000; // 25 hours later — past max TTL
    expect(store.validate(result.token, 'observe')).toEqual({ ok: false, reason: 'expired_token' });
  });

  test('validate rejects tokens with insufficient capability', () => {
    const store = new SessionTokenStore();
    const r = store.mint({ identity: 'u', capability: 'observe', origin: 'self_service' });
    if ('error' in r) throw new Error('unexpected');
    expect(store.validate(r.token, 'interact')).toEqual({ ok: false, reason: 'capability_insufficient' });
    expect(store.validate(r.token, 'mutate')).toEqual({ ok: false, reason: 'capability_insufficient' });
    expect(store.validate(r.token, 'restore')).toEqual({ ok: false, reason: 'capability_insufficient' });
  });

  test('higher capability tiers cover lower tiers', () => {
    expect(capabilityCovers('restore', 'mutate')).toBe(true);
    expect(capabilityCovers('restore', 'interact')).toBe(true);
    expect(capabilityCovers('restore', 'observe')).toBe(true);
    expect(capabilityCovers('mutate', 'interact')).toBe(true);
    expect(capabilityCovers('observe', 'interact')).toBe(false);
    expect(capabilityCovers('observe', 'mutate')).toBe(false);
  });

  test('heartbeat extends TTL', () => {
    let now = 1_000_000;
    const store = new SessionTokenStore(() => now);
    const r = store.mint({ identity: 'u', capability: 'observe', origin: 'self_service' });
    if ('error' in r) throw new Error('unexpected');
    const originalExpiry = r.expires_at;
    now += 30 * 60 * 1000; // 30 min later
    const newExpiry = store.heartbeat(r.token);
    expect(newExpiry).not.toBeNull();
    expect(newExpiry!).toBeGreaterThan(originalExpiry);
    expect(newExpiry!).toBe(now + 60 * 60 * 1000);
  });

  test('heartbeat after expiry returns null', () => {
    let now = 1_000_000;
    const store = new SessionTokenStore(() => now);
    const r = store.mint({ identity: 'u', capability: 'observe', origin: 'self_service' });
    if ('error' in r) throw new Error('unexpected');
    now += 25 * 60 * 60 * 1000; // past max TTL
    expect(store.heartbeat(r.token)).toBeNull();
  });

  test('rate limit blocks the 11th mint within 60s window', () => {
    const now = 1_000_000;
    const store = new SessionTokenStore(() => now);
    const results = [];
    for (let i = 0; i < 11; i++) {
      results.push(store.mint({ identity: 'spammer', capability: 'observe', origin: 'self_service' }));
    }
    const ok = results.filter(r => !('error' in r));
    const errs = results.filter(r => 'error' in r);
    expect(ok.length).toBe(10);
    expect(errs.length).toBe(1);
    expect(errs[0]).toEqual({ error: 'rate_limited' });
  });

  test('rate limit window slides — 11th mint succeeds after 60s', () => {
    let now = 1_000_000;
    const store = new SessionTokenStore(() => now);
    for (let i = 0; i < 10; i++) {
      store.mint({ identity: 'spammer', capability: 'observe', origin: 'self_service' });
    }
    now += 61_000; // past window
    const r = store.mint({ identity: 'spammer', capability: 'observe', origin: 'self_service' });
    expect('error' in r).toBe(false);
  });

  test('revoke removes a token', () => {
    const store = new SessionTokenStore();
    const r = store.mint({ identity: 'u', capability: 'observe', origin: 'self_service' });
    if ('error' in r) throw new Error('unexpected');
    expect(store.revoke(r.token)).toBe(true);
    expect(store.validate(r.token, 'observe')).toEqual({ ok: false, reason: 'invalid_token' });
  });

  test('revokeByIdentity removes all tokens for one identity', () => {
    const store = new SessionTokenStore();
    const a1 = store.mint({ identity: 'a', capability: 'observe', origin: 'self_service' });
    const a2 = store.mint({ identity: 'a', capability: 'observe', origin: 'self_service' });
    const b1 = store.mint({ identity: 'b', capability: 'observe', origin: 'self_service' });
    if ('error' in a1 || 'error' in a2 || 'error' in b1) throw new Error('unexpected');
    expect(store.revokeByIdentity('a')).toBe(2);
    expect(store.validate(a1.token, 'observe').ok).toBe(false);
    expect(store.validate(a2.token, 'observe').ok).toBe(false);
    expect(store.validate(b1.token, 'observe').ok).toBe(true);
  });

  test('list returns all active tokens', () => {
    const store = new SessionTokenStore();
    store.mint({ identity: 'a', capability: 'observe', origin: 'self_service' });
    store.mint({ identity: 'b', capability: 'mutate', origin: 'owner_granted' });
    expect(store.list().length).toBe(2);
  });
});
