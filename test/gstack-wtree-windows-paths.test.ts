/**
 * #3101: gstack-wtree must fingerprint a linked worktree on Windows, where
 * `git rev-parse --git-path index|objects` answers with a drive-letter absolute
 * path (C:/…). Read as relative, that path was re-rooted under the worktree, so
 * the private-object-directory fingerprint (gstack-review-log --start, E4) lost
 * the repository's objects and /review and /ship could not record a start.
 *
 * Windows-safe by construction: gstack-wtree runs through explicit `bash <script>`,
 * never shebang execution, and paths are handed to bash in forward-slash form.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dir, '..');
const WTREE = join(ROOT, 'bin', 'gstack-wtree');
const posix = (value: string) => value.replace(/\\/g, '/');

let root = '', worktree = '', objects = '', env: NodeJS.ProcessEnv = {};
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 30_000 });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'gstack-wtree-paths-')));
  const main = join(root, 'main');
  worktree = join(root, 'linked worktree');
  objects = join(root, 'objects');
  mkdirSync(main);
  mkdirSync(objects);
  const globalConfig = join(root, 'gitconfig');
  writeFileSync(globalConfig, '');
  env = {
    ...process.env, HOME: root, USERPROFILE: root,
    GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0',
    GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined, GIT_INDEX_FILE: undefined,
    GIT_OBJECT_DIRECTORY: undefined, GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  };
  git(main, 'init', '-q');
  // A real file, so HEAD's tree lives only in the repository's object store.
  writeFileSync(join(main, 'a.txt'), 'hello\n');
  git(main, 'add', 'a.txt');
  git(main, '-c', 'user.email=fixture@example.test', '-c', 'user.name=Fixture', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  git(main, 'worktree', 'add', '-q', '--detach', worktree);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

// The review-start call shape: new objects go to a private directory the caller owns.
function expectFingerprintOfHead() {
  const result = spawnSync('bash', [WTREE], {
    cwd: worktree, env: { ...env, GSTACK_WTREE_OBJECT_DIR: posix(objects) }, encoding: 'utf8', timeout: 30_000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(git(worktree, 'rev-parse', 'HEAD^{tree}'));
}

test('a linked worktree with a private object directory gets its fingerprint (#3101)', () => {
  expectFingerprintOfHead();
});

// Linux and macOS reproduce Git for Windows: `--git-path` answers in drive-letter
// form, and GIT_ALTERNATE_OBJECT_DIRECTORIES is one ;-separated list in which C:/…
// is absolute. Linux git splits on ':', so the shim hands that list over as one
// quoted entry, the way Windows git reads it.
test.skipIf(process.platform === 'win32')('a drive-letter --git-path answer is not re-rooted under the worktree (#3101)', () => {
  const real = JSON.stringify(Bun.which('git')!);
  const shim = join(root, 'shim');
  mkdirSync(shim);
  writeFileSync(join(shim, 'git'), `#!/usr/bin/env bash
case " $* " in *" rev-parse --git-path "*)
  out=$(${real} "$@") || exit $?
  case "$out" in /*) printf 'C:%s\\n' "$out" ;; *) printf '%s\\n' "$out" ;; esac
  exit 0 ;;
esac
if [ -n "\${GIT_ALTERNATE_OBJECT_DIRECTORIES:-}" ]; then
  export GIT_ALTERNATE_OBJECT_DIRECTORIES="\\"\${GIT_ALTERNATE_OBJECT_DIRECTORIES#C:}\\""
fi
exec ${real} "$@"
`, { mode: 0o755 });
  env.PATH = `${shim}${delimiter}${env.PATH}`;
  expect(git(worktree, 'rev-parse', '--git-path', 'objects')).toStartWith('C:/');
  expectFingerprintOfHead();
});
