/**
 * In-memory registry behind the browser-facing session cookies.
 *
 * Browsers cannot attach Authorization headers to EventSource or WebSocket
 * upgrades, so those surfaces authenticate with a short-lived HttpOnly cookie
 * instead of the root AUTH_TOKEN. Each surface gets its own registry instance:
 * the token spaces must not overlap, so an SSE-read cookie can never grant PTY
 * access and vice versa.
 *
 * Shared invariants (previously copy-pasted per surface):
 * - Tokens are 32 random bytes (URL-safe base64). 256 bits, unbruteforceable.
 * - In-memory only. No persistence across daemon restarts.
 * - Opportunistic pruning on every mint AND validate, plus a hard size cap, so
 *   a sustained mint + reconnect flow can't grow the registry unboundedly.
 * - Secure is intentionally omitted from the cookie: the daemon binds to
 *   127.0.0.1 over plain HTTP, and Secure would stop the browser from ever
 *   sending the cookie back. If gstack ever ships over HTTPS, add it.
 */
import * as crypto from 'crypto';

interface Session {
  createdAt: number;
  expiresAt: number;
}

/** Entries scanned per opportunistic prune — keeps cleanup O(1) amortized. */
const PRUNE_SCAN_LIMIT = 20;

export interface SessionCookieRegistryOptions {
  cookieName: string;
  ttlMs: number;
  maxSessions?: number;
}

export interface SessionCookieRegistry {
  cookieName: string;
  /** Mint a fresh session token. */
  mint(): { token: string; expiresAt: number };
  /** True only if the token exists AND has not expired. Expired entries are dropped. */
  validate(token: string | null | undefined): boolean;
  /** Drop a token (e.g. on WS close, so a leaked cookie can't be replayed). */
  revoke(token: string | null | undefined): void;
  /** Parse this registry's token out of a request's Cookie header. */
  extract(req: Request): string | null;
  /** Set-Cookie value: HttpOnly (no JS read), SameSite=Strict (no cross-site), Path=/. */
  buildSetCookie(token: string): string;
  /** Set-Cookie value that clears the cookie. */
  buildClearCookie(): string;
  /** Test-only reset. */
  reset(): void;
}

export function createSessionCookieRegistry(
  options: SessionCookieRegistryOptions,
): SessionCookieRegistry {
  const { cookieName, ttlMs } = options;
  const maxSessions = options.maxSessions ?? 10_000;
  const sessions = new Map<string, Session>();

  function pruneExpired(now: number): void {
    let checked = 0;
    for (const [token, session] of sessions) {
      if (checked++ >= PRUNE_SCAN_LIMIT) break;
      if (session.expiresAt <= now) sessions.delete(token);
    }
    // Backstop for the case nothing is expired but the registry is enormous:
    // drop the oldest entries.
    while (sessions.size > maxSessions) {
      const first = sessions.keys().next().value;
      if (!first) break;
      sessions.delete(first);
    }
  }

  return {
    cookieName,

    mint() {
      const token = crypto.randomBytes(32).toString('base64url');
      const now = Date.now();
      const expiresAt = now + ttlMs;
      sessions.set(token, { createdAt: now, expiresAt });
      pruneExpired(now);
      return { token, expiresAt };
    },

    validate(token) {
      if (!token) return false;
      const s = sessions.get(token);
      if (!s) {
        pruneExpired(Date.now());
        return false;
      }
      if (Date.now() > s.expiresAt) {
        sessions.delete(token);
        pruneExpired(Date.now());
        return false;
      }
      return true;
    },

    revoke(token) {
      if (!token) return;
      sessions.delete(token);
    },

    extract(req) {
      const cookieHeader = req.headers.get('cookie');
      if (!cookieHeader) return null;
      for (const part of cookieHeader.split(';')) {
        const [name, ...valueParts] = part.trim().split('=');
        if (name === cookieName) {
          return valueParts.join('=') || null;
        }
      }
      return null;
    },

    buildSetCookie(token) {
      const maxAge = Math.floor(ttlMs / 1000);
      return `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
    },

    buildClearCookie() {
      return `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
    },

    reset() {
      sessions.clear();
    },
  };
}
