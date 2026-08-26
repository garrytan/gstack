/**
 * bin/gstack-slug ↔ browse/bin/remote-slug parity.
 *
 * The bug this pins (2026-08-17, observed live in a Conductor worktree of
 * garrytan/gstack): a stray marker-bearing ancestor above the repo — an empty
 * `~/.git` directory that is not even a valid git repo — captured
 * gstack-slug's "outermost strong marker" walk-up as the project root. That
 * ancestor has no `origin` remote, so the resolver silently degraded to
 * `basename($HOME)` and emitted `SLUG=garrytan`, while remote-slug (which
 * asks git for the containing repo's remote) correctly said
 * `garrytan-gstack`. Every store keyed on the slug (decisions, timeline,
 * ceo-plans, learnings) filed into ~/.gstack/projects/garrytan/ — one bucket
 * shared by every repo under $HOME.
 *
 * The fix makes the canonical remote authoritative: gstack-slug now walks the
 * ancestor chain for the OUTERMOST dir with a `.git` entry (dir for normal
 * clones, FILE for git-worktrees) whose `origin` remote resolves, and derives
 * `owner-repo` with the exact same parse remote-slug uses. Marker-only
 * ancestors that are not remote-bearing repos can still anchor the basename
 * FALLBACK, but they can no longer shadow a real remote.
 *
 * Contracts pinned here:
 *  - Parity: for any repo (plain clone or git-worktree) whose slug derivation
 *    reaches a canonical remote, gstack-slug's SLUG equals remote-slug's
 *    output — including under a stray-marker home.
 *  - Walk-up preserved: a nested inner repo under an outer canonical-remote
 *    repo resolves to the OUTER repo's owner-repo (outermost wins), matching
 *    remote-slug run at the outer root.
 *  - Fallback preserved: a no-remote repo still resolves to its basename.
 *  - Cache self-heal: a pre-fix degraded cache entry (== the bogus marker
 *    root's basename) is rewritten to the canonical slug; legit #2212 sticky
 *    identity (repo that adopted a remote after first use) is NOT healed.
 *
 * Test pattern mirrors test/gstack-slug-cwd-walk-up.test.ts: per-test
 * tmpHome, spawnSync against the real bash scripts, fixtures on disk.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const SLUG_SCRIPT = path.join(ROOT, 'bin', 'gstack-slug');
const REMOTE_SLUG_SCRIPT = path.join(ROOT, 'browse', 'bin', 'remote-slug');

function baseEnv(tmpHome: string): Record<string, string | undefined> {
  // Drop any ambient override: a sibling test leaking GSTACK_PROJECT_SLUG in
  // a shared-process shard would flip runs into override mode.
  const { GSTACK_PROJECT_SLUG: _drop, ...ambient } = process.env;
  return { ...ambient, HOME: tmpHome, GSTACK_HOME: path.join(tmpHome, '.gstack') };
}

function runSlug(cwd: string, tmpHome: string): SpawnSyncReturns<string> {
  return spawnSync('bash', [SLUG_SCRIPT], {
    cwd,
    env: baseEnv(tmpHome),
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function runRemoteSlug(cwd: string, tmpHome: string): SpawnSyncReturns<string> {
  return spawnSync('bash', [REMOTE_SLUG_SCRIPT], {
    cwd,
    env: baseEnv(tmpHome),
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function slugOf(r: SpawnSyncReturns<string>): string {
  const m = r.stdout.match(/^SLUG=([^\n]*)$/m);
  return m ? m[1]! : '';
}

function git(args: string[], opts: { cwd?: string } = {}): void {
  const r = spawnSync('git', args, { encoding: 'utf8', timeout: 10_000, ...opts });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
}

/** git init -b main + optional origin remote. Returns the repo path. */
function makeRepo(dir: string, originUrl?: string): string {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main', dir]);
  if (originUrl) git(['-C', dir, 'remote', 'add', 'origin', originUrl]);
  return dir;
}

