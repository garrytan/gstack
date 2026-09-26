import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, realpathSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dir, '..');
const template = readFileSync(join(ROOT, 'ship/SKILL.md.tmpl'), 'utf8');
const guard = template.match(/```bash\n(_REDACT_PREPUSH=[\s\S]*?)```/)![1];
let root: string;
let repo: string;
let hook: string;
let env: NodeJS.ProcessEnv;

function shell(code: string, input = '') {
  return spawnSync('bash', ['-c', code], { cwd: repo, env, input, encoding: 'utf8', timeout: 10000 });
}

function git(...args: string[]) {
  const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8', timeout: 10000 });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function writeFixture(file: string, content: string) {
  const target = lstatSync(file, { throwIfNoEntry: false }) ? realpathSync(file) : join(realpathSync(dirname(file)), basename(file));
  const within = relative(realpathSync(root), target);
  expect(within.startsWith('..') || isAbsolute(within)).toBe(false);
  writeFileSync(file, content, { mode: 0o755 });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ship-hook-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  env = { ...process.env, HOME: root, GSTACK_HOME: join(root, 'state'), GSTACK_STATE_ROOT: join(root, 'state'), CLAUDE_PLUGIN_DATA: '',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0',
    GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined,
    PATH: `${dirname(process.execPath)}:${process.env.PATH}` };
  git('init', '-q');
  hook = join(repo, '.git/hooks/pre-push');
  const bin = join(root, '.claude/skills/gstack/bin');
  mkdirSync(bin, { recursive: true });
  writeFixture(join(bin, 'gstack-config'), `#!/bin/sh\nexec bash "${join(ROOT, 'bin/gstack-config')}" "$@"\n`);
  writeFixture(join(bin, 'gstack-redact'), `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, 'bin/gstack-redact')}" "$@"\n`);
  expect(shell('~/.claude/skills/gstack/bin/gstack-config set redact_prepush_hook true').status).toBe(0);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const old = `#!/usr/bin/env bash
# gstack-redact pre-push (managed)
_input="$(cat)"
_local="$(git rev-parse --git-path hooks/pre-push.local)"
printf '%s' "$_input" | "$_local" "$@"
`;
const refs = 'refs/heads/a aaaa refs/heads/a bbbb\nrefs/heads/b cccc refs/heads/b dddd\n';

test('the generated ship caller matches the template block under test', () => {
  const generated = readFileSync(join(ROOT, 'ship/SKILL.md'), 'utf8');
  expect(generated.match(/```bash\n(_REDACT_PREPUSH=[\s\S]*?)```/)![1]).toBe(guard);
});

test('ship refreshes an opted-in old managed hook; local bytes and complete stdin survive', () => {
  writeFixture(hook, old);
  const local = '#!/bin/sh\nwhile IFS= read -r line; do printf "%s\\n" "$line" >> "$HOME/received"; done\ntest "$(wc -l < "$HOME/received")" -ne 2 || exit 42\n';
  writeFixture(hook + '.local', local);
  expect(shell('"$(git rev-parse --git-path hooks/pre-push)" origin synthetic', refs).status).toBe(0);
  expect(readFileSync(join(root, 'received'), 'utf8')).toBe(refs.split('\n')[0] + '\n');
  rmSync(join(root, 'received'));
  const result = shell(guard);
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(hook, 'utf8')).toContain('_input="$(cat; printf x)"');
  expect(readFileSync(hook + '.local', 'utf8')).toBe(local);
  const callback = shell('"$(git rev-parse --git-path hooks/pre-push)" origin synthetic', refs);
  expect(callback.status).toBe(42);
  expect(readFileSync(join(root, 'received'), 'utf8')).toBe(refs);
});

test('installer control already refreshes the old managed hook', () => {
  writeFixture(hook, old);
  expect(shell('~/.claude/skills/gstack/bin/gstack-redact install-prepush-hook').status).toBe(0);
  expect(readFileSync(hook, 'utf8')).toContain('_input="$(cat; printf x)"');
});

