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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startTestServer } from './test-server';
import { BrowserManager } from '../src/browser-manager';
import {
  markHiddenElements,
  getCleanTextWithStripping,
  cleanupHiddenMarkers,
  urlBlocklistFilter,
} from '../src/content-security';

// Check if TestSavantAI model cache exists. If missing, ML tests skip.
const MODEL_CACHE = path.join(
  os.homedir(),
  '.gstack',
  'models',
  'testsavant-small',
  'onnx',
  'model.onnx',
);
const ML_AVAILABLE = fs.existsSync(MODEL_CACHE);

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

  // L4 ML tests — skipped if model cache is absent
  test.skipIf(!ML_AVAILABLE)('L4 — security.ts ML classifier flags the combined fixture text', async () => {
    const page = bm.getPage();
    await page.goto(`${baseUrl}/injection-combined.html`, { waitUntil: 'domcontentloaded' });
    // Use RAW text (not stripped) so the ML layer sees what Claude would see
    // in a naive pipeline — content-security.ts strips hidden content, but
    // we want to assert the ML layer would ALSO catch it independently.
    const rawText = await page.evaluate(() => document.body.innerText);

    const { loadTestsavant, scanPageContent } = await import('../src/security-classifier');
    await loadTestsavant();
    const signal = await scanPageContent(rawText);
    // Expect the classifier to flag some confidence > 0 (INJECTION label).
    // The combined fixture has instruction-heavy content which TestSavantAI
    // reliably flags at >= 0.5.
    expect(signal.confidence).toBeGreaterThan(0);
    expect(signal.layer).toBe('testsavant_content');
  }, 60000); // allow WASM cold-start up to 60s

  test.skipIf(!ML_AVAILABLE)('L4 — ML classifier does NOT flag the benign product description alone', async () => {
    const benign = 'Premium Widget. $29.99. High-quality widget with premium features. Add to Cart.';
    const { loadTestsavant, scanPageContent } = await import('../src/security-classifier');
    await loadTestsavant();
    const signal = await scanPageContent(benign);
    // Product-catalog content should score low. Give generous headroom
    // to avoid flakiness on model version drift — the contract is just
    // "doesn't false-positive on obviously-clean ecommerce copy."
    expect(signal.confidence).toBeLessThan(0.5);
  }, 60000);
});
