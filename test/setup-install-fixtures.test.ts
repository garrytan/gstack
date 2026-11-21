import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runBashScript } from './helpers/bash-script';

// A user install leaves test/fixtures/ out of its working tree (GST-3402).
// The fixtures carry eval task material (real issues from other repositories,
// held-out prompts), and a gstack install in a person's home put them in front
// of every agent session and eval arm there. setup's _trim_install_fixtures
// sets a sparse checkout on gstack's own checkout for a user install only; a
// contributor's clone, CI and a checkout with the dev toolchain keep the full
// tree, and nothing the runtime loads lives under test/fixtures/.

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');
const EVAL_LINE = 'owner__repo-0000 held-out prompt';
const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });

const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CI' && k !== 'GSTACK_CONTRIBUTOR' && !k.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf-8', timeout: 30_000 });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
  return r.stdout;
}

function write(dir: string, rel: string, body: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
}

/** A bash function sliced out of setup, by its name() { line through the closing }. */
function sliceFunction(name: string): string {
  const start = SETUP.indexOf('\n' + name + '() {\n');
  if (start === -1) throw new Error(name + '() not found in setup');
  return SETUP.slice(start + 1, SETUP.indexOf('\n}\n', start) + 3);
}

/** An origin shaped like gstack: setup and VERSION at the top, fixtures beside helpers the runtime imports. */
function origin(): { base: string; repo: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-trim-'));
  bases.push(base);
  const repo = path.join(base, 'origin');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'setup', '#!/usr/bin/env bash\n');
  write(repo, 'VERSION', '1.0.0\n');
  write(repo, 'lib/a.ts', 'export const a = 1;\n');
  write(repo, 'test/helpers/paid-test-set.ts', 'export const b = 2;\n');
  write(repo, 'test/fixtures/skill-route-b1-in-sample.json', JSON.stringify({ line: EVAL_LINE }) + '\n');
  write(repo, 'test/fixtures/golden/ship.md', 'golden\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'seed');
  return { base, repo };
}

/** The README install: a shallow single-branch clone. */
function install(o: { base: string; repo: string }, name = 'install'): string {
  const dir = path.join(o.base, name);
  git(o.base, 'clone', '-q', '--depth', '1', '--single-branch', 'file://' + o.repo, dir);
  return dir;
}

function trim(cwd: string, env: Record<string, string> = {}) {
  const script = 'log() { echo "$@"; }\n' + ['_deps_role', '_deps_has_dev', '_trim_install_fixtures'].map(sliceFunction).join('\n') + '\n_trim_install_fixtures\n';
  return runBashScript(script, { cwd, env: { ...GIT_ENV, ...env } });
}

const has = (dir: string, rel: string) => fs.existsSync(path.join(dir, rel));
const clean = (dir: string) => git(dir, 'status', '--porcelain') === '';

