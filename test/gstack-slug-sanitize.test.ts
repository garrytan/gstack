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
    timeout: 30_000,
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

// The GSTACK_PROJECT_SLUG escape hatch is per-invocation, never durable: a
// test exporting it from the repo root once rebound the ENTIRE repo's session
// state (evals, decisions, timelines) to the test's slug via the cwd cache.
// The cache is also GSTACK_HOME-aware now, matching lib/bin-context.ts's
// native port — temp-home runs must not litter the real ~/.gstack (observed:
// 2,528 stale temp-cwd entries).
describe('slug cache hygiene', () => {
  test('an env-override run never writes the cwd cache', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slug-env-'));
    try {
      const r = spawnSync(['bash', SLUG_BIN], {
        cwd: os.tmpdir(),
        env: { ...process.env, GSTACK_HOME: home, GSTACK_PROJECT_SLUG: 'override-slug' },
        timeout: 30_000,
      });
      expect(r.stdout.toString()).toContain('SLUG=override-slug');
      expect(fs.existsSync(path.join(home, 'slug-cache'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('an env-less run caches under GSTACK_HOME, not $HOME', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slug-home-'));
    try {
      // Strip any ambient override: a sibling test leaking
      // GSTACK_PROJECT_SLUG in a shared-process shard would flip this run
      // into override mode, which (correctly) skips the cache write.
      const { GSTACK_PROJECT_SLUG: _drop, ...ambient } = process.env;
      const r = spawnSync(['bash', SLUG_BIN], {
        cwd: os.tmpdir(),
        env: { ...ambient, GSTACK_HOME: home },
        timeout: 30_000,
      });
      expect(r.exitCode).toBe(0);
      const entries = fs.readdirSync(path.join(home, 'slug-cache'));
      expect(entries.length).toBe(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
