/**
 * CDP escape hatch — `$B cdp <Domain.method> [json-params]`.
 *
 * Path A from the spike: uses Playwright's newCDPSession() per page so we
 * piggyback Playwright's own CDP socket (no second WebSocket, no need for
 * --remote-debugging-port).
 *
 * Security posture (Codex T2):
 *   - DENY-DEFAULT. Methods must be explicitly listed in cdp-allowlist.ts.
 *   - Each entry is tagged scope (tab|browser) and output (trusted|untrusted).
 *
 * Concurrency posture (Codex T7):
 *   - Two-tier lock from browser-manager.ts.
 *   - tab-scoped methods take the per-tab mutex.
 *   - browser-scoped methods take the global lock that blocks all tab mutexes.
 *   - Hard 5s timeout on acquire → CDPMutexAcquireTimeout (no silent hangs).
 *   - Every lock-holder uses try { ... } finally { release() } so errors don't leak locks.
 */

import type { Page } from 'playwright';
import type { BrowserManager } from './browser-manager';
import { lookupCdpMethod, type CdpAllowEntry } from './cdp-allowlist';
import { logTelemetry } from './telemetry';

const CDP_TIMEOUT_MS = 5000;
const CDP_ACQUIRE_TIMEOUT_MS = 5000;

// ─── CDP session lifecycle helpers ─────────────────────────────
//
// Every direct `newCDPSession(page)` call needs a matching `session.detach()`
// to release the Chromium-side CDP target. Forgetting the detach leaves the
// target attached until the underlying transport drops (often process exit),
// which on a long-lived headed browser shows up as steadily-climbing
// browser-process RSS. To make the leak class unforgettable, callers should
// go through one of these two helpers and a static-grep test
// (browse/test/cdp-session-cleanup.test.ts) fails CI if any source file
// calls `newCDPSession(` outside this module.

/**
 * Ephemeral CDP session with try/finally detach. Use for one-shot CDP work
 * where the caller doesn't need session reuse — e.g. archive snapshots,
 * `$B memory`, a single `Page.captureScreenshot`. The session is detached
 * in `finally` regardless of whether `fn` threw, so the Chromium target
 * doesn't leak on the error path.
 *
 * For repeated use of the same page (e.g. the `$B cdp` bridge or the
 * inspector), use `getOrCreateCdpSession` instead — it caches and detaches
 * on page close.
 */
export async function withCdpSession<T>(
  page: Page,
  fn: (session: any) => Promise<T>,
): Promise<T> {
  const session = await page.context().newCDPSession(page);
  try {
    return await fn(session);
  } finally {
    try {
      await session.detach();
    } catch {
      // Best-effort cleanup. Session may already be detached (target closed,
      // context recreated, browser disconnect). Swallowing all errors is the
      // correct cleanup posture per CLAUDE.md "best-effort cleanup paths".
    }
  }
}

/**
 * Cached long-lived CDP session keyed by Page. First call creates the
 * session and registers a `page.once('close', ...)` hook that removes the
 * cache entry AND calls `session.detach()`. Pre-helper code only removed
 * the cache entry, leaving the Chromium-side target attached.
 *
 * Pass a caller-owned WeakMap so this helper doesn't impose a single global
 * cache — the `$B cdp` bridge and the inspector each keep their own session
 * pool with different invariants (e.g. the inspector also detaches on
 * `framenavigated` because DOM/CSS domain state is tied to the document).
 */
export async function getOrCreateCdpSession(
  page: Page,
  cache: WeakMap<Page, any>,
): Promise<any> {
  let session = cache.get(page);
  if (session) return session;
  session = await page.context().newCDPSession(page);
  cache.set(page, session);
  page.once('close', () => {
    cache.delete(page);
    session.detach().catch(() => {
      // Best-effort cleanup — see withCdpSession finally block.
    });
  });
  return session;
}

// ─── $B cdp bridge ─────────────────────────────────────────────

// Per-page CDPSession cache. Lifecycle delegated to getOrCreateCdpSession
// which registers a close hook that BOTH removes the cache entry AND calls
// session.detach() — pre-helper code only did the former, leaving the
// Chromium-side target attached.
const sessionCache: WeakMap<Page, any> = new WeakMap();

async function getCdpSession(page: Page): Promise<any> {
  return getOrCreateCdpSession(page, sessionCache);
}

export interface CdpDispatchInput {
  domain: string;
  method: string;
  params: Record<string, unknown>;
  tabId: number;
  bm: BrowserManager;
}

export interface CdpDispatchResult {
  raw: unknown;
  entry: CdpAllowEntry;
}

/**
 * Look up + acquire mutex + send + release. Throws structured errors on:
 *  - DENIED (method not on allowlist)
 *  - CDPMutexAcquireTimeout (lock contention exceeded budget)
 *  - CDPBridgeTimeout (CDP method itself didn't return in budget)
 *  - CDPSessionInvalidated (Playwright recreated context, session stale)
 */
export async function dispatchCdpCall(input: CdpDispatchInput): Promise<CdpDispatchResult> {
  const qualified = `${input.domain}.${input.method}`;
  const entry = lookupCdpMethod(qualified);
  if (!entry) {
    // Surface the denial via telemetry — this is the data that drives the
    // next allow-list expansion (DX D9: cdp_method_denied counter).
    logTelemetry({ event: 'cdp_method_denied', domain: input.domain, method: input.method });
    throw new Error(
      `DENIED: ${qualified} is not on the CDP allowlist.\n` +
        `Cause: deny-default posture; method has not been audited and added to cdp-allowlist.ts.\n` +
        `Action: if this method is genuinely needed, open a PR adding it to CDP_ALLOWLIST with a one-line justification + scope (tab|browser) + output (trusted|untrusted).`
    );
  }
  // Acquire the right tier of lock.
  const acquireStart = Date.now();
  const release =
    entry.scope === 'browser'
      ? await input.bm.acquireGlobalCdpLock(CDP_ACQUIRE_TIMEOUT_MS)
      : await input.bm.acquireTabLock(input.tabId, CDP_ACQUIRE_TIMEOUT_MS);
  const acquireMs = Date.now() - acquireStart;
  logTelemetry({ event: 'cdp_method_lock_acquire_ms', domain: input.domain, method: input.method, ms: acquireMs });
  logTelemetry({ event: 'cdp_method_called', domain: input.domain, method: input.method, allowed: true, scope: entry.scope });

  try {
    const page = input.bm.getPageForTab(input.tabId);
    if (!page) {
      throw new Error(
        `Cannot dispatch: tab ${input.tabId} not found.\n` +
          'Cause: tab was closed between command queue and dispatch.\n' +
          'Action: $B tabs to list current tabs.'
      );
    }
    let session;
    try {
      session = await getCdpSession(page);
    } catch (e: any) {
      throw new Error(
        `CDPSessionInvalidated: ${e.message}\n` +
          'Cause: Playwright context was recreated (e.g., viewport scale change) and the prior CDP session is stale.\n' +
          'Action: retry the command; the bridge will create a fresh session.'
      );
    }
    // Race the call against a hard timeout.
    const callPromise = session.send(qualified, input.params);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`CDPBridgeTimeout: ${qualified} did not return within ${CDP_TIMEOUT_MS}ms`)), CDP_TIMEOUT_MS),
    );
    const raw = await Promise.race([callPromise, timeoutPromise]);
    return { raw, entry };
  } finally {
    release();
  }
}
