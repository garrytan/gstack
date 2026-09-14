/**
 * Tests for the opt-in extended stealth mode (#1112 rebased into the
 * v1.41 wave).
 *
 * Pins:
 * 1. Default mode applies the always-on Layer C stealth script (and NOT
 *    the extended script) — the consistency-first default.
 * 2. GSTACK_STEALTH=extended adds EXTENDED_STEALTH_SCRIPT on top of Layer C.
 * 3. EXTENDED_STEALTH_SCRIPT contains the six detection-vector patches.
 * 4. Apply order: Layer C first, extended second (so the extended
 *    delete-from-prototype path layers on top of Layer C's getter without
 *    silently overriding it if delete fails).
 *
 * Live SannySoft pass-rate verification is a periodic-tier E2E test
 * (gated behind external network + Chromium); this file pins the
 * static + applyStealth semantics that run on every commit.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  EXTENDED_STEALTH_SCRIPT,
  isExtendedStealthEnabled,
  applyStealth,
} from '../src/stealth';

let originalEnv: string | undefined;

beforeEach(() => {
  originalEnv = process.env.GSTACK_STEALTH;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.GSTACK_STEALTH;
  else process.env.GSTACK_STEALTH = originalEnv;
});

describe('extended stealth — opt-in mode flag', () => {
  test('default mode is OFF (consistency-first contract)', () => {
    delete process.env.GSTACK_STEALTH;
    expect(isExtendedStealthEnabled()).toBe(false);
  });

  test('GSTACK_STEALTH=extended enables extended mode', () => {
    process.env.GSTACK_STEALTH = 'extended';
    expect(isExtendedStealthEnabled()).toBe(true);
  });

  test('GSTACK_STEALTH=1 also enables (env-style boolean)', () => {
    process.env.GSTACK_STEALTH = '1';
    expect(isExtendedStealthEnabled()).toBe(true);
  });

  test('GSTACK_STEALTH=anything-else does NOT enable', () => {
    process.env.GSTACK_STEALTH = 'verbose';
    expect(isExtendedStealthEnabled()).toBe(false);
  });
});

describe('EXTENDED_STEALTH_SCRIPT — six detection-vector patches', () => {
  test('1. deletes navigator.webdriver from prototype', () => {
    expect(EXTENDED_STEALTH_SCRIPT).toMatch(/delete.*Object\.getPrototypeOf\(navigator\)\.webdriver/);
  });

  test('2. spoofs WebGL renderer to Apple M1 Pro', () => {
    expect(EXTENDED_STEALTH_SCRIPT).toContain('Apple M1 Pro');
    expect(EXTENDED_STEALTH_SCRIPT).toContain('UNMASKED_VENDOR_WEBGL');
  });

  test('3. installs PluginArray-prototype-passing navigator.plugins', () => {
    expect(EXTENDED_STEALTH_SCRIPT).toContain('PluginArray');
    expect(EXTENDED_STEALTH_SCRIPT).toContain('MimeType');
  });

  test('4. populates window.chrome with app, runtime, loadTimes, csi', () => {
    expect(EXTENDED_STEALTH_SCRIPT).toContain('chrome.app');
    expect(EXTENDED_STEALTH_SCRIPT).toContain('chrome.runtime');
    expect(EXTENDED_STEALTH_SCRIPT).toContain('chrome.loadTimes');
    expect(EXTENDED_STEALTH_SCRIPT).toContain('chrome.csi');
  });

  test('5. backfills navigator.mediaDevices when missing', () => {
    expect(EXTENDED_STEALTH_SCRIPT).toContain('mediaDevices');
    expect(EXTENDED_STEALTH_SCRIPT).toContain('enumerateDevices');
  });

  test('6. clears CDP cdc_* property names from window', () => {
    expect(EXTENDED_STEALTH_SCRIPT).toContain("startsWith('cdc_')");
  });
});

describe('applyStealth — script wiring', () => {
  test('default mode applies Layer C + cleanup, not extended', async () => {
    delete process.env.GSTACK_STEALTH;
    const calls: string[] = [];
    const fakeCtx = {
      addInitScript: async (opts: { content: string }) => {
        calls.push(opts.content);
      },
    } as unknown as Parameters<typeof applyStealth>[0];
    await applyStealth(fakeCtx);
    expect(calls).toHaveLength(2);
    // [0] = Layer C (toString-proxy native-code lie + webdriver mask).
    expect(calls[0]).toContain('[native code]');
    expect(calls[0]).toContain('webdriver');
    // [1] = automation-artifact cleanup (cdc_ scan + Permissions shim) —
    //       now applied on EVERY launch path, not just the headed one.
    expect(calls[1]).toContain('cdc_');
    expect(calls[1]).toContain('setTimeout(cleanup');
    // Extended script must NOT be applied by default.
    expect(calls).not.toContain(EXTENDED_STEALTH_SCRIPT);
  });

  test('extended mode applies Layer C, cleanup, then extended (in order)', async () => {
    process.env.GSTACK_STEALTH = 'extended';
    const calls: string[] = [];
    const fakeCtx = {
      addInitScript: async (opts: { content: string }) => {
        calls.push(opts.content);
      },
    } as unknown as Parameters<typeof applyStealth>[0];
    await applyStealth(fakeCtx);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain('[native code]');     // Layer C first
    expect(calls[1]).toContain('cdc_');              // cleanup second
    expect(calls[2]).toBe(EXTENDED_STEALTH_SCRIPT);  // extended last
  });
});