test('missing hooks install and current managed wrappers remain byte-identical', () => {
  const local = '#!/bin/sh\nexit 37\n';
  writeFixture(hook + '.local', local);
  expect(shell(guard).status).toBe(0);
  const current = readFileSync(hook, 'utf8');
  expect(current).toContain('_input="$(cat; printf x)"');
  expect(shell(guard).status).toBe(0);
  expect(readFileSync(hook, 'utf8')).toBe(current);
  expect(readFileSync(hook + '.local', 'utf8')).toBe(local);
  expect(shell('"$(git rev-parse --git-path hooks/pre-push)" origin synthetic', refs).status).toBe(37);
});

test.each(['false', 'invalid'])('non-opted-in value %s does not refresh', value => {
  writeFixture(hook, old);
  expect(shell(`~/.claude/skills/gstack/bin/gstack-config set redact_prepush_hook ${value}`).status).toBe(0);
  expect(shell(guard).status).toBe(0);
  expect(readFileSync(hook, 'utf8')).toBe(old);
});

test.each([
  '#!/bin/sh\nexit 42\n',
  '#!/bin/sh\n# optionally calls gstack-redact\nexit 42\n',
  '#!/bin/sh\n# gstack-redact pre-push (managed) extra\nexit 42\n',
])('unmanaged policy remains unchanged: %s', policy => {
  writeFixture(hook, policy);
  const local = '#!/bin/sh\nexit 37\n';
  writeFixture(hook + '.local', local);
  const result = shell(guard);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('HOOK_STATE: unmanaged');
  expect(readFileSync(hook, 'utf8')).toBe(policy);
  expect(readFileSync(hook + '.local', 'utf8')).toBe(local);
});

test.each([
  '# gstack-redact pre-push (managed) extra',
  '# prefix # gstack-redact pre-push (managed)',
  '# gstack-redact pre-push (managed)\r',
])('consented install preserves and chains non-owned marker line: %s', marker => {
  const policy = `#!/bin/sh\n${marker}\ncat > "$HOME/received"\nprintf '%s\\n' "$@" > "$HOME/arguments"\nexit 37\n`;
  writeFixture(hook, policy);
  expect(existsSync(hook + '.local')).toBe(false);
  const automatic = shell(guard);
  expect(automatic.status).toBe(0);
  expect(automatic.stdout).toContain('HOOK_STATE: unmanaged');
  expect(readFileSync(hook, 'utf8')).toBe(policy);
  expect(existsSync(hook + '.local')).toBe(false);
  const install = shell('~/.claude/skills/gstack/bin/gstack-redact install-prepush-hook');
  expect(install.status, install.stderr).toBe(0);
  expect(existsSync(hook + '.local')).toBe(true);
  expect(readFileSync(hook + '.local', 'utf8')).toBe(policy);
  expect(readFileSync(hook, 'utf8')).toContain('_input="$(cat; printf x)"');
  expect(shell('"$(git rev-parse --git-path hooks/pre-push)" origin synthetic', refs).status).toBe(37);
  expect(readFileSync(join(root, 'received'), 'utf8')).toBe(refs);
  expect(readFileSync(join(root, 'arguments'), 'utf8')).toBe('origin\nsynthetic\n');
});

test.each(['.husky', '.git/custom-hooks', '.git/hooks', ''])('explicit hooksPath %s never authorizes automatic refresh', hooksPath => {
  git('config', 'core.hooksPath', hooksPath);
  const custom = resolve(repo, hooksPath);
  mkdirSync(custom, { recursive: true });
  const customHook = join(custom, 'pre-push');
  writeFixture(customHook, old);
  const local = '#!/bin/sh\nexit 37\n';
  writeFixture(customHook + '.local', local);
  const result = shell(guard);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('HOOKS_IN_GIT_DIR: no');
  expect(readFileSync(customHook, 'utf8')).toBe(old);
  expect(readFileSync(customHook + '.local', 'utf8')).toBe(local);
});

