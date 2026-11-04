import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chromium } from 'playwright';
import { BrowserManager, isCustomChromium } from '../src/browser-manager';

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


// #3907: handoff() must launch the browser GSTACK_CHROMIUM_PATH names, like
// launch() and launchHeaded(). The Playwright launch is a spy that rejects, so
// no window opens and handoff() returns its "Cannot open headed browser" error.
describe('handoff: GSTACK_CHROMIUM_PATH', () => {
  const EXTENSION = '/opt/gstack/extension';
  const ENV_KEYS = ['GSTACK_CHROMIUM_PATH', 'GSTACK_CHROMIUM_KIND', 'CHROMIUM_PROFILE'] as const;
  const saved: Record<string, string | undefined> = {};
  let tmpDir: string;
  let launch: ReturnType<typeof spyOn>;
  let bundledPath: ReturnType<typeof spyOn>;

  function promotable(): BrowserManager {
    const manager = new BrowserManager();
    Object.assign(manager as unknown as Record<string, unknown>, {
      browser: {},
      context: {},
      saveState: async () => ({ cookies: [], pages: [] }),
      ensureHeadedDisplay: async () => {},
      findExtensionPath: () => EXTENSION,
    });
    return manager;
  }

  const launchOptions = () => (launch.mock.calls[0] as [string, { executablePath?: string; args: string[] }])[1];

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    delete process.env.GSTACK_CHROMIUM_PATH;
    delete process.env.GSTACK_CHROMIUM_KIND;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-custom-chromium-'));
    process.env.CHROMIUM_PROFILE = path.join(tmpDir, 'profile');
    launch = spyOn(chromium, 'launchPersistentContext').mockRejectedValue(new Error('launch spy'));
    bundledPath = spyOn(chromium, 'executablePath').mockReturnValue(path.join(tmpDir, 'no-bundle', 'chrome'));
  });

  afterEach(() => {
    launch.mockRestore();
    bundledPath.mockRestore();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('launches the GSTACK_CHROMIUM_PATH binary and never probes the Playwright bundle', async () => {
    process.env.GSTACK_CHROMIUM_PATH = '/opt/chrome/chrome';
    expect(await promotable().handoff('custom')).toContain('Cannot open headed browser');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launchOptions().executablePath).toBe('/opt/chrome/chrome');
    expect(bundledPath).not.toHaveBeenCalled();
  });

  test('without GSTACK_CHROMIUM_PATH it launches the probed Playwright bundle', async () => {
    expect(await promotable().handoff('bundled')).toContain('Cannot open headed browser');
    expect('executablePath' in launchOptions()).toBe(false);
    expect(bundledPath).toHaveBeenCalled();
    expect(launchOptions().args).toContain(`--load-extension=${EXTENSION}`);
  });

  test('a build that bakes the extension in never gets it loaded twice', async () => {
    process.env.GSTACK_CHROMIUM_PATH = '/Applications/GBrowser.app/Contents/MacOS/GBrowser';
    await promotable().handoff('baked');
    expect(launchOptions().executablePath).toBe('/Applications/GBrowser.app/Contents/MacOS/GBrowser');
    expect(launchOptions().args.filter((arg) => arg.includes('extension'))).toEqual([]);
  });
});
