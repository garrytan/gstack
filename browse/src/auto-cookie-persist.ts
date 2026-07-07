/**
 * Automatic cookie persistence for the headless browse daemon (opt-in).
 *
 * Why this exists
 * ----------------
 * `BrowserManager.launch()` uses `chromium.launch()` + a NON-persistent
 * `browser.newContext()`, which Playwright defines as never writing browsing
 * data to disk. So when the daemon restarts (idle timeout, `/stop`, crash),
 * every in-memory cookie is gone. For a site whose device identity is bound to
 * a long-lived cookie (e.g. a `__Host-`-prefixed device-trust cookie), that
 * restart forces a fresh device registration on the next visit — the login
 * looks transparent, but the device cookie silently vanished.
 *
 * `recreateContext()` (viewport / user-agent change) already saves and restores
 * state in-memory, so it preserves cookies; only a full daemon restart loses
 * them. This layer closes that gap by persisting cookies to a small state file
 * and reloading them at launch.
 *
 * Design (validated against Playwright 1.58.2)
 * --------------------------------------------
 *  - OPT-IN. Off unless BROWSE_AUTO_COOKIE_PERSIST is truthy. Auto-persisting
 *    auth cookies to plaintext-on-disk for every user is a security escalation
 *    from the current ephemeral-profile semantics, so it must be a conscious
 *    choice. When enabled the daemon logs a one-time plaintext warning.
 *  - PERSISTENT COOKIES ONLY. Session cookies (expires === -1) are excluded by
 *    definition — turning a browser-session login into a durable one is wrong.
 *    Expired cookies are dropped so a logout/expiry is never resurrected.
 *  - Cookies are captured/restored as a Playwright `storageState`-shaped object
 *    ({ cookies, origins: [] }); we intentionally never persist localStorage,
 *    sessionStorage, IndexedDB, or open pages — only cookies.
 *  - Fields are preserved verbatim (domain/path/httpOnly/secure/sameSite/
 *    partitionKey); `__Host-` host-only cookies restore correctly via
 *    `newContext({ storageState })` / `addCookies` with their bare domain.
 *  - PER-WORKSPACE FILE + EXCLUSIVE LOCK. The state file is keyed by a hash of
 *    the resolved project dir, and a sibling lock dir (mkdir-atomic) prevents
 *    two concurrent daemons (separate git worktrees) from racing the same slot.
 *  - ATOMIC WRITES. Every checkpoint is a temp-file + rename, so a crash or a
 *    concurrent reader never sees a torn file (see writeSecureFileAtomic).
 *  - MANUAL STATES ARE UNTOUCHED. This is a separate internal file, not a
 *    reserved `state save|load <name>`; users can't clobber it and it can't
 *    clobber theirs.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { BrowserContext, Cookie } from 'playwright';
import type { BrowseConfig } from './config';
import { mkdirSecure, writeSecureFileAtomic } from './file-permissions';
import { safeUnlinkQuiet, isProcessAlive } from './error-handling';

const STATE_KIND = 'gstack-browse-auto-cookie-state';
const STATE_VERSION = 1;

/** Persisted wrapper written to <stateDir>/browse-auto-cookies/<profileId>.json */
interface AutoCookieState {
  version: number;
  kind: string;
  workspaceId: string;
  savedAt: string;
  storageState: { cookies: Cookie[]; origins: [] };
}

/** Lock ownership metadata (pid + start time), written into the lock dir. */
interface LockMeta {
  pid: number;
  startedAt: string;
}

let warnedOnce = false;

/**
 * Truthy check for the opt-in flag. Accepts 1/true/yes/on (case-insensitive);
 * everything else (unset, 0, false, empty) is off.
 */
