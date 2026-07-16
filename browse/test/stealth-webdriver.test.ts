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

  test('window.chrome.* ships the rich Layer C shape at runtime', async () => {
    const page = await context.newPage();
    try {
      const shape = await page.evaluate(() => {
        const c = (window as any).chrome;
        return {
          hasRuntime: !!c?.runtime,
          hasPlatformArch: !!c?.runtime?.PlatformArch,
          hasOnInstalled: !!c?.runtime?.OnInstalledReason,
          csiIsFn: typeof c?.csi === 'function',
          loadTimesIsFn: typeof c?.loadTimes === 'function',
          appIsObj: typeof c?.app === 'object',
        };
      });
      expect(shape.hasRuntime).toBe(true);
      expect(shape.hasPlatformArch).toBe(true);
      expect(shape.hasOnInstalled).toBe(true);
      expect(shape.csiIsFn).toBe(true);
      expect(shape.loadTimesIsFn).toBe(true);
      expect(shape.appIsObj).toBe(true);
    } finally {
      await page.close();
    }
  });

  test('Notification.permission is default AND Permissions API returns prompt for notifications', async () => {
    // The cdc/Permissions shim now lives in applyStealth, so this pairing
    // holds on the plain newContext path too — previously it was headed-only,
    // which left Notification.permission=default mismatched against the native
    // Permissions answer in headless. Regression guard for that gap.
    const page = await context.newPage();
    try {
      const result = await page.evaluate(async () => {
        const perm = typeof Notification !== 'undefined' ? Notification.permission : 'unavailable';
        let queryState = 'unavailable';
        try {
          const status = await navigator.permissions.query({ name: 'notifications' } as any);
          queryState = status.state;
        } catch {}
        return { perm, queryState };
      });
      expect(result.perm).toBe('default');
      expect(result.queryState).toBe('prompt');
    } finally {
      await page.close();
    }
  });

  test('patched getters report [native code] via the toString proxy', async () => {
    const page = await context.newPage();
    try {
      const getterSrc = await page.evaluate(() => {
        const wd = Object.getOwnPropertyDescriptor(navigator, 'webdriver');
        return wd && wd.get ? wd.get.toString() : '';
      });
      // Layer C wraps every patched getter through markNative, so the
      // Function.prototype.toString Proxy reports native code instead of the
      // injected source — defeats the toString integrity check.
      expect(getterSrc).toContain('[native code]');
    } finally {
      await page.close();
    }
  });

  test('toString proxy survives the depth-3 recursion trick', async () => {
    // The headline claim: defeats fn.toString.toString.toString().includes(
    // '[native code]'). Depth-1 is covered above; this walks the full chain a
    // detector uses so a regression that only masks one level is caught.
    const page = await context.newPage();
    try {
      const depth3 = await page.evaluate(() => {
        const wd = Object.getOwnPropertyDescriptor(navigator, 'webdriver');
        const get = wd && wd.get;
        return get ? (get as any).toString.toString.toString().includes('[native code]') : false;
      });
      expect(depth3).toBe(true);
    } finally {
      await page.close();
    }
  });

  test('chrome.csi() and chrome.loadTimes() execute, runtime.connect() throws native-shaped', async () => {
    // Presence (typeof === 'function') is not enough — a real detector calls
    // them. loadTimes() dereferences performance.timing; connect() must throw
    // the native "No matching signature" TypeError.
    const page = await context.newPage();
    try {
      const r = await page.evaluate(() => {
        const c = (window as any).chrome;
        let connectErr = '';
        try { c.runtime.connect(); } catch (e) { connectErr = String(e); }
        return {
          csiOk: typeof c.csi().onloadT === 'number',
          loadTimesOk: typeof c.loadTimes().wasFetchedViaSpdy === 'boolean',
          connectErr,
        };
      });
      expect(r.csiOk).toBe(true);
      expect(r.loadTimesOk).toBe(true);
      expect(r.connectErr).toContain('No matching signature');
    } finally {
      await page.close();
    }
  });
});

