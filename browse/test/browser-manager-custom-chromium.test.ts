import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chromium } from 'playwright';
import { BrowserManager, isCustomChromium } from '../src/browser-manager';
import { resetXProtectHealForTests } from '../src/xprotect-heal';

describe('browser-manager: isCustomChromium', () => {
  let origPath: string | undefined;
  let origKind: string | undefined;

  beforeEach(() => {
    origPath = process.env.GSTACK_CHROMIUM_PATH;
    origKind = process.env.GSTACK_CHROMIUM_KIND;
  });

  afterEach(() => {
    if (origPath === undefined) delete process.env.GSTACK_CHROMIUM_PATH;
    else process.env.GSTACK_CHROMIUM_PATH = origPath;
    if (origKind === undefined) delete process.env.GSTACK_CHROMIUM_KIND;
    else process.env.GSTACK_CHROMIUM_KIND = origKind;
  });

  test('GSTACK_CHROMIUM_KIND=custom-extension-baked → true (preferred explicit signal)', () => {
    delete process.env.GSTACK_CHROMIUM_PATH;
    process.env.GSTACK_CHROMIUM_KIND = 'custom-extension-baked';
    expect(isCustomChromium()).toBe(true);
  });

  test('GSTACK_CHROMIUM_KIND wins even when path is stock Chromium', () => {
    process.env.GSTACK_CHROMIUM_PATH = '/usr/bin/chromium';
    process.env.GSTACK_CHROMIUM_KIND = 'custom-extension-baked';
    expect(isCustomChromium()).toBe(true);
  });

  test('PascalCase GBrowser in path → true (fallback substring match)', () => {
    delete process.env.GSTACK_CHROMIUM_KIND;
    process.env.GSTACK_CHROMIUM_PATH = '/Applications/GBrowser.app/Contents/MacOS/GBrowser';
    expect(isCustomChromium()).toBe(true);
  });

  test('lowercase gbrowser in path → true (fallback substring match)', () => {
    delete process.env.GSTACK_CHROMIUM_KIND;
    process.env.GSTACK_CHROMIUM_PATH = '/Applications/gbrowser-dev.app/Contents/MacOS/GBrowser';
    expect(isCustomChromium()).toBe(true);
  });

  test('both env vars unset → false', () => {
    delete process.env.GSTACK_CHROMIUM_PATH;
    delete process.env.GSTACK_CHROMIUM_KIND;
    expect(isCustomChromium()).toBe(false);
  });

  test('stock chromium path → false', () => {
    delete process.env.GSTACK_CHROMIUM_KIND;
    process.env.GSTACK_CHROMIUM_PATH = '/usr/bin/chromium';
    expect(isCustomChromium()).toBe(false);
  });

  test('Playwright bundled chromium path → false', () => {
    delete process.env.GSTACK_CHROMIUM_KIND;
    process.env.GSTACK_CHROMIUM_PATH = '/Users/me/Library/Caches/ms-playwright/chromium-1234/chrome-mac/Chromium.app/Contents/MacOS/Chromium';
    expect(isCustomChromium()).toBe(false);
  });

  test('GSTACK_CHROMIUM_KIND with unrelated value falls through to path check', () => {
    process.env.GSTACK_CHROMIUM_KIND = 'something-else';
    process.env.GSTACK_CHROMIUM_PATH = '/usr/bin/chromium';
    expect(isCustomChromium()).toBe(false);
  });
});

