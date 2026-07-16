// Single-instance enforcement. Daemon takes an exclusive flock on
// ~/.gstack/ios-qa-daemon.pid on startup. Second invocation discovers the
// existing daemon's port + connects. Stale lock (PID dead) is reclaimed.
//
// Readiness protocol: daemon writes `READY: port=<n> pid=<pid>` to stdout
// once both listeners are up; the spawner reads stdout with a 5s timeout.

import { readFile, mkdir, unlink } from 'fs/promises';
import { existsSync, openSync, writeSync, closeSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';

export interface PidfileContents {
  pid: number;
  port: number;
  startedAt: number;
}

export function defaultPidfilePath(): string {
  return process.env.GSTACK_IOS_DAEMON_PIDFILE
    ?? join(homedir(), '.gstack', 'ios-qa-daemon.pid');
}

/**
 * Try to claim the pidfile. Returns:
 * - { claimed: true } when this process now owns the lock
 * - { claimed: false, existing } when another live daemon holds it
 *
 * The "live" check is process.kill(pid, 0): succeeds if the PID exists,
 * fails with ESRCH if not. We DO NOT trust a stale pidfile.
 */
export async function tryClaim(opts: {
  port: number;
  path?: string;
}): Promise<
  | { claimed: true; release: () => Promise<void> }
  | { claimed: false; existing: PidfileContents }
> {
  const path = opts.path ?? defaultPidfilePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  // Check for an existing pidfile.
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, 'utf-8');
      const existing = JSON.parse(raw) as PidfileContents;
      if (isAlive(existing.pid)) {
        return { claimed: false, existing };
      }
      // Stale — drop it and continue to claim.
      await unlink(path).catch(() => {});
    } catch {
      // Unparseable pidfile — treat as stale.
      await unlink(path).catch(() => {});
    }
  }

  // Use SYNCHRONOUS open with O_EXCL for atomic exclusion. Bun's async
  // fs.open(wx) doesn't reliably preserve O_EXCL semantics across concurrent
  // calls in the same process. Sync openSync goes straight to syscall and is
  // genuinely atomic.
  //
  // Constant 0x800 = O_EXCL on macOS/Linux; combined with O_CREAT (0x200) and
  // O_WRONLY (0x1) it's the equivalent of 'wx'. The sync API accepts the
  // string flag form too, but explicit numeric flags are the most defensive.
  const contents: PidfileContents = {
    pid: process.pid,
    port: opts.port,
    startedAt: Date.now(),
  };
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code === 'EEXIST') {
      // Race: another caller won.
      const raw = await readFile(path, 'utf-8').catch(() => '{}');
      const existing = JSON.parse(raw || '{}') as PidfileContents;
      return { claimed: false, existing };
    }
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify(contents, null, 2));
  } finally {
    closeSync(fd);
  }

  // Cleanup on exit.
  const cleanup = async () => {
    try {
      // Verify we still own it before unlinking.
      const raw = await readFile(path, 'utf-8');
      const cur = JSON.parse(raw) as PidfileContents;
      if (cur.pid === process.pid) {
        await unlink(path);
      }
    } catch {
      // best-effort
    }
  };

  process.on('exit', () => {
    try { unlinkSync(path); } catch { /* ignore */ }
  });
  process.on('SIGINT', () => { cleanup().finally(() => process.exit(0)); });
  process.on('SIGTERM', () => { cleanup().finally(() => process.exit(0)); });

  return { claimed: true, release: cleanup };
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const e = err as { code?: string };
    return e.code !== 'ESRCH';
  }
}

/**
 * Spawn a daemon process and wait for the READY line. Returns the port the
 * daemon claims to be listening on.
 *
 * Used by /ios-qa skill to spawn-on-demand. If another daemon is already
 * running, the spawned child detects the existing pidfile and prints a
 * READY line with the existing port (loaded from the pidfile).
 */
export async function spawnAndWaitReady(opts: {
  cmd: string;
  args: string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<{ pid: number; port: number }> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const child = spawn(opts.cmd, opts.args, {
    stdio: ['ignore', 'pipe', 'inherit'],
    detached: true,
    env: opts.env ?? process.env,
  });

  return new Promise((resolve, reject) => {
    let buffer = '';
    const onTimeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`daemon spawn timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(/READY:\s*port=(\d+)\s+pid=(\d+)/);
      if (match) {
        clearTimeout(onTimeout);
        child.unref();
        resolve({ pid: parseInt(match[2]!, 10), port: parseInt(match[1]!, 10) });
      }
    });
    child.on('error', (err) => {
      clearTimeout(onTimeout);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(onTimeout);
      reject(new Error(`daemon exited before READY (code=${code} signal=${signal})`));
    });
  });
}
