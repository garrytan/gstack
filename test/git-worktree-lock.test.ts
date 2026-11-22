/**
 * lib/git-worktree-lock.ts: gstack's own worktree adds and removals take one
 * lock per repository, because concurrent `git worktree add`s can read each
 * other's half-written commondir ("failed to read
 * .git/worktrees/worktree/commondir: Success", Trunk e3ed3abf).
 */
import { afterEach, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const LIB = path.resolve(import.meta.dir, '..', 'lib', 'git-worktree-lock.ts');
const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function repo(): { root: string; lock: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-worktree-lock-'));
  roots.push(root);
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  git('init', '-q', '-b', 'main');
  git('config', 'maintenance.auto', 'false');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  return { root, lock: path.join(root, '.git', 'gstack-worktree.lock') };
}

function adder(root: string, dirs: string[]): ChildProcess {
  const script = `import { addWorktree } from ${JSON.stringify(LIB)};
for (const dir of ${JSON.stringify(dirs)}) { const r = addWorktree(${JSON.stringify(root)}, dir, 'HEAD'); if (!r.ok) { console.error(r.err); process.exit(1); } }`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(child);
  return child;
}
const exited = (c: ChildProcess) => new Promise<{ code: number | null; err: string }>(resolve => {
  let err = '';
  c.stderr?.on('data', d => { err += d; });
  c.on('exit', code => resolve({ code, err }));
});
const holder = () => {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  children.push(c);
  return c;
};

test('an add waits while a live process holds the lock, then runs once that holder is gone', async () => {
  const { root, lock } = repo();
  const live = holder();
  fs.writeFileSync(lock, String(live.pid));
  const dir = path.join(root, 'attempt', 'worktree');
  const add = adder(root, [dir]);
  const done = exited(add);
  await Bun.sleep(1500);
  expect(fs.existsSync(path.join(dir, '.git'))).toBe(false);
  live.kill('SIGKILL');
  const r = await done;
  expect(r, r.err).toMatchObject({ code: 0 });
  expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);
  expect(fs.existsSync(lock)).toBe(false);
}, 30_000);

test('a lock left by a dead process is taken over at once', () => {
  const { root, lock } = repo();
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', timeout: 30_000 }).stdout;
  fs.writeFileSync(lock, dead);
  const { addWorktree } = require(LIB) as typeof import('../lib/git-worktree-lock');
  const r = addWorktree(root, path.join(root, 'wt'), 'HEAD');
  expect(r.ok, r.err).toBe(true);
  expect(fs.existsSync(lock)).toBe(false);
});

test('a lock older than the longest hold is taken over even when its pid belongs to a live process (pid reuse)', () => {
  const { root, lock } = repo();
  const live = holder();
  fs.writeFileSync(lock, String(live.pid));
  const old = (Date.now() - 10 * 60_000) / 1000;
  fs.utimesSync(lock, old, old);
  const { addWorktree } = require(LIB) as typeof import('../lib/git-worktree-lock');
  const started = Date.now();
  const r = addWorktree(root, path.join(root, 'wt'), 'HEAD');
  expect(r.ok, r.err).toBe(true);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(fs.existsSync(lock)).toBe(false);
});

test('contenders that find a dead holder\'s lock never hold the lock at the same time', async () => {
  const { root, lock } = repo();
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', timeout: 30_000 }).stdout;
  fs.writeFileSync(lock, dead);
  const log = path.join(root, 'holds.log');
  const script = `import fs from 'node:fs'; import { withWorktreeLock } from ${JSON.stringify(LIB)};
for (let i = 0; i < 3; i++) withWorktreeLock(${JSON.stringify(root)}, () => { const t = Date.now(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30); fs.appendFileSync(${JSON.stringify(log)}, t + ' ' + Date.now() + '\\n'); });`;
  const procs = Array.from({ length: 6 }, () => { const c = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] }); children.push(c); return c; });
  const results = await Promise.all(procs.map(exited));
  for (const r of results) expect(r, r.err).toMatchObject({ code: 0 });
  const holds = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => l.split(' ').map(Number) as [number, number]).sort((a, b) => a[0] - b[0]);
  expect(holds).toHaveLength(18);
  for (let i = 1; i < holds.length; i++) expect(holds[i]![0]).toBeGreaterThanOrEqual(holds[i - 1]![1]);
}, 60_000);

test('a lock is dated when it is taken, so time spent waiting never makes a live holder look stale', async () => {
  const { root, lock } = repo();
  const live = holder();
  fs.writeFileSync(lock, String(live.pid));
  const out = path.join(root, 'acquired.json');
  const script = `import fs from 'node:fs'; import { withWorktreeLock } from ${JSON.stringify(LIB)};
withWorktreeLock(${JSON.stringify(root)}, () => fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ now: Date.now(), mtimeMs: fs.statSync(${JSON.stringify(lock)}).mtimeMs })));`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(child);
  const done = exited(child);
  await Bun.sleep(1500);
  live.kill('SIGKILL');
  const r = await done;
  expect(r, r.err).toMatchObject({ code: 0 });
  const { now, mtimeMs } = JSON.parse(fs.readFileSync(out, 'utf8')) as { now: number; mtimeMs: number };
  expect(now - mtimeMs).toBeLessThan(1000);
}, 30_000);

test('a lock naming this process\'s own pid is a leftover from a recycled pid and is taken over at once', () => {
  const { root, lock } = repo();
  fs.writeFileSync(lock, String(process.pid));
  const { addWorktree } = require(LIB) as typeof import('../lib/git-worktree-lock');
  const started = Date.now();
  const r = addWorktree(root, path.join(root, 'wt'), 'HEAD');
  expect(r.ok, r.err).toBe(true);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(fs.existsSync(lock)).toBe(false);
});

test('an add still runs, unlocked, when the lock cannot be written', () => {
  const { root, lock } = repo();
  fs.mkdirSync(`${lock}.${process.pid}`);
  const { addWorktree } = require(LIB) as typeof import('../lib/git-worktree-lock');
  const r = addWorktree(root, path.join(root, 'wt'), 'HEAD');
  expect(r.ok, r.err).toBe(true);
  expect(fs.existsSync(lock)).toBe(false);
});

test('concurrent adds of worktrees that share one basename all succeed', async () => {
  const { root } = repo();
  const procs = Array.from({ length: 6 }, (_, p) => adder(root, Array.from({ length: 8 }, (_, i) => path.join(root, `p${p}-${i}`, 'worktree'))));
  const results = await Promise.all(procs.map(exited));
  for (const r of results) expect(r, r.err).toMatchObject({ code: 0 });
  const list = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8', timeout: 30_000 }).stdout;
  expect(list.split('\n').filter(l => l.startsWith('worktree ')).length).toBe(1 + 6 * 8);
}, 120_000);