// The launch itself is a spy, so these run without a browser window on any
// platform. A launch that rejects leaves handoff() on its headless browser.
describe('handoff: GSTACK_CHROMIUM_PATH', () => {
  const CUSTOM_PATH = '/opt/wrapper/Google Chrome';
  const EXTENSION_PATH = '/opt/gstack/extension';
  const STOP = 'launch spy stopped here';
  const ENV_KEYS = ['GSTACK_CHROMIUM_PATH', 'GSTACK_CHROMIUM_KIND', 'CHROMIUM_PROFILE'] as const;
  const originalEnv: Record<string, string | undefined> = {};
  let tmpDir: string;
  let launch: ReturnType<typeof spyOn>;
  let cacheExecutable: ReturnType<typeof spyOn>;

  /** A Playwright-cache layout whose revision no install root pins, so the XProtect heal can never reinstall it. */
  function cacheBundle(plistName: string): { revDir: string; exe: string } {
    const revDir = path.join(tmpDir, 'ms-playwright', 'chromium-999999');
    const app = path.join(revDir, 'chrome-mac', 'Google Chrome for Testing.app', 'Contents');
    fs.mkdirSync(path.join(app, 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(app, 'Info.plist'), `<plist><dict><string>${plistName}</string></dict></plist>`);
    const exe = path.join(app, 'MacOS', 'Google Chrome for Testing');
    fs.writeFileSync(exe, '#!/bin/sh\n', { mode: 0o755 });
    return { revDir, exe };
  }

  function promotableManager(): BrowserManager {
    const manager = new BrowserManager();
    Object.assign(manager as unknown as Record<string, unknown>, {
      browser: {},
      context: {},
      saveState: async () => ({ cookies: [], pages: [] }),
      ensureHeadedDisplay: async () => {},
      findExtensionPath: () => EXTENSION_PATH,
    });
    return manager;
  }

  const launchOptions = () => (launch.mock.calls[0] as [string, { executablePath?: string; args: string[] }])[1];

  beforeEach(() => {
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-custom-chromium-'));
    delete process.env.GSTACK_CHROMIUM_PATH;
    delete process.env.GSTACK_CHROMIUM_KIND;
    process.env.CHROMIUM_PROFILE = path.join(tmpDir, 'profile');
    resetXProtectHealForTests();
    launch = spyOn(chromium, 'launchPersistentContext').mockRejectedValue(new Error(STOP));
    cacheExecutable = spyOn(chromium, 'executablePath').mockReturnValue(cacheBundle('Google Chrome for Testing').exe);
  });

  afterEach(() => {
    launch.mockRestore();
    cacheExecutable.mockRestore();
    resetXProtectHealForTests();
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('launches the custom path and never probes the Playwright cache', async () => {
    process.env.GSTACK_CHROMIUM_PATH = CUSTOM_PATH;
    // A poisoned cache bundle must survive: the handoff is not launching it.
    const { revDir, exe } = cacheBundle('GStack Browser');
    cacheExecutable.mockReturnValue(exe);

    expect(await promotableManager().handoff('custom')).toContain(STOP);
    expect(launchOptions().executablePath).toBe(CUSTOM_PATH);
    expect(cacheExecutable).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(revDir, 'chrome-mac'))).toBe(true);
  });

  test('without a custom path it launches Playwright\'s bundle', async () => {
    expect(await promotableManager().handoff('bundled')).toContain(STOP);
    expect('executablePath' in launchOptions()).toBe(false);
    expect(cacheExecutable).toHaveBeenCalled();
  });

  test('without a custom path a poisoned cache bundle is still healed before launch', async () => {
    const { revDir, exe } = cacheBundle('GStack Browser');
    cacheExecutable.mockReturnValue(exe);

    const result = await promotableManager().handoff('poisoned');
    expect(result).toContain('Cannot open headed browser');
    expect(result).toContain('playwright install chromium');
    expect(launch).not.toHaveBeenCalled();
    expect(fs.existsSync(revDir)).toBe(false);
  });

  test.skipIf(process.platform !== 'darwin')('an XProtect-shaped kill of a custom path never heals the Playwright cache', async () => {
    process.env.GSTACK_CHROMIUM_PATH = CUSTOM_PATH;
    launch.mockRejectedValue(new Error('browserType.launchPersistentContext: Target page, context or browser has been closed\nBrowser logs:\n<launched> pid=9021\n[pid=9021] <process did exit: exitCode=null, signal=SIGKILL>'));

    expect(await promotableManager().handoff('killed')).toContain('Cannot open headed browser');
    expect(launch).toHaveBeenCalledTimes(1);
    // The heal resolves its target through chromium.executablePath().
    expect(cacheExecutable).not.toHaveBeenCalled();
  });

  test('loads the sidebar extension into a stock browser at a custom path', async () => {
    process.env.GSTACK_CHROMIUM_PATH = CUSTOM_PATH;
    await promotableManager().handoff('stock');
    expect(launchOptions().args).toContain(`--load-extension=${EXTENSION_PATH}`);
    expect(launchOptions().args).toContain(`--disable-extensions-except=${EXTENSION_PATH}`);
  });

  test('never loads the extension twice into a build that bakes it in', async () => {
    process.env.GSTACK_CHROMIUM_PATH = '/Applications/GBrowser.app/Contents/MacOS/GBrowser';
    await promotableManager().handoff('baked');
    expect(launchOptions().executablePath).toBe(process.env.GSTACK_CHROMIUM_PATH);
    expect(launchOptions().args.filter((arg) => arg.includes('extension'))).toEqual([]);
  });
});
