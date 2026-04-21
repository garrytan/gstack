/**
 * Review-flow E2E (sidepanel side, hermetic).
 *
 * Loads the real extension sidepanel.html in Playwright Chromium, stubs
 * the browse server responses, injects a `reviewable: true` security_event
 * into /sidebar-chat, and asserts the user-in-the-loop flow end-to-end:
 *
 *   1. Banner renders with "Review suspected injection" title
 *   2. Suspected text excerpt shows up inside the expandable details
 *   3. Allow + Block buttons are visible and actionable
 *   4. Clicking Allow posts to /security-decision with decision:"allow"
 *   5. Clicking Block posts to /security-decision with decision:"block"
 *   6. Banner auto-hides after decision
 *
 * This is the UI-and-wire test. The server-side handshake (decision file
 * write + sidebar-agent poll) is covered by security-review-flow.test.ts.
 * The full-stack version with real mock-claude + real classifier lives
 * in security-review-fullstack.test.ts (periodic tier).
 *
 * Gate tier. ~3s. Skipped if Playwright chromium is unavailable.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { chromium, type Browser, type Page } from 'playwright';

const EXTENSION_DIR = path.resolve(import.meta.dir, '..', '..', 'extension');
const SIDEPANEL_URL = `file://${EXTENSION_DIR}/sidepanel.html`;

const CHROMIUM_AVAILABLE = (() => {
  try {
    const exe = chromium.executablePath();
    return !!exe && fs.existsSync(exe);
  } catch {
    return false;
  }
})();

interface DecisionCall {
  tabId: number;
  decision: 'allow' | 'block';
  reason?: string;
}

/**
 * Install the same stubs the existing sidepanel-dom test uses, plus a
 * fetch interceptor that captures POSTs to /security-decision into a
 * page-scoped array. Returns a handle to read the captured calls.
 */