describe('applyStealth — per-install hardware from env', () => {
  let ctx: BrowserContext;
  let savedHw: string | undefined;
  let savedMem: string | undefined;

  beforeAll(async () => {
    savedHw = process.env.GSTACK_HW_CONCURRENCY;
    savedMem = process.env.GSTACK_DEVICE_MEMORY;
    process.env.GSTACK_HW_CONCURRENCY = '12';
    process.env.GSTACK_DEVICE_MEMORY = '4';
    ctx = await browser.newContext();
    await applyStealth(ctx); // readHostProfile() reads env at call time
  });

  afterAll(async () => {
    await ctx.close();
    if (savedHw === undefined) delete process.env.GSTACK_HW_CONCURRENCY;
    else process.env.GSTACK_HW_CONCURRENCY = savedHw;
    if (savedMem === undefined) delete process.env.GSTACK_DEVICE_MEMORY;
    else process.env.GSTACK_DEVICE_MEMORY = savedMem;
  });

  test('navigator.hardwareConcurrency and deviceMemory reflect the env profile', async () => {
    const page = await ctx.newPage();
    try {
      const hw = await page.evaluate(() => ({
        cores: navigator.hardwareConcurrency,
        mem: (navigator as any).deviceMemory,
      }));
      expect(hw.cores).toBe(12);
      expect(hw.mem).toBe(4);
    } finally {
      await page.close();
    }
  });
});

describe('applyStealth — extended mode layered on Layer C (GSTACK_STEALTH=extended)', () => {
  let ctx: BrowserContext;
  let savedStealth: string | undefined;

  beforeAll(async () => {
    savedStealth = process.env.GSTACK_STEALTH;
    process.env.GSTACK_STEALTH = 'extended';
    ctx = await browser.newContext();
    await applyStealth(ctx);
  });

  afterAll(async () => {
    await ctx.close();
    if (savedStealth === undefined) delete process.env.GSTACK_STEALTH;
    else process.env.GSTACK_STEALTH = savedStealth;
  });

  test('extended actually runs: navigator.plugins is the faked PluginArray', async () => {
    const page = await ctx.newPage();
    try {
      const names = await page.evaluate(() => Array.from(navigator.plugins).map((p) => p.name));
      expect(names).toContain('PDF Viewer');
    } finally {
      await page.close();
    }
  });

  test('blend: Layer C wins window.chrome.runtime (rich shape, not extended skeletal)', async () => {
    // extended's chrome.runtime is {OnInstalledReason, OnRestartRequiredReason}
    // and is if(!)-guarded, so Layer C (applied first, with PlatformArch) must
    // win. This pins the coexistence ordering the blend depends on.
    const page = await ctx.newPage();
    try {
      const hasRich = await page.evaluate(() => !!(window as any).chrome?.runtime?.PlatformArch);
      expect(hasRich).toBe(true);
    } finally {
      await page.close();
    }
  });

  test('blend: navigator.webdriver stays false (Layer C own-prop survives extended prototype delete)', async () => {
    const page = await ctx.newPage();
    try {
      const wd = await page.evaluate(() => (navigator as any).webdriver);
      expect(wd).toBe(false);
    } finally {
      await page.close();
    }
  });
});

describe('applyStealth — persistent context (headed + handoff parity)', () => {
  test('full Layer C applies to launchPersistentContext (the launchHeaded/handoff path)', async () => {
    // Simulate the launchHeaded/handoff path: launchPersistentContext +
    // applyStealth. Verifies the persistent-context path gets the SAME Layer C
    // as newContext, not just the webdriver mask.
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
      // Use a page created AFTER applyStealth. launchPersistentContext opens an
      // initial page at launch time, before addInitScript is registered, so
      // init scripts never run on pages()[0] (its webdriver is only false
      // because of the --disable-blink-features launch arg, not Layer C).
      const page = await ctx.newPage();
      const probe = await page.evaluate(() => ({
        webdriver: (navigator as any).webdriver,
        hasChromeRuntime: !!(window as any).chrome?.runtime?.PlatformArch,
      }));
      expect(probe.webdriver).toBe(false);
      expect(probe.hasChromeRuntime).toBe(true);
    } finally {
      await ctx.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
