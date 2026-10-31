/**
 * #2805: /ship's opted-in pre-push guard must install in a linked worktree on
 * Windows, where `git rev-parse --git-path hooks` returns an absolute path in a
 * different spelling (C:/… or C:\…) than Git Bash's `pwd` (/c/…). The guard
 * decides from git's own answers (core.hooksPath unset, hooks directory not a
 * link), never by string-matching two path spellings.
 *
 * Windows-safe by construction: helpers run through explicit `bash <script>` and
 * Bun argv, never shebang execution, and paths are handed to bash in forward-slash form.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dir, '..');
const HELPERS = join(ROOT, 'bin');
const posix = (value: string) => value.replace(/\\/g, '/');
const template = readFileSync(join(ROOT, 'ship/SKILL.md.tmpl'), 'utf8');
const block = template.match(/```bash\n(_REDACT_PREPUSH=[\s\S]*?)```/)![1];
const installed = '~/.claude/skills/gstack/bin/';
const guard = block
  .replaceAll(`${installed}gstack-config`, 'bash "$GSTACK_TEST_HELPERS/gstack-config"')
  .replaceAll(`${installed}gstack-paths`, 'bash "$GSTACK_TEST_HELPERS/gstack-paths"')
  .replaceAll(`${installed}gstack-redact`, '"$GSTACK_TEST_BUN" "$GSTACK_TEST_HELPERS/gstack-redact"');

let root = '', main = '', worktree = '', env: NodeJS.ProcessEnv = {};
// Windows Free Tests 41190552162: the file's first setup passed the 30 s hook budget (the next took 5 s, the retry
// 0.4 s), and a killed child reads only as status null, so each failure names how long every setup spawn took.
let spawns: string[] = [];
const run = (command: string, args: string[], cwd: string) => {
  const started = performance.now();
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 30_000 });
  spawns.push(`${command}: ${Math.round(performance.now() - started)} ms`);
  return result;
};
const spawnLog = (result: { stderr: string }) => `${result.stderr}\nspawns: ${spawns.join(', ')}`;
const git = (cwd: string, ...args: string[]) => {
  const result = run('git', args, cwd);
  expect(result.status, spawnLog(result)).toBe(0);
  return result.stdout.trim();
};

beforeEach(() => {
  spawns = [];
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ship-hook-paths-')));
  main = join(root, 'main');
  worktree = join(root, 'linked worktree');
  mkdirSync(main);
  const globalConfig = join(root, 'gitconfig');
  writeFileSync(globalConfig, '');
  env = {
    ...process.env, HOME: root, USERPROFILE: root, GSTACK_HOME: join(root, 'state'), GSTACK_STATE_ROOT: join(root, 'state'),
    CLAUDE_PLUGIN_DATA: '', GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0',
    GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined,
    GSTACK_TEST_HELPERS: posix(HELPERS), GSTACK_TEST_BUN: posix(process.execPath),
  };
  git(main, 'init', '-q');
  git(main, '-c', 'user.email=fixture@example.test', '-c', 'user.name=Fixture', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture');
  git(main, 'worktree', 'add', '-q', '--detach', worktree);
  const opted = run('bash', [join(HELPERS, 'gstack-config'), 'set', 'redact_prepush_hook', 'true'], main);
  expect(opted.status, spawnLog(opted)).toBe(0);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function expectInstalledFromWorktree() {
  const hooks = git(worktree, 'rev-parse', '--git-path', 'hooks');
  expect(resolve(worktree, hooks)).toBe(resolve(main, '.git', 'hooks'));
  const result = run('bash', ['-c', guard], worktree);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('REDACT_PREPUSH: true');
  expect(result.stdout).toContain('HOOKS_IN_GIT_DIR: yes');
  expect(readFileSync(join(main, '.git', 'hooks', 'pre-push'), 'utf8')).toContain('# gstack-redact pre-push (managed)');
}

test('the guard under test still calls each installed helper', () => {
  for (const helper of ['gstack-config', 'gstack-paths', 'gstack-redact']) expect(block).toContain(installed + helper);
  expect(guard).not.toContain(installed);
});

test('an opted-in linked worktree installs the guard into the common hooks directory (#2805)', () => {
  expectInstalledFromWorktree();
});

// Linux and macOS reproduce the Windows mismatch by returning the same absolute
// hooks directory in another spelling, as Git for Windows does for `--git-path`.
test.skipIf(process.platform === 'win32')('a differently spelled absolute hooks path still installs (#2805)', () => {
  const shim = join(root, 'shim');
  mkdirSync(shim);
  writeFileSync(join(shim, 'git'), `#!/usr/bin/env bash
if [ "$1" = rev-parse ] && [ "$2" = --git-path ]; then
  out=$(${JSON.stringify(Bun.which('git')!)} "$@") || exit $?
  case "$out" in /*) printf '/%s\\n' "$out" ;; *) printf '%s\\n' "$out" ;; esac
  exit 0
fi
exec ${JSON.stringify(Bun.which('git')!)} "$@"
`, { mode: 0o755 });
  env.PATH = `${shim}${delimiter}${env.PATH}`;
  expect(git(worktree, 'rev-parse', '--git-path', 'hooks')).toStartWith('//');
  expectInstalledFromWorktree();
});
