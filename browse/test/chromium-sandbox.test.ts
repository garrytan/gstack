/**
 * GST-1906: on a Linux host that denies unprivileged user namespaces (stock
 * Ubuntu 23.10+ under AppArmor, a non-root Docker container) Chromium aborts
 * with "No usable sandbox!". gstack treats Docker's /.dockerenv like
 * CONTAINER, keeps the sandbox on everywhere else, and turns that abort into
 * one actionable error. It never retries without the sandbox on its own.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chromium } from 'playwright';
import { BrowserManager, shouldEnableChromiumSandbox } from '../src/browser-manager';

const RAW = '[pid=4242][err] [1108/102007.815666:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:144] No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md';
const ABORT = `browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n\n<launching> /cache/chromium/chrome --headless\n<launched> pid=4242\n  - ${RAW}\n`;
const ENV_KEYS = ['CI', 'CONTAINER', 'GSTACK_CHROMIUM_NO_SANDBOX', 'GSTACK_CHROMIUM_PATH', 'BROWSE_EXTENSIONS_DIR', 'CHROMIUM_PROFILE'] as const;
const saved: Record<string, string | undefined> = {};
const origPlatform = process.platform;
const origGetuid = process.getuid;

beforeEach(() => {
  for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  Object.defineProperty(process, 'platform', { value: 'linux' });
  process.getuid = (() => 1000) as typeof process.getuid;
});

afterEach(() => {
  for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  Object.defineProperty(process, 'platform', { value: origPlatform });
  process.getuid = origGetuid;
});

function expectSandboxError(text: string) {
  expect(text).toContain('Chromium could not start its sandbox');
  expect(text).toContain('kernel.apparmor_restrict_unprivileged_userns');
  expect(text).toContain('GSTACK_CHROMIUM_NO_SANDBOX=1');
  expect(text).toContain('pages you trust');
  expect(text.indexOf(RAW)).toBeGreaterThan(text.indexOf('pages you trust'));
}

describe('shouldEnableChromiumSandbox: Docker and hosts with no signal', () => {
  test('non-root Linux with no CI or CONTAINER but a /.dockerenv → sandbox off', () => {
    expect(shouldEnableChromiumSandbox((p) => p === '/.dockerenv')).toBe(false);
  });

  test('no signal at all → sandbox stays on', () => {
    expect(shouldEnableChromiumSandbox(() => false)).toBe(true);
  });
});

describe('a "No usable sandbox" launch abort', () => {
  test('launch() fails once with the actionable error and never retries without the sandbox', async () => {
    const launch = spyOn(chromium, 'launch').mockRejectedValue(new Error(ABORT));
    try {
      const err = await new BrowserManager().launch().then(() => null, (e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toStartWith('Chromium could not start its sandbox');
      expectSandboxError(err!.message);
      expect(launch).toHaveBeenCalledTimes(1);
    } finally {
      launch.mockRestore();
    }
  });

  test('handoff() reports the same error and keeps the headless browser', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chromium-sandbox-'));
    process.env.CHROMIUM_PROFILE = path.join(tmp, 'profile');
    const launch = spyOn(chromium, 'launchPersistentContext').mockRejectedValue(new Error(ABORT));
    const bundled = spyOn(chromium, 'executablePath').mockReturnValue(path.join(tmp, 'no-bundle', 'chrome'));
    try {
      const manager = new BrowserManager();
      Object.assign(manager as unknown as Record<string, unknown>, {
        browser: {},
        context: {},
        saveState: async () => ({ cookies: [], pages: [] }),
        ensureHeadedDisplay: async () => {},
        findExtensionPath: () => null,
      });
      const out = await manager.handoff('sandbox');
      expect(out).toStartWith('ERROR: Cannot open headed browser');
      expectSandboxError(out);
      expect(launch).toHaveBeenCalledTimes(1);
    } finally {
      launch.mockRestore();
      bundled.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
