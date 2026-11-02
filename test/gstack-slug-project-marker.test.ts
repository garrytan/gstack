/**
 * .gstack-project marker (#2649, #1923): an opt-in file that makes its folder a
 * project of its own. Pinned for bin/gstack-slug, its TS twin in
 * lib/bin-context.ts, and browse/bin/remote-slug. The default (outermost
 * remote-bearing repo wins) is pinned unchanged in test/gstack-slug-parity.test.ts.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { projectMarkerRoot, readVersionedSlugCache, slugFromEnvironment } from '../lib/bin-context';
import { defaultUserConfigPath } from '../lib/pregate/context';
import { reviewPaths } from '../lib/ship-budget';

const ROOT = path.resolve(import.meta.dir, '..');
const SLUG = path.join(ROOT, 'bin', 'gstack-slug');
const REMOTE_SLUG = path.join(ROOT, 'browse', 'bin', 'remote-slug');

let home: string;
let state: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-marker-')));
  state = path.join(home, '.gstack');
  saved = { HOME: process.env.HOME, GSTACK_HOME: process.env.GSTACK_HOME, GSTACK_PROJECT_SLUG: process.env.GSTACK_PROJECT_SLUG };
  process.env.HOME = home;
  process.env.GSTACK_HOME = state;
  delete process.env.GSTACK_PROJECT_SLUG;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const { GSTACK_PROJECT_SLUG: _p, GSTACK_STATE_ROOT: _r, GSTACK_STATE_DIR: _d, CLAUDE_PLUGIN_DATA: _c, ...ambient } = process.env;
  return { ...ambient, HOME: home, GSTACK_HOME: state, ...extra };
}
function run(script: string, cwd: string, args: string[] = [], extra: Record<string, string> = {}) {
  return spawnSync('bash', [script, ...args], { cwd, env: env(extra), encoding: 'utf8', timeout: 15_000 });
}
const slug = (cwd: string, extra: Record<string, string> = {}) => run(SLUG, cwd, ['--get', 'SLUG'], extra).stdout.trim();
function identity(cwd: string): string {
  const r = run(SLUG, cwd, ['--identity']);
  expect(r.status).toBe(0);
  return r.stdout;
}
function git(args: string[], cwd?: string): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15_000, env: env({ GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }) });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}
function repo(dir: string, origin?: string): string {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main', dir]);
  if (origin) git(['-C', dir, 'remote', 'add', 'origin', origin]);
  return dir;
}
const mark = (dir: string) => fs.writeFileSync(path.join(dir, '.gstack-project'), '');
const cacheFiles = () => {
  const dir = path.join(state, 'slug-cache');
  return Object.fromEntries(fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
};

/** ws (me/workspace) holding the independent repo ws/proj (org/proj), as in #2649. */
function workspace() {
  const ws = repo(path.join(home, 'ws'), 'git@github.com:me/workspace.git');
  const proj = repo(path.join(ws, 'proj'), 'git@github.com:org/proj.git');
  fs.mkdirSync(path.join(proj, 'app'));
  return { ws, proj, app: path.join(proj, 'app') };
}
/** A plain (non-git) umbrella over two repos, as in #1923. */
function umbrella() {
  const top = path.join(home, 'MyProduct');
  const backend = repo(path.join(top, 'backend'), 'git@github.com:org/backend.git');
  const frontend = repo(path.join(top, 'frontend'), 'git@github.com:org/frontend.git');
  return { top, backend, frontend };
}