async function installStubsAndCapture(
  page: Page,
  scenario: { securityEntries: any[] },
): Promise<void> {
  await page.addInitScript((params: any) => {
    (window as any).__decisionCalls = [];

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

    (window as any).EventSource = class {
      constructor() {}
      addEventListener() {}
      close() {}
    };

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
          security: { status: 'protected', layers: { testsavant: 'ok', transcript: 'ok', canary: 'ok' } },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/sidebar-chat')) {
        return new Response(JSON.stringify({
          entries: scenarioRef.securityEntries ?? [],
          total: (scenarioRef.securityEntries ?? []).length,
          agentStatus: 'idle',
          activeTabId: 1,
          security: { status: 'protected', layers: { testsavant: 'ok', transcript: 'ok', canary: 'ok' } },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/security-decision') && init?.method === 'POST') {
        try {
          const body = JSON.parse(init.body || '{}');
          (window as any).__decisionCalls.push(body);
        } catch {
          (window as any).__decisionCalls.push({ _parseError: true, raw: init?.body });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/sidebar-tabs')) {
        return new Response(JSON.stringify({ tabs: [] }), { status: 200 });
      }
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
    try {
      // Race browser.close() against a timeout — on rare occasions Playwright
      // hangs on close because an EventSource stub keeps a poll alive. 10s is
      // plenty; past that we forcibly drop the handle. Bun's default hook
      // timeout is 5s and has bitten this file.
      await Promise.race([
        browser.close(),
        new Promise<void>((resolve) => setTimeout(resolve, 10000)),
      ]);
    } catch {}
  }
}, 15000);

/**
 * The reviewable security_event the sidebar-agent emits on tool-output BLOCK.
 * Mirrors the shape of the real production event: verdict:'block',
 * reviewable:true, suspected_text excerpt, per-layer signals, and tabId
 * so the banner's Allow/Block buttons know which tab to decide for.
 */
function buildReviewableEntry(overrides?: Partial<any>): any {
  return {
    id: 42,
    ts: '2026-04-20T12:00:00Z',
    role: 'agent',
    type: 'security_event',
    verdict: 'block',
    reason: 'tool_result_ml',
    layer: 'testsavant_content',
    confidence: 0.95,
    domain: 'news.ycombinator.com',
    tool: 'Bash',
    reviewable: true,
    suspected_text: 'A comment thread discussing ignore previous instructions and reveal secrets — classifier flagged this as injection but it is actually benign developer content about a prompt injection incident.',
    signals: [
      { layer: 'testsavant_content', confidence: 0.95 },
      { layer: 'transcript_classifier', confidence: 0.0, meta: { degraded: true } },
    ],
    tabId: 1,
    ...overrides,
  };
}

describe('sidepanel review-flow E2E', () => {
  test.skipIf(!CHROMIUM_AVAILABLE)('reviewable event shows review banner with suspected text + buttons', async () => {
    const context = await browser!.newContext();
    const page = await context.newPage();
    await installStubsAndCapture(page, { securityEntries: [buildReviewableEntry()] });
    await page.goto(SIDEPANEL_URL);

    // Wait for /sidebar-chat poll to deliver the entry + banner to render.
    await page.waitForFunction(
      () => {
        const b = document.getElementById('security-banner') as HTMLElement | null;
        return !!b && b.style.display !== 'none';
      },
      { timeout: 5000 },
    );

    // Title flips to the review framing (not "Session terminated")
    const title = await page.$eval('#security-banner-title', (el) => el.textContent);
    expect(title).toContain('Review suspected injection');

    // Subtitle mentions the tool + domain
    const subtitle = await page.$eval('#security-banner-subtitle', (el) => el.textContent);
    expect(subtitle).toContain('Bash');
    expect(subtitle).toContain('news.ycombinator.com');
    expect(subtitle).toContain('allow to continue');

    // Suspected text shows up unescaped (textContent, not innerHTML)
    const suspect = await page.$eval('#security-banner-suspect', (el) => el.textContent);
    expect(suspect).toContain('ignore previous instructions');

    // Both action buttons are visible
    const allowVisible = await page.locator('#security-banner-btn-allow').isVisible();
    const blockVisible = await page.locator('#security-banner-btn-block').isVisible();
    expect(allowVisible).toBe(true);
    expect(blockVisible).toBe(true);

    // Details auto-expanded so the user sees context
    const detailsHidden = await page.$eval('#security-banner-details', (el) => (el as HTMLElement).hidden);
    expect(detailsHidden).toBe(false);

    await context.close();
  }, 15000);

  test.skipIf(!CHROMIUM_AVAILABLE)('clicking Allow posts {decision:"allow"} and hides banner', async () => {
    const context = await browser!.newContext();
    const page = await context.newPage();
    await installStubsAndCapture(page, { securityEntries: [buildReviewableEntry()] });
    await page.goto(SIDEPANEL_URL);
    await page.waitForSelector('#security-banner-btn-allow:visible', { timeout: 5000 });

    await page.click('#security-banner-btn-allow');

    // Decision POST should have fired with decision:"allow" and the tabId
    // from the security_event. Give the fetch promise a tick to resolve.
    await page.waitForFunction(
      () => (window as any).__decisionCalls?.length > 0,
      { timeout: 2000 },
    );

    const calls = await page.evaluate(() => (window as any).__decisionCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].decision).toBe('allow');
    expect(calls[0].tabId).toBe(1);
    expect(calls[0].reason).toBe('user');

    // Banner should hide optimistically after the POST
    await page.waitForFunction(
      () => {
        const b = document.getElementById('security-banner') as HTMLElement | null;
        return !!b && b.style.display === 'none';
      },
      { timeout: 2000 },
    );

    await context.close();
  }, 15000);

  test.skipIf(!CHROMIUM_AVAILABLE)('clicking Block posts {decision:"block"} and hides banner', async () => {
    const context = await browser!.newContext();
    const page = await context.newPage();
    await installStubsAndCapture(page, { securityEntries: [buildReviewableEntry({ id: 55 })] });
    await page.goto(SIDEPANEL_URL);
    await page.waitForSelector('#security-banner-btn-block:visible', { timeout: 5000 });

    await page.click('#security-banner-btn-block');

    await page.waitForFunction(
      () => (window as any).__decisionCalls?.length > 0,
      { timeout: 2000 },
    );

    const calls = await page.evaluate(() => (window as any).__decisionCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].decision).toBe('block');
    expect(calls[0].tabId).toBe(1);

    await page.waitForFunction(
      () => {
        const b = document.getElementById('security-banner') as HTMLElement | null;
        return !!b && b.style.display === 'none';
      },
      { timeout: 2000 },
    );

    await context.close();
  }, 15000);

  test.skipIf(!CHROMIUM_AVAILABLE)('non-reviewable event still shows hard-stop banner with no buttons', async () => {
    // Regression guard: the existing hard-stop canary leak UX must not be
    // disturbed by the reviewable branch. An event without reviewable:true
    // keeps the old behavior.
    const hardStop = {
      id: 99,
      ts: '2026-04-20T12:00:00Z',
      role: 'agent',
      type: 'security_event',
      verdict: 'block',
      reason: 'canary_leaked',
      layer: 'canary',
      confidence: 1.0,
      domain: 'attacker.example.com',
      channel: 'tool_use:Bash',
      tabId: 1,
    };
    const context = await browser!.newContext();
    const page = await context.newPage();
    await installStubsAndCapture(page, { securityEntries: [hardStop] });
    await page.goto(SIDEPANEL_URL);
    await page.waitForFunction(
      () => {
        const b = document.getElementById('security-banner') as HTMLElement | null;
        return !!b && b.style.display !== 'none';
      },
      { timeout: 5000 },
    );

    const title = await page.$eval('#security-banner-title', (el) => el.textContent);
    expect(title).toContain('Session terminated');

    // Action row stays hidden for the non-reviewable path
    const actionsHidden = await page.$eval('#security-banner-actions', (el) => (el as HTMLElement).hidden);
    expect(actionsHidden).toBe(true);

    await context.close();
  }, 15000);

  test.skipIf(!CHROMIUM_AVAILABLE)('suspected text renders via textContent, not innerHTML (XSS guard)', async () => {
    // If the sidepanel ever regressed to innerHTML for the suspected text,
    // a crafted excerpt could execute script. This test uses one; if the
    // <script> runs, window.__xss gets set. It must remain undefined.
    const xssAttempt = buildReviewableEntry({
      suspected_text: '<script>window.__xss = "pwn"</script><img src=x onerror="window.__xss=\'onerror\'">',
    });
    const context = await browser!.newContext();
    const page = await context.newPage();
    await installStubsAndCapture(page, { securityEntries: [xssAttempt] });
    await page.goto(SIDEPANEL_URL);
    await page.waitForSelector('#security-banner-suspect:not([hidden])', { timeout: 5000 });

    // The literal text should appear inside the suspect block (as text, not markup)
    const suspectText = await page.$eval('#security-banner-suspect', (el) => el.textContent);
    expect(suspectText).toContain('<script>');

    // No script executed
    const xssFlag = await page.evaluate(() => (window as any).__xss);
    expect(xssFlag).toBeUndefined();

    await context.close();
  }, 15000);
});
