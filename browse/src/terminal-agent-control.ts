/**
 * terminal-agent process-control primitives shared by cli.ts spawn site,
 * server.ts shutdown teardown, and the v1.44 watchdog/respawn loop.
 *
 * Why this exists: pre-v1.44 used `pkill -f terminal-agent\.ts`, which
 * matches any process whose argv contains the string and would kill
 * sibling gstack sessions on the same host. The agent now writes a
 * structured `terminal-agent-pid` record (`{pid, gen, startedAt}`) and
 * every kill site routes through `killAgentByRecord` here — identity-based,
 * no regex.
 *
 * The `gen` field is a per-boot generation counter. Loopback /internal/*
 * calls from the parent server include `X-Browse-Gen` so a slow agent that
 * the watchdog respawned around can't accidentally service a stale grant
 * from the old generation.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';
import { safeUnlink, isProcessAlive } from './error-handling';
import { restrictFilePermissions, mkdirSecure } from './file-permissions';
import { atomicWriteSync } from '../../lib/fs-atomic';
import { readPidCmdline, readPidStartTime } from './xvfb';

function agentProcessInfo(pid: number): { startTime: string; commandLine: string } {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { startTime: '', commandLine: '' };
  if (process.platform !== 'win32') return { startTime: readPidStartTime(pid), commandLine: readPidCmdline(pid) };
  const script = `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object CreationDate,CommandLine | ConvertTo-Json -Compress)`;
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 2000 });
    if (result.status !== 0 || !result.stdout) return { startTime: '', commandLine: '' };
    const processInfo = JSON.parse(result.stdout);
    return { startTime: processInfo?.CreationDate || '', commandLine: processInfo?.CommandLine || '' };
  } catch { return { startTime: '', commandLine: '' }; }
}

export function readAgentStartTime(pid: number): string {
  return agentProcessInfo(pid).startTime;
}

const pendingAgentExits = new Set<any>();

export function acquireAgentStateLock(stateDir: string, waitMs = 5000): () => void {
  mkdirSecure(stateDir);
  const lockPath = path.join(stateDir, 'terminal-agent-pid.lock');
  const deadline = Date.now() + waitMs;
  let fd: number;
  while (true) {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      break;
    } catch (err: any) {
      if (err?.code !== 'EEXIST' || Date.now() >= deadline) {
        throw new Error(`terminal-agent state lock unavailable at ${lockPath}: ${err?.code || err}; inspect the owning process before manual recovery`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  const owned = fs.fstatSync(fd, { bigint: true });
  return () => {
    try {
      const current = fs.statSync(lockPath, { bigint: true });
      if (current.dev === owned.dev && current.ino === owned.ino) fs.unlinkSync(lockPath);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    } finally { fs.closeSync(fd); }
  };
}

/**
 * Locate the terminal-agent script on disk. In dev (cli.ts running via
 * `bun run`), it lives next to this file in browse/src. In a compiled
 * binary, Bun's --compile bakes the source into the executable and
 * exposes it relative to process.execPath. Either path must work or
 * the agent can't be spawned at all.
 */
