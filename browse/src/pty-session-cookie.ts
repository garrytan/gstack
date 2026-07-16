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
 * Design mirrors `sse-session-cookie.ts` deliberately. Same TTL, same
 * scoped-token-must-not-be-valid-as-root invariant, same opportunistic
 * pruning. Two registries instead of one because the cookie names are
 * different (`gstack_sse` vs `gstack_pty`) and the token spaces must not
 * overlap — an SSE-read cookie must never grant PTY access, and vice versa.
 */
import * as crypto from 'crypto';

interface Session {
  createdAt: number;
  expiresAt: number;
}

const TTL_MS = 30 * 60 * 1000; // 30 minutes — matches SSE cookie
const MAX_SESSIONS = 10_000;
const sessions = new Map<string, Session>();

export const PTY_COOKIE_NAME = 'gstack_pty';

/** Mint a fresh PTY session token. */
export function mintPtySessionToken(): { token: string; expiresAt: number } {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = now + TTL_MS;
  sessions.set(token, { createdAt: now, expiresAt });
  pruneExpired(now);
  return { token, expiresAt };
}

/**
 * Validate a token. Returns true only if the token exists AND is not expired.
 * Lazily removes expired entries; opportunistically prunes a few more on
 * every call so the registry stays bounded under reconnect pressure.
 */
export function validatePtySessionToken(token: string | null | undefined): boolean {
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

/**
 * Drop a session token (called on WS close so a leaked cookie can't be
 * replayed against a new PTY).
 */
export function revokePtySessionToken(token: string | null | undefined): void {
  if (!token) return;
  sessions.delete(token);
}

/** Parse the PTY session token from a Cookie header. */
export function extractPtyCookie(req: Request): string | null {
  const cookieHeader = req.headers.get('cookie');
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...valueParts] = part.trim().split('=');
    if (name === PTY_COOKIE_NAME) {
      return valueParts.join('=') || null;
    }
  }
  return null;
}

/**
 * Build the Set-Cookie header value for the PTY session cookie.
 * - HttpOnly: not readable from JS (mitigates XSS exfiltration).
 * - SameSite=Strict: not sent on cross-site requests (mitigates CSWSH).
 * - Path=/: scope to whole origin so /ws and /pty-session both see it.
 * - Max-Age matches the TTL.
 *
 * Secure is intentionally omitted: the daemon binds to 127.0.0.1 over plain
 * HTTP; setting Secure would prevent the browser from ever sending it back.
 */
export function buildPtySetCookie(token: string): string {
  const maxAge = Math.floor(TTL_MS / 1000);
  return `${PTY_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

/** Clear the PTY session cookie. */
export function buildPtyClearCookie(): string {
  return `${PTY_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

function pruneExpired(now: number): void {
  let checked = 0;
  for (const [token, session] of sessions) {
    if (checked++ >= 20) break;
    if (session.expiresAt <= now) sessions.delete(token);
  }
  while (sessions.size > MAX_SESSIONS) {
    const first = sessions.keys().next().value;
    if (!first) break;
    sessions.delete(first);
  }
}

// Test-only reset.
export function __resetPtySessions(): void {
  sessions.clear();
}