describe.skipIf(process.platform === 'win32')('a user install leaves test/fixtures/ out', () => {
  // Value: protects=eval task material in test/fixtures/ never sits in a user's home, where every eval arm with gstack can read it;
  //   fails_when=setup stops trimming a user install, or trims test/helpers/ the runtime imports;
  //   why_new=no test looked at what a fresh install puts on disk; seam=_trim_install_fixtures sliced from setup; no_claim=the full ./setup run
  test('a fresh user install has no test/fixtures/, keeps everything else, and stays clean', () => {
    const o = origin();
    const dir = install(o);
    expect(has(dir, 'test/fixtures/skill-route-b1-in-sample.json')).toBe(true);
    const r = trim(dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('left test/fixtures/ (test and eval data) out of this install');
    expect(r.stdout).toContain('git config gstack.contributor true, then ./setup again');
    expect(has(dir, 'test/fixtures')).toBe(false);
    expect([has(dir, 'test/helpers/paid-test-set.ts'), has(dir, 'lib/a.ts'), has(dir, 'setup')]).toEqual([true, true, true]);
    expect(clean(dir)).toBe(true);
    const again = trim(dir);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toBe('');
  });

  test('upgrades keep the fixtures out: a fast-forward and a plain pull bring new fixtures to disk nowhere, and other files still move', () => {
    const o = origin();
    const dir = install(o);
    write(o.repo, 'test/fixtures/new-eval.json', EVAL_LINE + '\n');
    write(o.repo, 'lib/a.ts', 'export const a = 2;\n');
    git(o.repo, 'add', '-A');
    git(o.repo, 'commit', '-qm', 'r2');
    git(dir, 'fetch', '-q', 'origin', 'main');
    const ff = spawnSync('bash', [path.join(ROOT, 'bin', 'gstack-ff-update'), dir, 'origin/main'], { env: GIT_ENV, encoding: 'utf-8', timeout: 60_000 });
    expect(ff.status, ff.stdout + ff.stderr).toBe(0);
    expect(has(dir, 'test/fixtures/new-eval.json')).toBe(true);
    expect(trim(dir).status).toBe(0);
    expect(has(dir, 'test/fixtures')).toBe(false);

    write(o.repo, 'test/fixtures/later-eval.json', EVAL_LINE + '\n');
    write(o.repo, 'lib/a.ts', 'export const a = 3;\n');
    git(o.repo, 'add', '-A');
    git(o.repo, 'commit', '-qm', 'r3');
    git(dir, 'fetch', '-q', 'origin', 'main');
    const ff2 = spawnSync('bash', [path.join(ROOT, 'bin', 'gstack-ff-update'), dir, 'origin/main'], { env: GIT_ENV, encoding: 'utf-8', timeout: 60_000 });
    expect(ff2.status, ff2.stdout + ff2.stderr).toBe(0);
    expect(ff2.stdout).toStartWith('ok ');
    expect(has(dir, 'test/fixtures')).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'lib/a.ts'), 'utf-8')).toContain('a = 3');
    expect(clean(dir)).toBe(true);

    write(o.repo, 'test/fixtures/pulled.json', EVAL_LINE + '\n');
    write(o.repo, 'lib/a.ts', 'export const a = 4;\n');
    git(o.repo, 'add', '-A');
    git(o.repo, 'commit', '-qm', 'r4');
    git(dir, 'pull', '-q', '--ff-only', 'origin', 'main');
    expect(has(dir, 'test/fixtures')).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'lib/a.ts'), 'utf-8')).toContain('a = 4');
    expect(clean(dir)).toBe(true);
  });

  test('an edited fixture in an existing install is kept, never deleted', () => {
    const o = origin();
    const dir = install(o);
    write(dir, 'test/fixtures/golden/ship.md', 'my edit\n');
    expect(trim(dir).status).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'test/fixtures/golden/ship.md'), 'utf-8')).toBe('my edit\n');
    expect(has(dir, 'test/fixtures/skill-route-b1-in-sample.json')).toBe(false);
  });

  // Negative controls: the full tree stays wherever the tests and evals run.
  test('a contributor clone, a CI run and a checkout with the dev toolchain keep test/fixtures/', () => {
    const o = origin();
    const marked = install(o, 'marked');
    git(marked, 'config', '--local', 'gstack.contributor', 'true');
    const ci = install(o, 'ci');
    const dev = install(o, 'dev');
    write(dev, 'node_modules/typescript/package.json', '{}\n');
    const byEnv = install(o, 'by-env');
    for (const [dir, env] of [[marked, {}], [ci, { CI: 'true' }], [dev, {}], [byEnv, { GSTACK_CONTRIBUTOR: '1' }]] as const) {
      const r = trim(dir, env);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe('');
      expect(has(dir, 'test/fixtures/skill-route-b1-in-sample.json')).toBe(true);
      expect(git(dir, 'config', '--get', '--default', 'unset', 'core.sparseCheckout').trim()).toBe('unset');
    }
  });

  test('marking a trimmed install as a contributor clone brings the fixtures back', () => {
    const o = origin();
    const dir = install(o);
    expect(trim(dir).status).toBe(0);
    expect(has(dir, 'test/fixtures')).toBe(false);
    git(dir, 'config', '--local', 'gstack.contributor', 'true');
    const r = trim(dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('restored test/fixtures/');
    expect(has(dir, 'test/fixtures/skill-route-b1-in-sample.json')).toBe(true);
    expect(clean(dir)).toBe(true);
  });

  test('a vendored copy inside a project never touches the project repository, and sparse patterns someone else set stay', () => {
    const o = origin();
    const project = path.join(o.base, 'project');
    fs.mkdirSync(project);
    git(project, 'init', '-q', '-b', 'main');
    const vendored = path.join(project, '.claude', 'skills', 'gstack');
    fs.cpSync(o.repo, vendored, { recursive: true, filter: (src) => !src.includes(path.sep + '.git') });
    git(project, 'add', '-A');
    git(project, 'commit', '-qm', 'vendor gstack');
    const r = trim(vendored);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('');
    expect(has(vendored, 'test/fixtures/skill-route-b1-in-sample.json')).toBe(true);
    expect(git(project, 'config', '--get', '--default', 'unset', 'core.sparseCheckout').trim()).toBe('unset');

    const own = install(o, 'own-sparse');
    git(own, 'sparse-checkout', 'set', '--no-cone', '/*', '!/lib/');
    expect(trim(own).stdout).toBe('');
    expect(git(own, 'sparse-checkout', 'list').trim().split('\n')).toEqual(['/*', '!/lib/']);
    expect(has(own, 'test/fixtures/skill-route-b1-in-sample.json')).toBe(true);
  });

  test('setup trims its own checkout once, after the build has succeeded', () => {
    const calls = SETUP.split('\n').filter((l) => l.includes('_trim_install_fixtures') && !l.trim().startsWith('#') && !l.startsWith('_trim_install_fixtures() {'));
    expect(calls).toEqual(['(cd "$SOURCE_GSTACK_DIR" && _trim_install_fixtures)']);
    expect(SETUP.indexOf(calls[0])).toBeGreaterThan(SETUP.indexOf('gstack setup failed: browse binary missing at $BROWSE_BIN'));
  });
});

