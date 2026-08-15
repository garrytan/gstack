/**
 * Sidepanel DOM test — verifies the extension's sidepanel.html/.js/.css
 * actually render and react to security events correctly when loaded in
 * a real Chromium.
 *
 * Uses Playwright. The extension sidepanel is loaded via file:// with a
 * stubbed window.fetch/chrome.runtime. Since the chat path was ripped
 * (v1.63–v1.64.1), sidepanel.js deliberately leaves the security shield
 * hidden and undriven — these tests pin THAT contract (see the tombstone
 * inside the describe for the five banner/shield-driving tests this file
 * used to run, and why they can never pass anymore).
 *
 * Runs in ~2s. Gate tier. Skipped if Playwright isn't available.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { chromium, type Browser, type Page } from 'playwright';

const EXTENSION_DIR = path.resolve(import.meta.dir, '..', '..', 'extension');
const SIDEPANEL_URL = `file://${EXTENSION_DIR}/sidepanel.html`;

/**
 * Eager check — does Playwright have chromium installed on disk?
 * test.skipIf() is evaluated at file-registration time (before beforeAll),
 * so a runtime probe of `browser` state wouldn't work — all tests would
 * unconditionally get registered as `skip: true`. We need a sync check.
 */
const CHROMIUM_AVAILABLE = (() => {
  try {
    const exe = chromium.executablePath();
    return !!exe && fs.existsSync(exe);
  } catch {
    return false;
  }
})();

/**
 * Seed the sidepanel so it thinks it's connected + poll-ready before
 * sidepanel.js runs its connection flow. We stub chrome.runtime, chrome.tabs,
 * and window.fetch so the sidepanel code paths behave as if a real browse
 * server is responding.
 */
async function installStubsBeforeLoad(page: Page, scenario: {
  healthSecurity?: { status: 'protected' | 'degraded' | 'inactive'; layers?: any };
  securityEntries?: any[];
}): Promise<void> {
  await page.addInitScript((params: any) => {
    // Stub chrome.runtime for the background-service-worker connection flow.
    // sendMessage supports both callback and Promise style — sidepanel.js
    // uses both patterns depending on the call site.
    (window as any).chrome = {
      runtime: {
        sendMessage: (_req: any, cb: any) => {
          const payload = { connected: true, port: 34567 };
          if (typeof cb === 'function') {
            setTimeout(() => cb(payload), 0);
            return undefined;
          }
          return Promise.resolve(payload);
        },
        lastError: null,
        onMessage: { addListener: () => {} },
      },
      tabs: {
        query: (_q: any, cb: any) => setTimeout(() => cb([{ id: 1, url: 'https://example.com' }]), 0),
        onActivated: { addListener: () => {} },
        onUpdated: { addListener: () => {} },
      },
    };

    // Stub EventSource — connectSSE() throws without this because file://
    // can't actually open an SSE connection to http://127.0.0.1.
    (window as any).EventSource = class {
      constructor() {}
      addEventListener() {}
      close() {}
    };

    // Stub fetch.
    const scenarioRef = params;
    const origFetch = window.fetch;
    window.fetch = async function (input: any, init?: any) {
      const url = String(input);
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({
          status: 'healthy',
          token: 'test-token',
          mode: 'headed',
          agent: { status: 'idle', runningFor: null, queueLength: 0 },
          session: null,
          security: scenarioRef.healthSecurity ?? { status: 'degraded', layers: {}, lastUpdated: '' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/sidebar-chat')) {
        return new Response(JSON.stringify({
          entries: scenarioRef.securityEntries ?? [],
          total: (scenarioRef.securityEntries ?? []).length,
          agentStatus: 'idle',
          activeTabId: 1,
          security: scenarioRef.healthSecurity ?? { status: 'degraded', layers: {} },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/sidebar-tabs')) {
        return new Response(JSON.stringify({ tabs: [] }), { status: 200 });
      }
      if (url.includes('/sidebar-activity')) {
        return new Response('{}', { status: 200 });
      }
      // Fall through for anything else we didn't scenario.
      if (typeof origFetch === 'function') return origFetch(input, init);
      return new Response('{}', { status: 200 });
    } as any;
  }, scenario);
}

let browser: Browser | null = null;

beforeAll(async () => {
  if (!CHROMIUM_AVAILABLE) return;
  browser = await chromium.launch({ headless: true });
}, 30000);

afterAll(async () => {
  if (browser) {
    try { await browser.close(); } catch {}
  }
});

describe('sidepanel security DOM', () => {
  // ── Tombstone (2026-08-15) ────────────────────────────────────────────
  // Five tests here drove the shield + security banner through the chat
  // path's /sidebar-chat + /health.security stubs:
  //   * shield icon reflects /health.security.status
  //   * shield flips to degraded when classifier warmup is incomplete
  //   * security_event entry triggers banner render with domain + layer scores
  //   * expand button toggles aria-expanded + reveals details
  //   * Escape key dismisses an open banner / close button dismisses banner
  // The chat path was ripped in v1.63–v1.64.1 and sidepanel.js now leaves the
  // shield "hidden by default, not driven" (see the comment in tryConnect).
  // The old assertions could never pass again; worse, the first one waited
  // 15s for a data-status that never arrives, and bun's timeout handler then
  // SIGTERM'd the SHARED beforeAll browser (exit 143), cascading "browser has
  // been closed" into every later test. CI never saw any of this because the
  // whole file skips when Playwright chromium is not installed.
  // What remains pins the CURRENT contract; if the shield indicator is ever
  // re-driven off a new endpoint, resurrect the old cases from git history
  // (they are behaviorally right for a driven shield).
  test.skipIf(!CHROMIUM_AVAILABLE)('sidepanel loads under stubs; shield exists and stays hidden', async () => {
    const context = await browser!.newContext();
    const page = await context.newPage();
    await installStubsBeforeLoad(page, {
      healthSecurity: { status: 'protected', layers: { testsavant: 'ok', canary: 'ok' } },
    });
    await page.goto(SIDEPANEL_URL);
    await page.waitForSelector('#security-shield', { state: 'attached', timeout: 5000 });
    const display = await page.$eval('#security-shield', (el) => window.getComputedStyle(el).display);
    expect(display).toBe('none');
    await context.close();
  }, 15000);

  test.skipIf(!CHROMIUM_AVAILABLE)('shield stays undriven — no data-status even with a healthy /health stub', async () => {
    const context = await browser!.newContext();
    const page = await context.newPage();
    await installStubsBeforeLoad(page, {
      healthSecurity: { status: 'protected', layers: { testsavant: 'ok', canary: 'ok' } },
    });
    await page.goto(SIDEPANEL_URL);
    // Give the connection flow ample time to run; the shield must NOT flip —
    // sidepanel.js deliberately does not drive it since the chat path rip.
    await page.waitForTimeout(1500);
    const status = await page.$eval('#security-shield', (el) => el.getAttribute('data-status'));
    expect(status).toBeNull();
    const aria = await page.$eval('#security-shield', (el) => el.getAttribute('aria-label'));
    expect(aria).toBe('Security status: unknown');
    await context.close();
  }, 15000);
});
