/**
 * PTY session lease registry (v1.44+).
 *
 * Separates two concerns that pre-v1.44 were conflated under one token:
 *
 *  - **sessionId** — stable, non-secret identifier for a single PTY session.
 *    Safe to log, safe to include in URLs and server access logs, safe to
 *    keep in DevTools. Identifies "this terminal," not "you're allowed to
 *    use this terminal."
 *
 *  - **attachToken** — secret, short-lived (30 s) bearer credential that
 *    grants the WS upgrade for ONE attach attempt against a session. Minted
 *    on every /pty-session and /pty-session/reattach call; revoked when
 *    the WS upgrade consumes it. Kept out of logs.
 *
 *  - **lease** — server-side bookkeeping that maps sessionId → expiresAt.
 *    Re-attach within the lease window resumes the same PTY (and replays
 *    the ring buffer from terminal-agent). Lease expiry tears down the
 *    session.
 *
 * Codex outside-voice (T1 of the eng review) pushed for this separation:
 * "the auth token IS the session id" collapsed identity into a secret,
 * meaning re-attach URLs and logs carry the bearer credential. The lease
 * model fixes that without changing the user experience.
 *
 * Mint cadence:
 *  - Initial /pty-session: mint sessionId + lease + attachToken (one round trip).
 *  - /pty-session/reattach: validate sessionId/lease, mint fresh attachToken.
 *  - /pty-restart: revoke old lease, mint fresh sessionId + lease + attachToken.
 *  - /pty-dispose: revoke lease (and the terminal-agent disposes the PTY).
 *
 * Lease TTL is env-overridable so v1.44 e2e tests can compress detach
 * windows to 1 s instead of waiting 30 minutes per assertion.
 */
import * as crypto from 'crypto';

interface Lease {
  createdAt: number;
  expiresAt: number;
}

const LEASE_TTL_MS = parseInt(
  process.env.GSTACK_PTY_LEASE_TTL_MS || `${30 * 60 * 1000}`,
  10,
); // 30 minutes default; covers idle-but-engaged user sessions
const MAX_LEASES = 10_000;
const leases = new Map<string, Lease>();

/**
 * Mint a fresh sessionId + lease. Returns the non-secret sessionId and
 * the expiry timestamp (caller surfaces both to the client). Never throws.
 */
export function mintLease(): { sessionId: string; expiresAt: number } {
  const sessionId = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = now + LEASE_TTL_MS;
  leases.set(sessionId, { createdAt: now, expiresAt });
  pruneExpired(now);
  return { sessionId, expiresAt };
}

/**
 * Check whether a lease is still valid (exists AND not expired). Returns
 * the current expiresAt for valid leases; null otherwise. Lazily prunes
 * stale entries.
 */
export function validateLease(sessionId: string | null | undefined): { ok: true; expiresAt: number } | { ok: false } {
  if (!sessionId) return { ok: false };
  const lease = leases.get(sessionId);
  if (!lease) {
    pruneExpired(Date.now());
    return { ok: false };
  }
  if (Date.now() > lease.expiresAt) {
    leases.delete(sessionId);
    pruneExpired(Date.now());
    return { ok: false };
  }
  return { ok: true, expiresAt: lease.expiresAt };
}

/**
 * Extend the lease's expiresAt to `now + LEASE_TTL_MS`. Caller should
 * gate refresh on `expiresAt - now < REFRESH_THRESHOLD` (D10 lazy
 * refresh: avoid refreshing on every keepalive when the lease is
 * comfortably far from expiry).
 *
 * Returns `{ ok: true, expiresAt }` on success, `{ ok: false }` if the
 * lease is unknown or already expired (the agent must close the WS and
 * surface auth-invalid). Critical security invariant: never resurrect
 * an expired lease — the 30-min TTL is what bounds blast radius for a
 * leaked attach token whose lease should have been GC'd.
 */
export function refreshLease(sessionId: string | null | undefined): { ok: true; expiresAt: number } | { ok: false } {
  if (!sessionId) return { ok: false };
  const lease = leases.get(sessionId);
  if (!lease) return { ok: false };
  const now = Date.now();
  if (now > lease.expiresAt) {
    leases.delete(sessionId);
    return { ok: false };
  }
  lease.expiresAt = now + LEASE_TTL_MS;
  return { ok: true, expiresAt: lease.expiresAt };
}

/**
 * Drop a lease. Called on explicit dispose (/pty-dispose, /pty-restart,
 * WS close with code 4001) and on session timeout in terminal-agent.
 */
export function revokeLease(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  leases.delete(sessionId);
}

/** Returns the lease count — test + observability helper. */
export function leaseCount(): number {
  return leases.size;
}

/** Test-only reset. */
export function __resetLeases(): void {
  leases.clear();
}

function pruneExpired(now: number): void {
  let checked = 0;
  for (const [sessionId, lease] of leases) {
    if (checked++ >= 20) break;
    if (lease.expiresAt <= now) leases.delete(sessionId);
  }
  while (leases.size > MAX_LEASES) {
    const first = leases.keys().next().value;
    if (!first) break;
    leases.delete(first);
  }
}
