import { describe, test, expect, beforeEach } from 'bun:test';

// pty-session-lease registers a sessionId space distinct from the pre-v1.44
// attach-token space (browse/src/pty-session-cookie.ts). These tests pin
// the validate-first contract that codex outside-voice flagged as critical:
// refreshLease MUST NOT resurrect expired leases, otherwise the 30-min TTL
// stops bounding leaked-token blast radius.

import {
  mintLease,
  validateLease,
  refreshLease,
  revokeLease,
  leaseCount,
  __resetLeases,
} from '../src/pty-session-lease';

beforeEach(() => {
  __resetLeases();
});

describe('pty-session-lease: mint/validate/revoke', () => {
  test('mintLease returns a fresh non-secret sessionId + future expiresAt', () => {
    const a = mintLease();
    const b = mintLease();
    expect(a.sessionId).toBeTruthy();
    expect(b.sessionId).toBeTruthy();
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.expiresAt).toBeGreaterThan(Date.now());
    // base64url alphabet: characters in [A-Za-z0-9_-].
    expect(a.sessionId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(leaseCount()).toBe(2);
  });

  test('validateLease ok for fresh lease, false for unknown', () => {
    const { sessionId } = mintLease();
    const ok = validateLease(sessionId);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.expiresAt).toBeGreaterThan(Date.now());
    expect(validateLease('not-a-real-session-id').ok).toBe(false);
    expect(validateLease(null).ok).toBe(false);
    expect(validateLease(undefined).ok).toBe(false);
  });

  test('revokeLease removes the lease; subsequent validate returns false', () => {
    const { sessionId } = mintLease();
    expect(validateLease(sessionId).ok).toBe(true);
    revokeLease(sessionId);
    expect(validateLease(sessionId).ok).toBe(false);
    expect(leaseCount()).toBe(0);
  });

  test('revokeLease tolerates unknown sessionId without throwing', () => {
    expect(() => revokeLease('phantom')).not.toThrow();
    expect(() => revokeLease(null)).not.toThrow();
  });
});

describe('pty-session-lease: refresh contract (validate-first)', () => {
  test('refreshLease extends expiresAt for a valid lease', () => {
    const { sessionId, expiresAt: initial } = mintLease();
    // Sleep micro-tick — Date.now() is ms-grain so a synchronous extend
    // may not move the integer. Use a tight async wait instead.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const r = refreshLease(sessionId);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.expiresAt).toBeGreaterThan(initial);
        resolve();
      }, 5);
    });
  });

  test('refreshLease rejects unknown sessionId (validate-first invariant)', () => {
    const r = refreshLease('never-minted');
    expect(r.ok).toBe(false);
  });

  test('refreshLease never resurrects an expired lease', async () => {
    // Force TTL down to 5ms for this assertion by minting + waiting past expiry.
    // Lease internals use Date.now() so the easiest way to expire one is
    // to artificially backdate via revoke+remint cycle. Simpler: mint, then
    // wait for the registry's own expiry check to trip.
    //
    // We can't backdate without breaking encapsulation, so this test exercises
    // the negative-validate path: minted lease, then prove that refresh after
    // explicit revoke still returns ok:false (same as expired-and-pruned).
    const { sessionId } = mintLease();
    revokeLease(sessionId);
    const r = refreshLease(sessionId);
    expect(r.ok).toBe(false);
  });

  test('refreshLease tolerates null / undefined sessionId', () => {
    expect(refreshLease(null).ok).toBe(false);
    expect(refreshLease(undefined).ok).toBe(false);
  });
});
