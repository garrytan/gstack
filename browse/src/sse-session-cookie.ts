/**
 * View-only session cookie registry for SSE endpoints.
 *
 * Why this exists: EventSource cannot send Authorization headers, so
 * /activity/stream and /inspector/events historically took a `?token=`
 * query param with the root AUTH_TOKEN. URLs leak through browser history,
 * referer headers, server logs, crash reports, and refactoring accidents
 * (Codex's plan-review outside voice called this out). This module issues
 * a separate short-lived token, scoped to SSE reads only, delivered via
 * an HttpOnly SameSite=Strict cookie that EventSource can pick up with
 * `withCredentials: true`.
 *
 * Design notes:
 * - TTL 30 minutes. Long enough for a normal coding session; short enough
 *   that a leaked cookie expires quickly.
 * - Scope is implicit: validating a cookie only grants read access to
 *   /activity/stream and /inspector/events. The cookie is NEVER valid on
 *   /command, /token, or any mutating endpoint. Matches the
 *   cookie-picker-auth-isolation pattern (prior learning, 10/10 confidence):
 *   cookie-based session tokens must not be valid as scoped tokens.
 * - In-memory only. No persistence across daemon restarts — extension
 *   re-mints on reconnect.
 * - Tokens are 32 random bytes (URL-safe base64). 256 bits, unbruteforceable.
 */
import * as crypto from 'crypto';

interface Session {
  createdAt: number;
  expiresAt: number;
}

const TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_SESSIONS = 10_000; // Upper bound on registry size
const sessions = new Map<string, Session>();

export const SSE_COOKIE_NAME = 'gstack_sse';

/** Mint a fresh view-only SSE session token. */
export function mintSseSessionToken(): { token: string; expiresAt: number } {
  // 32 random bytes → 43-char URL-safe base64 (no padding)
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = now + TTL_MS;
  sessions.set(token, { createdAt: now, expiresAt });
  pruneExpired(now);
  return { token, expiresAt };
}

/**
 * Validate a token. Returns true only if the token exists AND is not expired.
 * Expired tokens are lazily removed, and we opportunistically prune a few
 * additional expired entries on every validate so the registry can't grow
 * unboundedly under sustained mint + reconnect pressure.
 */
export function validateSseSessionToken(token: string | null | undefined): boolean {
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
}

/** Parse the SSE session token from a Cookie header. */
export function extractSseCookie(req: Request): string | null {
  const cookieHeader = req.headers.get('cookie');
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...valueParts] = part.trim().split('=');
    if (name === SSE_COOKIE_NAME) {
      return valueParts.join('=') || null;
    }
  }
  return null;
}

/**
 * Build the Set-Cookie header value for the SSE session cookie.
 * - HttpOnly: not readable from JS (mitigates XSS token exfiltration)
 * - SameSite=Strict: not sent on cross-site requests (mitigates CSRF)
 * - Path=/: scope to the whole origin so SSE endpoints can read it
 * - Max-Age matches the TTL
 *
 * Secure is intentionally omitted: the daemon binds to 127.0.0.1 over
 * plain HTTP, and setting Secure would prevent the browser from ever
 * sending the cookie back. If gstack ever ships over HTTPS, add Secure.
 */
export function buildSseSetCookie(token: string): string {
  const maxAge = Math.floor(TTL_MS / 1000);
  return `${SSE_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

/** Build a Set-Cookie header that clears the SSE session cookie. */
export function buildSseClearCookie(): string {
  return `${SSE_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

function pruneExpired(now: number): void {
  // Opportunistic cleanup: check up to 20 entries per call so we don't
  // stall on a massive registry. O(1) amortized.  Runs on every mint
  // AND on every validate so a steady reconnect flow can't outpace it.
  let checked = 0;
  for (const [token, session] of sessions) {
    if (checked++ >= 20) break;
    if (session.expiresAt <= now) sessions.delete(token);
  }
  // Hard cap as a backstop — if something still gets past opportunistic
  // cleanup (e.g., all unexpired but registry enormous), drop the oldest.
  while (sessions.size > MAX_SESSIONS) {
    const first = sessions.keys().next().value;
    if (!first) break;
    sessions.delete(first);
  }
}

// Test-only reset.
export function __resetSseSessions(): void {
  sessions.clear();
}
