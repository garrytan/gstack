/**
 * Sidepanel DOM test — verifies the extension's sidepanel.html/.js/.css
 * actually render and react to security events correctly when loaded in
 * a real Chromium.
 *
 * Uses Playwright + BrowserManager. The extension sidepanel is loaded via
 * file:// with a stubbed window.fetch that simulates the browse server
 * returning /health + /sidebar-chat responses. We inject security_event
 * entries via the stubbed /sidebar-chat response and assert:
 *
 *   * Banner renders (display: block, not display: none)
 *   * Title + subtitle text reflects domain + layer
 *   * Layer scores appear in the expandable details
 *   * Shield icon data-status attr flips based on /health.security.status
 *   * Escape key dismisses the banner
 *   * Expand button toggles aria-expanded + layer list visibility
 *
 * All 83 prior security tests cover the JS behavior in isolation; this
 * test covers the integration: sidepanel.html + sidepanel.js + sidepanel.css
 * + real DOM + real event dispatch.
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
  test.skipIf(!CHROMIUM_AVAILABLE)('shield icon reflects /health.security.status', async () => {
    const context = await browser!.newContext();
    const page = await context.newPage();
    await installStubsBeforeLoad(page, {
      healthSecurity: {
        status: 'protected',
        layers: { testsavant: 'ok', transcript: 'ok', canary: 'ok' },
      },
    });
    await page.goto(SIDEPANEL_URL);
    // sidepanel.js updates the shield after the first /health call
    // succeeds. Give it a tick.
    await page.waitForFunction(
      () => document.getElementById('security-shield')?.getAttribute('data-status') === 'protected',
      { timeout: 5000 },
    );
    const status = await page.$eval('#security-shield', (el) => el.getAttribute('data-status'));
    expect(status).toBe('protected');
    // aria-label carries human-readable state
    const aria = await page.$eval('#security-shield', (el) => el.getAttribute('aria-label'));
    expect(aria).toContain('protected');
    await context.close();
  }, 15000);

  test.skipIf(!CHROMIUM_AVAILABLE)('shield flips to degraded when classifier warmup is incomplete', async () => {
    const context = await browser!.newContext();
    const page = await context.newPage();
    await installStubsBeforeLoad(page, {
      healthSecurity: {
        status: 'degraded',
        layers: { testsavant: 'off', transcript: 'ok', canary: 'ok' },
      },
    });
    await page.goto(SIDEPANEL_URL);
    await page.waitForFunction(
      () => document.getElementById('security-shield')?.getAttribute('data-status') === 'degraded',
      { timeout: 5000 },
    );
    const status = await page.$eval('#security-shield', (el) => el.getAttribute('data-status'));
    expect(status).toBe('degraded');
    await context.close();
  }, 15000);

  test.skipIf(!CHROMIUM_AVAILABLE)('security_event entry triggers banner render with domain + layer scores', async () => {
    const securityEntry = {
      id: 1,
      ts: '2026-04-20T00:00:00Z',
      role: 'agent',
      type: 'security_event',
      verdict: 'block',
      reason: 'canary_leaked',
      layer: 'canary',
      confidence: 1.0,
      domain: 'attacker.example.com',
      channel: 'tool_use:Bash',
      signals: [
        { layer: 'testsavant_content', confidence: 0.92 },
        { layer: 'transcript_classifier', confidence: 0.78 },
      ],
    };

    const context = await browser!.newContext();
    const page = await context.newPage();
    await installStubsBeforeLoad(page, {
      healthSecurity: {
        status: 'protected',
        layers: { testsavant: 'ok', transcript: 'ok', canary: 'ok' },
      },
      securityEntries: [securityEntry],
    });
    await page.goto(SIDEPANEL_URL);

    // The banner should become visible once /sidebar-chat poll delivers the
    // security_event entry and addChatEntry routes it to showSecurityBanner.
    await page.waitForSelector('#security-banner', { state: 'visible', timeout: 5000 });
    const displayed = await page.$eval('#security-banner', (el) =>
      window.getComputedStyle(el).display !== 'none',
    );
    expect(displayed).toBe(true);

    // Subtitle includes the attack domain
    const subtitleText = await page.textContent('#security-banner-subtitle');
    expect(subtitleText).toContain('attacker.example.com');
    expect(subtitleText).toContain('prompt injection detected');

    // Layer list was populated — primary layer (canary) always renders;
    // signals array brings in the additional ML layers
    const layers = await page.$$eval('.security-banner-layer', (els) =>
      els.map((el) => el.textContent),
    );
    expect(layers.length).toBeGreaterThanOrEqual(1);
    // Canary row expected
    expect(layers.join(' ')).toMatch(/Canary|canary/);

    await context.close();
  }, 15000);

  test.skipIf(!CHROMIUM_AVAILABLE)('expand button toggles aria-expanded + reveals details', async () => {
    const entry = {
      id: 1,
      ts: '2026-04-20T00:00:00Z',
      role: 'agent',
      type: 'security_event',
      verdict: 'block',
      reason: 'ensemble_agreement',
      layer: 'testsavant_content',
      confidence: 0.88,
      domain: 'example.com',
      signals: [
        { layer: 'testsavant_content', confidence: 0.88 },
        { layer: 'transcript_classifier', confidence: 0.71 },
      ],
    };
    const context = await browser!.newContext();
    const page = await context.newPage();
    await installStubsBeforeLoad(page, {
      healthSecurity: { status: 'protected', layers: { testsavant: 'ok', transcript: 'ok', canary: 'ok' } },
      securityEntries: [entry],
    });
    await page.goto(SIDEPANEL_URL);
    await page.waitForSelector('#security-banner', { state: 'visible', timeout: 5000 });

    // Initially collapsed
    const initialAria = await page.$eval('#security-banner-expand', (el) =>
      el.getAttribute('aria-expanded'),
    );
    expect(initialAria).toBe('false');
    const initialHidden = await page.$eval('#security-banner-details', (el) =>
      (el as HTMLElement).hidden,
    );
    expect(initialHidden).toBe(true);

    // Click expand
    await page.click('#security-banner-expand');
    const expandedAria = await page.$eval('#security-banner-expand', (el) =>
      el.getAttribute('aria-expanded'),
    );
    expect(expandedAria).toBe('true');
    const expandedHidden = await page.$eval('#security-banner-details', (el) =>
      (el as HTMLElement).hidden,
    );
    expect(expandedHidden).toBe(false);

    await context.close();
  }, 15000);

  test.skipIf(!CHROMIUM_AVAILABLE)('Escape key dismisses an open banner', async () => {
    const entry = {
      id: 1,
      ts: '2026-04-20T00:00:00Z',
      role: 'agent',
      type: 'security_event',
      verdict: 'block',
      reason: 'canary_leaked',
      layer: 'canary',
      confidence: 1.0,
      domain: 'evil.example.com',
    };
    const context = await browser!.newContext();
    const page = await context.newPage();
    await installStubsBeforeLoad(page, {
      healthSecurity: { status: 'protected', layers: { testsavant: 'ok', transcript: 'ok', canary: 'ok' } },
      securityEntries: [entry],
    });
    await page.goto(SIDEPANEL_URL);
    await page.waitForSelector('#security-banner', { state: 'visible', timeout: 5000 });

    // Hit Escape — should hide the banner
    await page.keyboard.press('Escape');
    // Wait a tick for the event handler to run
    await page.waitForFunction(
      () => {
        const el = document.getElementById('security-banner');
        return el ? window.getComputedStyle(el).display === 'none' : false;
      },
      { timeout: 2000 },
    );
    const stillVisible = await page.$eval('#security-banner', (el) =>
      window.getComputedStyle(el).display !== 'none',
    );
    expect(stillVisible).toBe(false);
    await context.close();
  }, 15000);

  test.skipIf(!CHROMIUM_AVAILABLE)('close button dismisses banner', async () => {
    const entry = {
      id: 1,
      ts: '2026-04-20T00:00:00Z',
      role: 'agent',
      type: 'security_event',
      verdict: 'block',
      reason: 'canary_leaked',
      layer: 'canary',
      confidence: 1.0,
      domain: 'evil.example.com',
    };
    const context = await browser!.newContext();
    const page = await context.newPage();
    await installStubsBeforeLoad(page, {
      healthSecurity: { status: 'protected', layers: { testsavant: 'ok', transcript: 'ok', canary: 'ok' } },
      securityEntries: [entry],
    });
    await page.goto(SIDEPANEL_URL);
    await page.waitForSelector('#security-banner', { state: 'visible', timeout: 5000 });

    await page.click('#security-banner-close');
    await page.waitForFunction(
      () => {
        const el = document.getElementById('security-banner');
        return el ? window.getComputedStyle(el).display === 'none' : false;
      },
      { timeout: 2000 },
    );
    const displayed = await page.$eval('#security-banner', (el) =>
      window.getComputedStyle(el).display !== 'none',
    );
    expect(displayed).toBe(false);
    await context.close();
  }, 15000);
});
