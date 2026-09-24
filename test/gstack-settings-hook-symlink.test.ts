import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { canRevokeReads } from './helpers/fs-caps';

const hook = path.resolve(import.meta.dir, '../bin/gstack-settings-hook');
let root: string;
let target: string;
let settings: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-link-')));
  fs.mkdirSync(path.join(root, 'config'));
  fs.mkdirSync(path.join(root, 'dotfiles'));
  target = path.join(root, 'dotfiles/settings.json');
  settings = path.join(root, 'config/settings.json');
  fs.writeFileSync(target, '{"theme":"dark","hooks":{}}\n', { mode: 0o600 });
  fs.symlinkSync('../dotfiles/settings.json', settings);
  expect(fs.realpathSync(settings)).toBe(target);
  expect(target.startsWith(root + path.sep)).toBe(true);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function env(file = settings) {
  return { ...process.env, HOME: root, GSTACK_HOME: path.join(root, 'state'), GSTACK_SETTINGS_FILE: file };
}

function addArgs(source = 'link-test') {
  return ['add-event', '--event', 'PostToolUse', '--command', '/fixture/hook', '--source', source];
}

function run(args: string[], file = settings) {
  return spawnSync('bash', [hook, ...args], { env: env(file), encoding: 'utf8', timeout: 10_000 });
}

function runWithRealpathFailure(args: string[], code: string, afterTemp = false) {
  const fakeBin = path.join(root, 'bin');
  const preload = path.join(root, 'realpath-permission.ts');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(preload, `const fs = require('fs');
const original = fs.realpathSync;
fs.realpathSync = (file, ...args) => {
  if (String(file) === process.env.GSTACK_SETTINGS_INPUT && (!${afterTemp} || (process.env.GSTACK_TMP_PATH && fs.existsSync(process.env.GSTACK_TMP_PATH)))) {
    throw Object.assign(new Error('synthetic realpath permission failure'), { code: ${JSON.stringify(code)} });
  }
  return original(file, ...args);
};
`);
  fs.writeFileSync(path.join(fakeBin, 'bun'), '#!/bin/sh\nexec "$ACTUAL_BUN" --preload "$FS_PROBE" "$@"\n', { mode: 0o755 });
  return spawnSync('bash', [hook, ...args], {
    env: { ...env(), PATH: fakeBin + path.delimiter + process.env.PATH, ACTUAL_BUN: process.execPath, FS_PROBE: preload },
    encoding: 'utf8', timeout: 10_000,
  });
}