export function isAutoCookiePersistEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = (env.BROWSE_AUTO_COOKIE_PERSIST || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Optional host allowlist from BROWSE_AUTO_COOKIE_DOMAINS (comma-separated).
 * Supports exact hosts (example.com) and leading-wildcard (*.example.com,
 * which also matches the apex example.com). Empty/unset ⇒ null ⇒ all hosts.
 */
export function parseDomainAllowlist(
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  const raw = (env.BROWSE_AUTO_COOKIE_DOMAINS || '').trim();
  if (!raw) return null;
  const list = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.length > 0 ? list : null;
}

function hostMatchesAllowlist(domain: string, allowlist: string[]): boolean {
  // Cookie domains may carry a leading dot (domain cookies); normalize it off.
  const host = (domain.startsWith('.') ? domain.slice(1) : domain).toLowerCase();
  for (const pattern of allowlist) {
    if (pattern.startsWith('*.')) {
      const base = pattern.slice(2);
      if (host === base || host.endsWith(`.${base}`)) return true;
    } else if (host === pattern) {
      return true;
    }
  }
  return false;
}

/**
 * Stable per-workspace id. Hash of the resolved (realpath) project dir so two
 * different checkouts of the same repo don't share a slot, and a moved/renamed
 * dir gets its own. Falls back to the raw projectDir if realpath fails.
 */
export function computeProfileId(config: BrowseConfig): string {
  let base = config.projectDir;
  try {
    base = fs.realpathSync(config.projectDir);
  } catch {
    // Dir may not exist yet in some test setups — hash the declared path.
  }
  return createHash('sha256').update(base).digest('hex').slice(0, 16);
}

function autoDir(config: BrowseConfig): string {
  return path.join(config.stateDir, 'browse-auto-cookies');
}
function statePath(config: BrowseConfig): string {
  return path.join(autoDir(config), `${computeProfileId(config)}.json`);
}
function lockPath(config: BrowseConfig): string {
  return path.join(autoDir(config), `${computeProfileId(config)}.lock`);
}

function normalizeCookieDomain(domain: string): string {
  const d = domain.startsWith('.') ? domain.slice(1) : domain;
  return d.toLowerCase();
}

/**
 * Keep only cookies that are safe and sensible to persist:
 *  - persistent (expires !== -1) and not already expired,
 *  - well-formed (string name/value, non-empty string domain),
 *  - not internal-network (mirrors the manual `state load` safety filter),
 *  - within the optional host allowlist.
 */
export function filterPersistableCookies(
  cookies: Cookie[],
  allowlist: string[] | null,
  now: number = Date.now(),
): Cookie[] {
  const nowSec = now / 1000;
  return cookies.filter((c) => {
    if (!c || typeof c.name !== 'string' || typeof c.value !== 'string') return false;
    if (typeof c.domain !== 'string' || !c.domain) return false;
    // Session cookie — Playwright reports expires === -1. Never persist.
    if (typeof c.expires !== 'number' || c.expires === -1 || !Number.isFinite(c.expires)) return false;
    if (c.expires <= nowSec) return false; // already expired
    const d = normalizeCookieDomain(c.domain);
    if (d === 'localhost' || d.endsWith('.internal') || d === '169.254.169.254') return false;
    if (allowlist && !hostMatchesAllowlist(c.domain, allowlist)) return false;
    return true;
  });
}

/**
 * Deterministic content hash of a cookie set — used to skip no-op writes.
 * Sorted by (domain, path, name) and reduced to the identity-bearing fields so
 * that a re-serialization with reordered cookies doesn't churn the file.
 */
export function cookieSetHash(cookies: Cookie[]): string {
  const norm = cookies
    .map(c => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      expires: c.expires, httpOnly: c.httpOnly, secure: c.secure,
      sameSite: c.sameSite, partitionKey: c.partitionKey ?? null,
    }))
    .sort((a, b) =>
      a.domain.localeCompare(b.domain) || a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
  return createHash('sha256').update(JSON.stringify(norm)).digest('hex');
}

// ─── Locking (mkdir-atomic; conservative stale reclaim) ─────────────────────

/**
 * Try to acquire the per-workspace lock. `mkdir` of the lock dir is the atomic
 * primitive — it fails if the dir already exists. If a lock is held by a dead
 * pid (crash without cleanup) we reclaim it; a lock held by a live pid means a
 * peer daemon owns the slot and we back off. Returns true on acquisition.
 */
export function acquireLock(config: BrowseConfig): boolean {
  const dir = lockPath(config);
  const meta: LockMeta = { pid: process.pid, startedAt: new Date().toISOString() };
  // Ensure the parent (browse-auto-cookies/) exists; the lock dir itself is
  // created non-recursively so its creation stays the atomic acquire primitive.
  try { mkdirSecure(autoDir(config)); } catch { /* best-effort — mkdirSync below reports the real failure */ }
  try {
    fs.mkdirSync(dir, { recursive: false });
  } catch (err: any) {
    if (err?.code !== 'EEXIST') return false;
    // Lock exists — reclaim only if its owner is provably dead.
    if (!reclaimIfStale(dir)) return false;
    try {
      fs.mkdirSync(dir, { recursive: false });
    } catch {
      return false; // lost a race to another reclaimer
    }
  }
  try {
    fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify(meta), { mode: 0o600 });
  } catch {
    // Metadata is advisory; the dir's existence is the actual lock.
  }
  return true;
}

