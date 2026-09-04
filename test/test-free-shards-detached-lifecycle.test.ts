/**
 * End-to-end proof that a browse daemon which escapes the shard process group
 * remains owned by the free-test runner. This is the exact production failure
 * shape: setsid server + real Playwright Chromium + deleted state fixture.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  registerTestShardProcess,
  type TestShardProcessRecord,
} from '../browse/src/test-shard-process-registry';
import {
  createTestShardProcessRegistry,
  reapTestShardProcesses,
  registryEnvironment,
  type TestShardProcessRegistryHandle,
} from '../scripts/test-shard-process-owner';
import { runFreeShard } from '../scripts/test-free-shards';

const ROOT = path.resolve(import.meta.dir, '..');
const SERVER = path.join(ROOT, 'browse', 'src', 'server.ts');
const SUMMARY = 'Ran 1 tests across 1 files. [1.00ms]';

interface DetachedReceipt {
  shardPid: number;
  shardPgid: number;
  serverPid: number;
  serverPgid: number;
  chromiumPid: number;
  port: number;
  stateFile: string;
  stateDeletedBeforeShardExit: boolean;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readPsField(pid: number, field: 'command=' | 'lstart=' | 'pgid='): string {
  const result = spawnSync('ps', ['-p', String(pid), '-o', field], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2_000,
  });
  return result.status === 0 ? (result.stdout || '').trim() : '';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface IdentityFixture {
  child: ChildProcess;
  closed: Promise<void>;
  pid: number;
  processGroupId: number;
  processStartTime: string;
  marker: string;
}

async function startIdentityFixture(registryRoot: string): Promise<IdentityFixture> {
  const marker = path.join(registryRoot, 'exact-owner-marker');
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)', SERVER, marker],
    { detached: true, stdio: 'ignore' },
  );
  if (!child.pid) throw new Error('identity fixture did not expose a PID');
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const processGroupRaw = readPsField(child.pid, 'pgid=');
    const processStartTime = readPsField(child.pid, 'lstart=');
    const command = readPsField(child.pid, 'command=');
    if (/^\d+$/.test(processGroupRaw) && processStartTime && command.includes(SERVER) && command.includes(marker)) {
      return {
        child,
        closed,
        pid: child.pid,
        processGroupId: Number.parseInt(processGroupRaw, 10),
        processStartTime,
        marker,
      };
    }
    await delay(25);
  }
  child.kill('SIGKILL');
  await closed;
  throw new Error('identity fixture did not become observable');
}

async function stopIdentityFixture(fixture: IdentityFixture): Promise<void> {
  if (isAlive(fixture.pid)) {
    const command = readPsField(fixture.pid, 'command=');
    if (!command.includes(SERVER) || !command.includes(fixture.marker)) {
      throw new Error(`refusing to stop PID ${fixture.pid}: identity marker changed`);
    }
    process.kill(fixture.pid, 'SIGKILL');
  }
  await Promise.race([fixture.closed, delay(5_000)]);
  if (isAlive(fixture.pid)) throw new Error(`identity fixture PID ${fixture.pid} survived exact cleanup`);
}

function appendIdentityRecord(
  handle: TestShardProcessRegistryHandle,
  fixture: IdentityFixture,
  identity: Pick<TestShardProcessRecord, 'processGroupId' | 'processStartTime'>,
): void {
  const record: TestShardProcessRecord = {
    schema: 1,
    type: 'process',
    runId: handle.runId,
    kind: 'browse-server',
    pid: fixture.pid,
    parentPid: process.pid,
    processGroupId: identity.processGroupId,
    processStartTime: identity.processStartTime,
    port: null,
    stateFile: null,
    registeredAt: new Date().toISOString(),
  };
  fs.appendFileSync(handle.registryPath, `${JSON.stringify(record)}\n`);
}

function portAcceptsConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 500);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

describe('test-free-shards: detached process ownership', () => {
  test('POSIX registration omits a dead fake PID because no process remains to own', () => {
    if (process.platform === 'win32') return;
    const registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-missing-start-'));
    try {
      const handle = createTestShardProcessRegistry(registryRoot);
      expect(registerTestShardProcess({
        kind: 'browse-server',
        pid: Number.MAX_SAFE_INTEGER,
      }, { ...process.env, ...registryEnvironment(handle) })).toBe(false);
      expect(fs.readFileSync(handle.registryPath, 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      fs.rmSync(registryRoot, { recursive: true, force: true });
    }
  });

  test('POSIX registration fails closed for a live PID whose start identity is unavailable', async () => {
    if (process.platform === 'win32') return;
    const registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-live-missing-start-'));
    let fixture: IdentityFixture | null = null;
    try {
      const handle = createTestShardProcessRegistry(registryRoot);
      fixture = await startIdentityFixture(registryRoot);
      const livePid = fixture.pid;
      expect(() => registerTestShardProcess({
        kind: 'browse-server',
        pid: livePid,
      }, { ...process.env, ...registryEnvironment(handle) }, {
        readPsField: () => '',
      })).toThrow('cannot prove test-owned browse-server process start time');
      expect(fs.readFileSync(handle.registryPath, 'utf8').trim().split('\n')).toHaveLength(1);
      expect(isAlive(fixture.pid)).toBe(true);
    } finally {
      if (fixture) await stopIdentityFixture(fixture);
      fs.rmSync(registryRoot, { recursive: true, force: true });
    }
  }, 15_000);

  test('POSIX cleanup refuses a live matching command with missing start identity', async () => {
    if (process.platform === 'win32') return;
    const registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-empty-start-owner-'));
    let fixture: IdentityFixture | null = null;
    try {
      const handle = createTestShardProcessRegistry(registryRoot);
      fixture = await startIdentityFixture(registryRoot);
      expect(fixture.processGroupId).toBe(fixture.pid);
      appendIdentityRecord(handle, fixture, {
        processGroupId: fixture.processGroupId,
        processStartTime: '',
      });

      const report = await reapTestShardProcesses(handle);
      expect(report.success).toBe(false);
      expect(report.identityMismatches).toBe(1);
      expect(report.termSignals).toBe(0);
      expect(report.killSignals).toBe(0);
      expect(isAlive(fixture.pid)).toBe(true);
    } finally {
      if (fixture) await stopIdentityFixture(fixture);
      fs.rmSync(registryRoot, { recursive: true, force: true });
    }
  }, 15_000);

  test('POSIX cleanup refuses a same-start matching command whose PGID changed', async () => {
    if (process.platform === 'win32') return;
    const registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pgid-mismatch-'));
    let fixture: IdentityFixture | null = null;
    try {
      const handle = createTestShardProcessRegistry(registryRoot);
      fixture = await startIdentityFixture(registryRoot);
      expect(fixture.processGroupId).toBe(fixture.pid);
      appendIdentityRecord(handle, fixture, {
        processGroupId: fixture.processGroupId + 1,
        processStartTime: fixture.processStartTime,
      });

      const report = await reapTestShardProcesses(handle);
      expect(report.success).toBe(false);
      expect(report.identityMismatches).toBe(1);
      expect(report.termSignals).toBe(0);
      expect(report.killSignals).toBe(0);
      expect(isAlive(fixture.pid)).toBe(true);
    } finally {
      if (fixture) await stopIdentityFixture(fixture);
      fs.rmSync(registryRoot, { recursive: true, force: true });
    }
  }, 15_000);

  test('a failed process-group census fails the shard and retains its custody state', async () => {
    if (process.platform === 'win32') return;
    const registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-census-failure-'));
    let fixture: IdentityFixture | null = null;
    let retainedStateDir: string | null = null;
    try {
      fixture = await startIdentityFixture(registryRoot);
      expect(fixture.processGroupId).toBe(fixture.pid);
      const registerProgram = `
        const fs = require('node:fs');
        fs.appendFileSync(process.env.GSTACK_TEST_PROCESS_REGISTRY, JSON.stringify({
          schema: 1,
          type: 'process',
          runId: process.env.GSTACK_TEST_PROCESS_REGISTRY_ID,
          kind: 'browse-server',
          pid: ${fixture.pid},
          parentPid: process.pid,
          processGroupId: ${fixture.processGroupId},
          processStartTime: ${JSON.stringify(fixture.processStartTime)},
          port: null,
          stateFile: null,
          registeredAt: new Date().toISOString(),
        }) + '\\n');
        console.log(${JSON.stringify(SUMMARY)});
      `;
      const outcome = await runFreeShard(['census-failure'], 1, 1, {
        commandFor: () => ({ command: process.execPath, args: ['-e', registerProgram] }),
        processCleanupDependencies: {
          listGroupMembers: () => {
            throw new Error('injected process-group census failure');
          },
        },
        quiet: true,
        log: () => {},
      });

      expect(outcome.status).toBe('failed');
      expect(outcome.cleanupFailure).toContain('injected process-group census failure');
      const retainedMatch = /shard state retained at (.+)$/.exec(outcome.cleanupFailure ?? '');
      expect(retainedMatch).not.toBeNull();
      retainedStateDir = retainedMatch?.[1] ?? null;
      expect(retainedStateDir && fs.existsSync(retainedStateDir)).toBe(true);
      expect(isAlive(fixture.pid)).toBe(true);
    } finally {
      if (fixture) await stopIdentityFixture(fixture);
      if (retainedStateDir) fs.rmSync(retainedStateDir, { recursive: true, force: true });
      fs.rmSync(registryRoot, { recursive: true, force: true });
    }
  }, 15_000);

  test('reaps a setsid browse daemon and real Chromium after its state fixture is deleted', async () => {
    // This test is explicitly excluded from the curated Windows lane. Keep a
    // direct guard for developers who invoke this file manually on Windows.
    if (process.platform === 'win32') return;

    const captureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-detached-e2e-'));
    const capturePath = path.join(captureRoot, 'receipt.json');
    const daemonLogPath = path.join(captureRoot, 'daemon.log');
    const lines: string[] = [];
    const childProgram = `
      const fs = require('node:fs');
      const path = require('node:path');
      const { spawn, spawnSync } = require('node:child_process');
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const pgid = (pid) => {
        const result = spawnSync('ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8', timeout: 2000 });
        return Number.parseInt((result.stdout || '').trim(), 10);
      };
      (async () => {
        const fixtureRoot = path.join(process.env.TMPDIR, 'deleted-browser-state');
        const stateFile = path.join(fixtureRoot, '.gstack', 'browse.json');
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        const daemonLog = fs.openSync(${JSON.stringify(daemonLogPath)}, 'a');
        const daemon = spawn(process.execPath, ['run', ${JSON.stringify(SERVER)}], {
          cwd: ${JSON.stringify(ROOT)},
          detached: true,
          stdio: ['ignore', daemonLog, daemonLog],
          env: {
            ...process.env,
            BROWSE_STATE_FILE: stateFile,
            BROWSE_PARENT_PID: '0',
            BROWSE_IDLE_TIMEOUT: '3600000',
          },
        });
        fs.closeSync(daemonLog);
        daemon.unref();

        const deadline = Date.now() + 20000;
        let state = null;
        while (Date.now() < deadline) {
          try {
            state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            const health = await fetch('http://127.0.0.1:' + state.port + '/health');
            if (health.ok) break;
          } catch {}
          state = null;
          await delay(100);
        }
        const processRows = (spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 2000 }).stdout || '')
          .split('\\n')
          .map((line) => /^\\s*(\\d+)\\s+(\\d+)\\s+(.*)$/.exec(line))
          .filter(Boolean)
          .map((match) => ({ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] }));
        const descendants = new Set([state?.pid]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const row of processRows) {
            if (!descendants.has(row.parentPid) || descendants.has(row.pid)) continue;
            descendants.add(row.pid);
            changed = true;
          }
        }
        const chromium = processRows.find((row) =>
          descendants.has(row.pid) && /(?:chrom(?:e|ium)|headless[_-]shell)/i.test(row.command));
        if (!state || !chromium) {
          const diagnostic = fs.existsSync(${JSON.stringify(daemonLogPath)})
            ? fs.readFileSync(${JSON.stringify(daemonLogPath)}, 'utf8').slice(-2000)
            : 'daemon emitted no log';
          throw new Error('real browse daemon/Chromium did not become healthy: ' + diagnostic);
        }

        const receipt = {
          shardPid: process.pid,
          shardPgid: pgid(process.pid),
          serverPid: state.pid,
          serverPgid: pgid(state.pid),
          chromiumPid: chromium.pid,
          port: state.port,
          stateFile,
          stateDeletedBeforeShardExit: false,
        };
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
        receipt.stateDeletedBeforeShardExit = !fs.existsSync(stateFile);
        fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(receipt));
        console.log(${JSON.stringify(SUMMARY)});
      })().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      });
    `;

    try {
      const outcome = await runFreeShard(['detached-lifecycle'], 1, 1, {
        commandFor: () => ({ command: process.execPath, args: ['-e', childProgram] }),
        quiet: true,
        wallTimeoutMs: 45_000,
        log: (line) => lines.push(line),
      });
      expect(outcome.status).toBe('passed');
      const receipt = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as DetachedReceipt;
      expect(receipt.serverPgid).toBe(receipt.serverPid);
      expect(receipt.serverPgid).not.toBe(receipt.shardPgid);
      expect(receipt.stateDeletedBeforeShardExit).toBe(true);
      expect(receipt.chromiumPid).toBeGreaterThan(0);
      expect(isAlive(receipt.serverPid)).toBe(false);
      expect(isAlive(receipt.chromiumPid)).toBe(false);
      expect(await portAcceptsConnections(receipt.port)).toBe(false);
      expect(fs.existsSync(receipt.stateFile)).toBe(false);
      expect(fs.existsSync(path.dirname(path.dirname(receipt.stateFile)))).toBe(false);
      expect(lines.some((line) => /detached-process gate: [2-9]\d* registered, .* 0 survivor\(s\), pass$/.test(line))).toBe(true);
    } finally {
      fs.rmSync(captureRoot, { recursive: true, force: true });
    }
  }, 60_000);

  test('reaps a Chromium helper spawned only after graceful shutdown starts', async () => {
    if (process.platform === 'win32') return;

    const captureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-late-chromium-e2e-'));
    const capturePath = path.join(captureRoot, 'receipt.json');
    const lines: string[] = [];
    const serverProgram = `
      const fs = require('node:fs');
      const { spawn, spawnSync } = require('node:child_process');
      const pgid = (pid) => Number.parseInt(
        (spawnSync('ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8', timeout: 2000 }).stdout || '').trim(),
        10,
      );
      let spawned = false;
      process.on('SIGINT', () => {
        if (spawned) return;
        spawned = true;
        const helper = spawn(process.execPath, [
          '-e',
          'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
          'Chromium Helper',
        ], { stdio: 'ignore' });
        helper.unref();
        fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
          serverPid: process.pid,
          serverPgid: pgid(process.pid),
          helperPid: helper.pid,
          helperPgid: pgid(helper.pid),
        }));
      });
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `;
    const shardProgram = `
      const fs = require('node:fs');
      const { spawn, spawnSync } = require('node:child_process');
      const daemon = spawn(process.execPath, ['-e', ${JSON.stringify(serverProgram)}, ${JSON.stringify(SERVER)}], {
        detached: true,
        stdio: 'ignore',
      });
      daemon.unref();
      const ps = (field) => (spawnSync('ps', ['-p', String(daemon.pid), '-o', field], { encoding: 'utf8', timeout: 2000 }).stdout || '').trim();
      fs.appendFileSync(process.env.GSTACK_TEST_PROCESS_REGISTRY, JSON.stringify({
        schema: 1,
        type: 'process',
        runId: process.env.GSTACK_TEST_PROCESS_REGISTRY_ID,
        kind: 'browse-server',
        pid: daemon.pid,
        parentPid: process.pid,
        processGroupId: Number.parseInt(ps('pgid='), 10),
        processStartTime: ps('lstart='),
        port: null,
        stateFile: null,
        registeredAt: new Date().toISOString(),
      }) + '\\n');
      console.log(${JSON.stringify(SUMMARY)});
    `;

    try {
      const outcome = await runFreeShard(['late-chromium-helper'], 1, 1, {
        commandFor: () => ({ command: process.execPath, args: ['-e', shardProgram] }),
        quiet: true,
        wallTimeoutMs: 15_000,
        log: (line) => lines.push(line),
      });
      expect(outcome.status).toBe('passed');
      const receipt = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as {
        serverPid: number;
        serverPgid: number;
        helperPid: number;
        helperPgid: number;
      };
      expect(receipt.serverPgid).toBe(receipt.serverPid);
      expect(receipt.helperPgid).toBe(receipt.serverPgid);
      expect(isAlive(receipt.serverPid)).toBe(false);
      expect(isAlive(receipt.helperPid)).toBe(false);
      expect(lines.some((line) => /detached-process gate: 2 registered, .* 0 survivor\(s\), pass$/.test(line))).toBe(true);
    } finally {
      fs.rmSync(captureRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
