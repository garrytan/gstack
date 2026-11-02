/**
 * #3541 (the /ship half): `gstack-ship-receipt write` with no --session-kind
 * and no GSTACK_SESSION_KIND asks bin/gstack-session-kind, a bash script.
 * Spawned by path it never starts on Windows (no shebangs), so every receipt
 * written there carried no session_kind.
 *
 * Windows-safe by construction: both bins launch through
 * lib/script-invocation.ts (Git Bash on win32), state lives under os.tmpdir().
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runScriptSync } from '../lib/script-invocation';

const ROOT = path.resolve(import.meta.dir, '..');

let tmp = '', repo = '', env: NodeJS.ProcessEnv = {};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-receipt-kind-')));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const gitconfig = path.join(tmp, 'gitconfig');
  fs.writeFileSync(gitconfig, '');
  env = {
    ...process.env, HOME: tmp, USERPROFILE: tmp, GSTACK_STATE_ROOT: path.join(tmp, 'state'), GSTACK_HOME: path.join(tmp, 'state'), GSTACK_SESSION_KIND: '',
    GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined,
  };
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
  };
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('-c', 'user.email=fixture@example.test', '-c', 'user.name=Fixture', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('switch', '-q', '-c', 'feat');
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('write without a session kind records what gstack-session-kind prints (#3541)', () => {
  const kind = runScriptSync(path.join(ROOT, 'bin', 'gstack-session-kind'), [], { cwd: repo, env, encoding: 'utf8', timeout: 30_000 });
  expect(kind.status, kind.stderr).toBe(0);
  const body = path.join(tmp, 'body.md');
  fs.writeFileSync(body, '## Summary\n');
  const w = runScriptSync(path.join(ROOT, 'bin', 'gstack-ship-receipt'), ['write', '--pr', '1', '--base', 'main', '--body', body, '--json'], {
    cwd: repo, env, encoding: 'utf8', timeout: 120_000,
  });
  expect(w.error).toBeUndefined();
  expect(w.status, w.stderr).toBe(0);
  expect(JSON.parse(w.stdout).session_kind).toBe(kind.stdout.trim());
}, 150_000);
