/**
 * Unit tests for the extracted poisoned-bundle self-heal probe (#2242).
 *
 * probePoisonedChromiumBundle() detects a Chromium bundle mutated by the
 * pre-v1.64 in-place rebrand (Info.plist contains "GStack Browser"),
 * removes it so `playwright install chromium` actually re-downloads, and
 * throws a typed PoisonedBundleError with the remediation command.
 *
 * Contracts pinned here:
 *   - standard cache layout (chromium-<rev>/chrome-mac/<name>.app): the
 *     WHOLE revision dir is removed, INSTALLATION_COMPLETE marker included
 *     (leaving the marker makes the recommended re-fetch a no-op)
 *   - non-cache layout: the .app + sibling install markers are removed,
 *     nothing else
 *   - clean bundle: untouched, no throw
 *   - GSTACK_CHROMIUM_PATH bundles (custom/embedder) are NEVER deleted:
 *     the probe refuses to act on that executable, and both call sites
 *     (launchHeaded + handoff) only pass chromium.executablePath()
 *   - the rethrow guard at the call sites is typed (instanceof), not a
 *     fragile message-string match
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { probePoisonedChromiumBundle, PoisonedBundleError } from '../src/browser-manager';

const SRC = fs.readFileSync(
  path.join(import.meta.dir, '..', 'src', 'browser-manager.ts'),
  'utf-8',
);

const POISONED_PLIST =
  '<plist><dict><key>CFBundleName</key><string>GStack Browser</string></dict></plist>';
const CLEAN_PLIST =
  '<plist><dict><key>CFBundleName</key><string>Google Chrome for Testing</string></dict></plist>';

let tmpDir: string;
let savedCustomPath: string | undefined;

/** Build <parentDir>/<name>.app with a plist and executable; return the executable path. */
function makeApp(parentDir: string, plist: string): { appDir: string; exe: string } {
  const appDir = path.join(parentDir, 'Google Chrome for Testing.app');
  const macos = path.join(appDir, 'Contents', 'MacOS');
  fs.mkdirSync(macos, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'Contents', 'Info.plist'), plist);
  const exe = path.join(macos, 'Google Chrome for Testing');
  fs.writeFileSync(exe, '#!/bin/sh\n', { mode: 0o755 });
  return { appDir, exe };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poison-probe-'));
  savedCustomPath = process.env.GSTACK_CHROMIUM_PATH;
  delete process.env.GSTACK_CHROMIUM_PATH;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (savedCustomPath === undefined) delete process.env.GSTACK_CHROMIUM_PATH;
  else process.env.GSTACK_CHROMIUM_PATH = savedCustomPath;
});

describe('probePoisonedChromiumBundle — poisoned cache bundle', () => {
  test('standard cache layout: whole chromium-<rev> dir removed (markers included), typed error thrown', () => {
    const revDir = path.join(tmpDir, 'ms-playwright', 'chromium-1234');
    const { exe } = makeApp(path.join(revDir, 'chrome-mac'), POISONED_PLIST);
    fs.writeFileSync(path.join(revDir, 'INSTALLATION_COMPLETE'), '');
    fs.writeFileSync(path.join(revDir, 'DEPENDENCIES_VALIDATED'), '');

    let caught: unknown;
    try {
      probePoisonedChromiumBundle(exe);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PoisonedBundleError);
    // The message is the user's remediation — it must carry the command.
    expect((caught as Error).message).toContain('playwright install chromium');
    // Whole revision dir gone: leaving INSTALLATION_COMPLETE behind makes
    // `playwright install chromium` no-op ("is already downloaded") and the
    // remediation we just printed would do nothing.
    expect(fs.existsSync(revDir)).toBe(false);
  });

  test('non-cache layout: only the .app + sibling install markers removed, neighbors survive', () => {
    const parentDir = path.join(tmpDir, 'custom-bundles');
    const { appDir, exe } = makeApp(parentDir, POISONED_PLIST);
    fs.writeFileSync(path.join(parentDir, 'INSTALLATION_COMPLETE'), '');
    fs.writeFileSync(path.join(parentDir, 'DEPENDENCIES_VALIDATED'), '');
    fs.writeFileSync(path.join(parentDir, 'unrelated.txt'), 'keep me');

    expect(() => probePoisonedChromiumBundle(exe)).toThrow(PoisonedBundleError);
    expect(fs.existsSync(appDir)).toBe(false);
    expect(fs.existsSync(path.join(parentDir, 'INSTALLATION_COMPLETE'))).toBe(false);
    expect(fs.existsSync(path.join(parentDir, 'DEPENDENCIES_VALIDATED'))).toBe(false);
    // The parent dir itself and unrelated files are NOT swept.
    expect(fs.readFileSync(path.join(parentDir, 'unrelated.txt'), 'utf-8')).toBe('keep me');
  });
});

describe('probePoisonedChromiumBundle — clean and missing bundles', () => {
  test('clean plist: untouched, no throw', () => {
    const revDir = path.join(tmpDir, 'ms-playwright', 'chromium-1234');
    const { appDir, exe } = makeApp(path.join(revDir, 'chrome-mac'), CLEAN_PLIST);
    fs.writeFileSync(path.join(revDir, 'INSTALLATION_COMPLETE'), '');

    expect(() => probePoisonedChromiumBundle(exe)).not.toThrow();
    expect(fs.existsSync(path.join(appDir, 'Contents', 'Info.plist'))).toBe(true);
    expect(fs.existsSync(path.join(revDir, 'INSTALLATION_COMPLETE'))).toBe(true);
  });

  test('no plist at the probed path: no-op, no throw (bundle not installed yet)', () => {
    expect(() =>
      probePoisonedChromiumBundle(path.join(tmpDir, 'nope.app', 'Contents', 'MacOS', 'nope')),
    ).not.toThrow();
  });
});

describe('probePoisonedChromiumBundle — GSTACK_CHROMIUM_PATH is never deleted', () => {
  test('probe refuses to act on the GSTACK_CHROMIUM_PATH executable, even when poisoned', () => {
    // A custom/embedder bundle (GStack Browser.app wrapper) legitimately
    // contains "GStack Browser" in its plist — that is its branding, not
    // cache poison. Deleting it would destroy the embedder's product.
    const { appDir, exe } = makeApp(path.join(tmpDir, 'GStack Browser.app-parent'), POISONED_PLIST);
    process.env.GSTACK_CHROMIUM_PATH = exe;

    expect(() => probePoisonedChromiumBundle(exe)).not.toThrow();
    expect(fs.existsSync(path.join(appDir, 'Contents', 'Info.plist'))).toBe(true);
    expect(fs.existsSync(exe)).toBe(true);
  });

  test('caller contract: both headed launch paths probe chromium.executablePath() only', () => {
    // launchHeaded + handoff each call the probe with the Playwright-cache
    // path. No call site may ever pass the custom-bundle env var.
    const calls = SRC.match(/probePoisonedChromiumBundle\(chromium\.executablePath\(\)\)/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(SRC).not.toMatch(/probePoisonedChromiumBundle\([^)]*GSTACK_CHROMIUM_PATH/);
  });
});

describe('typed rethrow guard at the call sites', () => {
  test('instanceof PoisonedBundleError, not message-string sniffing', () => {
    expect(SRC).not.toContain("includes('poisoned bundle')");
    expect(SRC).toMatch(/instanceof PoisonedBundleError/);
  });
});
