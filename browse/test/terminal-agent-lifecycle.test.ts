import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  acquireAgentStateLock, agentRecordPath, clearAgentRecord, isOurAgent, killAgentByRecord, readAgentRecord,
  readAgentStartTime, spawnTerminalAgent, stopAgentByRecord, type AgentRecord,
  writeAgentRecord,
} from '../src/terminal-agent-control';

const sourceDir = path.join(import.meta.dir, '..', 'src');
const dirs: string[] = [];
const pids: number[] = [];
const dir = () => {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'g4-'));
  dirs.push(value);
  return value;
};
const waitFor = async (check: () => boolean, timeout = 3000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return true;
    await Bun.sleep(25);
  }
  return check();
};
const spawn = (stateDir: string, ownerPid = process.pid) => {
  const pid = spawnTerminalAgent({ stateFile: path.join(stateDir, 'browse.json'), serverPort: 0, ownerPid,
    extraEnv: { GSTACK_TERMINAL_OWNER_WATCHDOG_MS: '25' } });
  if (pid) pids.push(pid);
  return pid;
};

afterEach(() => {
  for (const pid of pids.splice(0)) {
    const record = dirs.map(readAgentRecord).find(value => value?.pid === pid);
    if (record) stopAgentByRecord(record, 200);
  }
  for (const stateDir of dirs.splice(0)) fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('terminal-agent owned lifecycle regression', () => {
  for (const field of ['dev', 'ino'] as const) {
    test(`lock release preserves a replacement with an adjacent 64-bit ${field}`, () => {
      const stateDir = dir();
      const lockPath = path.join(stateDir, 'terminal-agent-pid.lock');
      const identity = 1n << 63n;
      expect(Number(identity)).toBe(Number(identity + 1n));
      const originalFstat = fs.fstatSync;
      const originalStat = fs.statSync;
      const descriptor = spyOn(fs, 'fstatSync').mockImplementation(((fd: number, options?: any) => {
        const stat = originalFstat(fd, options);
        return Object.assign(stat, { [field]: options?.bigint ? identity : Number(identity) });
      }) as typeof fs.fstatSync);
      const pathname = spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike, options?: any) => {
        const stat = originalStat(file, options);
        return String(file) === lockPath
          ? Object.assign(stat, { [field]: options?.bigint ? identity + 1n : Number(identity + 1n) })
          : stat;
      }) as typeof fs.statSync);
      try {
        acquireAgentStateLock(stateDir)();
        expect(fs.existsSync(lockPath)).toBe(true);
      } finally {
        descriptor.mockRestore();
        pathname.mockRestore();
      }
    });
  }

  test('connect and supervisor pass the persistent daemon as owner', () => {
    const cli = fs.readFileSync(path.join(sourceDir, 'cli.ts'), 'utf8');
    const connect = cli.slice(cli.indexOf('// Auto-start terminal agent'), cli.indexOf('// ─── Outer Supervisor'));
    const supervisor = cli.slice(cli.indexOf('// ─── Outer Supervisor'), cli.indexOf('// ─── Headed Disconnect'));
    expect(connect).toMatch(/spawnTerminalAgent\(\{[^}]*ownerPid:\s*newState\.pid/s);
    expect(supervisor).toMatch(/spawnTerminalAgent\(\{[^}]*ownerPid:\s*respawned\.pid/s);
  });

  test('owned agent starts, is replaced only after exit, and leaves a live sibling alone', async () => {
    const firstDir = dir();
    const siblingDir = dir();
    const first = spawn(firstDir);
    const sibling = spawn(siblingDir);
    expect(first).toBeGreaterThan(0);
    expect(sibling).toBeGreaterThan(0);
    expect(await waitFor(() => fs.existsSync(path.join(firstDir, 'terminal-port')))).toBe(true);
    const firstRecord = readAgentRecord(firstDir)!;
    const siblingRecord = readAgentRecord(siblingDir)!;
    expect(isOurAgent(firstRecord, process.pid)).toBe(true);
    const replacement = spawn(firstDir);
    expect(replacement).toBeGreaterThan(0);
    expect(replacement).not.toBe(first);
    expect(isOurAgent(firstRecord)).toBe(false);
    expect(isOurAgent(siblingRecord)).toBe(true);
    expect(readAgentRecord(firstDir)?.pid).toBe(replacement);
  });

  test('child waits for its PID to replace the pre-spawn reservation', async () => {
    const stateDir = dir();
    const originalSpawn = Bun.spawn;
    (Bun as any).spawn = (...args: Parameters<typeof Bun.spawn>) => {
      const child = originalSpawn(...args);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
      return child;
    };
    try {
      const pid = spawn(stateDir);
      expect(pid).toBeGreaterThan(0);
      expect(await waitFor(() => fs.existsSync(path.join(stateDir, 'terminal-port')))).toBe(true);
      expect(readAgentRecord(stateDir)?.pid).toBe(pid);
    } finally { (Bun as any).spawn = originalSpawn; }
  });

  test('failed signals retain the live record and prevent a duplicate spawn', () => {
    const stateDir = dir();
    const first = spawn(stateDir)!;
    const record = readAgentRecord(stateDir)!;
    const original = process.kill;
    (process as any).kill = ((pid: number, signal: NodeJS.Signals | number) => {
      if (pid === first && signal !== 0) throw Object.assign(new Error('denied'), { code: 'EPERM' });
      return original(pid, signal);
    }) as typeof process.kill;
    try {
      expect(spawn(stateDir)).toBeNull();
      expect(readAgentRecord(stateDir)).toEqual(record);
    } finally {
      (process as any).kill = original;
    }
  });

  test('a transient identity lookup failure after a signal is not confirmed exit', () => {
    const stateDir = dir();
    const first = spawn(stateDir)!;
    const record = readAgentRecord(stateDir)!;
    const originalKill = process.kill;
    const originalSpawnSync = Bun.spawnSync;
    let obscured = false;
    (process as any).kill = ((pid: number, signal: NodeJS.Signals | number) => {
      if (pid === first && signal !== 0) { obscured = true; return true; }
      return originalKill(pid, signal);
    }) as typeof process.kill;
    (Bun as any).spawnSync = (...args: Parameters<typeof Bun.spawnSync>) => {
      const command = args[0] as string[];
      if (obscured && command[0] === 'ps' && command[2] === String(first)) {
        return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      return originalSpawnSync(...args);
    };
    try {
      expect(spawn(stateDir)).toBeNull();
      expect(readAgentRecord(stateDir)).toEqual(record);
    } finally {
      (process as any).kill = originalKill;
      (Bun as any).spawnSync = originalSpawnSync;
    }
  });

  test('PID reuse and foreign records are never signaled', () => {
    const stateDir = dir();
    const forged: AgentRecord = {
      pid: process.pid, gen: 'synthetic-foreign-generation', startedAt: Date.now(),
      startTime: readAgentStartTime(process.pid), ownerPid: process.pid, ownerStartTime: readAgentStartTime(process.pid),
    };
    fs.writeFileSync(agentRecordPath(stateDir), JSON.stringify(forged));
    expect(isOurAgent(forged)).toBe(false);
    expect(killAgentByRecord(forged, 'SIGTERM')).toBe(false);
    expect(spawn(stateDir)).toBeNull();
    expect(readAgentRecord(stateDir)).toEqual(forged);
    clearAgentRecord(stateDir, { ...forged, gen: 'different' });
    expect(readAgentRecord(stateDir)).toEqual(forged);
  });

  test('unwritable record path rejects before spawning any agent', () => {
    const stateDir = dir();
    const blocker = path.join(stateDir, 'blocker');
    fs.writeFileSync(blocker, 'block');
    const originalSpawn = Bun.spawn;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    (Bun as any).spawn = (...args: Parameters<typeof Bun.spawn>) => {
      child = originalSpawn(...args);
      return child;
    };
    try {
      expect(() => spawnTerminalAgent({ stateFile: path.join(blocker, 'browse.json'), serverPort: 0, ownerPid: process.pid }))
        .toThrow();
      expect(child).toBeUndefined();
      expect(fs.readdirSync(stateDir)).toEqual(['blocker']);
    } finally {
      (Bun as any).spawn = originalSpawn;
      try { child?.kill('SIGKILL'); } catch {}
    }
  });

  test('a leftover exclusive lock refuses recovery without stealing ownership', () => {
    const stateDir = dir();
    const lock = path.join(stateDir, 'terminal-agent-pid.lock');
    fs.writeFileSync(lock, '');
    expect(() => acquireAgentStateLock(stateDir, 0)).toThrow('state lock unavailable');
    expect(fs.existsSync(lock)).toBe(true);
    expect(readAgentRecord(stateDir)).toBeNull();
  });

  test('record update failure after spawn confirms child exit before dropping its handle', async () => {
    const stateDir = dir();
    const originalSpawn = Bun.spawn;
    const originalRename = fs.renameSync;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let writes = 0;
    const rename = spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === agentRecordPath(stateDir) && ++writes === 2) {
        throw Object.assign(new Error('synthetic state write failure'), { code: 'EIO' });
      }
      return originalRename(from, to);
    }) as typeof fs.renameSync);
    (Bun as any).spawn = (...args: Parameters<typeof Bun.spawn>) => {
      child = originalSpawn(...args);
      return child;
    };
    try {
      expect(() => spawn(stateDir)).toThrow('synthetic state write failure');
      expect(writes).toBe(2);
      expect(child).toBeDefined();
      expect(await Promise.race([child!.exited.then(() => true), Bun.sleep(3000).then(() => false)])).toBe(true);
      expect(readAgentRecord(stateDir)).toBeNull();
    } finally {
      rename.mockRestore();
      (Bun as any).spawn = originalSpawn;
      try { child?.kill('SIGKILL'); } catch {}
    }
  });

  (process.platform === 'win32' ? test.skip : test)('unconfirmed post-write child keeps its reservation until it exits', async () => {
    const stateDir = dir();
    const originalSpawn = Bun.spawn;
    const originalRename = fs.renameSync;
    const originalKill = process.kill;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let writes = 0;
    let deniedSignals = 0;
    const rename = spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === agentRecordPath(stateDir) && ++writes === 2) throw new Error('synthetic update refusal');
      return originalRename(from, to);
    }) as typeof fs.renameSync);
    (Bun as any).spawn = (...args: Parameters<typeof Bun.spawn>) => {
      child = originalSpawn(...args);
      originalKill(child.pid, 'SIGSTOP');
      return child;
    };
    (process as any).kill = ((pid: number, signal: NodeJS.Signals | number) => {
      if (child && pid === child.pid && signal !== 0) {
        deniedSignals++;
        throw Object.assign(new Error('signal denied'), { code: 'EPERM' });
      }
      return originalKill(pid, signal);
    }) as typeof process.kill;
    try {
      expect(() => spawn(stateDir)).toThrow('exit is unconfirmed');
      expect(deniedSignals).toBeGreaterThan(0);
      expect(readAgentRecord(stateDir)?.pid).toBe(0);
      expect(spawn(stateDir)).toBeNull();
      expect(readAgentRecord(stateDir)?.pid).toBe(0);
      originalKill(child!.pid, 'SIGCONT');
      expect(await Promise.race([child!.exited.then(() => true), Bun.sleep(4000).then(() => false)])).toBe(true);
      expect(await waitFor(() => readAgentRecord(stateDir) === null)).toBe(true);
    } finally {
      (process as any).kill = originalKill;
      (Bun as any).spawn = originalSpawn;
      rename.mockRestore();
      if (child) try { originalKill(child.pid, 'SIGCONT'); } catch {}
      try { child?.kill('SIGKILL'); } catch {}
    }
  }, 6000);

  test('owner death and record takeover shut down the old generation without deleting its successor', async () => {
    const stateDir = dir();
    const owner = Bun.spawn([process.execPath, '-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
    try {
      const pid = spawn(stateDir, owner.pid)!;
      expect(await waitFor(() => fs.existsSync(path.join(stateDir, 'terminal-port')))).toBe(true);
      const record = readAgentRecord(stateDir)!;
      owner.kill('SIGTERM');
      await owner.exited;
      expect(await waitFor(() => !isOurAgent(record), 5000)).toBe(true);
      expect(readAgentRecord(stateDir)).toBeNull();
    } finally { try { owner.kill('SIGKILL'); } catch {} }

    const first = spawn(stateDir)!;
    expect(await waitFor(() => fs.existsSync(path.join(stateDir, 'terminal-port')))).toBe(true);
    const original = readAgentRecord(stateDir)!;
    const successor = { ...original, pid: 2147483646, gen: 'synthetic-successor' };
    fs.writeFileSync(agentRecordPath(stateDir), JSON.stringify(successor));
    expect(await waitFor(() => !isOurAgent(original), 5000)).toBe(true);
    expect(readAgentRecord(stateDir)).toEqual(successor);
    expect(first).toBeGreaterThan(0);
  }, 12000);

  test('losing concurrent startup cannot publish over the winning generation', async () => {
    const stateDir = dir();
    const stateFile = path.join(stateDir, 'browse.json');
    const barrier = path.join(stateDir, 'go');
    const ownerStartTime = readAgentStartTime(process.pid);
    const rawAgent = (gen: string, paused: boolean) => Bun.spawn(['bun', 'run', path.join(sourceDir, 'terminal-agent.ts'), `--agent-gen=${gen}`], {
      env: { ...process.env, BROWSE_STATE_FILE: stateFile, BROWSE_OWNER_PID: String(process.pid),
        BROWSE_OWNER_START_TIME: ownerStartTime, BROWSE_AGENT_GEN: gen, NODE_ENV: 'test',
        GSTACK_TERMINAL_OWNER_WATCHDOG_MS: '25',
        ...(paused ? { GSTACK_TERMINAL_TEST_PUBLISH_BARRIER: barrier } : {}) },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const old = rawAgent('synthetic-old-generation', true);
    let winner: ReturnType<typeof Bun.spawn> | undefined;
    try {
      writeAgentRecord(stateDir, { pid: old.pid, gen: 'synthetic-old-generation', startedAt: Date.now(),
        startTime: readAgentStartTime(old.pid), ownerPid: process.pid, ownerStartTime });
      expect(await waitFor(() => fs.existsSync(`${barrier}.ready`))).toBe(true);
      winner = rawAgent('synthetic-new-generation', false);
      writeAgentRecord(stateDir, { pid: winner.pid, gen: 'synthetic-new-generation', startedAt: Date.now(),
        startTime: readAgentStartTime(winner.pid), ownerPid: process.pid, ownerStartTime });
      expect(await waitFor(() => fs.existsSync(path.join(stateDir, 'terminal-port')))).toBe(true);
      const port = fs.readFileSync(path.join(stateDir, 'terminal-port'), 'utf8');
      const token = fs.readFileSync(path.join(stateDir, 'terminal-internal-token'), 'utf8');
      fs.writeFileSync(barrier, 'continue');
      expect(await Promise.race([old.exited.then(() => true), Bun.sleep(3000).then(() => false)])).toBe(true);
      expect(readAgentRecord(stateDir)?.gen).toBe('synthetic-new-generation');
      expect(fs.readFileSync(path.join(stateDir, 'terminal-port'), 'utf8')).toBe(port);
      expect(fs.readFileSync(path.join(stateDir, 'terminal-internal-token'), 'utf8')).toBe(token);
    } finally {
      fs.writeFileSync(barrier, 'continue');
      try { old.kill('SIGKILL'); } catch {}
      try { winner?.kill('SIGKILL'); } catch {}
      await old.exited;
      if (winner) await winner.exited;
    }
  }, 10000);

  test('daemon respawns after agent crash, then exits without deleting a successor state', async () => {
    const stateDir = dir();
    const stateFile = path.join(stateDir, 'browse.json');
    const daemon = Bun.spawn(['bun', 'run', path.join(sourceDir, 'server.ts')], {
      env: { ...process.env, BROWSE_STATE_FILE: stateFile, BROWSE_HEADLESS_SKIP: '1', BROWSE_PARENT_PID: '0',
        GSTACK_AGENT_WATCHDOG_TICK_MS: '50', GSTACK_STATE_WATCH_MS: '50' },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    try {
      expect(await waitFor(() => fs.existsSync(stateFile))).toBe(true);
      expect(await waitFor(() => {
        const record = readAgentRecord(stateDir);
        return !!record && record.pid > 0 && isOurAgent(record, daemon.pid);
      }, 5000)).toBe(true);
      const old = readAgentRecord(stateDir)!;
      expect(old.ownerPid).toBe(daemon.pid);
      expect(isOurAgent(old, daemon.pid)).toBe(true);
      expect(killAgentByRecord(old, 'SIGKILL')).toBe(true);
      expect(await waitFor(() => !!readAgentRecord(stateDir) && readAgentRecord(stateDir)!.gen !== old.gen, 5000)).toBe(true);
      const successor = { ...JSON.parse(fs.readFileSync(stateFile, 'utf8')), pid: process.pid, instanceId: 'synthetic-successor' };
      fs.writeFileSync(stateFile, JSON.stringify(successor));
      expect(await waitFor(() => daemon.exitCode !== null, 5000)).toBe(true);
      expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toEqual(successor);
    } finally {
      try { daemon.kill('SIGKILL'); } catch {}
      await daemon.exited;
    }
  }, 15000);
});
