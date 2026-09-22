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
import { execFileSync } from 'child_process';
import { safeUnlink, safeKill, isProcessAlive } from './error-handling';
import { restrictFilePermissions, mkdirSecure } from './file-permissions';
import { atomicWriteSync } from '../../lib/fs-atomic';

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

/** argv marker appended by spawnTerminalAgent; reapOrphanAgents reads it back from `ps`. */
export const OWNER_PID_ARG = '--owner-pid';
const PRIOR_AGENT_KILL_GRACE_MS = 1000;

/**
 * Spawn a fresh terminal-agent as a detached child. Steps, in order:
 *
 *   1. reapOrphanAgents(): kill agents of this script whose owner daemon is
 *      dead, plus any earlier agent that belongs to the SAME owner. A daemon
 *      wants exactly one agent; a watchdog that lost its record must not
 *      accumulate them (observed: one blind respawn per minute for three days
 *      filled a machine's process table).
 *   2. Kill the agent recorded at `<stateDir>/terminal-agent-pid` and CONFIRM
 *      it is gone before clearing the record (killAgentAndConfirm). An
 *      unkillable prior is kept and its PID returned — never two agents.
 *   3. `Bun.spawn(['bun', 'run', script, '--owner-pid', N])` with
 *      BROWSE_OWNER_PID / BROWSE_AGENT_GEN in env, so the agent can watch its
 *      owner and self-exit, and so `ps` shows who owns it.
 *   4. Write the {pid, gen, startedAt} record IMMEDIATELY, before the agent
 *      has bound — closing the window in which a shutdown or watchdog tick
 *      found no record. If the record can't be persisted (state dir not
 *      writable) the spawn is undone and null returned: an agent nobody can
 *      find by identity is an agent nobody can ever kill.
 *
 * `ownerPid` is the daemon the agent serves. The watchdog passes process.pid;
 * the CLI passes the daemon's PID because the CLI exits right after spawning —
 * an agent watching the CLI would die seconds later, and one watching nothing
 * lives forever. Note this means a CLI-spawned agent is reparented to PID 1
 * while perfectly healthy: ppid is NOT an orphan signal.
 *
 * Used by both the CLI cold-start path (cli.ts) and the v1.44 watchdog in
 * server.ts.
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
  const stateDir = path.dirname(opts.stateFile);
  const script = opts.scriptPath || resolveTerminalAgentScript();
  if (!script || !fs.existsSync(script)) return null;
  const ownerPid = opts.ownerPid;

  // 1. Sweep: dead-owner orphans + earlier agents of this same owner.
  try {
    const reaped = reapOrphanAgents(script, { ownerPid });
    if (reaped.length) console.warn(`[browse] reaped stale terminal-agent(s): ${reaped.join(', ')}`);
  } catch (err: any) {
    console.warn('[browse] stale terminal-agent sweep failed:', err?.message || err);
  }

  // 2. Confirmed prior-kill. Only clear the record once the PID is gone.
  const prior = readAgentRecord(stateDir);
  if (prior) {
    if (!killAgentAndConfirm(prior, PRIOR_AGENT_KILL_GRACE_MS)) {
      console.warn(`[browse] prior terminal-agent PID ${prior.pid} survived SIGKILL — keeping it`);
      return prior.pid;
    }
    clearAgentRecord(stateDir);
  }

  // 3. Spawn with the owner marker in argv and env.
  const gen = crypto.randomBytes(16).toString('base64url');
  const proc = (Bun as any).spawn(['bun', 'run', script, OWNER_PID_ARG, String(ownerPid)], {
    cwd: opts.cwd || process.cwd(),
    env: {
      ...process.env,
      BROWSE_STATE_FILE: opts.stateFile,
      BROWSE_SERVER_PORT: String(opts.serverPort),
      BROWSE_OWNER_PID: String(ownerPid),
      BROWSE_AGENT_GEN: gen,
      ...(opts.extraEnv || {}),
    },
    stdio: ['ignore', 'ignore', 'ignore'],
    // Explicit for the Node fallback path (dist/bun-polyfill.cjs), where the
    // host default is the opposite of Bun's. A visible console window on every
    // watchdog respawn is the symptom when this is missing.
    windowsHide: true,
  });
  proc.unref?.();
  const pid: number | null = proc.pid ?? null;
  if (!pid) return null;

  // 4. Record immediately. The agent re-writes the same {pid, gen} once bound.
  try {
    writeAgentRecord(stateDir, { pid, gen, startedAt: Date.now(), ownerPid });
  } catch (err: any) {
    console.warn(`[browse] terminal-agent record unwritable in ${stateDir} (${err?.message || err}) — not keeping agent ${pid}`);
    try { safeKill(pid, 'SIGTERM'); } catch {}
    return null;
  }
  return pid;
}

export interface AgentRecord {
  pid: number;
  /** Random per-boot identifier. Loopback /internal/* sees X-Browse-Gen: <gen>. */
  gen: string;
  /** ms since epoch. Reserved for future PID-reuse guards. */
  startedAt: number;
  /** Daemon PID this agent serves (--owner-pid). Absent on records written by older code. */
  ownerPid?: number;
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

export function clearAgentRecord(stateDir: string): void {
  safeUnlink(agentRecordPath(stateDir));
}

/**
 * Kill the agent identified by `record`. Signal defaults to SIGTERM (give
 * the agent a chance to run its own SIGTERM cleanup). Returns true if a
 * signal was actually sent to a live PID; false if the PID was already
 * dead (no-op). Never throws — ESRCH is swallowed by safeKill.
 *
 * Validates liveness BEFORE signaling so a PID-reuse race (the recorded
 * PID was reaped and a brand-new unrelated process now holds it) can't
 * cause us to kill the wrong process. This is a best-effort defense:
 * Linux/macOS don't expose process-start-time cheaply, and the gap
 * between record-write and watchdog-tick is small (60s max).
 */
