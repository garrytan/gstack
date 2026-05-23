import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { applyStealth, WEBDRIVER_MASK_SCRIPT, STEALTH_LAUNCH_ARGS } from '../src/stealth';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: STEALTH_LAUNCH_ARGS });
});

afterAll(async () => {
  await browser.close();
});

describe('STEALTH_LAUNCH_ARGS', () => {
  test('includes --disable-blink-features=AutomationControlled', () => {
    expect(STEALTH_LAUNCH_ARGS).toContain('--disable-blink-features=AutomationControlled');
  });
});

describe('WEBDRIVER_MASK_SCRIPT', () => {
  test('contains a single Object.defineProperty for navigator.webdriver', () => {
    expect(WEBDRIVER_MASK_SCRIPT).toContain('navigator');
    expect(WEBDRIVER_MASK_SCRIPT).toContain('webdriver');
    expect(WEBDRIVER_MASK_SCRIPT).toContain('false');
  });

  test('does NOT touch plugins, languages, or window.chrome (D7 narrowing)', () => {
    expect(WEBDRIVER_MASK_SCRIPT).not.toMatch(/plugins/i);
    expect(WEBDRIVER_MASK_SCRIPT).not.toMatch(/languages/i);
    expect(WEBDRIVER_MASK_SCRIPT).not.toMatch(/window\.chrome/);
  });
});

describe('applyStealth — context level', () => {
  let context: BrowserContext;

  beforeAll(async () => {
    context = await browser.newContext();
    await applyStealth(context);
  });

  afterAll(async () => {
    await context.close();
  });

  test('navigator.webdriver returns false on a fresh page', async () => {
    const page = await context.newPage();
    try {
      const webdriver = await page.evaluate(() => (navigator as any).webdriver);
      expect(webdriver).toBe(false);
    } finally {
      await page.close();
    }
  });

  test('webdriver is false for every new page in the same context (init script applies to all pages)', async () => {
    const p1 = await context.newPage();
    const p2 = await context.newPage();
    try {
      const w1 = await p1.evaluate(() => (navigator as any).webdriver);
      const w2 = await p2.evaluate(() => (navigator as any).webdriver);
      expect(w1).toBe(false);
      expect(w2).toBe(false);
    } finally {
      await p1.close();
      await p2.close();
    }
  });

  test('navigator.plugins is NOT a hardcoded fixed list (D7: let Chromium emit native)', async () => {
    const page = await context.newPage();
    try {
      const plugins = await page.evaluate(() => Array.from(navigator.plugins).map((p) => p.name));
      // We do not assert exact contents — Chromium versions vary. We assert
      // that we did NOT replace plugins with the wintermute fake list.
      // The wintermute approach was: get: () => [1, 2, 3, 4, 5]
      const isFake = plugins.length === 5
        && plugins.every((name) => /^[12345]$/.test(String(name)));
      expect(isFake).toBe(false);
    } finally {
      await page.close();
    }
  });

  test('navigator.languages is NOT hardcoded by us (D7)', async () => {
    const page = await context.newPage();
    try {
      const langs = await page.evaluate(() => navigator.languages);
      // Whatever Chromium emits is fine; we just assert we are not the
      // ones forcing it to ['en-US', 'en'] (wintermute pattern).
      // Cannot assert this strictly because Chromium often DOES emit those
      // values naturally. Instead, assert that languages is an array of
      // strings — i.e. the property still works (we didn't break it).
      expect(Array.isArray(langs)).toBe(true);
      expect(langs.every((l) => typeof l === 'string')).toBe(true);
    } finally {
      await page.close();
    }
  });
});

describe('applyStealth — persistent context (headed-mode parity)', () => {
  test('webdriver mask applies to launchPersistentContext too (D7)', async () => {
    // Simulate the launchHeaded path: launchPersistentContext + applyStealth
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-stealth-'));

    const ctx = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      args: STEALTH_LAUNCH_ARGS,
    });
    try {
      await applyStealth(ctx);
      const page = ctx.pages()[0] ?? await ctx.newPage();
      const webdriver = await page.evaluate(() => (navigator as any).webdriver);
      expect(webdriver).toBe(false);
    } finally {
      await ctx.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