function encodedCacheKey(absPath: string): string {
  return absPath.replace(/\//g, '_');
}

/** Assert both scripts succeed in `cwd` and emit the same slug. */
function expectParity(cwd: string, tmpHome: string, expected: string): void {
  const gstack = runSlug(cwd, tmpHome);
  const remote = runRemoteSlug(cwd, tmpHome);
  expect(gstack.status).toBe(0);
  expect(remote.status).toBe(0);
  const remoteOut = remote.stdout.trim();
  expect(slugOf(gstack)).toBe(expected);
  expect(remoteOut).toBe(expected);
  expect(slugOf(gstack)).toBe(remoteOut);
}

describe('gstack-slug ↔ remote-slug parity', () => {
  let tmpHome: string;
  let fixtures: string;

  beforeEach(() => {
    // realpathSync: macOS tmpdir is a symlink (/var -> /private/var); the
    // scripts key their cache and walk on the resolved cwd.
    tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slug-parity-home-')));
    fixtures = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slug-parity-fix-')));
  });

  afterEach(() => {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(fixtures, { recursive: true, force: true }); } catch {}
  });

  test('plain clone, https remote WITH .git suffix — identical owner-repo slug', () => {
    const repo = makeRepo(path.join(fixtures, 'proj'), 'https://github.com/acme/widgets.git');
    expectParity(repo, tmpHome, 'acme-widgets');
  });

  test('plain clone, https remote WITHOUT .git suffix (live-bug URL shape) — identical slug', () => {
    const repo = makeRepo(path.join(fixtures, 'proj'), 'https://github.com/garrytan/gstack');
    expectParity(repo, tmpHome, 'garrytan-gstack');
  });

  test('plain clone, scp-like ssh remote — identical owner-repo slug', () => {
    const repo = makeRepo(path.join(fixtures, 'proj'), 'git@github.com:acme/widgets.git');
    expectParity(repo, tmpHome, 'acme-widgets');
  });

  test('git-worktree of a clone (.git FILE, the Conductor shape) — identical slug', () => {
    const main = makeRepo(path.join(fixtures, 'main-clone'), 'https://github.com/garrytan/gstack');
    git(['-C', main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const wt = path.join(fixtures, 'wt');
    git(['-C', main, 'worktree', 'add', '-q', wt, '-b', 'feature-branch']);
    // Sanity: worktree roots carry a .git FILE, not a directory.
    expect(fs.statSync(path.join(wt, '.git')).isFile()).toBe(true);
    expectParity(wt, tmpHome, 'garrytan-gstack');
  });

  test('LIVE BUG SHAPE: stray empty .git on an ancestor "home" no longer degrades the slug', () => {
    // The exact 2026-08-17 reproduction: an ancestor dir with an empty .git
    // (not a valid repo, no origin) above a canonical-remote worktree.
    const strayHome = path.join(fixtures, 'strayhome');
    fs.mkdirSync(path.join(strayHome, '.git'), { recursive: true }); // empty — invalid repo
    const main = makeRepo(
      path.join(strayHome, 'conductor', 'workspaces', 'gstack', 'main-clone'),
      'https://github.com/garrytan/gstack',
    );
    git(['-C', main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const wt = path.join(strayHome, 'conductor', 'workspaces', 'gstack', 'beirut-v4');
    git(['-C', main, 'worktree', 'add', '-q', wt, '-b', 'gstack-fix-wave']);

    // Both the plain clone and the worktree must resolve to owner-repo — the
    // pre-fix resolver emitted `strayhome` (the marker root's basename) here.
    expectParity(main, tmpHome, 'garrytan-gstack');
    expectParity(wt, tmpHome, 'garrytan-gstack');
    expect(slugOf(runSlug(wt, tmpHome))).not.toBe('strayhome');
  });

  test('walk-up preserved: nested inner repo (no remote) resolves to the OUTER repo slug', () => {
    const outer = makeRepo(path.join(fixtures, 'outer'), 'git@github.com:acme/outer.git');
    const inner = makeRepo(path.join(outer, 'vendor', 'inner'));

    const gstack = runSlug(inner, tmpHome);
    expect(gstack.status).toBe(0);
    // Outermost remote-bearing repo wins — same answer as remote-slug asked
    // at the outer root. (remote-slug asked from INSIDE the inner repo can't
    // see past the inner .git — its remote derivation does not succeed there,
    // so the parity clause doesn't apply; the walk-up contract does.)
    expect(slugOf(gstack)).toBe('acme-outer');
    expect(runRemoteSlug(outer, tmpHome).stdout.trim()).toBe('acme-outer');
  });

  test('walk-up preserved: nested inner repo WITH its own remote still resolves to the OUTER repo slug', () => {
    const outer = makeRepo(path.join(fixtures, 'outer'), 'git@github.com:acme/outer.git');
    const inner = makeRepo(path.join(outer, 'vendor', 'inner'), 'git@github.com:acme/inner.git');

    const gstack = runSlug(inner, tmpHome);
    expect(gstack.status).toBe(0);
    // Outermost wins — unchanged from the pre-fix walk-up semantics.
    expect(slugOf(gstack)).toBe('acme-outer');
  });

  test('fallback unchanged: no-remote repo resolves to its basename (and remote-slug agrees)', () => {
    const repo = makeRepo(path.join(fixtures, 'lonely'));
    const gstack = runSlug(repo, tmpHome);
    expect(gstack.status).toBe(0);
    expect(slugOf(gstack)).toBe('lonely');
    // remote-slug's own no-remote fallback is basename(toplevel) — parity
    // holds incidentally on this shape too.
    expect(runRemoteSlug(repo, tmpHome).stdout.trim()).toBe('lonely');
  });

  test('cache self-heal: a pre-fix degraded cache entry is rewritten to the canonical slug', () => {
    const strayHome = path.join(fixtures, 'strayhome');
    fs.mkdirSync(path.join(strayHome, '.git'), { recursive: true });
    const repo = makeRepo(path.join(strayHome, 'git', 'proj'), 'https://github.com/garrytan/gstack');

    // Pre-seed the cache with the pre-fix degraded value: the bogus marker
    // root's basename (what the old resolver computed and cached).
    const cacheDir = path.join(tmpHome, '.gstack', 'slug-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, encodedCacheKey(repo));
    fs.writeFileSync(cacheFile, 'strayhome');

    const gstack = runSlug(repo, tmpHome);
    expect(gstack.status).toBe(0);
    expect(slugOf(gstack)).toBe('garrytan-gstack');
    // The cache file itself must have been overwritten (self-healing).
    expect(fs.readFileSync(cacheFile, 'utf8').trim()).toBe('garrytan-gstack');
  });

  test('hostile origin `url = ..` cannot become a ".." slug — basename fallback holds', () => {
    // git accepts `..` as a remote URL; the sed parse passes it through
    // unchanged, so unguarded it becomes SLUG=".." — filing state one level
    // ABOVE ~/.gstack/projects/ (confined to ~/.gstack, but still traversal).
    // The dot-only guard rejects it and the basename fallback anchors identity.
    const repo = makeRepo(path.join(fixtures, 'dotty'), '..');
    const r = runSlug(repo, tmpHome);
    expect(r.status).toBe(0);
    expect(slugOf(r)).toBe('dotty');
    // The cache must hold the healed value, never the dot slug.
    const cacheFile = path.join(tmpHome, '.gstack', 'slug-cache', encodedCacheKey(repo));
    expect(fs.readFileSync(cacheFile, 'utf8').trim()).toBe('dotty');
  });

  test('package.json wrapper root (no .git): sticky basename slug is PRESERVED — heal is stray-repo-shape only', () => {
    // Legit #2212 shape: a monorepo wrapper anchored by package.json used
    // gstack before an inner dir grew a remote-bearing repo. The degraded-
    // ancestor heal must NOT fire here — it is restricted to marker roots
    // anchored by a .git entry whose origin does NOT resolve (the live-bug
    // stray-repo shape).
    const wrapper = path.join(fixtures, 'wrapperproj');
    fs.mkdirSync(wrapper, { recursive: true });
    fs.writeFileSync(path.join(wrapper, 'package.json'), '{"name":"wrapper"}\n');
    const inner = makeRepo(path.join(wrapper, 'apps', 'web'), 'https://github.com/acme/web.git');

    const cacheDir = path.join(tmpHome, '.gstack', 'slug-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, encodedCacheKey(inner));
    fs.writeFileSync(cacheFile, 'wrapperproj');

    const r = runSlug(inner, tmpHome);
    expect(r.status).toBe(0);
    expect(slugOf(r)).toBe('wrapperproj'); // NOT healed to acme-web
    expect(fs.readFileSync(cacheFile, 'utf8').trim()).toBe('wrapperproj');
  });

  test('sticky identity preserved (#2212): repo that adopted a remote after first use is NOT healed', () => {
    // Legit sticky shape: the repo itself is the marker root (REMOTE_ROOT ==
    // PROJECT_ROOT) and its cached identity is its pre-origin basename slug.
    const repo = makeRepo(path.join(fixtures, 'stickyproj'), 'https://github.com/x/y.git');
    const cacheDir = path.join(tmpHome, '.gstack', 'slug-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, encodedCacheKey(repo));
    fs.writeFileSync(cacheFile, 'stickyproj');

    const gstack = runSlug(repo, tmpHome);
    expect(gstack.status).toBe(0);
    expect(slugOf(gstack)).toBe('stickyproj');
    expect(fs.readFileSync(cacheFile, 'utf8').trim()).toBe('stickyproj');
  });
});
