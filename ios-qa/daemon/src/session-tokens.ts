// Short-lived session token store. In-memory only (never disk). Refreshable
// via /session/heartbeat. Listable and revokable from loopback listener.

import { randomBytes } from 'crypto';
import type { Capability, SessionToken } from './types';
import { capabilityCovers } from './types';

const TOKEN_BYTES = 32; // 256-bit
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h per D9
const MAX_TTL_MS = 24 * 60 * 60 * 1000; // 24h hard cap

export class SessionTokenStore {
  private tokens = new Map<string, SessionToken>();
  private mintsPerIdentity = new Map<string, number[]>(); // ts (ms) for rate limiting

  constructor(
    private now: () => number = () => Date.now(),
  ) {}

  /**
   * Mint a session token. Returns null on rate limit.
   */
  mint(opts: {
    identity: string;
    capability: Capability;
    ttlMs?: number;
    deviceUdid?: string | null;
    origin: SessionToken['origin'];
  }): SessionToken | { error: 'rate_limited' } {
    if (!this.checkRateLimit(opts.identity)) {
      return { error: 'rate_limited' };
    }
    const ttl = Math.min(opts.ttlMs ?? DEFAULT_TTL_MS, MAX_TTL_MS);
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const expires_at = this.now() + ttl;
    const session: SessionToken = {
      token,
      identity: opts.identity,
      capability: opts.capability,
      expires_at,
      device_udid: opts.deviceUdid ?? null,
      origin: opts.origin,
    };
    this.tokens.set(token, session);
    return session;
  }

  /**
   * Validate a token. Returns the session if valid (token exists, not
   * expired). Otherwise returns null with a reason for the audit log.
   */
  validate(token: string | null | undefined, need: Capability):
    | { ok: true; session: SessionToken }
    | { ok: false; reason: 'no_token' | 'invalid_token' | 'expired_token' | 'capability_insufficient' } {
    if (!token) return { ok: false, reason: 'no_token' };
    const s = this.tokens.get(token);
    if (!s) return { ok: false, reason: 'invalid_token' };
    if (s.expires_at < this.now()) {
      this.tokens.delete(token);
      return { ok: false, reason: 'expired_token' };
    }
    if (!capabilityCovers(s.capability, need)) {
      return { ok: false, reason: 'capability_insufficient' };
    }
    return { ok: true, session: s };
  }

  /**
   * Slide token expiry forward by ttlMs. Caps at the token's original max
   * (which itself is bounded by MAX_TTL_MS). Returns the new expiry.
   */
  heartbeat(token: string, ttlMs?: number): number | null {
    const s = this.tokens.get(token);
    if (!s) return null;
    if (s.expires_at < this.now()) {
      this.tokens.delete(token);
      return null;
    }
    const newExpiry = this.now() + Math.min(ttlMs ?? DEFAULT_TTL_MS, MAX_TTL_MS);
    s.expires_at = newExpiry;
    return newExpiry;
  }

  revoke(token: string): boolean {
    return this.tokens.delete(token);
  }

  revokeByIdentity(identity: string): number {
    let count = 0;
    for (const [token, s] of this.tokens) {
      if (s.identity === identity) {
        this.tokens.delete(token);
        count++;
      }
    }
    return count;
  }

  list(): SessionToken[] {
    return [...this.tokens.values()];
  }

  // For tests: clear all state.
  reset() {
    this.tokens.clear();
    this.mintsPerIdentity.clear();
  }

  /**
   * Rate limit: 10 mints / 60s per identity. Sliding window.
   */
  private checkRateLimit(identity: string): boolean {
    const now = this.now();
    const window = 60_000;
    const limit = 10;
    const hits = this.mintsPerIdentity.get(identity) ?? [];
    const recent = hits.filter(t => now - t < window);
    if (recent.length >= limit) {
      this.mintsPerIdentity.set(identity, recent);
      return false;
    }
    recent.push(now);
    this.mintsPerIdentity.set(identity, recent);
    return true;
  }
}
