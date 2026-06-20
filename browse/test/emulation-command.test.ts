/**
 * Device / geo / locale / timezone emulation tests.
 *
 * No real browser: these exercise BrowserManager's state + the option builders
 * that feed newContext()/launchPersistentContext(). We assert the shape of the
 * options object rather than launching Chromium, so the suite runs anywhere
 * (Playwright's Chromium can't drive under Bun on Windows — see CLAUDE.md).
 *
 * buildContextOptions is private; tests reach it via an `as any` cast, which is
 * a runtime no-op (TS `private`, not `#private`) and keeps the contract pinned.
 */

import { describe, it, expect } from 'bun:test';
import { BrowserManager } from '../src/browser-manager';
import { devices } from 'playwright';

function ctxOpts(bm: BrowserManager): any {
  return (bm as any).buildContextOptions();
}

describe('BrowserManager emulation: defaults', () => {
  it('untouched manager emits only viewport + deviceScaleFactor', () => {
    const opts = ctxOpts(new BrowserManager());
    expect(opts).toEqual({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    expect(opts.userAgent).toBeUndefined();
    expect(opts.locale).toBeUndefined();
  });

  it('buildEmulationExtras is empty when nothing is set', () => {
    expect(new BrowserManager().buildEmulationExtras()).toEqual({});
  });
});

describe('BrowserManager emulation: device presets', () => {
  it('setDevice folds UA + viewport + scale + mobile/touch into context options', () => {
    const bm = new BrowserManager();
    bm.setDevice('Test Phone', {
      userAgent: 'TestUA/1.0',
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    const opts = ctxOpts(bm);
    expect(opts.userAgent).toBe('TestUA/1.0');
    expect(opts.viewport).toEqual({ width: 390, height: 844 });
    expect(opts.deviceScaleFactor).toBe(3);
    expect(opts.isMobile).toBe(true);
    expect(opts.hasTouch).toBe(true);
  });

  it('clearDevice restores desktop defaults and drops mobile/touch', () => {
    const bm = new BrowserManager();
    bm.setDevice('Test Phone', { userAgent: 'X', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    bm.clearDevice();
    const opts = ctxOpts(bm);
    expect(opts).toEqual({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    expect(opts.isMobile).toBeUndefined();
    expect(opts.hasTouch).toBeUndefined();
  });

  it('Playwright ships a non-empty device table (lookup source for the CLI)', () => {
    expect(Object.keys(devices).length).toBeGreaterThan(0);
  });
});

describe('BrowserManager emulation: geo / locale / timezone', () => {
  it('setLocale and setTimezone appear in both extras and full options', () => {
    const bm = new BrowserManager();
    bm.setLocale('ja-JP');
    bm.setTimezone('Asia/Tokyo');
    expect(bm.buildEmulationExtras()).toEqual({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
    const opts = ctxOpts(bm);
    expect(opts.locale).toBe('ja-JP');
    expect(opts.timezoneId).toBe('Asia/Tokyo');
  });

  it('setGeolocation also grants the geolocation permission', () => {
    const bm = new BrowserManager();
    bm.setGeolocation({ latitude: 37.77, longitude: -122.41 });
    const extras = bm.buildEmulationExtras();
    expect(extras.geolocation).toEqual({ latitude: 37.77, longitude: -122.41 });
    expect(extras.permissions).toEqual(['geolocation']);
  });

  it('clearing locale/timezone/geo removes them', () => {
    const bm = new BrowserManager();
    bm.setLocale('en-GB'); bm.setTimezone('Europe/London'); bm.setGeolocation({ latitude: 51.5, longitude: -0.1 });
    bm.setLocale(null); bm.setTimezone(null); bm.setGeolocation(null);
    expect(bm.buildEmulationExtras()).toEqual({});
  });

  it('extras never include viewport/isMobile (safe for headed real-window path)', () => {
    const bm = new BrowserManager();
    bm.setDevice('Test Phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    bm.setLocale('fr-FR');
    const extras = bm.buildEmulationExtras();
    expect(extras.viewport).toBeUndefined();
    expect(extras.isMobile).toBeUndefined();
    expect(extras.locale).toBe('fr-FR');
  });
});

describe('BrowserManager emulation: status', () => {
  it('getEmulationStatus reflects the active overrides', () => {
    const bm = new BrowserManager();
    bm.setDevice('Pixel Test', { userAgent: 'UA', viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true });
    bm.setLocale('de-DE');
    bm.setTimezone('Europe/Berlin');
    bm.setGeolocation({ latitude: 52.5, longitude: 13.4 });
    const s = bm.getEmulationStatus();
    expect(s.device).toBe('Pixel Test');
    expect(s.viewport).toBe('412x915');
    expect(s.deviceScaleFactor).toBe(2.6);
    expect(s.locale).toBe('de-DE');
    expect(s.timezone).toBe('Europe/Berlin');
    expect(s.geolocation).toBe('52.5,13.4');
  });
});
