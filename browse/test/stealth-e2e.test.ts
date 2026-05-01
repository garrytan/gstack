/**
 * stealth-e2e.test.ts — End-to-end stealth verification
 *
 * Launches a real Chromium instance with stealth patches applied,
 * navigates to a page, and verifies all fingerprint vectors are clean.
 *
 * Requires: Chromium binary (Playwright's bundled or system)
 * Slower than unit tests (~5-10s). Run with: bun test stealth-e2e
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { stealthArgs, applyStealthPatches } from '../src/stealth';

let browser: Browser;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({
    headless: true, // headless is fine for fingerprint checks
    args: [...stealthArgs, '--no-sandbox'],
  });
  context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  });
  await applyStealthPatches(context);
  page = await context.newPage();
  // Navigate to a blank page to initialize the browser context
  await page.goto('about:blank');
}, 30_000);

afterAll(async () => {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
});

describe('stealth e2e — fingerprint verification', () => {
  // ─── Webdriver ────────────────────────────────────────

  test('navigator.webdriver is undefined', async () => {
    const val = await page.evaluate(() => navigator.webdriver);
    expect(val).toBeUndefined();
  });

  test('"webdriver" is not in navigator (property existence check)', async () => {
    const exists = await page.evaluate(() => 'webdriver' in navigator);
    expect(exists).toBe(false);
  });

  // ─── WebGL ────────────────────────────────────────────

  test('WebGL vendor is spoofed (not SwiftShader)', async () => {
    const vendor = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl');
      if (!gl) return null;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (!ext) return null;
      return gl.getParameter(ext.UNMASKED_VENDOR_WEBGL);
    });
    expect(vendor).toBeTruthy();
    expect(vendor).toContain('Apple');
    expect(vendor).not.toContain('SwiftShader');
  });

  test('WebGL renderer is spoofed to an Apple chip', async () => {
    const renderer = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl');
      if (!gl) return null;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (!ext) return null;
      return gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    });
    expect(renderer).toBeTruthy();
    expect(renderer).toMatch(/Apple.*M[123]/);
    expect(renderer).not.toContain('SwiftShader');
    expect(renderer).not.toContain('llvmpipe');
  });

  test('WebGL2 renderer is also spoofed', async () => {
    const renderer = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2');
      if (!gl) return null;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (!ext) return null;
      return gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    });
    // WebGL2 might not be available in all environments
    if (renderer !== null) {
      expect(renderer).toMatch(/Apple.*M[123]/);
    }
  });

  // ─── Plugins ──────────────────────────────────────────

  test('navigator.plugins has 5 entries', async () => {
    const len = await page.evaluate(() => navigator.plugins.length);
    expect(len).toBe(5);
  });

  test('navigator.plugins passes instanceof PluginArray', async () => {
    const isPluginArray = await page.evaluate(() => navigator.plugins instanceof PluginArray);
    expect(isPluginArray).toBe(true);
  });

  test('navigator.plugins[0] is a Plugin with correct shape', async () => {
    const info = await page.evaluate(() => {
      const p = navigator.plugins[0];
      return {
        name: p?.name,
        filename: p?.filename,
        hasItem: typeof p?.item === 'function',
        hasNamedItem: typeof p?.namedItem === 'function',
      };
    });
    expect(info.name).toBe('Chrome PDF Plugin');
    expect(info.filename).toBe('internal-pdf-viewer');
    expect(info.hasItem).toBe(true);
    expect(info.hasNamedItem).toBe(true);
  });

  // ─── Chrome Object ────────────────────────────────────

  test('window.chrome exists and has app', async () => {
    const hasApp = await page.evaluate(() => !!(window as any).chrome?.app);
    expect(hasApp).toBe(true);
  });

  test('window.chrome.app has correct shape', async () => {
    const shape = await page.evaluate(() => {
      const app = (window as any).chrome?.app;
      return {
        hasInstallState: !!app?.InstallState,
        hasRunningState: !!app?.RunningState,
        getDetails: typeof app?.getDetails,
      };
    });
    expect(shape.hasInstallState).toBe(true);
    expect(shape.hasRunningState).toBe(true);
    expect(shape.getDetails).toBe('function');
  });

  test('window.chrome.runtime exists', async () => {
    const exists = await page.evaluate(() => !!(window as any).chrome?.runtime);
    expect(exists).toBe(true);
  });

  test('window.chrome.loadTimes returns object', async () => {
    const result = await page.evaluate(() => {
      const lt = (window as any).chrome?.loadTimes;
      return typeof lt === 'function' ? typeof lt() : 'not a function';
    });
    expect(result).toBe('object');
  });

  // ─── Languages ────────────────────────────────────────

  test('navigator.languages is [en-US, en]', async () => {
    const langs = await page.evaluate(() => [...navigator.languages]);
    expect(langs).toEqual(['en-US', 'en']);
  });

  // ─── Permissions ──────────────────────────────────────

  test('notification permission returns prompt', async () => {
    const state = await page.evaluate(async () => {
      const result = await navigator.permissions.query({ name: 'notifications' as any });
      return result.state;
    });
    expect(state).toBe('prompt');
  });

  // ─── CDP Artifacts ────────────────────────────────────

  test('no cdc_ properties on window', async () => {
    const cdcKeys = await page.evaluate(() =>
      Object.keys(window).filter(k => k.startsWith('cdc_') || k.startsWith('$cdc_'))
    );
    expect(cdcKeys).toEqual([]);
  });

  test('no __webdriver properties on document', async () => {
    const wdKeys = await page.evaluate(() =>
      Object.keys(document).filter(k => k.startsWith('__webdriver') || k.startsWith('__selenium'))
    );
    expect(wdKeys).toEqual([]);
  });

  // ─── Automation Frameworks ────────────────────────────

  test('no Playwright globals leaked', async () => {
    const leaked = await page.evaluate(() => ({
      __playwright: !!(window as any).__playwright,
      __pw_manual: !!(window as any).__pw_manual,
      _phantom: !!(window as any)._phantom,
      __nightmare: !!(window as any).__nightmare,
      _selenium: !!(window as any)._selenium,
    }));
    expect(leaked.__playwright).toBe(false);
    expect(leaked.__pw_manual).toBe(false);
    expect(leaked._phantom).toBe(false);
    expect(leaked.__nightmare).toBe(false);
    expect(leaked._selenium).toBe(false);
  });

  // ─── Platform Consistency ─────────────────────────────

  test('navigator.platform matches user agent (MacIntel)', async () => {
    const platform = await page.evaluate(() => navigator.platform);
    // Our UA says Mac, so platform should be MacIntel
    expect(platform).toBe('MacIntel');
  });

  // ─── Stealth survives navigation ──────────────────────

  test('patches survive page navigation', async () => {
    // Navigate to a data: URL (new document load)
    await page.goto('data:text/html,<h1>test</h1>');

    const checks = await page.evaluate(() => ({
      webdriverUndef: navigator.webdriver === undefined,
      webdriverNotIn: !('webdriver' in navigator),
      pluginsLength: navigator.plugins.length,
      hasChrome: !!(window as any).chrome?.app,
      langs: [...navigator.languages],
    }));

    expect(checks.webdriverUndef).toBe(true);
    expect(checks.webdriverNotIn).toBe(true);
    expect(checks.pluginsLength).toBe(5);
    expect(checks.hasChrome).toBe(true);
    expect(checks.langs).toEqual(['en-US', 'en']);
  });
}, 30_000);
