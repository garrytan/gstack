/**
 * Factory for expiring session-cookie registries.
 *
 * pty-session-cookie.ts and sse-session-cookie.ts were byte-identical modulo
 * the cookie name — a security-critical parser/TTL/prune implementation that
 * had to be fixed in two places (and a third hand-rolled copy of the cookie
 * parse had already diverged in terminal-agent.ts). One implementation now;
 * the two modules are thin instantiations that keep their names and their
 * distinct threat-model docstrings.
 *
 * Deliberately NOT unified here: pty-session-lease.ts — that's a different
 * contract (sessionId/secret separation, refresh, env-overridable TTL).
 *
 * SECURITY INVARIANT: this module must never import token-registry — cookie
 * session tokens must not be valid as scoped tokens (the
 * cookie-picker-auth-isolation pattern). Pinned by sse-session-cookie.test.ts.
 */
import * as crypto from 'crypto';

interface Session {
  createdAt: number;
  expiresAt: number;
}

export interface SessionCookieStore {
  mint(): { token: string; expiresAt: number };
  validate(token: string | null | undefined): boolean;
  revoke(token: string | null | undefined): void;
  extract(req: Request): string | null;
  buildSetCookie(token: string): string;
  /** Test-only reset. */
  __reset(): void;
}

export function createSessionCookieStore(opts: {
  cookieName: string;
  ttlMs: number;
  maxSessions?: number;
}): SessionCookieStore {
  const { cookieName, ttlMs } = opts;
  const maxSessions = opts.maxSessions ?? 10_000;
  const sessions = new Map<string, Session>();

  function pruneExpired(now: number): void {
    // Opportunistic cleanup: check up to 20 entries per call so we don't
    // stall on a massive registry. O(1) amortized. Runs on every mint AND
    // on every validate so a steady reconnect flow can't outpace it.
    let checked = 0;
    for (const [token, session] of sessions) {
      if (checked++ >= 20) break;
      if (session.expiresAt <= now) sessions.delete(token);
    }
    // Hard cap as a backstop — if something still gets past opportunistic
    // cleanup (e.g., all unexpired but registry enormous), drop the oldest.
    while (sessions.size > maxSessions) {
      const first = sessions.keys().next().value;
      if (!first) break;
      sessions.delete(first);
    }
  }

  return {
    mint() {
      // 32 random bytes → 43-char URL-safe base64 (no padding). 256 bits.
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

    /**
     * Set-Cookie value:
     * - HttpOnly: not readable from JS (mitigates XSS exfiltration).
     * - SameSite=Strict: not sent on cross-site requests (mitigates
     *   CSRF/CSWSH).
     * - Path=/: scope to the whole origin.
     * - Max-Age matches the TTL.
     * Secure is intentionally omitted: the daemon binds 127.0.0.1 over plain
     * HTTP; Secure would prevent the browser from ever sending it back.
     */
    buildSetCookie(token) {
      const maxAge = Math.floor(ttlMs / 1000);
      return `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
    },

    __reset() {
      sessions.clear();
    },
  };
}