/** Reclaim a lock dir iff its recorded owner pid is no longer alive. */
function reclaimIfStale(dir: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(dir, 'owner.json'), 'utf-8');
    const meta = JSON.parse(raw) as LockMeta;
    if (typeof meta.pid === 'number' && meta.pid > 0 && isProcessAlive(meta.pid)) {
      return false; // live owner — do not steal
    }
  } catch {
    // No/!parseable metadata — treat as stale (best-effort reclaim).
  }
  safeUnlinkQuiet(path.join(dir, 'owner.json'));
  try {
    fs.rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/** Release the lock if we own it (pid match). Safe to call unconditionally. */
export function releaseLock(config: BrowseConfig): void {
  const dir = lockPath(config);
  try {
    const raw = fs.readFileSync(path.join(dir, 'owner.json'), 'utf-8');
    const meta = JSON.parse(raw) as LockMeta;
    if (meta.pid !== process.pid) return; // not ours — don't remove
  } catch {
    // No metadata — fall through and attempt removal (we likely created it).
  }
  safeUnlinkQuiet(path.join(dir, 'owner.json'));
  try { fs.rmdirSync(dir); } catch { /* best-effort */ }
}

// ─── Load / Save ────────────────────────────────────────────────────────────

/**
 * Read persisted cookies for restore, as a Playwright storageState-shaped
 * object suitable for `newContext({ storageState })`. Returns null when the
 * feature is off, no file exists, the file is corrupt/foreign, or the workspace
 * id doesn't match. Never throws — a bad state file must not block launch.
 */
export function loadAutoCookieState(
  config: BrowseConfig,
  now: number = Date.now(),
): { cookies: Cookie[]; origins: [] } | null {
  if (!isAutoCookiePersistEnabled()) return null;
  const file = statePath(config);
  let raw: string;
  try {
    if (!fs.existsSync(file)) return null;
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err: any) {
    // A read error here (e.g. EACCES) is NOT the benign corrupt-file case — the
    // device cookie silently won't restore, so surface it rather than swallow.
    console.warn(`[browse] auto-cookie state unreadable (${err?.code || err?.message}); starting without persisted cookies`);
    return null;
  }
  let parsed: AutoCookieState;
  try {
    parsed = JSON.parse(raw) as AutoCookieState;
  } catch {
    return null; // corrupt JSON — ignore (a later save overwrites it)
  }
  if (!parsed || parsed.kind !== STATE_KIND || parsed.version !== STATE_VERSION) return null;
  if (parsed.workspaceId !== computeProfileId(config)) return null;
  const cookies = parsed.storageState?.cookies;
  if (!Array.isArray(cookies)) return null;
  // Re-filter on load: a cookie may have expired while the daemon was down,
  // and the allowlist may have tightened since the last save.
  const usable = filterPersistableCookies(cookies, parseDomainAllowlist(), now);
  return { cookies: usable, origins: [] };
}

/**
 * Snapshot the live context's cookies and persist the persistable subset.
 * No-ops when disabled, when there's no context, or when the filtered set is
 * unchanged since the last write (hash compare). Returns a small status for
 * logging/tests. Best-effort: never throws into the caller (checkpoints run on
 * hot paths and during shutdown).
 *
 * `lastHash` lets the caller skip redundant writes; pass the value returned by
 * the previous call. An empty filtered set is still written once (to clear a
 * prior file) so a logout is not resurrected on next load.
 */
export async function saveAutoCookieState(
  config: BrowseConfig,
  context: BrowserContext | null,
  lastHash: string | null,
): Promise<{ wrote: boolean; hash: string | null; count: number }> {
  try {
    if (!isAutoCookiePersistEnabled() || !context) {
      return { wrote: false, hash: lastHash, count: 0 };
    }
    const all = await context.cookies();
    const persistable = filterPersistableCookies(all, parseDomainAllowlist());
    const hash = cookieSetHash(persistable);
    if (hash === lastHash) {
      return { wrote: false, hash, count: persistable.length };
    }
    const state: AutoCookieState = {
      version: STATE_VERSION,
      kind: STATE_KIND,
      workspaceId: computeProfileId(config),
      savedAt: new Date().toISOString(),
      storageState: { cookies: persistable, origins: [] },
    };
    mkdirSecure(autoDir(config));
    writeSecureFileAtomic(statePath(config), JSON.stringify(state));
    return { wrote: true, hash, count: persistable.length };
  } catch {
    // Persistence is a convenience layer — a failure here must never break a
    // command or block shutdown.
    return { wrote: false, hash: lastHash, count: 0 };
  }
}

/** One-time plaintext warning when the feature is enabled. */
export function warnPlaintextOnce(config: BrowseConfig): void {
  if (warnedOnce || !isAutoCookiePersistEnabled()) return;
  warnedOnce = true;
  console.warn(
    `[browse] BROWSE_AUTO_COOKIE_PERSIST is ON — persistent cookies are written ` +
    `in PLAINTEXT to ${autoDir(config)} (owner-only file perms only). ` +
    `These are auth credentials; anyone who can read the file can impersonate ` +
    `the logged-in sessions. Disable by unsetting the env var.`
  );
}

/** Opportunistic cleanup of leftover temp files from a crashed atomic write. */
export function cleanStaleTempFiles(config: BrowseConfig): void {
  const dir = autoDir(config);
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.') && name.endsWith('.tmp')) {
        safeUnlinkQuiet(path.join(dir, name));
      }
    }
  } catch {
    // Dir may not exist yet — nothing to clean.
  }
}

/** Test-only: reset the once-per-process warning gate. */
export function __resetWarnedForTests(): void {
  warnedOnce = false;
}