describe('settings hook preserves the resolved settings target', () => {
  test('add, ensure and remove preserve the link, real target and private mode', () => {
    const add = run(addArgs());
    expect(add.status, add.stderr).toBe(0);
    expect(fs.lstatSync(settings).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(settings)).toBe('../dotfiles/settings.json');
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).hooks.PostToolUse[0]._gstack_source).toBe('link-test');
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    const before = fs.readFileSync(target, 'utf8');
    const ensure = run(['ensure-event', ...addArgs().slice(1)]);
    expect(ensure.status, ensure.stderr).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
    const remove = run(['remove-source', '--source', 'link-test']);
    expect(remove.status, remove.stderr).toBe(0);
    expect(fs.lstatSync(settings).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).theme).toBe('dark');
    expect(fs.readFileSync(target, 'utf8')).not.toContain('link-test');
  });

  test('backup and rollback are siblings of the real target, not the link', () => {
    const original = fs.readFileSync(target, 'utf8');
    const add = run(addArgs());
    expect(add.status, add.stderr).toBe(0);
    expect(fs.existsSync(target + '.bak-latest')).toBe(true);
    expect(fs.existsSync(settings + '.bak-latest')).toBe(false);
    const rollback = run(['rollback']);
    expect(rollback.status, rollback.stderr).toBe(0);
    expect(fs.lstatSync(settings).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe(original);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  test('different aliases contend for the same target lock', () => {
    fs.mkdirSync(target + '.lock');
    fs.writeFileSync(target + '.lock/owner', 'fixture-owner');
    const result = spawnSync('bash', [hook, ...addArgs()], {
      env: { ...env(), GSTACK_SETTINGS_LOCK_TIMEOUT_MS: '100' },
      encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).toBe(5);
    expect(result.stderr).toContain('could not acquire lock');
    expect(fs.lstatSync(settings).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).not.toContain('link-test');
    expect(fs.existsSync(settings + '.lock')).toBe(false);
  });

  test('dangling and cyclic links are rejected without replacing them', () => {
    fs.unlinkSync(target);
    const dangling = run(addArgs());
    expect(dangling.status).not.toBe(0);
    expect(fs.lstatSync(settings).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    fs.symlinkSync('../config/settings.json', target);
    const cyclic = run(addArgs());
    expect(cyclic.status).not.toBe(0);
    expect(fs.lstatSync(settings).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
  });

  test('malformed linked settings stay unchanged', () => {
    fs.writeFileSync(target, '{not json');
    const result = run(addArgs());
    expect(result.status).toBe(3);
    expect(fs.lstatSync(settings).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('{not json');
  });

  test('a missing ordinary settings file can still be created', () => {
    const fresh = path.join(root, 'config/fresh.json');
    const result = run(addArgs(), fresh);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.lstatSync(fresh).isFile()).toBe(true);
    expect(JSON.parse(fs.readFileSync(fresh, 'utf8')).hooks.PostToolUse).toHaveLength(1);
    expect(fs.statSync(fresh).mode & 0o777).toBe(0o600);
  });

  test('read-only commands and absent-parent no-ops do not create files', () => {
    expect(run(addArgs()).status).toBe(0);
    const original = fs.readFileSync(target, 'utf8');
    const siblings = fs.readdirSync(path.dirname(target));
    expect(run(['list-sources']).stdout).toContain('link-test');
    expect(run(['list-items', '--event', 'PostToolUse']).stdout).toContain('/fixture/hook');
    expect(run(['diff-event', ...addArgs().slice(1)]).status).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe(original);
    expect(fs.readdirSync(path.dirname(target))).toEqual(siblings);
    expect(fs.lstatSync(settings).isSymbolicLink()).toBe(true);
    const missing = path.join(root, 'absent/config/settings.json');
    expect(run(['list-sources'], missing).status).toBe(0);
    expect(run(['remove-source', '--source', 'link-test'], missing).status).toBe(0);
    expect(fs.existsSync(path.join(root, 'absent'))).toBe(false);
  });

  test('legacy add, remove and prune-stale use the real target', () => {
    const command = path.join(root, 'missing/bin/gstack-session-update');
    expect(run(['add', command]).status).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toContain(command);
    expect(run(['remove', command]).status).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).not.toContain(command);
    expect(run(['add', command]).status).toBe(0);
    expect(run(['prune-stale']).status).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).not.toContain(command);
    expect(fs.lstatSync(settings).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).theme).toBe('dark');
  });

  test.skipIf(!canRevokeReads())('an unreadable linked target stays untouched', () => {
    const original = fs.readFileSync(target, 'utf8');
    fs.chmodSync(target, 0o000);
    try {
      const result = run(addArgs());
      expect(result.status, result.stderr).toBe(3);
      expect(result.stderr).toContain('cannot read');
      expect(fs.lstatSync(settings).isSymbolicLink()).toBe(true);
      expect(fs.readdirSync(path.dirname(target))).toEqual(['settings.json']);
    } finally {
      fs.chmodSync(target, 0o600);
    }
    expect(fs.readFileSync(target, 'utf8')).toBe(original);
  });

  for (const code of ['EACCES', 'EPERM']) {
    test(`a ${code} realpath failure keeps the unreadable-settings exit contract`, () => {
      const original = fs.readFileSync(target, 'utf8');
      const result = runWithRealpathFailure(addArgs(), code);
      expect(result.status, result.stderr).toBe(3);
      expect(result.stderr).toContain('cannot read');
      expect(fs.lstatSync(settings).isSymbolicLink()).toBe(true);
      expect(fs.readdirSync(path.dirname(target))).toEqual(['settings.json']);
      expect(fs.readFileSync(target, 'utf8')).toBe(original);
    });
  }

  for (const action of ['add-event', 'rollback']) {
    test(`a late permission failure during ${action} removes its temporary settings copy`, () => {
      if (action === 'rollback') expect(run(addArgs()).status).toBe(0);
      const original = fs.readFileSync(target, 'utf8');
      const result = runWithRealpathFailure(action === 'rollback' ? ['rollback'] : addArgs(), 'EACCES', true);
      expect(result.status, result.stderr).toBe(3);
      expect(result.stderr).toContain('cannot read');
      expect(fs.lstatSync(settings).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(target, 'utf8')).toBe(original);
      expect(fs.readdirSync(path.dirname(target)).filter(name => name.startsWith('settings.json.tmp.'))).toEqual([]);
    });
  }

  test('concurrent writes through file and directory aliases both survive', async () => {
    const directoryAlias = path.join(root, 'linked-directory');
    fs.symlinkSync('dotfiles', directoryAlias);
    const directorySettings = path.join(directoryAlias, 'settings.json');
    expect(fs.realpathSync(directorySettings)).toBe(target);
    const first = Bun.spawn(['bash', hook, ...addArgs()], { env: env(), stdout: 'pipe', stderr: 'pipe' });
    const second = Bun.spawn(['bash', hook, 'add-event', '--event', 'Stop', '--command', '/fixture/stop', '--source', 'second-source'], {
      env: env(directorySettings), stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const statuses = await Promise.all([first.exited, second.exited]);
      expect(statuses).toEqual([0, 0]);
      const stored = JSON.parse(fs.readFileSync(target, 'utf8'));
      expect(stored.hooks.PostToolUse[0]._gstack_source).toBe('link-test');
      expect(stored.hooks.Stop[0]._gstack_source).toBe('second-source');
      expect(fs.lstatSync(settings).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(directoryAlias).isSymbolicLink()).toBe(true);
    } finally {
      if (first.exitCode === null) first.kill();
      if (second.exitCode === null) second.kill();
      await Promise.all([first.exited, second.exited]);
    }
  });

  test('a link retargeted while waiting for its lock cannot mutate either target', async () => {
    const other = path.join(root, 'dotfiles/other.json');
    const original = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(other, original);
    fs.mkdirSync(target + '.lock');
    fs.writeFileSync(target + '.lock/owner', 'fixture-owner');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const realMkdir = spawnSync('which', ['mkdir'], { encoding: 'utf8', timeout: 5_000 }).stdout.trim();
    expect(realMkdir).not.toBe('');
    const observed = path.join(root, 'lock-observed');
    fs.writeFileSync(path.join(bin, 'mkdir'), '#!/bin/bash\nif [ "$1" = "$LOCK_EXPECTED" ]; then printf seen > "$LOCK_OBSERVED"; fi\nexec "$REAL_MKDIR" "$@"\n', { mode: 0o755 });
    const child = spawn('bash', [hook, ...addArgs()], {
      env: { ...env(), PATH: `${bin}:${process.env.PATH}`, LOCK_EXPECTED: target + '.lock', LOCK_OBSERVED: observed, REAL_MKDIR: realMkdir },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000,
    });
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', data => { stderr += data; });
    const finished = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    try {
      const deadline = Date.now() + 2_000;
      while (!fs.existsSync(observed) && Date.now() < deadline) await Bun.sleep(10);
      expect(fs.existsSync(observed)).toBe(true);
      fs.unlinkSync(settings);
      fs.symlinkSync('../dotfiles/other.json', settings);
      expect(fs.realpathSync(settings)).toBe(other);
      fs.rmSync(target + '.lock', { recursive: true });
      expect(await finished, stderr).not.toBe(0);
      expect(fs.readFileSync(target, 'utf8')).toBe(original);
      expect(fs.readFileSync(other, 'utf8')).toBe(original);
      expect(fs.lstatSync(settings).isSymbolicLink()).toBe(true);
    } finally {
      if (child.exitCode === null) child.kill();
      await finished;
    }
  });
});
