/**
 * stealth.ts Layer C additions (T3 + D6 for GBrowser anti-detection):
 * verifies the build-time scaffolding without requiring a live browser.
 *
 * Live-browser verification of these spoofs in actual page contexts is
 * covered by the gbrowser-side `test/anti-bot.test.sh` (Phase 1 / T7)
 * which loads the probe page through the built GBrowser app post-bundle.
 * These tests only exercise the JS script builder + the static export
 * shapes — fast, hermetic, no chromium launch.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import {
  buildStealthScript,
  buildGStackLaunchArgs,
  readHostProfile,
  AUTOMATION_ARTIFACT_CLEANUP_SCRIPT,
  WEBDRIVER_MASK_SCRIPT,
  STEALTH_LAUNCH_ARGS,
  STEALTH_IGNORE_DEFAULT_ARGS,
} from '../src/stealth';

describe('STEALTH_IGNORE_DEFAULT_ARGS — T1', () => {
  test('includes --enable-automation (kills infobar)', () => {
    expect(STEALTH_IGNORE_DEFAULT_ARGS).toContain('--enable-automation');
  });
  test('includes the 4 Patchright-recommended adds', () => {
    expect(STEALTH_IGNORE_DEFAULT_ARGS).toContain('--disable-popup-blocking');
    expect(STEALTH_IGNORE_DEFAULT_ARGS).toContain('--disable-component-update');
    expect(STEALTH_IGNORE_DEFAULT_ARGS).toContain('--disable-default-apps');
  });
  test('preserves the original extension-loading blockers', () => {
    expect(STEALTH_IGNORE_DEFAULT_ARGS).toContain('--disable-extensions');
    expect(STEALTH_IGNORE_DEFAULT_ARGS).toContain('--disable-component-extensions-with-background-pages');
  });
});

describe('buildStealthScript — T3 Layer C', () => {
  const hw = { platform: 'MacARM', hwConcurrency: 16, deviceMemory: 8 };

  test('builds a self-invoking function (atomic injection)', () => {
    const s = buildStealthScript(hw);
    expect(s.trim().startsWith('(() => {')).toBe(true);
    expect(s.trim().endsWith('})();')).toBe(true);
  });

  test('installs the Function.prototype.toString Proxy FIRST', () => {
    const s = buildStealthScript(hw);
    const proxyIdx = s.indexOf('new Proxy(nativeToString');
    const webdriverIdx = s.indexOf("'webdriver'");
    expect(proxyIdx).toBeGreaterThan(0);
    expect(webdriverIdx).toBeGreaterThan(proxyIdx);
  });

  test('navigator.webdriver getter returns false', () => {
    const s = buildStealthScript(hw);
    expect(s).toMatch(/Object\.defineProperty\(navigator, 'webdriver'/);
    expect(s).toMatch(/return false/);
  });

  test('window.chrome.runtime ships full enum shape', () => {
    const s = buildStealthScript(hw);
    expect(s).toContain('OnInstalledReason');
    expect(s).toContain('PlatformArch');
    expect(s).toContain('PlatformOs');
    expect(s).toContain('RequestUpdateCheckStatus');
    // sendMessage / connect must throw native-shaped errors
    expect(s).toContain('runtime.connect');
    expect(s).toContain('runtime.sendMessage');
  });

  test('chrome.csi and chrome.loadTimes provide method bodies', () => {
    const s = buildStealthScript(hw);
    expect(s).toContain('chrome.csi = markNative(function csi()');
    expect(s).toContain('chrome.loadTimes = markNative(function loadTimes()');
    // loadTimes shape must include wasFetchedViaSpdy/connectionInfo —
    // those are what real Chrome's loadTimes() returns on HTTP/2 sites.
    expect(s).toContain('wasFetchedViaSpdy');
    expect(s).toContain('connectionInfo');
  });

  test('Notification.permission aligned to default', () => {
    const s = buildStealthScript(hw);
    expect(s).toMatch(/Notification, 'permission'/);
    expect(s).toMatch(/return 'default'/);
  });

  test('hardware values interpolated from host profile (NOT hardcoded)', () => {
    const s = buildStealthScript({ platform: 'MacARM', hwConcurrency: 12, deviceMemory: 4 });
    expect(s).toContain('return 12');
    expect(s).toContain('return 4');
    expect(s).not.toMatch(/return 8;.*hardwareConcurrency/);
  });

  test('cleans up Selenium + Playwright + Phantom + Nightmare globals', () => {
    const s = buildStealthScript(hw);
    // Spot-check a few from each category
    expect(s).toContain('__webdriver_evaluate');     // Selenium
    expect(s).toContain('domAutomationController');  // Chrome Driver classic
    expect(s).toContain('__pwInitScripts');          // Playwright
    expect(s).toContain('callPhantom');              // PhantomJS
    expect(s).toContain('__nightmare');              // NightmareJS
    expect(s).toContain('_Selenium_IDE_Recorder');   // Selenium IDE
  });

  test('uses markNative wrapper for every patched function', () => {
    const s = buildStealthScript(hw);
    // Every getter (hardwareConcurrency, deviceMemory, webdriver, Notification.permission)
    // should be wrapped through markNative so the toString Proxy covers it.
    const markNativeMatches = s.match(/markNative\(/g) || [];
    // At least 8 markNative wrappings (webdriver, csi, loadTimes, connect, sendMessage,
    // notification permission, hwConcurrency, deviceMemory)
    expect(markNativeMatches.length).toBeGreaterThanOrEqual(7);
  });

  test('script does not include "GStackBrowser" branding string', () => {
    const s = buildStealthScript(hw);
    // D6: dropped from UA, must not leak in via stealth payload either.
    expect(s).not.toContain('GStackBrowser');
  });
});

describe('buildGStackLaunchArgs — Pack 1 cmdline-switch construction', () => {
  // Helper: clear all GSTACK_* env, run test body, restore env.
  function withEnv(env: Record<string, string | undefined>, body: () => void) {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('GSTACK_')) {
        saved[k] = process.env[k];
        delete process.env[k];
      }
    }
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined) process.env[k] = v;
    }
    try {
      body();
    } finally {
      for (const k of Object.keys(process.env)) {
        if (k.startsWith('GSTACK_')) delete process.env[k];
      }
      for (const [k, v] of Object.entries(saved)) {
        if (v !== undefined) process.env[k] = v;
      }
    }
  }

  test('empty env produces no switches (suppress-stack is opt-in)', () => {
    withEnv({}, () => {
      // All switches are opt-in: the six per-install flags fall through
      // (nothing in env), and the Pack 2 / B11 suppression flag is only
      // emitted when GSTACK_CDP_STEALTH is on/1/true. Empty env → [].
      expect(buildGStackLaunchArgs()).toEqual([]);
    });
  });

  test('all env values populated (incl. CDP stealth opt-in) → all 7 switches emitted', () => {
    withEnv({
      GSTACK_GPU_VENDOR: 'Apple Inc.',
      GSTACK_GPU_RENDERER: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)',
      GSTACK_PLATFORM: 'MacARM',
      GSTACK_GPU_CHIPSET: 'Apple M4 Max',
      GSTACK_HW_CONCURRENCY: '16',
      GSTACK_DEVICE_MEMORY: '8',
      GSTACK_CDP_STEALTH: 'on',
    }, () => {
      const args = buildGStackLaunchArgs();
      expect(args).toContain('--gstack-gpu-vendor=Apple Inc.');
      expect(args).toContain('--gstack-gpu-renderer=ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)');
      expect(args).toContain('--gstack-ua-platform=macOS');
      expect(args).toContain('--gstack-ua-model=Apple M4 Max');
      expect(args).toContain('--gstack-hw-concurrency=16');
      expect(args).toContain('--gstack-device-memory=8');
      expect(args).toContain('--gstack-suppress-prepare-stack-trace');
      expect(args.length).toBe(7);
    });
  });

  test('platform mapping: MacARM and MacIntel both → macOS', () => {
    withEnv({ GSTACK_PLATFORM: 'MacARM' }, () => {
      expect(buildGStackLaunchArgs()).toContain('--gstack-ua-platform=macOS');
    });
    withEnv({ GSTACK_PLATFORM: 'MacIntel' }, () => {
      expect(buildGStackLaunchArgs()).toContain('--gstack-ua-platform=macOS');
    });
  });

  test('platform mapping: Win32 → Windows, Linux x86_64 → Linux', () => {
    withEnv({ GSTACK_PLATFORM: 'Win32' }, () => {
      expect(buildGStackLaunchArgs()).toContain('--gstack-ua-platform=Windows');
    });
    withEnv({ GSTACK_PLATFORM: 'Linux x86_64' }, () => {
      expect(buildGStackLaunchArgs()).toContain('--gstack-ua-platform=Linux');
    });
  });

  test('partial env: only set switches that have values', () => {
    withEnv({ GSTACK_HW_CONCURRENCY: '12' }, () => {
      const args = buildGStackLaunchArgs();
      // hw only — suppress-stack is opt-in and GSTACK_CDP_STEALTH is unset.
      expect(args).toContain('--gstack-hw-concurrency=12');
      expect(args).not.toContain('--gstack-suppress-prepare-stack-trace');
      expect(args.length).toBe(1);
    });
  });

  test('prepare-stack-trace suppression is opt-in via GSTACK_CDP_STEALTH', () => {
    // on/1/true enable it; off and unset omit it, so stock Playwright
    // Chromium (no GSTACK_CDP_STEALTH) never receives the unknown switch.
    for (const v of ['on', '1', 'true']) {
      withEnv({ GSTACK_CDP_STEALTH: v }, () => {
        expect(buildGStackLaunchArgs()).toContain('--gstack-suppress-prepare-stack-trace');
      });
    }
    withEnv({ GSTACK_CDP_STEALTH: 'off' }, () => {
      expect(buildGStackLaunchArgs()).not.toContain('--gstack-suppress-prepare-stack-trace');
    });
    withEnv({}, () => {
      expect(buildGStackLaunchArgs()).not.toContain('--gstack-suppress-prepare-stack-trace');
    });
  });

  test('unrecognized platform falls through without --gstack-ua-platform', () => {
    withEnv({ GSTACK_PLATFORM: 'OS/2' }, () => {
      const args = buildGStackLaunchArgs();
      expect(args.some(a => a.startsWith('--gstack-ua-platform='))).toBe(false);
    });
  });

  test('GPU vendor with spaces survives intact (no quote/escape regression)', () => {
    withEnv({ GSTACK_GPU_VENDOR: 'NVIDIA Corporation' }, () => {
      const args = buildGStackLaunchArgs();
      expect(args).toContain('--gstack-gpu-vendor=NVIDIA Corporation');
    });
  });
});

describe('backwards-compat exports', () => {
  test('WEBDRIVER_MASK_SCRIPT still exported', () => {
    expect(WEBDRIVER_MASK_SCRIPT).toContain("'webdriver'");
    expect(WEBDRIVER_MASK_SCRIPT).toContain('false');
  });
  test('STEALTH_LAUNCH_ARGS still includes blink-features=AutomationControlled', () => {
    expect(STEALTH_LAUNCH_ARGS).toContain('--disable-blink-features=AutomationControlled');
  });
});

describe('readHostProfile — clamp/fallback', () => {
  let savedHw: string | undefined;
  let savedMem: string | undefined;
  afterEach(() => {
    if (savedHw === undefined) delete process.env.GSTACK_HW_CONCURRENCY;
    else process.env.GSTACK_HW_CONCURRENCY = savedHw;
    if (savedMem === undefined) delete process.env.GSTACK_DEVICE_MEMORY;
    else process.env.GSTACK_DEVICE_MEMORY = savedMem;
  });
  function withHw(hw: string | undefined, mem: string | undefined): ReturnType<typeof readHostProfile> {
    savedHw = process.env.GSTACK_HW_CONCURRENCY;
    savedMem = process.env.GSTACK_DEVICE_MEMORY;
    if (hw === undefined) delete process.env.GSTACK_HW_CONCURRENCY; else process.env.GSTACK_HW_CONCURRENCY = hw;
    if (mem === undefined) delete process.env.GSTACK_DEVICE_MEMORY; else process.env.GSTACK_DEVICE_MEMORY = mem;
    return readHostProfile();
  }

  test('valid env values pass through', () => {
    expect(withHw('16', '8')).toEqual({ hwConcurrency: 16, deviceMemory: 8 });
  });

  test('missing env → default 8/8', () => {
    expect(withHw(undefined, undefined)).toEqual({ hwConcurrency: 8, deviceMemory: 8 });
  });

  test('zero / negative / NaN / empty all clamp to 8 (never a 0 or NaN bot tell)', () => {
    for (const bad of ['0', '-4', 'abc', '']) {
      const p = withHw(bad, bad);
      expect(p.hwConcurrency).toBe(8);
      expect(p.deviceMemory).toBe(8);
    }
  });
});

describe('AUTOMATION_ARTIFACT_CLEANUP_SCRIPT — static shape', () => {
  test('strips cdc_/__webdriver and maps notifications query to prompt', () => {
    expect(AUTOMATION_ARTIFACT_CLEANUP_SCRIPT).toContain("startsWith('cdc_')");
    expect(AUTOMATION_ARTIFACT_CLEANUP_SCRIPT).toContain("startsWith('__webdriver')");
    expect(AUTOMATION_ARTIFACT_CLEANUP_SCRIPT).toContain("name === 'notifications'");
    expect(AUTOMATION_ARTIFACT_CLEANUP_SCRIPT).toContain("state: 'prompt'");
  });
});
