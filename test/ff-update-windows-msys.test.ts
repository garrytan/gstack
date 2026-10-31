/**
 * #3468: gstack-ff-update stages its capture indexes under a mktemp
 * directory and hands them to git as GIT_INDEX_FILE. With MSYS path
 * conversion off (MSYS_NO_PATHCONV=1, common for docker), Git for Windows got
 * the raw /tmp/... path and could not open it, so an install could not move.
 *
 * Windows-safe by construction: gstack-ff-update runs through
 * lib/script-invocation.ts (Git Bash on win32), fixtures live under os.tmpdir().
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runScriptSync } from '../lib/script-invocation';

const ROOT = path.resolve(import.meta.dir, '..');
let base = '';
let env: NodeJS.ProcessEnv = {};
const posix = (p: string) => p.replace(/\\/g, '/');

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 30_000 });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ff-msys-')));
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = t\n\temail = t@t\n[commit]\n\tgpgsign = false\n');
  env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined };
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

test('an install moves to a new release with MSYS path conversion off (#3468)', () => {
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const install = path.join(base, 'install');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  fs.mkdirSync(seed);
  fs.writeFileSync(path.join(seed, 'VERSION'), '1.0.0\n');
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  git(base, 'clone', '-q', origin, install);
  fs.writeFileSync(path.join(seed, 'VERSION'), '1.1.0\n');
  git(seed, 'commit', '-q', '-am', 'release');
  git(seed, 'push', '-q', 'origin', 'main');
  git(install, 'fetch', '-q');
  fs.writeFileSync(path.join(install, 'local-note.txt'), 'kept\n');
  const r = runScriptSync(path.join(ROOT, 'bin', 'gstack-ff-update'), [posix(install), 'origin/main'], {
    cwd: base, env: { ...env, MSYS_NO_PATHCONV: '1' }, encoding: 'utf8', timeout: 120_000,
  });
  expect(r.error).toBeUndefined();
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  expect(git(install, 'rev-parse', 'HEAD')).toBe(git(seed, 'rev-parse', 'HEAD'));
  expect(fs.readFileSync(path.join(install, 'local-note.txt'), 'utf8')).toBe('kept\n');
}, 150_000);
