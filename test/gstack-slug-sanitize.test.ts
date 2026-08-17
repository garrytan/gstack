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
      });
      expect(r.exitCode).toBe(0);
      const entries = fs.readdirSync(path.join(home, 'slug-cache'));
      expect(entries.length).toBe(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// A slug is a PATH COMPONENT: ~/.gstack/projects/<slug>/, and via
// gstack-memory-ingest it also becomes a directory inside the staging tree
// handed to `gbrain import`. A leading dot makes that component a HIDDEN
// directory. Markdown collectors skip hidden entries while walking, so pages
// staged under one are never collected and memory-ingest's accounting guard
// then refuses to advance state on EVERY run ("gbrain import accounted for
// N of M staged page(s)"). No adversary needed: once a user wires artifacts
// sync, ~/.gstack is itself a git repo, so any gstack bin invoked with a cwd
// inside it resolves basename(PROJECT_ROOT) == ".gstack".
describe('slug leading-dot hygiene', () => {
  function slugFor(dirName: string): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slug-dot-home-'));
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'slug-dot-'));
    try {
      const proj = path.join(fs.realpathSync(parent), dirName);
      fs.mkdirSync(proj, { recursive: true });
      // package.json is a STRONG project-identity marker, so the walk-up
      // resolves this directory as the project root and takes its basename.
      fs.writeFileSync(path.join(proj, 'package.json'), '{}');
      const { GSTACK_PROJECT_SLUG: _drop, ...ambient } = process.env;
      const r = spawnSync(['bash', SLUG_BIN], {
        cwd: proj,
        env: { ...ambient, GSTACK_HOME: home },
      });
      expect(r.exitCode).toBe(0);
      const line = r.stdout.toString().split('\n').find((l) => l.startsWith('SLUG='));
      expect(line).toBeDefined();
      return line!.slice('SLUG='.length);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(parent, { recursive: true, force: true });
    }
  }

  test('a dot-prefixed project directory does not produce a hidden slug', () => {
    expect(slugFor('.gstack')).toBe('gstack');
  });

  test('leading dots are stripped, interior dots are preserved', () => {
    expect(slugFor('..hidden.thing')).toBe('hidden.thing');
  });

  test('a slug never starts with a dot, whatever the directory is named', () => {
    for (const name of ['.gstack', '.config', '...', '.a']) {
      expect(slugFor(name)).not.toMatch(/^\./);
    }
  });

  test('an all-dots directory name falls back instead of emitting an empty slug', () => {
    expect(slugFor('...')).toBe('unknown');
  });
});
