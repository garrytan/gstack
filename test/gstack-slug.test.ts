/**
 * Tests for bin/gstack-slug — verifies subdir guard, .gstack-slug override,
 * and --reset cache management.
 *
 * Regression coverage for #1125 (subdir inherits outer-repo slug).
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const SCRIPT = join(import.meta.dir, '..', 'bin', 'gstack-slug');

const dirs: string[] = [];

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]) {
  return spawnSync('git', args, { cwd, stdio: 'pipe', timeout: 5000 });
}

function initRepo(dir: string, remoteUrl?: string) {
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@test.com');
  git(dir, 'config', 'user.name', 'Test');
  if (remoteUrl) git(dir, 'remote', 'add', 'origin', remoteUrl);
  writeFileSync(join(dir, 'README.md'), '# test\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'initial');
}

function runSlug(cwd: string, args: string[] = [], homeOverride?: string): { stdout: string; stderr: string; code: number } {
  const home = homeOverride ?? makeDir('slug-home');
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd,
    env: { ...process.env, HOME: home },
    stdio: 'pipe',
    timeout: 5000,
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    code: result.status ?? -1,
  };
}

function parseSlug(stdout: string): string | undefined {
  const match = stdout.match(/^SLUG=(.+)$/m);
  return match?.[1];
}

afterAll(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

describe('subdir guard (regression for #1125)', () => {
  test('PWD inside outer repo does NOT inherit outer remote', () => {
    const outer = makeDir('outer');
    initRepo(outer, 'git@github.com:me/workspace.git');
    const subdir = join(outer, 'IoTopia');
    mkdirSync(subdir);

    const { stdout } = runSlug(subdir);
    const slug = parseSlug(stdout);

    // Must NOT be the outer slug. Falls through to basename.
    expect(slug).not.toBe('me-workspace');
    expect(slug).toBe('IoTopia');
  });

  test('PWD at repo toplevel still inherits remote slug', () => {
    const repo = makeDir('toplevel');
    initRepo(repo, 'git@github.com:owner/proj.git');

    const { stdout } = runSlug(repo);
    expect(parseSlug(stdout)).toBe('owner-proj');
  });

  test('no git repo at all falls back to basename', () => {
    const dir = makeDir('plainDir');
    const { stdout } = runSlug(dir);
    expect(parseSlug(stdout)).toMatch(/^plainDir-/);
  });
});

describe('.gstack-slug override', () => {
  test('overrides git inference at toplevel', () => {
    const repo = makeDir('overrideRepo');
    initRepo(repo, 'git@github.com:wrong/remote.git');
    writeFileSync(join(repo, '.gstack-slug'), 'my-real-project\n');

    const { stdout } = runSlug(repo);
    expect(parseSlug(stdout)).toBe('my-real-project');
  });

  test('overrides basename in a subdir', () => {
    const outer = makeDir('outerOverride');
    initRepo(outer, 'git@github.com:me/workspace.git');
    const subdir = join(outer, 'sub');
    mkdirSync(subdir);
    writeFileSync(join(subdir, '.gstack-slug'), 'sub-project');

    const { stdout } = runSlug(subdir);
    expect(parseSlug(stdout)).toBe('sub-project');
  });

  test('sanitizes unsafe characters', () => {
    const dir = makeDir('sanitize');
    writeFileSync(join(dir, '.gstack-slug'), 'evil; rm -rf /\n');

    const { stdout } = runSlug(dir);
    const slug = parseSlug(stdout);
    expect(slug).not.toContain(';');
    expect(slug).not.toContain(' ');
    expect(slug).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  test('reads only first line', () => {
    const dir = makeDir('multiline');
    writeFileSync(join(dir, '.gstack-slug'), 'first-line\nsecond-line\n');

    const { stdout } = runSlug(dir);
    expect(parseSlug(stdout)).toBe('first-line');
  });
});

describe('--reset', () => {
  test('clears cache entry for current PWD', () => {
    const home = makeDir('resetHome');
    const repo = makeDir('resetRepo');
    initRepo(repo, 'git@github.com:owner/proj.git');

    runSlug(repo, [], home);
    // bash's `pwd` can resolve symlinks (e.g. /var/folders → /private/var/folders on
    // macOS), so derive the cache key from the same resolved path the script uses.
    const cacheKey = realpathSync(repo).replace(/\//g, '_');
    const cacheFile = join(home, '.gstack', 'slug-cache', cacheKey);
    expect(existsSync(cacheFile)).toBe(true);

    const reset = runSlug(repo, ['--reset'], home);
    expect(reset.code).toBe(0);
    expect(existsSync(cacheFile)).toBe(false);
  });

  test('is a no-op when no cache exists', () => {
    const home = makeDir('noCacheHome');
    const dir = makeDir('noCacheDir');

    const { code } = runSlug(dir, ['--reset'], home);
    expect(code).toBe(0);
  });
});

describe('cache stability', () => {
  test('second run reuses cached slug', () => {
    const home = makeDir('stableHome');
    const repo = makeDir('stableRepo');
    initRepo(repo, 'git@github.com:owner/cached.git');

    const first = runSlug(repo, [], home);
    expect(parseSlug(first.stdout)).toBe('owner-cached');

    // Remove the remote — cached slug should still come back
    git(repo, 'remote', 'remove', 'origin');

    const second = runSlug(repo, [], home);
    expect(parseSlug(second.stdout)).toBe('owner-cached');
  });
});
