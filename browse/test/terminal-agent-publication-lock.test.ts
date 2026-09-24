import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireAgentStateLock, agentRecordPath, readAgentStartTime, writeAgentRecord, type AgentRecord } from '../src/terminal-agent-control';

const roots: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
const directory = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-lock-'));
  roots.push(root);
  return root;
};
const lockPath = (root: string) => path.join(root, 'terminal-agent-pid.lock');
const metadata = (record: AgentRecord) => ({ kind: 'agent-publication-v1', pid: record.pid, gen: record.gen,
  startTime: record.startTime, ownerPid: record.ownerPid, ownerStartTime: record.ownerStartTime });

async function fixture(dead = true) {
  const root = directory();
  const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'ignore'] });
  children.push(child);
  const record: AgentRecord = { pid: child.pid, gen: 'publication-test-generation', startedAt: Date.now(),
    startTime: readAgentStartTime(child.pid), ownerPid: process.pid, ownerStartTime: readAgentStartTime(process.pid) };
  expect(record.startTime).not.toBe('');
  expect(record.ownerStartTime).not.toBe('');
  writeAgentRecord(root, record);
  fs.writeFileSync(lockPath(root), JSON.stringify(metadata(record)), { mode: 0o600 });
  if (dead) { child.kill('SIGKILL'); await child.exited; }
  return { root, record };
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) try { child.kill('SIGKILL'); } catch {}
    await child.exited;
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('owned terminal-agent publication lock recovery', () => {
  test('the exact daemon reclaims its dead agent lock and normal release cleans up', async () => {
    const { root, record } = await fixture();
    const release = acquireAgentStateLock(root, 0);
    expect(fs.readFileSync(lockPath(root), 'utf8')).toBe('');
    expect(JSON.parse(fs.readFileSync(agentRecordPath(root), 'utf8'))).toEqual(record);
    release();
    expect(fs.existsSync(lockPath(root))).toBe(false);
    expect(fs.readdirSync(root).filter(name => name.includes('.tmp.'))).toEqual([]);
  });

  test('a live exact owner is never reclaimed', async () => {
    const { root } = await fixture(false);
    const before = fs.readFileSync(lockPath(root), 'utf8');
    expect(() => acquireAgentStateLock(root, 0)).toThrow('state lock unavailable');
    expect(fs.readFileSync(lockPath(root), 'utf8')).toBe(before);
  });

  test('a reused live PID with the old birth identity is never reclaimed', async () => {
    const { root, record } = await fixture(false);
    record.startTime = 'an earlier process birth';
    writeAgentRecord(root, record);
    const before = JSON.stringify(metadata(record));
    fs.writeFileSync(lockPath(root), before);
    expect(() => acquireAgentStateLock(root, 0)).toThrow('state lock unavailable');
    expect(fs.readFileSync(lockPath(root), 'utf8')).toBe(before);
  });

  for (const code of ['EPERM', 'EIO']) {
    test(`uncertain process liveness (${code}) retains the lock`, async () => {
      const { root, record } = await fixture();
      const original = process.kill;
      const kill = spyOn(process, 'kill').mockImplementation(((pid: number, signal: any) => {
        if (pid === record.pid && signal === 0) throw Object.assign(new Error('unavailable'), { code });
        return original(pid, signal);
      }) as typeof process.kill);
      try { expect(() => acquireAgentStateLock(root, 0)).toThrow('state lock unavailable'); }
      finally { kill.mockRestore(); }
      expect(fs.existsSync(lockPath(root))).toBe(true);
    });
  }

  for (const variant of ['empty', 'invalid-json', 'unknown-kind', 'generation', 'pid', 'birth', 'daemon', 'daemon-birth', 'missing-record', 'record-replaced']) {
    test(`foreign or ambiguous lock is retained: ${variant}`, async () => {
      const { root, record } = await fixture();
      const lock = metadata(record);
      if (variant === 'unknown-kind') lock.kind = 'other-lock';
      if (variant === 'generation') lock.gen = 'foreign-generation';
      if (variant === 'pid') lock.pid++;
      if (variant === 'birth') lock.startTime = 'foreign birth';
      if (variant === 'daemon') {
        record.ownerPid = 1;
        lock.ownerPid = 1;
        writeAgentRecord(root, record);
      }
      if (variant === 'daemon-birth') {
        record.ownerStartTime = 'earlier daemon birth';
        lock.ownerStartTime = record.ownerStartTime;
        writeAgentRecord(root, record);
      }
      if (variant === 'missing-record') fs.unlinkSync(agentRecordPath(root));
      if (variant === 'record-replaced') writeAgentRecord(root, { ...record, gen: 'successor' });
      const before = variant === 'empty' ? '' : variant === 'invalid-json' ? '{invalid' : JSON.stringify(lock);
      fs.writeFileSync(lockPath(root), before);
      expect(() => acquireAgentStateLock(root, 0)).toThrow('state lock unavailable');
      expect(fs.readFileSync(lockPath(root), 'utf8')).toBe(before);
    });
  }

  test('a symlink lock is not followed or reclaimed', async () => {
    const { root } = await fixture();
    const target = path.join(root, 'foreign-lock');
    fs.renameSync(lockPath(root), target);
    fs.symlinkSync(target, lockPath(root));
    expect(() => acquireAgentStateLock(root, 0)).toThrow('state lock unavailable');
    expect(fs.lstatSync(lockPath(root)).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
  });

  test('an inode replacement during validation is retained', async () => {
    const { root } = await fixture();
    const original = fs.lstatSync;
    let reads = 0;
    const stat = spyOn(fs, 'lstatSync').mockImplementation(((file: any, options: any) => {
      if (String(file) === lockPath(root) && ++reads === 2) {
        fs.renameSync(lockPath(root), path.join(root, 'retired-lock'));
        fs.writeFileSync(lockPath(root), 'replacement');
      }
      return original(file, options);
    }) as typeof fs.lstatSync);
    try { expect(() => acquireAgentStateLock(root, 0)).toThrow('state lock unavailable'); }
    finally { stat.mockRestore(); }
    expect(reads).toBe(2);
    expect(fs.readFileSync(lockPath(root), 'utf8')).toBe('replacement');
  });

  test('a successor agent record appearing during validation retains the lock', async () => {
    const { root, record } = await fixture();
    const original = fs.readFileSync;
    let reads = 0;
    const read = spyOn(fs, 'readFileSync').mockImplementation(((file: any, options: any) => {
      if (String(file) === agentRecordPath(root) && ++reads === 2) writeAgentRecord(root, { ...record, gen: 'successor' });
      return original(file, options);
    }) as typeof fs.readFileSync);
    try { expect(() => acquireAgentStateLock(root, 0)).toThrow('state lock unavailable'); }
    finally { read.mockRestore(); }
    expect(fs.existsSync(lockPath(root))).toBe(true);
  });

  test('an unbound process cannot publish reclaimable owner metadata', () => {
    const root = directory();
    expect(() => acquireAgentStateLock(root, 0, 'unbound')).toThrow('publication lock identity');
    expect(fs.existsSync(lockPath(root))).toBe(false);
  });

  test('metadata changed in place during validation is retained', async () => {
    const { root } = await fixture();
    const original = fs.readFileSync;
    let reads = 0;
    const read = spyOn(fs, 'readFileSync').mockImplementation(((file: any, options: any) => {
      if (String(file) === agentRecordPath(root) && ++reads === 2) fs.writeFileSync(lockPath(root), 'foreign replacement');
      return original(file, options);
    }) as typeof fs.readFileSync);
    try { expect(() => acquireAgentStateLock(root, 0)).toThrow('state lock unavailable'); }
    finally { read.mockRestore(); }
    expect(fs.readFileSync(lockPath(root), 'utf8')).toBe('foreign replacement');
  });

  test('the actual registered daemon watchdog respawns after a publication-lock crash', () => {
    const root = directory();
    const ready = path.join(root, 'held.json');
    const preload = path.join(root, 'publication-preload.ts');
    fs.writeFileSync(preload, `
      const fs = require('node:fs');
      const ready = ${JSON.stringify(ready)};
      const spawn = Bun.spawn;
      Bun.spawn = (argv, options) => {
        if (Array.isArray(argv) && argv.some(value => typeof value === 'string' && (value.endsWith('/server.ts') || value.endsWith('/terminal-agent.ts')))) {
          argv = [argv[0], argv[1], '--preload', import.meta.path, ...argv.slice(2)];
        }
        return spawn(argv, options);
      };
      const agent = process.argv.some(value => value.endsWith('/terminal-agent.ts'));
      const daemon = process.argv.some(value => value.endsWith('/server.ts'));
      const link = fs.linkSync;
      fs.linkSync = (from, to) => {
        link(from, to);
        if (agent && String(to).endsWith('/terminal-agent-pid.lock') && !fs.existsSync(ready)) {
          const owner = JSON.parse(fs.readFileSync(to, 'utf8'));
          if (owner.kind !== 'agent-publication-v1' || owner.pid !== process.pid) throw new Error('Publication metadata was not atomic');
          fs.writeFileSync(ready, JSON.stringify({ pid: process.pid, owner }));
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
          throw new Error('Expected the original fixture to kill the publication holder');
        }
      };
      const kill = process.kill;
      process.kill = (pid, signal) => {
        if (!agent && !daemon && signal === 'SIGKILL') {
          const deadline = Date.now() + 1500;
          while (!fs.existsSync(ready) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
          if (!fs.existsSync(ready) || JSON.parse(fs.readFileSync(ready, 'utf8')).pid !== pid) throw new Error('Publication holder was not captured');
        }
        return kill(pid, signal);
      };
    `);
    const result = spawnSync(process.execPath, ['test', '--preload', preload,
      path.join(import.meta.dir, 'terminal-agent-lifecycle.test.ts'), '--test-name-pattern',
      'daemon respawns after agent crash, then exits without deleting a successor state', '--timeout=30000'],
    { encoding: 'utf8', timeout: 20000, env: { ...process.env, BROWSE_HEADLESS_SKIP: '1' } });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('1 pass');
    expect(result.stderr).toContain('0 fail');
    const held = JSON.parse(fs.readFileSync(ready, 'utf8'));
    expect(held.owner.pid).toBe(held.pid);
    expect(held.owner.gen).toBeTruthy();
    expect(held.owner.startTime).toBeTruthy();
  }, 25000);
});
