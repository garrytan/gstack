/**
 * #2160/#1989: playwright-core must pass windowsHide at its two
 * Windows-visible child_process sites — the browser launch spawn (Node
 * defaults windowsHide to FALSE for spawn, so browser children could flash a
 * console window) and the force-kill taskkill spawnSync. The launch site is
 * bun-patched; the taskkill site is upstream since Playwright 1.64 (#3907),
 * so only the installed-tree check below covers it. This is the repo's
 * first patchedDependencies entry; these static checks pin the three-legged
 * coherence (patch file ↔ package.json ↔ installed tree) so a playwright
 * bump that forgets to re-target the patch fails CI instead of silently
 * dropping it. NOTE: bumping playwright (c25-style) REQUIRES regenerating
 * this patch against the new version — see the revert pairing in the wave
 * plan (reverting the bump means dropping the patch too).
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..', '..');

function installedPlaywrightCoreVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'node_modules', 'playwright-core', 'package.json'), 'utf-8',
  ));
  return pkg.version as string;
}

describe('playwright-core windowsHide patch (#2160, #1989)', () => {
  test('package.json declares the patch for the installed version', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    const version = installedPlaywrightCoreVersion();
    const key = `playwright-core@${version}`;
    expect(pkg.patchedDependencies).toBeDefined();
    // Version-keyed on purpose: if playwright is bumped without re-targeting
    // the patch, this fails with the exact key that needs regenerating.
    expect(pkg.patchedDependencies[key]).toBe(`patches/playwright-core@${version}.patch`);
  });

  test('the patch file exists and carries the launch windowsHide site', () => {
    const version = installedPlaywrightCoreVersion();
    const patchPath = path.join(ROOT, 'patches', `playwright-core@${version}.patch`);
    expect(fs.existsSync(patchPath)).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'patches', 'playwright-core@1.62.1.patch'))).toBe(false);
    const patch = fs.readFileSync(patchPath, 'utf-8');
    // Launch spawnOptions site.
    expect(patch).toContain('+    windowsHide: true,');
  });

  test('bun.lock is coherent: the lockfile records the patched dependency', () => {
    const lock = fs.readFileSync(path.join(ROOT, 'bun.lock'), 'utf-8');
    const version = installedPlaywrightCoreVersion();
    expect(lock).toContain(`patches/playwright-core@${version}.patch`);
  });

  test('the INSTALLED tree actually has the patch applied (bun install ran it)', () => {
    const bundle = fs.readFileSync(
      path.join(ROOT, 'node_modules', 'playwright-core', 'lib', 'coreBundle.js'), 'utf-8',
    );
    expect(bundle).toContain('gstack patch (#2160/#1989)');
    expect(bundle).toContain('shell: true, windowsHide: true');
  });
});

// Windows Free Tests 40656299153 and 41056150287 (cookie-picker-ui, serial retry passed): goto failed with
// net::ERR_NO_BUFFER_SPACE on 127.0.0.1. Chromium's TcpPortRandomizationWin raises WSAENOBUFS with ports free;
// microsoft/playwright#43605 disables it in 1.65, and the 1.64.1 patch backports it; drop this block at 1.65.
describe('playwright-core TcpPortRandomizationWin backport (microsoft/playwright#43605)', () => {
  test('the patch and the installed tree disable the feature in the --disable-features list', () => {
    expect(fs.readFileSync(path.join(ROOT, 'patches', 'playwright-core@1.64.1.patch'), 'utf-8')).toContain('+      "TcpPortRandomizationWin"');
    const bundle = fs.readFileSync(path.join(ROOT, 'node_modules', 'playwright-core', 'lib', 'coreBundle.js'), 'utf-8');
    const list = bundle.slice(bundle.indexOf('disabledFeatures = ['), bundle.indexOf('].filter(Boolean);', bundle.indexOf('disabledFeatures = [')));
    expect(list).toContain('"TcpPortRandomizationWin"');
    expect(bundle).toContain('"--disable-features=" + disabledFeatures.join(",")');
  });
});

// #3907: CVE-2026-106378 (macOS GPU-process sandbox escape, crbug.com/507596239) is fixed by Chromium
// commit 0c2f3e54b265 (main@{#1695786}), first tagged in 155.0.8059.12. Playwright 1.62.1 shipped
// 151.0.7922.34, which lacks it. A Playwright pin whose bundled Chromium is older reopens the escape.
describe('bundled Chromium carries the CVE-2026-106378 fix (#3907)', () => {
  test('playwright-core pins Chromium 155.0.8059.12 or later', () => {
    const browsers = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'node_modules', 'playwright-core', 'browsers.json'), 'utf-8',
    )) as { browsers: Array<{ name: string; browserVersion: string }> };
    const version = browsers.browsers.find((b) => b.name === 'chromium')!.browserVersion.split('.').map(Number);
    const floor = [155, 0, 8059, 12];
    const cmp = version.map((part, i) => part - floor[i]).find((d) => d !== 0) ?? 0;
    expect(cmp).toBeGreaterThanOrEqual(0);
  });
});
