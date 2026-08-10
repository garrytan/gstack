/**
 * Session cookie registry for the Terminal sidebar tab's PTY WebSocket.
 *
 * Why this exists: WebSocket clients in browsers cannot send Authorization
 * headers on the upgrade request. The terminal-agent's /ws upgrade therefore
 * authenticates via cookie. We never put the PTY token in /health (codex
 * outside-voice finding #2: /health already leaks AUTH_TOKEN to any
 * localhost caller in headed mode; reusing that path for shell access would
 * widen an existing bug). Instead, the extension does an authenticated
 * POST /pty-session with the bootstrap AUTH_TOKEN; the server mints a
 * short-lived cookie scoped to this terminal session and pushes it to the
 * agent via loopback. The browser then carries the cookie automatically on
 * the WS upgrade.
 *
 * Shares the registry mechanics in `session-cookie-registry.ts` with
 * `sse-session-cookie.ts`. Two registries instead of one because the cookie
 * names are different (`gstack_sse` vs `gstack_pty`) and the token spaces must
 * not overlap — an SSE-read cookie must never grant PTY access, and vice versa.
 */
import { createSessionCookieRegistry } from './session-cookie-registry';

const TTL_MS = 30 * 60 * 1000; // 30 minutes — matches SSE cookie

export const PTY_COOKIE_NAME = 'gstack_pty';

const registry = createSessionCookieRegistry({
  cookieName: PTY_COOKIE_NAME,
  ttlMs: TTL_MS,
});

/** Mint a fresh PTY session token. */
export function mintPtySessionToken(): { token: string; expiresAt: number } {
  return registry.mint();
}

/** Validate a token. True only if it exists AND is not expired. */
export function validatePtySessionToken(token: string | null | undefined): boolean {
  return registry.validate(token);
}

/**
 * Drop a session token (called on WS close so a leaked cookie can't be
 * replayed against a new PTY).
 */
export function revokePtySessionToken(token: string | null | undefined): void {
  registry.revoke(token);
}

/** Parse the PTY session token from a Cookie header. */
export function extractPtyCookie(req: Request): string | null {
  return registry.extract(req);
}

/** Build the Set-Cookie header value for the PTY session cookie. */
export function buildPtySetCookie(token: string): string {
  return registry.buildSetCookie(token);
}

/** Clear the PTY session cookie. */
export function buildPtyClearCookie(): string {
  return registry.buildClearCookie();
}

// Test-only reset.
export function __resetPtySessions(): void {
  registry.reset();
}
