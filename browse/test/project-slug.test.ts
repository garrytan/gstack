/**
 * browse/src/project-slug.ts — per-project slug resolution for the daemon.
 *
 * Zero coverage before this file. domain-skills keys per-project storage on
 * this value, so a regression here writes one project's browser-skills into
 * another project's directory (or into `unknown/`) with no error. The cache is
 * the subtle part: it must be populated on first call and must survive a later
 * env change within the same daemon process.
 *
 * The gstack-slug fallback path is exercised in a child process with a
 * sandboxed HOME: `os.homedir()` is resolved once per process, so mutating
 * `process.env.HOME` in-process does not redirect the helper lookup — and the
 * real `~/.claude/skills/gstack/bin/gstack-slug` exists on developer machines
 * (and after the setup tests run in CI), which would make an in-process
 * assertion order-dependent.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { getCurrentProjectSlug, _resetProjectSlugCache } from '../src/project-slug';

const MODULE_PATH = path.resolve(import.meta.dir, '../src/project-slug.ts');
const isWindows = process.platform === 'win32';
const savedOverride = process.env.GSTACK_PROJECT_SLUG;
const tempDirs: string[] = [];

/** A HOME whose gstack-slug helper is either absent or a controlled stub. */
function sandboxHome(slugBinBody?: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'project-slug-home-'));
  tempDirs.push(home);
  if (slugBinBody !== undefined) {
    const binDir = path.join(home, '.claude/skills/gstack/bin');
    fs.mkdirSync(binDir, { recursive: true });
    const bin = path.join(binDir, 'gstack-slug');
    fs.writeFileSync(bin, `#!/usr/bin/env sh\n${slugBinBody}\n`);
    fs.chmodSync(bin, 0o755);
  }
  return home;
}

/** Resolve the slug in a child process with a sandboxed HOME. */
function slugInChild(home: string, calls = 1, envOverride?: Record<string, string>): string {
  const script = `
    const { getCurrentProjectSlug } = await import(${JSON.stringify(MODULE_PATH)});
    let out = '';
    for (let i = 0; i < ${calls}; i += 1) out = getCurrentProjectSlug();
    console.log(out);
  `;
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...envOverride };
  delete (env as Record<string, string | undefined>).GSTACK_PROJECT_SLUG;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8', env });
  expect(r.status).toBe(0);
  return r.stdout.trim();
}

beforeEach(() => {
  delete process.env.GSTACK_PROJECT_SLUG;
  _resetProjectSlugCache();
});

afterEach(() => {
  if (savedOverride === undefined) delete process.env.GSTACK_PROJECT_SLUG;
  else process.env.GSTACK_PROJECT_SLUG = savedOverride;
  _resetProjectSlugCache();
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('getCurrentProjectSlug — env override', () => {
  test('GSTACK_PROJECT_SLUG wins over the slug helper', () => {
    process.env.GSTACK_PROJECT_SLUG = 'my-project';
    expect(getCurrentProjectSlug()).toBe('my-project');
  });

  test('override is cached — a later env change does not take effect', () => {
    process.env.GSTACK_PROJECT_SLUG = 'first';
    expect(getCurrentProjectSlug()).toBe('first');
    process.env.GSTACK_PROJECT_SLUG = 'second';
    expect(getCurrentProjectSlug()).toBe('first');
  });

  test('_resetProjectSlugCache re-reads the environment', () => {
    process.env.GSTACK_PROJECT_SLUG = 'first';
    expect(getCurrentProjectSlug()).toBe('first');
    _resetProjectSlugCache();
    process.env.GSTACK_PROJECT_SLUG = 'second';
    expect(getCurrentProjectSlug()).toBe('second');
  });

  test('resolution without an override returns a non-empty slug', () => {
    expect(getCurrentProjectSlug().length).toBeGreaterThan(0);
  });
});

describe.skipIf(isWindows)('getCurrentProjectSlug — gstack-slug fallback', () => {
  test('parses SLUG= from the helper output', () => {
    expect(slugInChild(sandboxHome('echo SLUG=my-app'))).toBe('my-app');
  });

  test('strips surrounding quotes from the helper output', () => {
    expect(slugInChild(sandboxHome('echo SLUG="quoted-app"'))).toBe('quoted-app');
  });

  test('helper output without a SLUG= line is used verbatim', () => {
    expect(slugInChild(sandboxHome('echo bare-slug'))).toBe('bare-slug');
  });

  test('empty helper output → "unknown"', () => {
    expect(slugInChild(sandboxHome('exit 0'))).toBe('unknown');
  });

  test('missing helper → "unknown", never a throw', () => {
    expect(slugInChild(sandboxHome())).toBe('unknown');
  });

  test('failing helper → "unknown"', () => {
    expect(slugInChild(sandboxHome('echo SLUG=x >&2\nexit 3'))).toBe('unknown');
  });

  test('helper is spawned once — the result is cached across calls', () => {
    // The stub appends a marker per invocation; three calls must produce one.
    const home = sandboxHome();
    const binDir = path.join(home, '.claude/skills/gstack/bin');
    const counter = path.join(home, 'calls');
    fs.mkdirSync(binDir, { recursive: true });
    const bin = path.join(binDir, 'gstack-slug');
    fs.writeFileSync(bin, `#!/usr/bin/env sh\necho x >> ${JSON.stringify(counter)}\necho SLUG=cached\n`);
    fs.chmodSync(bin, 0o755);

    expect(slugInChild(home, 3)).toBe('cached');
    expect(fs.readFileSync(counter, 'utf-8').trim().split('\n').length).toBe(1);
  });

  test('an empty-string override does not short-circuit the helper', () => {
    expect(slugInChild(sandboxHome('echo SLUG=from-helper'), 1, { GSTACK_PROJECT_SLUG: '' })).toBe(
      'from-helper',
    );
  });
});
