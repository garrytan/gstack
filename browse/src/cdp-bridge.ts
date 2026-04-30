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

// Per-page CDPSession cache. Created lazily on first allow-listed call,
// cleaned up when the page closes.
const sessionCache: WeakMap<Page, any> = new WeakMap();

async function getCdpSession(page: Page): Promise<any> {
  let s = sessionCache.get(page);
  if (s) return s;
  s = await page.context().newCDPSession(page);
  sessionCache.set(page, s);
  // Clear cache on detach so we don't hold a stale handle.
  page.once('close', () => sessionCache.delete(page));
  return s;
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
