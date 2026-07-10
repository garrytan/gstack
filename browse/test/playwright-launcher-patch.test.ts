import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// Windows console-flash guard for the Playwright browser launcher (#2151
// follow-up; siblings: #1835, #1989).
//
// On Windows the browse server runs console-less (node server-node.mjs,
// detached from the CLI). chrome-headless-shell is a console-subsystem
// exe, so playwright-core's processLauncher spawning it without
// windowsHide allocates a visible console window per launch, and its
// force-kill path shells out to `taskkill` (another window). Upstream
// playwright doesn't set windowsHide, so we carry a bun
// `patchedDependencies` patch. These tripwires pin:
//   1. package.json declares the patch for the installed version — if a
//      playwright bump orphans the patch key, test 3 catches the silent
//      regression (bun applies patches per exact version).
//   2. the patch file itself still contains both windowsHide sites.
//   3. the INSTALLED node_modules file actually got patched.

const ROOT = path.resolve(import.meta.dir, '..', '..');
const INSTALLED_LAUNCHER = path.join(
  ROOT, 'node_modules', 'playwright-core', 'lib', 'server', 'utils', 'processLauncher.js',
);

describe('playwright-core processLauncher windowsHide patch', () => {
  test('1. package.json declares a patchedDependencies entry matching the installed playwright-core version', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    const installed = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'node_modules', 'playwright-core', 'package.json'), 'utf-8',
    ));
    const key = `playwright-core@${installed.version}`;
    expect(pkg.patchedDependencies?.[key]).toBeDefined();
    expect(fs.existsSync(path.join(ROOT, pkg.patchedDependencies[key]))).toBe(true);
  });

  test('2. the patch covers both spawn sites (browser launch + taskkill)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    const patchRel = Object.entries(pkg.patchedDependencies ?? {})
      .find(([k]) => k.startsWith('playwright-core@'))?.[1] as string;
    const patch = fs.readFileSync(path.join(ROOT, patchRel), 'utf-8');
    expect(patch).toContain('+    windowsHide: true,');
    expect(patch).toContain('{ shell: true, windowsHide: true }');
  });

  test('3. the installed processLauncher.js is actually patched', () => {
    const src = fs.readFileSync(INSTALLED_LAUNCHER, 'utf-8');
    const launchBlock = src.slice(src.indexOf('async function launchProcess'), src.indexOf('const spawnedProcess'));
    expect(launchBlock).toContain('windowsHide: true');
    expect(src).toMatch(/taskkill[^\n]*\{ shell: true, windowsHide: true \}/);
  });
});