export function resolveTerminalAgentScript(searchHints: { metaDir?: string; execPath?: string } = {}): string | null {
  const meta = searchHints.metaDir || __dirname;
  const exec = searchHints.execPath || process.execPath;
  const candidates = [
    path.resolve(meta, 'terminal-agent.ts'),
    path.resolve(path.dirname(exec), '..', 'src', 'terminal-agent.ts'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Spawn an owned terminal-agent. A prior record is retained until its exact
 * process exits, and the new generation is recorded before it may bind.
 *
 * Used by both the CLI cold-start path (cli.ts) and the v1.44 watchdog in
 * server.ts. Centralizing here removes a copy-paste between them and means
 * spawn-env additions (BROWSE_OWNER_PID being the first) land in one place.
 */
export function spawnTerminalAgent(opts: {
  stateFile: string;
  serverPort: number;
  /** PID of the browse server that owns this agent. */
  ownerPid: number;
  cwd?: string;
  /** Optional extra env vars to add to the agent's process env. */
  extraEnv?: Record<string, string>;
  /** Override script lookup for tests. */
  scriptPath?: string;
}): number | null {
  if (!Number.isSafeInteger(opts.ownerPid) || opts.ownerPid <= 0) throw new Error('terminal-agent requires a daemon owner PID');
  const stateDir = path.dirname(opts.stateFile);
  const script = opts.scriptPath || resolveTerminalAgentScript();
  if (!script || !fs.existsSync(script)) return null;
  const release = acquireAgentStateLock(stateDir);
  try {
    const prior = readAgentRecord(stateDir);
    if (prior) {
      if (prior.pid === 0) {
        console.warn('[browse] terminal-agent startup or failed exit remains unconfirmed; retaining its reservation');
        return null;
      }
      if (isAgentRecordLive(prior) && !stopAgentByRecord(prior)) {
        console.warn(`[browse] terminal-agent PID ${prior.pid} is still running or its identity cannot be confirmed; refusing a second agent`);
        return null;
      }
      clearAgentRecord(stateDir, prior);
      safeUnlink(path.join(stateDir, 'terminal-port'));
      safeUnlink(path.join(stateDir, 'terminal-internal-token'));
    }
    const ownerStartTime = readAgentStartTime(opts.ownerPid);
    if (!ownerStartTime) throw new Error('terminal-agent owner identity is unavailable');
    const gen = crypto.randomBytes(16).toString('base64url');
    const reservation: AgentRecord = { pid: 0, gen, startedAt: Date.now(), ownerPid: opts.ownerPid, ownerStartTime };
    writeAgentRecord(stateDir, reservation);
    let proc: any;
    try {
      proc = (Bun as any).spawn(['bun', 'run', script, `--agent-gen=${gen}`], {
        cwd: opts.cwd || process.cwd(),
        env: {
          ...process.env,
          ...(opts.extraEnv || {}),
          BROWSE_STATE_FILE: opts.stateFile,
          BROWSE_SERVER_PORT: String(opts.serverPort),
          BROWSE_OWNER_PID: String(opts.ownerPid),
          BROWSE_OWNER_START_TIME: ownerStartTime,
          BROWSE_AGENT_GEN: gen,
        },
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      });
    } catch (err) {
      clearAgentRecord(stateDir, reservation);
      throw err;
    }
    const retainUntilExit = () => {
      pendingAgentExits.add(proc);
      proc.exited?.then(() => {
        try {
          const releasePending = acquireAgentStateLock(stateDir);
          try { clearAgentRecord(stateDir, reservation); } finally { releasePending(); }
        } catch (err) { console.warn('[browse] terminal-agent pending exit cleanup failed:', err); }
        pendingAgentExits.delete(proc);
      }, (err: unknown) => console.warn('[browse] terminal-agent exit remains unconfirmed:', err));
    };
    const pid = proc.pid;
    const startTime = pid ? readAgentStartTime(pid) : '';
    if (!pid || !startTime) {
      try { proc.kill('SIGTERM'); } catch {}
      retainUntilExit();
      throw new Error('terminal-agent process identity is unavailable');
    }
    const record: AgentRecord = { pid, gen, startedAt: Date.now(), startTime, ownerPid: opts.ownerPid, ownerStartTime };
    try {
      writeAgentRecord(stateDir, record);
    } catch (err) {
      if (!stopAgentByRecord(record)) {
        retainUntilExit();
        throw new Error(`terminal-agent record update failed and child ${pid} exit is unconfirmed: ${err}`);
      }
      clearAgentRecord(stateDir, reservation);
      throw err;
    }
    proc.unref?.();
    return pid;
  } finally { release(); }
}

export interface AgentRecord {
  pid: number;
  /** Random per-boot identifier. Loopback /internal/* sees X-Browse-Gen: <gen>. */
  gen: string;
  /** ms since epoch. Reserved for future PID-reuse guards. */
  startedAt: number;
  startTime?: string;
  ownerPid?: number;
  ownerStartTime?: string;
}

export function agentRecordPath(stateDir: string): string {
  return path.join(stateDir, 'terminal-agent-pid');
}

/** Read the current record. Returns null on missing/malformed file. */
export function readAgentRecord(stateDir: string): AgentRecord | null {
  try {
    const raw = fs.readFileSync(agentRecordPath(stateDir), 'utf-8');
    const j = JSON.parse(raw);
    if (typeof j?.pid === 'number' && typeof j?.gen === 'string' && typeof j?.startedAt === 'number') {
      return j as AgentRecord;
    }
    return null;
  } catch {
    return null;
  }
}

/** Atomic write (throws on failure — boot must not proceed on a bad record). */
export function writeAgentRecord(stateDir: string, record: AgentRecord): void {
  try { mkdirSecure(stateDir); } catch {}
  const target = agentRecordPath(stateDir);
  atomicWriteSync(target, JSON.stringify(record), { mode: 0o600 });
  // Windows ACL hardening (POSIX chmod is redundant with mode above).
  restrictFilePermissions(target);
}

export function clearAgentRecord(stateDir: string, expected?: AgentRecord): void {
  if (expected) {
    const current = readAgentRecord(stateDir);
    if (!current || current.pid !== expected.pid || current.gen !== expected.gen) return;
  }
  safeUnlink(agentRecordPath(stateDir));
}

export function isAgentRecordLive(record: AgentRecord): boolean {
  return Number.isSafeInteger(record.pid) && record.pid > 0 && isProcessAlive(record.pid);
}

function agentStatus(record: AgentRecord, ownerPid?: number): 'owned' | 'gone' | 'unknown' {
  if (!isAgentRecordLive(record)) return 'gone';
  if (!record.startTime || !record.ownerPid || !record.ownerStartTime) return 'unknown';
  if (ownerPid !== undefined && (record.ownerPid !== ownerPid || record.ownerStartTime !== readAgentStartTime(ownerPid))) return 'unknown';
  const actual = agentProcessInfo(record.pid);
  if (!actual.startTime) return isAgentRecordLive(record) ? 'unknown' : 'gone';
  if (actual.startTime !== record.startTime) return 'gone';
  try {
    let state: string | undefined;
    if (process.platform === 'linux') {
      state = fs.readFileSync(`/proc/${record.pid}/stat`, 'utf8').match(/^\d+ \(.*\) ([A-Z])/u)?.[1];
    } else if (process.platform === 'darwin') {
      const result = spawnSync('ps', ['-p', String(record.pid), '-o', 'stat='], { encoding: 'utf8', windowsHide: true, timeout: 2000 });
      if (result.status === 0) state = result.stdout?.trim()?.[0];
    }
    if (state === 'Z') return 'gone';
  } catch {}
  if (!isAgentRecordLive(record)) return 'gone';
  return actual.commandLine.split(/\s+/).some(arg => arg.replace(/^['"]|['"]$/g, '') === `--agent-gen=${record.gen}`)
    ? 'owned' : 'unknown';
}

export function isOurAgent(record: AgentRecord, ownerPid?: number): boolean {
  return agentStatus(record, ownerPid) === 'owned';
}

export function isAgentRecordGone(record: AgentRecord): boolean {
  return agentStatus(record) === 'gone';
}

/**
 * Kill the agent identified by `record`. Signal defaults to SIGTERM (give
 * the agent a chance to run its own SIGTERM cleanup). Returns true if a
 * signal reached an exact-generation live process, false otherwise.
 */
export function killAgentByRecord(
  record: AgentRecord,
  signal: NodeJS.Signals = 'SIGTERM',
): boolean {
  if (!isOurAgent(record)) return false;
  try { process.kill(record.pid, signal); return true; } catch { return false; }
}

export function stopAgentByRecord(record: AgentRecord, graceMs = 1000): boolean {
  const initial = agentStatus(record);
  if (initial === 'gone') return true;
  if (initial !== 'owned') return false;
  const waitForExit = (ms: number) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const status = agentStatus(record);
      if (status === 'gone') return true;
      if (status === 'unknown') return false;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    return agentStatus(record) === 'gone';
  };
  if (!killAgentByRecord(record, 'SIGTERM')) return agentStatus(record) === 'gone';
  if (waitForExit(graceMs)) return true;
  const afterGrace = agentStatus(record);
  if (afterGrace !== 'owned') return afterGrace === 'gone';
  if (!killAgentByRecord(record, 'SIGKILL')) return agentStatus(record) === 'gone';
  return waitForExit(graceMs);
}