/** Relative imports and requires in a module's source. */
function relativeImports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm)) out.push(m[1]);
  return out;
}

/** Repo-relative files reached by relative import from the entries, and every import that lands in test/fixtures/. */
function fixtureImports(entries: string[], read: (rel: string) => string | null): string[] {
  const seen = new Set<string>();
  const bad: string[] = [];
  const queue = [...entries];
  while (queue.length) {
    const rel = queue.pop()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const src = read(rel);
    if (src === null || rel.endsWith('.json')) continue;
    for (const spec of relativeImports(src)) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      if (base.startsWith('test/fixtures/')) { bad.push(rel + ' -> ' + base); continue; }
      const hit = [base, base + '.ts', base + '.js', base.replace(/\.js$/, '.ts'), base + '/index.ts'].find((c) => read(c) !== null);
      if (hit) queue.push(hit);
    }
  }
  return bad;
}

describe('nothing an installed gstack loads lives under test/fixtures/', () => {
  const readRepo = (rel: string): string | null => {
    const p = path.join(ROOT, rel);
    try { return fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf-8') : null; } catch { return null; }
  };
  const walk = (dir: string): string[] => {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return [];
    return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
      const rel = dir + '/' + e.name;
      if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' ? [] : walk(rel);
      return /\.(ts|mts|js|mjs|cjs)$/.test(e.name) && !e.name.endsWith('.test.ts') ? [rel] : [];
    });
  };

  test('the static import closure of bin/, lib/, hosts/, the binaries\' sources and the build scripts never reaches test/fixtures/', () => {
    const bins = fs.readdirSync(path.join(ROOT, 'bin')).map((f) => 'bin/' + f)
      .filter((rel) => { const src = readRepo(rel); return src !== null && (rel.endsWith('.ts') || /^#!.*\bbun\b/.test(src.split('\n')[0])); });
    const entries = [...bins, ...['lib', 'hosts', 'browse/src', 'design/src', 'make-pdf/src'].flatMap(walk), 'scripts/gen-skill-docs.ts', 'scripts/discover-skills.ts'];
    expect(bins.length).toBeGreaterThan(20);
    expect(fixtureImports(entries, readRepo)).toEqual([]);
  });

  test('negative control: an import of a fixture, direct or through a helper, is caught', () => {
    const files: Record<string, string> = {
      'bin/tool.ts': "import { x } from '../lib/a';\n",
      'lib/a.ts': "export { y } from '../test/helpers/h';\n",
      'test/helpers/h.ts': "const data = require('../fixtures/eval.json');\n",
      'test/fixtures/eval.json': '{}',
    };
    expect(fixtureImports(['bin/tool.ts'], (rel) => files[rel] ?? null)).toEqual(['test/helpers/h.ts -> test/fixtures/eval.json']);
  });
});
