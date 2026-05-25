/**
 * Regression test — bin/gstack-slug must resolve to the OUTERMOST project root
 * along the cwd ancestor chain, not to a subdirectory that happens to contain
 * a build/deploy marker.
 *
 * The bug this prevents (2026-05-25):
 * `bin/gstack-slug` derived its slug from the literal `pwd` with no walk-up.
 * When a session's cwd landed inside a subdir that had its own project-like
 * marker (e.g. `.vercel/` dropped by `vercel --prod`, or a vendored `package.json`),
 * the slug resolved to the subdir's basename — silently misfiling checkpoints,
 * autosave state, and operational learnings under a phantom slug like `site`
 * instead of the real project's slug like `loadout`.
 *
 * The fix walks up from `pwd` looking for canonical project-identity markers
 * (`.git`, `.project.yaml`, `package.json`, `pyproject.toml`, `Cargo.toml`,
 * `Gemfile`, `go.mod`) and takes the OUTERMOST match. Build/deploy artifacts
 * (`.vercel`, `.next`, `dist`, `node_modules`, etc.) are NOT in the allow-list,
 * so they cannot establish a phantom project root.
 *
 * Caching is self-healing: a stale cache entry for the literal pwd gets
 * overwritten with the freshly-computed correct slug on the next invocation
 * (no manual `rm -rf ~/.gstack/slug-cache/` required).
 *
 * Test pattern mirrors `test/migration-checkpoint-ownership.test.ts`:
 * per-test `tmpHome`, `spawnSync` against the real bash script with the
 * tmpHome injected as `HOME`, fixtures built on disk.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const SCRIPT = path.join(ROOT, 'bin', 'gstack-slug');

function runSlug(
  cwd: string,
  tmpHome: string,
  extraEnv: Record<string, string> = {},
): SpawnSyncReturns<string> {
  // Scrub PATH so we always use system bash + system git; pass HOME so the
  // script's cache writes land in tmpHome, never AJ's real ~/.gstack.
  const env = { ...process.env, HOME: tmpHome, ...extraEnv };
  return spawnSync('bash', [SCRIPT], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function parseSlug(stdout: string): { slug: string; branch: string } {
  const slugMatch = stdout.match(/^SLUG=([^\n]*)$/m);
  const branchMatch = stdout.match(/^BRANCH=([^\n]*)$/m);
  return {
    slug: slugMatch ? slugMatch[1]! : '',
    branch: branchMatch ? branchMatch[1]! : '',
  };
}

function encodedCacheKey(absPath: string): string {
  return absPath.replace(/\//g, '_');
}

describe('gstack-slug — outermost project-root resolution', () => {
  let tmpHome: string;
  let projectsRoot: string;

  beforeEach(() => {
    // realpathSync canonicalizes /var/folders/... -> /private/var/folders/... on
    // macOS so that the cache key our test computes matches the cache key the
    // bash script computes from `$(pwd)`. Without this the script writes to
    // _private_var_folders_... and the test sees _var_folders_... (silent mismatch).
    tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-slug-test-')));
    projectsRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-slug-projects-')));
  });

  afterEach(() => {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projectsRoot, { recursive: true, force: true }); } catch {}
  });

  // AC-1: the canonical loadout/site/.vercel reproduction.
  test('AC-1: .git at root, .vercel in subdir — slug from subdir resolves to ROOT basename', () => {
    const projectRoot = path.join(projectsRoot, 'loadout');
    const siteSubdir = path.join(projectRoot, 'site');
    fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
    fs.mkdirSync(path.join(siteSubdir, '.vercel'), { recursive: true });
    fs.writeFileSync(path.join(siteSubdir, '.vercel', 'project.json'), '{}\n');

    const result = runSlug(siteSubdir, tmpHome);
    expect(result.status).toBe(0);
    const { slug } = parseSlug(result.stdout);
    expect(slug).toBe('loadout');
    expect(slug).not.toBe('site');
  });

  // AC-1 variant: package.json at root, node_modules-only in subdir.
  test('AC-1 variant: package.json at root, node_modules-only subdir — slug = ROOT basename', () => {
    const projectRoot = path.join(projectsRoot, 'monorepo');
    const subdir = path.join(projectRoot, 'packages', 'web');
    fs.mkdirSync(subdir, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'package.json'), '{}\n');
    fs.mkdirSync(path.join(subdir, 'node_modules'), { recursive: true });

    const result = runSlug(subdir, tmpHome);
    expect(result.status).toBe(0);
    const { slug } = parseSlug(result.stdout);
    expect(slug).toBe('monorepo');
  });

  // AC-2: stale cache for the subdir's pwd gets self-healed.
  test('AC-2: stale cache for subdir pwd is overwritten with correct outermost-root slug', () => {
    const projectRoot = path.join(projectsRoot, 'loadout');
    const siteSubdir = path.join(projectRoot, 'site');
    fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
    fs.mkdirSync(path.join(siteSubdir, '.vercel'), { recursive: true });
    fs.writeFileSync(path.join(siteSubdir, '.vercel', 'project.json'), '{}\n');

    // Pre-seed the cache with the WRONG value (simulating pre-fix poisoning).
    const cacheDir = path.join(tmpHome, '.gstack', 'slug-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheKey = encodedCacheKey(siteSubdir);
    const cacheFile = path.join(cacheDir, cacheKey);
    fs.writeFileSync(cacheFile, 'site');

    const result = runSlug(siteSubdir, tmpHome);
    expect(result.status).toBe(0);
    const { slug } = parseSlug(result.stdout);
    expect(slug).toBe('loadout');

    // The cache file itself must have been overwritten (self-healing).
    const cachedAfter = fs.readFileSync(cacheFile, 'utf8').trim();
    expect(cachedAfter).toBe('loadout');
  });

  // AC-3: no regression — cwd IS the project root.
  test('AC-3: cwd is the project root with .git — slug = basename, no change in behavior', () => {
    const projectRoot = path.join(projectsRoot, 'myproject');
    fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });

    const result = runSlug(projectRoot, tmpHome);
    expect(result.status).toBe(0);
    const { slug } = parseSlug(result.stdout);
    expect(slug).toBe('myproject');
  });

  // AC-4: no regression — no markers anywhere on the cwd ancestor chain.
  test('AC-4: no project markers anywhere on cwd chain — slug = pwd basename (fallback)', () => {
    // projectsRoot itself is just a tmp dir with no markers; create a deeper
    // path inside it that also has no markers anywhere up to it.
    const deep = path.join(projectsRoot, 'just', 'a', 'plain', 'folder');
    fs.mkdirSync(deep, { recursive: true });

    const result = runSlug(deep, tmpHome);
    expect(result.status).toBe(0);
    const { slug } = parseSlug(result.stdout);
    expect(slug).toBe('folder');
  });

  // AC-5: no regression — real git remote takes precedence (slug from remote URL).
  test('AC-5: project root has a real git remote — slug derived from remote URL', () => {
    const projectRoot = path.join(projectsRoot, 'realgit');
    fs.mkdirSync(projectRoot, { recursive: true });
    // Initialize a real git repo with an origin remote so `git remote get-url`
    // succeeds. (The script's step 2 reads the remote when there's no cache.)
    const gitInit = spawnSync('git', ['init', '-q', '-b', 'main', projectRoot], {
      encoding: 'utf8',
    });
    expect(gitInit.status).toBe(0);
    const gitRemote = spawnSync(
      'git',
      ['-C', projectRoot, 'remote', 'add', 'origin', 'https://github.com/foo/bar.git'],
      { encoding: 'utf8' },
    );
    expect(gitRemote.status).toBe(0);

    const result = runSlug(projectRoot, tmpHome);
    expect(result.status).toBe(0);
    const { slug } = parseSlug(result.stdout);
    // Existing sed-based regex extracts "foo/bar" → "foo-bar" after tr '/' '-'.
    expect(slug).toBe('foo-bar');
  });

  // AC-6: cache eviction is single-shot — does NOT touch other cache entries.
  test('AC-6: cache eviction only rewrites the literal-pwd key, not other entries', () => {
    const projectRoot = path.join(projectsRoot, 'loadout');
    const siteSubdir = path.join(projectRoot, 'site');
    fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
    fs.mkdirSync(path.join(siteSubdir, '.vercel'), { recursive: true });
    fs.writeFileSync(path.join(siteSubdir, '.vercel', 'project.json'), '{}\n');

    const cacheDir = path.join(tmpHome, '.gstack', 'slug-cache');
    fs.mkdirSync(cacheDir, { recursive: true });

    // Seed the literal pwd key with the wrong value (will be evicted).
    const targetKey = encodedCacheKey(siteSubdir);
    fs.writeFileSync(path.join(cacheDir, targetKey), 'site');

    // Seed an UNRELATED cache entry — must remain untouched.
    const unrelatedKey = '_Users_someone_unrelated_project';
    const unrelatedFile = path.join(cacheDir, unrelatedKey);
    fs.writeFileSync(unrelatedFile, 'unrelated-value-must-survive');

    const result = runSlug(siteSubdir, tmpHome);
    expect(result.status).toBe(0);

    // Target key got self-healed.
    expect(fs.readFileSync(path.join(cacheDir, targetKey), 'utf8').trim()).toBe('loadout');
    // Unrelated key is untouched.
    expect(fs.readFileSync(unrelatedFile, 'utf8').trim()).toBe('unrelated-value-must-survive');
  });

  // AC-7: output contract is preserved exactly.
  test('AC-7: stdout shape is `SLUG=<safe>\\nBRANCH=<safe>\\n`, sanitized to [a-zA-Z0-9._-]', () => {
    const projectRoot = path.join(projectsRoot, 'loadout');
    const siteSubdir = path.join(projectRoot, 'site');
    fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
    fs.mkdirSync(path.join(siteSubdir, '.vercel'), { recursive: true });
    fs.writeFileSync(path.join(siteSubdir, '.vercel', 'project.json'), '{}\n');

    const result = runSlug(siteSubdir, tmpHome);
    expect(result.status).toBe(0);
    // Exactly two lines (with trailing newline from the last `echo`).
    expect(result.stdout).toMatch(/^SLUG=[a-zA-Z0-9._-]+\nBRANCH=[a-zA-Z0-9._-]+\n$/);
  });

  // Edge case: GSTACK_PROJECT_SLUG env override wins over walk-up (documented escape hatch).
  test('GSTACK_PROJECT_SLUG env override beats every other resolution path', () => {
    const projectRoot = path.join(projectsRoot, 'loadout');
    const siteSubdir = path.join(projectRoot, 'site');
    fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
    fs.mkdirSync(path.join(siteSubdir, '.vercel'), { recursive: true });
    fs.writeFileSync(path.join(siteSubdir, '.vercel', 'project.json'), '{}\n');

    const result = runSlug(siteSubdir, tmpHome, { GSTACK_PROJECT_SLUG: 'custom-override' });
    expect(result.status).toBe(0);
    const { slug } = parseSlug(result.stdout);
    expect(slug).toBe('custom-override');
  });
});
