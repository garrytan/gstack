import { afterEach, beforeEach, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dir, '..');
const template = readFileSync(join(ROOT, 'investigate/SKILL.md.tmpl'), 'utf8');
const scope = template.split('## Scope Lock')[1].split('\n---')[0];
const acquisition = [...scope.matchAll(/```bash\n([\s\S]*?)```/g)][1][1];
const registered = template.match(/command: '(.*check-freeze\.sh.*)'/)![1].replace(/''/g, "'");
let root: string;
let a: string;
let b: string;
let state: string;
let env: NodeJS.ProcessEnv;

function bash(code: string, cwd = a, input = '') {
  return spawnSync('bash', ['-c', code], { cwd, env, input, encoding: 'utf8', timeout: 10000 });
}
function hook(cwd: string, target: string) {
  const result = bash(registered, cwd, JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: target } }));
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
function acquire(path = 'src') {
  const result = bash(acquisition.replaceAll('<detected-directory>', path));
  expect(result.status, result.stderr).toBe(0);
  return result;
}
function mutation(action: string, value = '', extra: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', [join(env.HOME!, '.claude/skills/gstack/freeze/bin/freeze-state.sh'), action, value], {
    cwd: a, env: { ...env, ...extra }, encoding: 'utf8', timeout: 10000,
  });
}
function owner() {
  const token = acquire().stdout.match(/^FREEZE_OWNER=([a-f0-9]{32})$/m)?.[1];
  expect(token).toBeDefined();
  return token!;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'freeze-owner-'));
  a = join(root, 'a'); b = join(root, 'b');
  mkdirSync(join(a, 'src'), { recursive: true });
  writeFileSync(join(a, 'src/file.ts'), 'fixture\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], ['worktree', 'add', '-q', '--detach', b]]) {
    const result = spawnSync('git', args, { cwd: a, encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stderr).toBe(0);
  }
  env = { ...process.env, HOME: join(root, 'home'), GSTACK_HOME: join(root, 'state'), CLAUDE_PLUGIN_DATA: '', CLAUDE_PLUGIN_ROOT: '' };
  mkdirSync(env.GSTACK_HOME!);
  state = join(env.GSTACK_HOME!, 'freeze-dir.txt');
  for (const file of ['freeze/bin/check-freeze.sh', 'freeze/bin/freeze-state.sh', 'careful/bin/hook-extract.sh', 'bin/gstack-paths']) {
    if (!existsSync(join(ROOT, file))) continue;
    const dest = join(env.HOME!, '.claude/skills/gstack', file);
    mkdirSync(dirname(dest), { recursive: true });
    expect(realpathSync(dirname(dest)).startsWith(root + '/')).toBe(true);
    copyFileSync(join(ROOT, file), dest);
    chmodSync(dest, 0o755);
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test('investigation scope keeps the original physical boundary across two worktrees', () => {
  acquire();
  expect(hook(a, join(a, 'src/file.ts')).hookSpecificOutput).toBeUndefined();
  expect(hook(b, join(a, 'src/file.ts')).hookSpecificOutput).toBeUndefined();
  expect(hook(b, join(b, 'src/file.ts')).hookSpecificOutput?.permissionDecision).toBe('deny');
  expect(readFileSync(state, 'utf8').split('\n')[0]).toBe(realpathSync(join(a, 'src')));
});
test('pre-existing user boundary survives an investigation unchanged', () => {
  const previous = join(b, 'src') + '/\n';
  writeFileSync(state, previous);
  acquire();
  expect(readFileSync(state, 'utf8')).toBe(previous);
  expect(hook(a, join(a, 'src/file.ts')).hookSpecificOutput?.permissionDecision).toBe('deny');
});
test('legacy relative state is preserved and requires explicit recovery, never rebound to cwd', () => {
  writeFileSync(state, 'src/\n');
  const result = hook(b, join(b, 'src/file.ts'));
  expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
  expect(result.hookSpecificOutput?.permissionDecisionReason).toContain('absolute');
  expect(readFileSync(state, 'utf8')).toBe('src/\n');
});
test('legacy absolute boundary remains a valid unchanged control', () => {
  writeFileSync(state, join(a, 'src') + '/\n');
  expect(hook(b, join(a, 'src/file.ts')).hookSpecificOutput).toBeUndefined();
  expect(hook(b, join(b, 'src/file.ts')).hookSpecificOutput?.permissionDecision).toBe('deny');
});
test('owned filesystem-root boundary allows descendants without altering its owner', () => {
  const acquired = acquire('/');
  const token = acquired.stdout.match(/^FREEZE_OWNER=([a-f0-9]{32})$/m)![1];
  const before = readFileSync(state, 'utf8');
  expect(hook(a, join(a, 'src/file.ts')).hookSpecificOutput).toBeUndefined();
  expect(hook(b, join(b, 'src/new.ts')).hookSpecificOutput).toBeUndefined();
  expect(readFileSync(state, 'utf8')).toBe(before);
  expect(mutation('release', token).status).toBe(0);
  expect(existsSync(state)).toBe(false);
});
test('legacy root spellings retain their absolute-root meaning', () => {
  for (const boundary of ['/', '///']) {
    writeFileSync(state, boundary + '\n');
    expect(hook(a, join(a, 'src/file.ts')).hookSpecificOutput).toBeUndefined();
    expect(readFileSync(state, 'utf8')).toBe(boundary + '\n');
  }
});

for (const ending of ['completion', 'explicit abort', 'known ending error']) {
  test(`${ending}: emitted terminal cleanup releases only the acquired token`, () => {
    const token = owner();
    const cleanup = [...scope.matchAll(/```bash\n([\s\S]*?)```/g)][2][1];
    expect(bash(cleanup.replace('<retained-owner-token>', token)).status).toBe(0);
    expect(existsSync(state)).toBe(false);
    expect(hook(b, join(b, 'src/file.ts')).hookSpecificOutput).toBeUndefined();
    expect(mutation('release', token).status).toBe(0);
  });
}
test('same-path and different-path successors survive stale-owner cleanup', () => {
  for (const path of [join(a, 'src'), join(b, 'src')]) {
    mutation('clear');
    const token = owner();
    expect(mutation('set', path).status).toBe(0);
    const successor = readFileSync(state, 'utf8');
    expect(mutation('release', token).stdout).toContain('FREEZE_PRESERVED');
    expect(readFileSync(state, 'utf8')).toBe(successor);
  }
});
test('cleanup-before-replacement and unfreeze-before-cleanup preserve the last writer', () => {
  const token = owner();
  expect(mutation('release', token).status).toBe(0);
  expect(mutation('set', join(b, 'src')).status).toBe(0);
  const successor = readFileSync(state, 'utf8');
  expect(mutation('release', token).status).toBe(0);
  expect(readFileSync(state, 'utf8')).toBe(successor);
  expect(mutation('clear').status).toBe(0);
  expect(mutation('release', token).status).toBe(0);
  expect(existsSync(state)).toBe(false);
});
test('a symlinked input is pinned physically even after the link changes', () => {
  symlinkSync(join(a, 'src'), join(a, 'linked'));
  acquire('linked');
  rmSync(join(a, 'linked'));
  symlinkSync(join(b, 'src'), join(a, 'linked'));
  expect(hook(b, join(a, 'src/file.ts')).hookSpecificOutput).toBeUndefined();
  expect(hook(b, join(b, 'src/file.ts')).hookSpecificOutput?.permissionDecision).toBe('deny');
});
test('foreign and malformed legacy state survives both acquisition and release', () => {
  for (const previous of ['src/\n', `${join(b, 'src')}\nforeign-owner\n`]) {
    writeFileSync(state, previous);
    expect(acquire().stdout).toContain('FREEZE_PRESERVED');
    expect(mutation('release', 'f'.repeat(32)).stdout).toContain('FREEZE_PRESERVED');
    expect(readFileSync(state, 'utf8')).toBe(previous);
  }
});
test('invalid directories and owner tokens do not alter the existing boundary', () => {
  owner();
  const previous = readFileSync(state, 'utf8');
  expect(mutation('set', 'does-not-exist').status).not.toBe(0);
  expect(mutation('release', '').status).not.toBe(0);
  expect(readFileSync(state, 'utf8')).toBe(previous);
  expect(existsSync(join(env.GSTACK_HOME!, '.freeze-mutation.lock'))).toBe(false);
});
test('all mutation operations preserve state while a writer holds the mutex', () => {
  const token = owner();
  const previous = readFileSync(state, 'utf8');
  mkdirSync(join(env.GSTACK_HOME!, '.freeze-mutation.lock'));
  for (const [action, value] of [['acquire', 'src'], ['set', 'src'], ['release', token], ['clear', '']]) {
    const result = mutation(action, value);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FREEZE_BUSY');
    expect(readFileSync(state, 'utf8')).toBe(previous);
  }
});
test('a replacement cannot interleave after owner comparison but before removal', async () => {
  const token = owner();
  const bin = join(root, 'barrier-bin');
  mkdirSync(bin);
  const arrived = join(root, 'arrived');
  const proceed = join(root, 'proceed');
  writeFileSync(join(bin, 'rm'), `#!/bin/sh\nprintf ready > '${arrived}'\nwhile [ ! -e '${proceed}' ]; do /bin/sleep 0.02; done\nexec /bin/rm "$@"\n`, { mode: 0o755 });
  const child = spawn('bash', [join(env.HOME!, '.claude/skills/gstack/freeze/bin/freeze-state.sh'), 'release', token], {
    cwd: a, env: { ...env, PATH: `${bin}:${env.PATH}` }, stdio: 'ignore', timeout: 5000,
  });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  try {
    for (let i = 0; i < 200 && !existsSync(arrived); i++) await Bun.sleep(10);
    expect(existsSync(arrived)).toBe(true);
    expect(mutation('set', join(b, 'src')).status).toBe(1);
    writeFileSync(proceed, 'continue');
    expect(await exited).toBe(0);
    expect(mutation('set', join(b, 'src')).status).toBe(0);
    const successor = readFileSync(state, 'utf8');
    expect(mutation('release', token).status).toBe(0);
    expect(readFileSync(state, 'utf8')).toBe(successor);
    expect(hook(a, join(b, 'src/file.ts')).hookSpecificOutput).toBeUndefined();
  } finally { writeFileSync(proceed, 'continue'); await exited; }
});
test('all skill writers use the coordinated helper, never raw file mutations', () => {
  for (const name of ['investigate', 'freeze', 'guard', 'unfreeze']) {
    const content = readFileSync(join(ROOT, name, 'SKILL.md.tmpl'), 'utf8');
    expect(content).toContain('freeze/bin/freeze-state.sh');
    expect(content).not.toMatch(/(?:>|rm[^\n]*)[^\n]*freeze-dir\.txt/);
  }
});
test('the writer and registered callback agree on a newline-bearing state root', () => {
  env.GSTACK_HOME = join(root, 'state\n');
  state = join(env.GSTACK_HOME, 'freeze-dir.txt');
  const result = mutation('acquire', join(a, 'src'));
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(state)).toBe(true);
  expect(hook(b, join(a, 'src/file.ts')).hookSpecificOutput).toBeUndefined();
  expect(hook(b, join(b, 'src/file.ts')).hookSpecificOutput?.permissionDecision).toBe('deny');
});
test('a newline-bearing boundary is rejected rather than silently truncated', () => {
  const boundary = join(a, 'src\n');
  mkdirSync(boundary);
  expect(mutation('acquire', boundary).status).toBe(2);
  expect(existsSync(state)).toBe(false);
});
test('an owned physical boundary preserves trailing spaces exactly', () => {
  const boundary = join(a, 'src ');
  mkdirSync(boundary);
  expect(mutation('acquire', boundary).status).toBe(0);
  expect(hook(b, join(boundary, 'file.ts')).hookSpecificOutput).toBeUndefined();
  expect(hook(b, join(a, 'src/file.ts')).hookSpecificOutput?.permissionDecision).toBe('deny');
});
