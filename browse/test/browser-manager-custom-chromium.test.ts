import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { isCustomChromium } from '../src/browser-manager';

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
