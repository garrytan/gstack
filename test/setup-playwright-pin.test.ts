import { describe, test, expect } from 'bun:test';
import * as path from 'path';
import * as fs from 'fs';

// Regression guard for #1829: headed `browse connect` failed after a
// "successful" ./setup because the browser-install step and the compiled
// browse binary resolved different Playwright versions (hence different
// Chromium revisions), and the post-install verify only exercised a headless
// launch — which passes off the cached headless shell even when the full
// Chrome-for-Testing build that headed mode needs is missing.
//
// These are static source assertions (no browser download) in the same spirit
// as setup-windows-fallback.test.ts, so they stay fast and CI-portable.

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');

function extractFn(name: string): string {
  const start = SETUP_SRC.indexOf(`${name}() {`);
  const end = SETUP_SRC.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`Could not locate ${name}() in setup`);
  return SETUP_SRC.slice(start, end + 2);
}

describe('setup: Playwright browser install is pinned to the bundled version (#1829)', () => {
  test('does not invoke unpinned `bunx playwright install` to download browsers', () => {
    // The unpinned form resolves the *latest* Playwright at runtime, which can
    // download a Chromium revision that differs from the one compiled into the
    // browse binary. The fallback inside the version-pin guard is allowed, so
    // we only forbid the unpinned call as a real (non-comment) browser-install
    // command outside that guarded fallback.
    const lines = SETUP_SRC.split('\n');
    const offending = lines.filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) return false;
      // The guarded fallback lives directly under `if [ -n "$pw_version" ]`.
      if (!/bunx\s+playwright\s+install\s+chromium/.test(line)) return false;
      return true;
    });
    // Exactly one occurrence is permitted: the `else` fallback when the pinned
    // version could not be resolved.
    expect(offending.length).toBe(1);
  });

  test('installs the Playwright version bundled in node_modules', () => {
    expect(SETUP_SRC).toContain('playwright/package.json');
    expect(SETUP_SRC).toMatch(/bunx\s+"playwright@\$pw_version"\s+install\s+chromium/);
  });
});

describe('setup: ensure_playwright_browser detects a missing full Chromium build (#1829)', () => {
  const fn = extractFn('ensure_playwright_browser');

  test('asserts chromium.executablePath() exists before treating the browser as ready', () => {
    // Without this, the verify launches headless and passes off the cached
    // headless shell, masking a missing full build that headed mode needs.
    expect(fn).toContain('executablePath()');
    // Both the Node (Windows) and Bun (Unix) branches must fail closed when the
    // full build is absent.
    expect(fn).toContain('fs.existsSync(chromium.executablePath())');
    expect(fn).toContain('existsSync(chromium.executablePath())');
    expect(fn).toContain('process.exit(1)');
  });
});
