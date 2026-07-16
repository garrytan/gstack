/**
 * gstack-slug cache-read sanitization.
 *
 * `eval "$(gstack-slug)"` is how callers load SLUG/BRANCH. The compute and
 * fallback paths filter to [a-zA-Z0-9._-], but a value read straight from the
 * cache file used to be echoed unsanitized — a planted cache file could inject
 * shell. This pins the fix: a poisoned cache must never produce shell
 * metacharacters in the SLUG= output line.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'bun';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const SLUG_BIN = path.join(ROOT, 'bin', 'gstack-slug');

/** Reproduce the script's cache-key derivation: absolute path with / -> _. */
function cacheKeyFor(dir: string): string {
  return dir.replace(/\//g, '_');
}

function runSlug(cwd: string, home: string) {
  return spawnSync([SLUG_BIN], {
    cwd,
    env: { ...process.env, HOME: home },
  });
}

describe('gstack-slug cache-read sanitization', () => {
  test('a poisoned cache file cannot inject shell metacharacters into output', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gslug-home-'));
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'gslug-proj-'));
    try {
      const cacheDir = path.join(home, '.gstack', 'slug-cache');
      fs.mkdirSync(cacheDir, { recursive: true });
      // realpath: macOS tmpdir is a symlink (/var -> /private/var); the script
      // runs in the resolved cwd, so key off the resolved path.
      const realProj = fs.realpathSync(proj);
      const payload = 'evil"; touch ' + path.join(home, 'pwned') + '; echo "x';
      fs.writeFileSync(path.join(cacheDir, cacheKeyFor(realProj)), payload);

      const out = runSlug(realProj, home);
      const stdout = out.stdout.toString();

      const slugLine = stdout.split('\n').find((l) => l.startsWith('SLUG='));
      expect(slugLine).toBeDefined();
      const slugValue = slugLine!.slice('SLUG='.length);

      // The value must be sanitized: only [a-zA-Z0-9._-], no quotes/semicolons/spaces.
      expect(slugValue).toMatch(/^[a-zA-Z0-9._-]*$/);
      expect(slugLine).not.toContain('"');
      expect(slugLine).not.toContain(';');
      expect(slugLine).not.toContain(' ');

      // And the injection must not have fired during the script's own run.
      expect(fs.existsSync(path.join(home, 'pwned'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });
});
