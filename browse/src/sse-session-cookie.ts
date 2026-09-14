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
 *
 * Shares the registry implementation with pty-session-cookie.ts via
 * createSessionCookieStore; separate INSTANCE so the token spaces never
 * overlap.
 */
import { createSessionCookieStore } from './session-cookie-store';

const TTL_MS = 30 * 60 * 1000; // 30 minutes

export const SSE_COOKIE_NAME = 'gstack_sse';

const store = createSessionCookieStore({ cookieName: SSE_COOKIE_NAME, ttlMs: TTL_MS });

/** Mint a fresh view-only SSE session token. */
export function mintSseSessionToken(): { token: string; expiresAt: number } {
  return store.mint();
}

/**
 * Validate a token. Returns true only if the token exists AND is not expired.
 * Expired tokens are lazily removed, and we opportunistically prune a few
 * additional expired entries on every validate so the registry can't grow
 * unboundedly under sustained mint + reconnect pressure.
 */
export function validateSseSessionToken(token: string | null | undefined): boolean {
  return store.validate(token);
}

/** Parse the SSE session token from a Cookie header. */
export function extractSseCookie(req: Request): string | null {
  return store.extract(req);
}

/** Build the Set-Cookie header value for the SSE session cookie. */
export function buildSseSetCookie(token: string): string {
  return store.buildSetCookie(token);
}

// Test-only reset.
export function __resetSseSessions(): void {
  store.__reset();
}
