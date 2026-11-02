/**
 * Fixture for gstack-ship-preflight and gstack-ship-release tests (GSTA-167 PR 4): a bare
 * origin and a clone under the OS temp directory, outside this checkout, with an explicit
 * seed identity on every repository, a private state root, and a stub gh on PATH whose
 * output a test sets.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..', '..');
export const PREFLIGHT = path.join(ROOT, 'bin', 'gstack-ship-preflight');
export const RELEASE = path.join(ROOT, 'bin', 'gstack-ship-release');

export interface ShipFx {
  root: string; work: string; origin: string; state: string;
  git(...args: string[]): { status: number | null; stdout: string; stderr: string };
  write(files: Record<string, string>): void;
  commit(msg: string): void;
  /** Push to origin/main from a second clone, moving the base under the feature branch. */
  advanceBase(files: Record<string, string>): void;
  gh(script: string): void;
  run(bin: string, args: string[], extraEnv?: Record<string, string>): { status: number | null; stdout: string; stderr: string };
  cleanup(): void;
}

/** origin's URL as a GitHub remote; the clone's insteadOf maps it to the bare repository, so gh calls see a GitHub repo and git still works offline. */
export const GITHUB_URL = 'https://github.com/fx/fx.git';

const IDENTITY = ['-c', 'user.email=fixture@example.com', '-c', 'user.name=Fixture', '-c', 'commit.gpgsign=false'];

export function shipFixture(base: Record<string, string> = {}, feat: Record<string, string> = { 'src/b.ts': 'export const b = 2;\n' }): ShipFx {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ship-bin-')));
  if (!path.relative(ROOT, root).startsWith('..')) throw new Error('fixture must live outside the checkout');
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const state = path.join(root, 'state');
  const stub = path.join(root, 'stub');
  fs.mkdirSync(stub, { recursive: true });
  const gitIn = (cwd: string, args: string[]) => {
    const r = spawnSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8', timeout: 30_000 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const writeIn = (dir: string, files: Record<string, string>) => {
    for (const [p, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t); }
  };
  const must = (r: { status: number | null; stderr: string }, what: string) => { if (r.status !== 0) throw new Error(`${what}: ${r.stderr}`); };
  must(gitIn(root, ['init', '-q', '--bare', '-b', 'main', origin]), 'init origin');
  must(gitIn(root, ['clone', '-q', origin, work]), 'clone');
  writeIn(work, { VERSION: '1.0.0.0\n', 'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n- pending\n', 'package.json': '{"name":"fx","version":"1.0.0"}\n',
    'README.md': '# Fx\n', 'src/a.ts': 'export const a = 1;\n', ...base });
  must(gitIn(work, ['add', '-A']), 'add'); must(gitIn(work, ['commit', '-qm', 'base']), 'seed commit');
  must(gitIn(work, ['push', '-q', 'origin', 'main']), 'push base'); gitIn(work, ['remote', 'set-head', 'origin', 'main']);
  must(gitIn(work, ['config', `url.${origin}.insteadOf`, GITHUB_URL]), 'insteadOf'); must(gitIn(work, ['config', 'remote.origin.url', GITHUB_URL]), 'github origin');
  must(gitIn(work, ['checkout', '-qb', 'feat']), 'branch');
  writeIn(work, feat);
  must(gitIn(work, ['add', '-A']), 'add feat'); must(gitIn(work, ['commit', '-qm', 'feat']), 'feat commit');
  const { GSTACK_SESSION_KIND: _k, GSTACK_HEADLESS: _h, OPENCLAW_SESSION: _o, CI: _c, GITHUB_ACTIONS: _g, ...ambient } = process.env;
  const env = { ...ambient, PATH: `${stub}:${process.env.PATH}`, GSTACK_STATE_ROOT: state, GSTACK_HOME: state, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GSTACK_SESSION_KIND: 'interactive' };
  fs.writeFileSync(path.join(root, 'gitconfig'), '[commit]\n\tgpgsign = false\n');
  const fx: ShipFx = {
    root, work, origin, state,
    git: (...args) => gitIn(work, args),
    write: files => writeIn(work, files),
    commit: msg => { must(gitIn(work, ['add', '-A']), 'add'); must(gitIn(work, ['commit', '-qm', msg]), msg); },
    advanceBase: files => {
      const other = fs.mkdtempSync(path.join(root, 'other-'));
      must(gitIn(root, ['clone', '-q', origin, other]), 'clone other');
      writeIn(other, files);
      must(gitIn(other, ['add', '-A']), 'add'); must(gitIn(other, ['commit', '-qm', 'base moves']), 'base moves'); must(gitIn(other, ['push', '-q', 'origin', 'main']), 'push');
    },
    gh: script => { fs.writeFileSync(path.join(stub, 'gh'), `#!/bin/sh\n${script}\n`, { mode: 0o755 }); },
    run: (bin, args, extraEnv = {}) => {
      const r = spawnSync(bin, args, { cwd: work, encoding: 'utf8', timeout: 300_000, env: { ...env, ...extraEnv } });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
  fx.gh('exit 0');
  return fx;
}

export const lineOf = (out: string, key: string) => out.split('\n').find(l => l.startsWith(`${key}: `)) ?? '';
