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
 * - Registry mechanics (entropy, pruning, cookie flags) live in
 *   `session-cookie-registry.ts`; this module owns the SSE-specific policy.
 */
import { createSessionCookieRegistry } from './session-cookie-registry';

const TTL_MS = 30 * 60 * 1000; // 30 minutes

export const SSE_COOKIE_NAME = 'gstack_sse';

const registry = createSessionCookieRegistry({
  cookieName: SSE_COOKIE_NAME,
  ttlMs: TTL_MS,
});

/** Mint a fresh view-only SSE session token. */
export function mintSseSessionToken(): { token: string; expiresAt: number } {
  return registry.mint();
}

/** Validate a token. True only if it exists AND is not expired. */
export function validateSseSessionToken(token: string | null | undefined): boolean {
  return registry.validate(token);
}

/** Parse the SSE session token from a Cookie header. */
export function extractSseCookie(req: Request): string | null {
  return registry.extract(req);
}

/** Build the Set-Cookie header value for the SSE session cookie. */
export function buildSseSetCookie(token: string): string {
  return registry.buildSetCookie(token);
}

/** Build a Set-Cookie header that clears the SSE session cookie. */
export function buildSseClearCookie(): string {
  return registry.buildClearCookie();
}

// Test-only reset.
export function __resetSseSessions(): void {
  registry.reset();
}