describe('gstack-slug: .gstack-project marker', () => {
  test('a marker at a nested repo\'s top folder gives it (and its subfolders) its own slug; the outer repo is unchanged', () => {
    const { ws, proj, app } = workspace();
    const first = run(SLUG, proj, ['--get', 'SLUG']);
    expect(first.stdout.trim()).toBe('me-workspace');
    expect(first.stderr).toContain(`touch '${proj}/.gstack-project'`);
    expect(run(SLUG, proj, ['--get', 'SLUG']).stderr).toBe('');
    fs.mkdirSync(path.join(state, 'projects', 'me-workspace', 'checkpoints'), { recursive: true });
    fs.writeFileSync(path.join(state, 'projects', 'me-workspace', 'checkpoints', '20261001-120000-x.md'), '## Working on: x\n');
    mark(proj);
    const moved = run(SLUG, proj, ['--get', 'SLUG']);
    expect(moved.stdout.trim()).toBe('org-proj');
    expect(moved.stderr).toContain('--adopt-legacy --from me-workspace --under-root');
    expect(run(SLUG, proj, ['--get', 'SLUG']).stderr).toBe('');
    expect(run(SLUG, app, ['--get', 'PROJECT_MARKER']).stdout.trim()).toBe(path.join(proj, '.gstack-project'));
    expect(run(SLUG, app, ['--get', 'REPO_SLUG']).stdout.trim()).toBe('me-workspace');
    expect(slug(app)).toBe('org-proj');
    expect(slug(ws)).toBe('me-workspace');
    expect(identity(app)).toContain(`PROJECT_MARKER=${path.join(proj, '.gstack-project')}`);
    expect(identity(app)).toContain(`PROJECT_ROOT=${proj}`);
  });

  test('the marker beats a sticky cache entry, and removing it restores every repo entry byte for byte', () => {
    const { proj } = workspace();
    expect(slug(proj)).toBe('me-workspace');
    for (const p of [path.join(proj, '.git'), proj]) fs.writeFileSync(path.join(state, 'slug-cache', p.replace(/\//g, '_')), 'v2:sticky-name');
    expect(slug(proj)).toBe('sticky-name');
    const before = cacheFiles();
    mark(proj);
    expect(slug(proj)).toBe('org-proj');
    expect(cacheFiles()).toEqual(before);
    fs.rmSync(path.join(proj, '.gstack-project'));
    expect(slug(proj)).toBe('sticky-name');
    expect(cacheFiles()).toEqual(before);
  });

  test('an umbrella marker folds child repos into one project; a child\'s own marker wins', () => {
    const { top, backend, frontend } = umbrella();
    expect(slug(backend)).toBe('org-backend');
    mark(top);
    expect(slug(top)).toBe('MyProduct');
    expect(slug(backend)).toBe('MyProduct');
    expect(slug(frontend)).toBe('MyProduct');
    mark(backend);
    expect(slug(backend)).toBe('org-backend');
    expect(slug(frontend)).toBe('MyProduct');
  });

  test('GSTACK_PROJECT_SLUG still beats a marker', () => {
    const { proj } = workspace();
    mark(proj);
    expect(slug(proj, { GSTACK_PROJECT_SLUG: 'pinned' })).toBe('pinned');
  });

  test('a marker in a subfolder of a repo is ignored, with the reason in --identity', () => {
    const { ws } = workspace();
    const sub = path.join(ws, 'docs');
    fs.mkdirSync(sub);
    mark(sub);
    expect(slug(sub)).toBe('me-workspace');
    expect(identity(sub)).toMatch(/MARKER_IGNORED=.*inside\\ the\\ git\\ work\\ tree/);
  });

  test('a linked, directory or dangling marker is ignored', () => {
    const { top, backend } = umbrella();
    fs.symlinkSync(path.join(home, 'nowhere'), path.join(top, '.gstack-project'));
    expect(slug(backend)).toBe('org-backend');
    fs.rmSync(path.join(top, '.gstack-project'));
    fs.mkdirSync(path.join(top, '.gstack-project'));
    expect(slug(backend)).toBe('org-backend');
    expect(identity(backend)).toMatch(/MARKER_IGNORED=.*a\\ directory/);
  });

  test('a marker at $HOME is ignored', () => {
    const { backend } = umbrella();
    mark(home);
    expect(slug(backend)).toBe('org-backend');
    expect(identity(backend)).toMatch(/MARKER_IGNORED=.*at\\ or\\ above/);
  });

  test('a hostile origin at the marked folder falls back to its basename', () => {
    const proj = repo(path.join(home, 'outer', 'evil'), '..');
    mark(proj);
    expect(slug(proj)).toBe('evil');
  });

  test('a linked worktree outside the umbrella follows it while the marker exists', () => {
    const { top, backend } = umbrella();
    git(['-C', backend, 'commit', '-q', '--allow-empty', '-m', 'init']);
    mark(top);
    expect(slug(backend)).toBe('MyProduct');
    const wt = path.join(home, 'elsewhere', 'wt');
    git(['-C', backend, 'worktree', 'add', '-q', wt]);
    expect(slug(wt)).toBe('MyProduct');
    fs.rmSync(path.join(top, '.gstack-project'));
    expect(slug(wt)).toBe('org-backend');
  });

  test('a linked worktree outside the umbrella follows it before the main checkout has ever resolved', () => {
    const { top, backend } = umbrella();
    git(['-C', backend, 'commit', '-q', '--allow-empty', '-m', 'init']);
    mark(top);
    const wt = path.join(home, 'elsewhere', 'wt');
    git(['-C', backend, 'worktree', 'add', '-q', wt]);
    expect(projectMarkerRoot(wt)).toBe(top);
    expect(slug(wt)).toBe('MyProduct');
    expect(slugFromEnvironment(state, wt)).toBe('MyProduct');
    expect(run(REMOTE_SLUG, wt).stdout.trim()).toBe('MyProduct');
    expect(slug(backend)).toBe('MyProduct');
    expect(slug(wt)).toBe('MyProduct');
  });

  test('a worktree outside $HOME ignores a $HOME marker above its main checkout', () => {
    const backend = repo(path.join(home, 'code', 'backend'), 'git@github.com:org/backend.git');
    git(['-C', backend, 'commit', '-q', '--allow-empty', '-m', 'init']);
    mark(home);
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-marker-out-')));
    try {
      const wt = path.join(outside, 'wt');
      git(['-C', backend, 'worktree', 'add', '-q', wt]);
      expect(slug(wt)).toBe('org-backend');
      expect(projectMarkerRoot(wt)).toBe('');
      expect(slugFromEnvironment(state, wt)).toBe('org-backend');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a worktree outside the umbrella follows it even when $HOME is itself a git repository', () => {
    git(['init', '-q', home]);
    const { top, backend } = umbrella();
    git(['-C', backend, 'commit', '-q', '--allow-empty', '-m', 'init']);
    mark(top);
    expect(slug(backend)).toBe('MyProduct');
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-marker-out-')));
    try {
      const wt = path.join(outside, 'wt');
      git(['-C', backend, 'worktree', 'add', '-q', wt]);
      expect(slug(wt)).toBe('MyProduct');
      expect(slugFromEnvironment(state, wt)).toBe('MyProduct');
      expect(run(REMOTE_SLUG, wt).stdout.trim()).toBe('MyProduct');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('remote-slug agrees with gstack-slug under a counted marker and keeps its own answer otherwise', () => {
    const { top, backend } = umbrella();
    mark(top);
    expect(run(REMOTE_SLUG, backend).stdout.trim()).toBe('MyProduct');
    const { ws, proj } = workspace();
    mark(path.join(ws));
    fs.rmSync(path.join(ws, '.gstack-project'));
    expect(run(REMOTE_SLUG, proj).stdout.trim()).toBe('org-proj');
    mark(proj);
    expect(run(REMOTE_SLUG, proj).stdout.trim()).toBe(slug(proj));
  });

  test('--adopt-legacy --under-root previews, then copies and restamps only checkpoints saved inside the marked folder', () => {
    const { ws, proj, app } = workspace();
    const old = path.join(state, 'projects', 'me-workspace', 'checkpoints');
    fs.mkdirSync(old, { recursive: true });
    const ck = (name: string, wt: string) => fs.writeFileSync(path.join(old, name), `---\nremote: github.com/me/workspace\nproject_root: ${ws}\nworktree: ${wt}\nhead: abc123\n---\n## Working on: x\n`);
    ck('20261001-120000-inner.md', proj);
    ck('20261002-120000-sibling.md', path.join(ws, 'other'));
    fs.writeFileSync(path.join(old, '20260901-120000-old.md'), '## Working on: unstamped\n');
    mark(proj);
    const preview = run(SLUG, app, ['--adopt-legacy', '--from', 'me-workspace', '--under-root']);
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain('WOULD_COPY');
    expect(preview.stdout).toContain('1 checkpoint(s) predate identity stamps');
    expect(fs.existsSync(path.join(state, 'projects', 'org-proj', 'checkpoints'))).toBe(false);
    const apply = run(SLUG, app, ['--adopt-legacy', '--from', 'me-workspace', '--under-root', '--apply']);
    expect(apply.status).toBe(0);
    const copied = fs.readdirSync(path.join(state, 'projects', 'org-proj', 'checkpoints'));
    expect(copied).toEqual(['20261001-120000-inner.md']);
    const text = fs.readFileSync(path.join(state, 'projects', 'org-proj', 'checkpoints', copied[0]), 'utf8');
    expect(text).toContain('head: abc123');
    expect(text).toContain(`project_root: ${proj}`);
    const cls = spawnSync('bash', [SLUG, '--classify-checkpoints'], { cwd: app, env: env(), input: path.join(state, 'projects', 'org-proj', 'checkpoints', copied[0]) + '\n', encoding: 'utf8', timeout: 15_000 });
    expect(cls.stdout.split('\t')[0]).toBe('match');
    expect(fs.readdirSync(old).length).toBe(3);
  });

  test('--adopt-legacy --under-root never replaces what already sits at the destination name', () => {
    const { ws, proj, app } = workspace();
    const old = path.join(state, 'projects', 'me-workspace', 'checkpoints');
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, '20261001-120000-inner.md'), `---\nproject_root: ${ws}\nworktree: ${proj}\n---\n## Working on: x\n`);
    mark(proj);
    const dest = path.join(state, 'projects', 'org-proj', 'checkpoints');
    fs.mkdirSync(dest, { recursive: true });
    fs.symlinkSync(path.join(home, 'saved-elsewhere.md'), path.join(dest, '20261001-120000-inner.md'));
    const apply = run(SLUG, app, ['--adopt-legacy', '--from', 'me-workspace', '--under-root', '--apply']);
    expect(apply.stdout).not.toContain('COPIED');
    expect(fs.lstatSync(path.join(dest, '20261001-120000-inner.md')).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(dest)).toEqual(['20261001-120000-inner.md']);
  });

  test('a marked folder whose name has no usable letters or digits is ignored, the same in bash and TS', () => {
    const top = path.join(home, '项目');
    const backend = repo(path.join(top, 'backend'), 'git@github.com:org/backend.git');
    fs.mkdirSync(path.join(backend, 'src'));
    mark(top);
    expect(slug(path.join(backend, 'src'))).toBe('org-backend');
    expect(slugFromEnvironment(state, path.join(backend, 'src'))).toBe('org-backend');
    expect(projectMarkerRoot(top)).toBe('');
    expect(identity(top)).toMatch(/MARKER_IGNORED=.*folder\\ name/);
    expect(run(REMOTE_SLUG, path.join(backend, 'src')).stdout.trim()).toBe('org-backend');
  });

  test('remote-slug follows a marker under a non-ASCII parent in the C locale', () => {
    const top = path.join(home, '文档', 'proj');
    const backend = repo(path.join(top, 'backend'), 'git@github.com:org/backend.git');
    mark(top);
    expect(slug(backend, { LC_ALL: 'C' })).toBe('proj');
    expect(run(REMOTE_SLUG, backend, [], { LC_ALL: 'C' }).stdout.trim()).toBe('proj');
  });

  test('repo mode stays with each repository under an umbrella', () => {
    const { top, backend } = umbrella();
    for (let i = 0; i < 5; i++) git(['-C', backend, 'commit', '-q', '--allow-empty', '-m', `c${i}`]);
    mark(top);
    expect(slug(backend)).toBe('MyProduct');
    const r = run(path.join(ROOT, 'bin', 'gstack-repo-mode'), backend);
    expect(r.stdout).toContain('REPO_MODE=solo');
    expect(fs.existsSync(path.join(state, 'projects', 'MyProduct', 'repo-mode.json'))).toBe(false);
    expect(fs.existsSync(path.join(state, 'projects', 'org-backend', 'repo-mode.json'))).toBe(true);
  });

  test('the ship-budget pointer and the review log stay with the repository when a marker appears mid-run', () => {
    const { proj } = workspace();
    git(['-C', proj, 'commit', '-q', '--allow-empty', '-m', 'init']);
    const before = reviewPaths(proj, env());
    expect(before.marker).toContain(path.join('projects', 'me-workspace') + path.sep);
    mark(proj);
    expect(slug(proj)).toBe('org-proj');
    expect(reviewPaths(proj, env())).toEqual(before);
    const branch = run(SLUG, proj, ['--get', 'BRANCH']).stdout.trim();
    fs.mkdirSync(path.join(state, 'projects', 'me-workspace'), { recursive: true });
    fs.writeFileSync(path.join(state, 'projects', 'me-workspace', `${branch}-reviews.jsonl`), '{"skill":"review","status":"clean"}\n');
    expect(run(path.join(ROOT, 'bin', 'gstack-review-read'), proj).stdout).toContain('"skill":"review"');
  });

  test('sibling repos under an umbrella keep separate ship-budget pointers', () => {
    const { top, backend, frontend } = umbrella();
    mark(top);
    expect(reviewPaths(backend, env()).marker).not.toBe(reviewPaths(frontend, env()).marker);
    expect(reviewPaths(backend, env()).reviewLog).toContain(path.join('projects', 'org-backend') + path.sep);
  });

  test('recovered checkpoints keep the repository they were saved in', () => {
    const { top, backend } = umbrella();
    const old = path.join(state, 'projects', 'org-backend', 'checkpoints');
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, '20261001-120000-x.md'), `---\nremote: github.com/org/backend\nproject_root: ${backend}\nhead: abc123\n---\n## Working on: x\n`);
    mark(top);
    const apply = run(SLUG, backend, ['--adopt-legacy', '--from', 'org-backend', '--under-root', '--apply']);
    expect(apply.stdout).toContain('COPIED');
    const text = fs.readFileSync(path.join(state, 'projects', 'MyProduct', 'checkpoints', '20261001-120000-x.md'), 'utf8');
    expect(text).toContain(`worktree: ${backend}`);
    expect(text).toContain(`project_root: ${top}`);
  });

  test('a committed marker in a repo with no remote gives its linked worktrees the same slug', () => {
    const solo = repo(path.join(home, 'solo'));
    mark(solo);
    git(['-C', solo, 'add', '.gstack-project']);
    git(['-C', solo, 'commit', '-q', '-m', 'marker']);
    const wt = path.join(home, 'elsewhere', 'feature-wt');
    git(['-C', solo, 'worktree', 'add', '-q', wt]);
    expect(slug(solo)).toBe('solo');
    expect(slug(wt)).toBe('solo');
    expect(slugFromEnvironment(state, wt)).toBe('solo');
  });

  test('marked folders whose paths differ only by / and _ keep separate slugs', () => {
    const a = path.join(home, 'team_app');
    const b = path.join(home, 'team', 'app');
    for (const d of [a, b]) { fs.mkdirSync(d, { recursive: true }); mark(d); }
    expect(slug(a)).toBe('team_app');
    expect(slug(b)).toBe('app');
    expect(slugFromEnvironment(state, b)).toBe('app');
    expect(readVersionedSlugCache(state, b)).toBe('app');
    expect(readVersionedSlugCache(state, a)).toBe('team_app');
  });

  test('--adopt-legacy --under-root refuses where no marker applies', () => {
    const { proj } = workspace();
    const r = run(SLUG, proj, ['--adopt-legacy', '--from', 'me-workspace', '--under-root']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no .gstack-project applies here');
  });
});

describe('lib/bin-context: marker twin', () => {
  test('slugFromEnvironment and the hook reader follow the marker, and both forget it on removal', () => {
    const { proj, app } = workspace();
    expect(slugFromEnvironment(state, app)).toBe('me-workspace');
    expect(readVersionedSlugCache(state, app)).toBe('me-workspace');
    mark(proj);
    expect(readVersionedSlugCache(state, app)).toBeUndefined();
    expect(slugFromEnvironment(state, app)).toBe('org-proj');
    expect(readVersionedSlugCache(state, app)).toBe('org-proj');
    fs.rmSync(path.join(proj, '.gstack-project'));
    expect(readVersionedSlugCache(state, app)).toBe('me-workspace');
    expect(slugFromEnvironment(state, app)).toBe('me-workspace');
  });

  test('bash and TS read each other\'s marker entries', () => {
    const { top, backend } = umbrella();
    mark(top);
    expect(slugFromEnvironment(state, backend)).toBe('MyProduct');
    fs.writeFileSync(path.join(state, 'slug-cache', 'marker', top.replace(/\//g, '_')), 'v2:from-ts');
    expect(slug(backend)).toBe('from-ts');
    fs.writeFileSync(path.join(state, 'slug-cache', 'marker', top.replace(/\//g, '_')), 'v2:from-bash');
    expect(slugFromEnvironment(state, backend)).toBe('from-bash');
  });

  test('repository scope ignores every marker, so a committed marker cannot move pregate policy', () => {
    const u = umbrella();
    mark(u.top);
    expect(slugFromEnvironment(state, u.backend)).toBe('MyProduct');
    expect(slugFromEnvironment(state, u.backend, { scope: 'repository' })).toBe('org-backend');
    const { proj, app } = workspace();
    const before = defaultUserConfigPath(proj);
    expect(before).toBe(path.join(state, 'projects', 'me-workspace', 'pregate.json'));
    mark(proj);
    git(['-C', proj, 'add', '.gstack-project']);
    git(['-C', proj, 'commit', '-q', '-m', 'marker']);
    expect(slugFromEnvironment(state, app)).toBe('org-proj');
    expect(slugFromEnvironment(state, app, { scope: 'repository' })).toBe('me-workspace');
    expect(defaultUserConfigPath(proj)).toBe(before);
  });

  test('a linked worktree follows the umbrella natively and stops when the marker goes', () => {
    const { top, backend } = umbrella();
    git(['-C', backend, 'commit', '-q', '--allow-empty', '-m', 'init']);
    mark(top);
    expect(slugFromEnvironment(state, backend)).toBe('MyProduct');
    const wt = path.join(home, 'elsewhere', 'wt');
    git(['-C', backend, 'worktree', 'add', '-q', wt]);
    expect(projectMarkerRoot(wt)).toBe(top);
    expect(slugFromEnvironment(state, wt)).toBe('MyProduct');
    expect(readVersionedSlugCache(state, wt)).toBe('MyProduct');
    fs.rmSync(path.join(top, '.gstack-project'));
    expect(projectMarkerRoot(wt)).toBe('');
    expect(slugFromEnvironment(state, wt)).toBe('org-backend');
    expect(slug(wt)).toBe('org-backend');
  });

  test('subfolder and $HOME markers are ignored natively too', () => {
    const { ws } = workspace();
    const sub = path.join(ws, 'docs');
    fs.mkdirSync(sub);
    mark(sub);
    mark(home);
    expect(slugFromEnvironment(state, sub)).toBe('me-workspace');
  });
});