export function killAgentByRecord(
  record: AgentRecord,
  signal: NodeJS.Signals = 'SIGTERM',
): boolean {
  if (!isProcessAlive(record.pid)) return false;
  safeKill(record.pid, signal);
  return true;
}

/** Synchronous bounded sleep that works under both Bun and Node (no polyfill needed). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForExit(pid: number, ms: number): boolean {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    sleepSync(process.platform === 'win32' ? 250 : 50); // tasklist is slow on Windows
  }
  return !isProcessAlive(pid);
}

/**
 * SIGTERM → wait graceMs → SIGKILL → wait 500ms. Returns true only when the
 * PID is confirmed gone, so callers may safely unlink the record. Sync and
 * bounded because spawnTerminalAgent (and the watchdog tick) are sync.
 * Never throws.
 */
export function killAgentAndConfirm(prior: AgentRecord, graceMs = 1000): boolean {
  try {
    if (!killAgentByRecord(prior, 'SIGTERM')) return true;
    if (waitForExit(prior.pid, graceMs)) return true;
    try { safeKill(prior.pid, 'SIGKILL'); } catch {}
    return waitForExit(prior.pid, 500);
  } catch {
    return !isProcessAlive(prior.pid);
  }
}

export interface AgentPsRow {
  pid: number;
  ppid: number;
  /** From the `--owner-pid N` argv marker; null for pre-marker (legacy) agents. */
  ownerPid: number | null;
}

/**
 * Pure parser for `ps axww -o pid=,ppid=,command=`. Matches only rows whose
 * command is `<…/>bun run <scriptPath>[ --owner-pid N …]` — the exact script
 * path, a `bun` executable (bare or absolute), nothing else. `node …`,
 * `grep …`, other scripts and `<scriptPath>.bak` are all rejected.
 */
export function parseAgentRows(psOutput: string, scriptPath: string): AgentPsRow[] {
  const out: AgentPsRow[] = [];
  const marker = ` run ${scriptPath}`;
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const cmd = m[3];
    const idx = cmd.indexOf(marker);
    if (idx <= 0 || path.basename(cmd.slice(0, idx)) !== 'bun') continue;
    const rest = cmd.slice(idx + marker.length);
    if (rest !== '' && !rest.startsWith(' ')) continue; // rejects terminal-agent.ts.bak
    const om = /(?:^|\s)--owner-pid\s+(\d+)(?:\s|$)/.exec(rest);
    out.push({ pid: +m[1], ppid: +m[2], ownerPid: om ? +om[1] : null });
  }
  return out;
}

/**
 * Owner of the agent process `pid` as recorded in its argv marker: a number
 * (`--owner-pid N`), null for a marker-less (pre-marker) agent, undefined when
 * no such agent row exists or `ps` is unavailable (Windows). Lets a daemon
 * decide whether a live agent named by a legacy record (no ownerPid) is its
 * own before trusting it.
 */
export function agentOwner(pid: number, scriptPath: string, psOutput?: string): number | null | undefined {
  if (process.platform === 'win32') return undefined;
  let ps: string;
  try {
    ps = psOutput ?? execFileSync('ps', ['axww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 3000 });
  } catch {
    return undefined;
  }
  const row = parseAgentRows(ps, scriptPath).find((r) => r.pid === pid);
  return row ? row.ownerPid : undefined;
}

/**
 * Reap agents of `scriptPath` that no live daemon wants:
 *   - rows carrying `--owner-pid N`: reaped iff N is dead, or N === opts.ownerPid
 *     (the caller is about to spawn a replacement for that owner — a daemon
 *     runs exactly one agent, so any earlier one of the same owner is a duplicate);
 *   - rows without the marker (pre-marker agents): reaped iff ppid === 1, or
 *     ppid === opts.ownerPid (watchdog-spawned duplicates of this daemon).
 *     A still-owned legacy agent reaped by the ppid-1 rule is respawned by its
 *     daemon's watchdog within a tick, now with the marker — a one-time cost.
 * Never signals the calling process. Not `pkill`: exact argv identity, no
 * regex over process names. No-op on Windows. Sync and bounded.
 */
export function reapOrphanAgents(
  scriptPath: string,
  opts: {
    ownerPid?: number;
    psOutput?: string;
    isAlive?: (pid: number) => boolean;
    kill?: (pid: number, sig: NodeJS.Signals) => void;
    graceMs?: number;
    selfPid?: number;
  } = {},
): number[] {
  if (process.platform === 'win32') return [];
  const isAlive = opts.isAlive ?? isProcessAlive;
  const kill = opts.kill ?? ((pid: number, sig: NodeJS.Signals) => safeKill(pid, sig));
  const selfPid = opts.selfPid ?? process.pid;
  const ps = opts.psOutput ?? execFileSync('ps', ['axww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 3000 });
  const victims = parseAgentRows(ps, scriptPath).filter((r) => {
    if (r.pid === selfPid) return false;
    if (r.ownerPid !== null) return !isAlive(r.ownerPid) || r.ownerPid === opts.ownerPid;
    return r.ppid === 1 || (opts.ownerPid !== undefined && r.ppid === opts.ownerPid);
  });
  if (!victims.length) return [];
  for (const v of victims) { try { kill(v.pid, 'SIGTERM'); } catch {} }
  const deadline = Date.now() + (opts.graceMs ?? 500);
  while (Date.now() < deadline && victims.some((v) => isAlive(v.pid))) sleepSync(50);
  for (const v of victims) { if (isAlive(v.pid)) { try { kill(v.pid, 'SIGKILL'); } catch {} } }
  return victims.map((v) => v.pid);
}