test('global absolute hooksPath preserves managed wrapper and local policy', () => {
  const custom = join(root, 'custom-hooks');
  mkdirSync(custom);
  env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig');
  git('config', '--global', 'core.hooksPath', custom);
  writeFixture(join(custom, 'pre-push'), old);
  const local = '#!/bin/sh\nexit 37\n';
  writeFixture(join(custom, 'pre-push.local'), local);
  expect(shell(guard).status).toBe(0);
  expect(readFileSync(join(custom, 'pre-push'), 'utf8')).toBe(old);
  expect(readFileSync(join(custom, 'pre-push.local'), 'utf8')).toBe(local);
  expect(existsSync(hook)).toBe(false);
});

test('a config lookup error never authorizes automatic refresh', () => {
  writeFixture(hook, old);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFixture(join(bin, 'git'), `#!/bin/sh\nif [ "\${1}" = config ] && [ "\${2}" = --get ]; then exit 2; fi\nexec "${Bun.which('git')}" "$@"\n`);
  env.PATH = `${bin}:${env.PATH}`;
  const result = shell(guard);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('HOOKS_IN_GIT_DIR: no');
  expect(readFileSync(hook, 'utf8')).toBe(old);
});

test('an invalid repository cannot invoke the installer', () => {
  repo = root;
  const result = shell(guard);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('HOOKS_IN_GIT_DIR: no');
  expect(existsSync(join(root, 'hooks'))).toBe(false);
});

test.each([false, true])('a hook symlink is never followed, dangling=%s', dangling => {
  const target = join(root, 'policy');
  if (!dangling) writeFixture(target, old);
  symlinkSync(target, hook);
  if (!dangling) expect(realpathSync(hook)).toBe(realpathSync(target));
  const result = shell(guard);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('HOOK_STATE: unmanaged');
  expect(lstatSync(hook).isSymbolicLink()).toBe(true);
  if (!dangling) expect(readFileSync(target, 'utf8')).toBe(old);
  else expect(existsSync(target)).toBe(false);
});

test('a symlinked hooks directory is never refreshed', () => {
  const target = join(root, 'linked-hooks');
  mkdirSync(target);
  writeFixture(join(target, 'pre-push'), old);
  rmSync(dirname(hook), { recursive: true });
  symlinkSync(target, dirname(hook));
  expect(realpathSync(dirname(hook))).toBe(realpathSync(target));
  const result = shell(guard);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('HOOKS_IN_GIT_DIR: no');
  expect(readFileSync(join(target, 'pre-push'), 'utf8')).toBe(old);
});

test('a non-file hook is unmanaged', () => {
  mkdirSync(hook);
  const result = shell(guard);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('HOOK_STATE: unmanaged');
  expect(lstatSync(hook).isDirectory()).toBe(true);
});

test('installer failure stops the caller before subsequent commands', () => {
  const bin = join(root, '.claude/skills/gstack/bin/gstack-redact');
  writeFixture(bin, '#!/bin/sh\nexit 31\n');
  const result = shell(guard + '\nprintf CONTINUED\n');
  expect(result.status).toBe(31);
  expect(result.stdout).not.toContain('CONTINUED');
});

test('ordinary linked-worktree hooks refresh in the common git directory', () => {
  const seed = spawnSync('git', ['-c', `core.hooksPath=${join(repo, '.git/hooks')}`, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture'], {
    cwd: repo, env: { ...env, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: undefined },
    encoding: 'utf8', timeout: 10000,
  });
  expect(seed.status, seed.stderr).toBe(0);
  const worktree = join(root, 'worktree');
  git('worktree', 'add', '-q', '--detach', worktree);
  writeFixture(hook, old);
  repo = worktree;
  expect(realpathSync(dirname(git('rev-parse', '--git-path', 'hooks/pre-push')))).toBe(realpathSync(dirname(hook)));
  expect(shell(guard).status).toBe(0);
  expect(readFileSync(hook, 'utf8')).toContain('_input="$(cat; printf x)"');
});
