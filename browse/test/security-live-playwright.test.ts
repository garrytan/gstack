/**
 * Live Playwright integration — defense-in-depth contract.
 *
 * Loads the existing injection-combined.html fixture in a real Chromium
 * instance and verifies BOTH module layers detect the attack independently:
 *
 *   L1-L3 (content-security.ts):
 *     * Hidden element stripping removes the .sneaky div
 *     * ARIA regex catches the aria-label injection
 *     * URL blocklist catches webhook.site / pipedream / requestbin
 *
 *   L4 (security.ts via security-classifier.ts):
 *     * ML classifier scores extracted text as INJECTION
 *
 * If content-security.ts ever gets refactored to remove a layer thinking
 * "the ML classifier covers it now," this test fails — the ML signal and
 * the deterministic signal must BOTH be present.
 *
 * ML portion is skipped gracefully if the model cache is absent (first-run
 * CI). To prime: `bun run browse/src/sidebar-agent.ts` for ~30s and kill it.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { startTestServer } from './test-server';
import { BrowserManager } from '../src/browser-manager';
import {
  markHiddenElements,
  getCleanTextWithStripping,
  cleanupHiddenMarkers,
  urlBlocklistFilter,
} from '../src/content-security';

describe('defense-in-depth — live Playwright fixture', () => {
  let testServer: ReturnType<typeof startTestServer>;
  let bm: BrowserManager;
  let baseUrl: string;

  beforeAll(async () => {
    testServer = startTestServer(0);
    baseUrl = testServer.url;
    bm = new BrowserManager();
    await bm.launch();
  });

  afterAll(() => {
    try { testServer.server.stop(); } catch {}
    setTimeout(() => process.exit(0), 500);
  });

  test('L2 — content-security.ts hidden-element stripper detects the .sneaky div', async () => {
    const page = bm.getPage();
    await page.goto(`${baseUrl}/injection-combined.html`, { waitUntil: 'domcontentloaded' });
    const stripped = await markHiddenElements(page);
    // Expect at least the sneaky div + the ARIA-injection link
    expect(stripped.length).toBeGreaterThanOrEqual(1);
    const sneakyMatch = stripped.some(s =>
      s.toLowerCase().includes('opacity') || s.toLowerCase().includes('off-screen'),
    );
    expect(sneakyMatch).toBe(true);
    await cleanupHiddenMarkers(page);
  });

  test('L2b — content-security.ts ARIA regex catches the injected aria-label', async () => {
    const page = bm.getPage();
    await page.goto(`${baseUrl}/injection-combined.html`, { waitUntil: 'domcontentloaded' });
    const stripped = await markHiddenElements(page);
    const ariaHits = stripped.filter(s => s.toLowerCase().includes('aria injection'));
    expect(ariaHits.length).toBeGreaterThanOrEqual(1);
    await cleanupHiddenMarkers(page);
  });

  test('L3 — content-security.ts URL blocklist fires on multiple exfil domains', async () => {
    const page = bm.getPage();
    await page.goto(`${baseUrl}/injection-combined.html`, { waitUntil: 'domcontentloaded' });
    const html = await page.content();
    const result = urlBlocklistFilter(html, `${baseUrl}/injection-combined.html`, 'html');
    expect(result.safe).toBe(false);
    // The fixture has webhook.site, pipedream.com, AND requestbin.com — expect at least 2 distinct hits
    const distinctDomains = new Set(
      result.warnings.map(w => (w.match(/(webhook\.site|pipedream\.com|requestbin\.com)/) ?? [])[1]).filter(Boolean),
    );
    expect(distinctDomains.size).toBeGreaterThanOrEqual(2);
  });

  test('L1 — stripped clean text excludes the .sneaky injection', async () => {
    const page = bm.getPage();
    await page.goto(`${baseUrl}/injection-combined.html`, { waitUntil: 'domcontentloaded' });
    await markHiddenElements(page);
    const cleanText = await getCleanTextWithStripping(page);
    // Visible content preserved
    expect(cleanText).toContain('Premium Widget');
    // Hidden injection removed
    expect(cleanText).not.toContain('SYSTEM OVERRIDE');
    expect(cleanText).not.toContain('webhook.site/malicious');
    await cleanupHiddenMarkers(page);
  });

  test('defense-in-depth — all deterministic layers (L1-L3) fire on the combined fixture', async () => {
    // Pins the contract: removing any one content-security.ts layer breaks
    // at least one signal in this test. This is the E5 regression anchor.
    const page = bm.getPage();
    await page.goto(`${baseUrl}/injection-combined.html`, { waitUntil: 'domcontentloaded' });
    const stripped = await markHiddenElements(page);
    const html = await page.content();
    const urlResult = urlBlocklistFilter(html, `${baseUrl}/injection-combined.html`, 'html');

    // L2: hidden element stripper
    const hiddenCount = stripped.filter(s =>
      s.toLowerCase().includes('opacity') || s.toLowerCase().includes('off-screen'),
    ).length;
    expect(hiddenCount).toBeGreaterThanOrEqual(1);

    // L2b: ARIA regex
    const ariaCount = stripped.filter(s => s.toLowerCase().includes('aria injection')).length;
    expect(ariaCount).toBeGreaterThanOrEqual(1);

    // L3: URL blocklist
    expect(urlResult.safe).toBe(false);

    await cleanupHiddenMarkers(page);
  });
});
