/**
 * Pure utilities for design-daemon discovery.
 *
 * Shared between daemon.ts (writes/removes the state file) and
 * daemon-client.ts (reads state, decides spawn-vs-attach). Mirrors
 * browse/src/cli.ts:109-315 — same atomic-write + fs.openSync 'wx' lock
 * pattern, with an added cmdline-based identity check to guard against
 * SIGTERM hitting a reused PID (Codex finding on the daemon plan).
 */

import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

export interface DaemonState {
  pid: number;
  port: number;
  startedAt: string; // ISO 8601
  version: string;
  serverPath: string;
  cmdlineMarker: string;
}

// String we grep for in the spawned daemon's cmdline to confirm a pid is
// ours before sending any signal. Must appear in argv at spawn time.
export const CMDLINE_MARKER = "gstack-design-daemon";

export function resolveStateFilePath(): string {
  // Env override has highest precedence so tests can point both client and
  // spawned daemon at a per-test path without a shared cwd.
  const envOverride = process.env.DESIGN_DAEMON_STATE_FILE;
  if (envOverride) return envOverride;
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (root) return path.join(root, ".gstack", "design.json");
  } catch {
    // not in a git repo — fall through
  }
  return path.join(process.cwd(), ".gstack", "design.json");
}

export function resolveLockFilePath(stateFile: string = resolveStateFilePath()): string {
  return `${stateFile}.lock`;
}

export function resolveDaemonLogPath(): string {
  return path.join(os.homedir(), ".gstack", "design-daemon.log");
}

export function resolveStartupLogPath(): string {
  return path.join(os.homedir(), ".gstack", "design-daemon-startup.log");
}

/**
 * Read the gstack version both client and daemon should agree on. Looks
 * (in order): DESIGN_DAEMON_VERSION env, design/dist/.version baked at
 * build time, VERSION at the source-tree root (dev), then "unknown".
 *
 * Compiled binaries lose the source-tree relative path at runtime, so we
 * try the dist/.version sidecar (which build.sh writes) before falling
 * back. This keeps client.expectedVersion and daemon.VERSION coherent.
 */
export function readVersionString(): string {
  const env = process.env.DESIGN_DAEMON_VERSION;
  if (env) return env;
  const candidates = [
    // Compiled binary: design/dist/design lives alongside design/dist/.version
    path.join(path.dirname(process.execPath), ".version"),
    // Dev: design/src/* → repo root is two levels up
    path.join(import.meta.dir, "..", "..", "VERSION"),
    // Defensive: design/dist sibling of source tree
    path.join(import.meta.dir, "..", "dist", ".version"),
  ];
  for (const p of candidates) {
    try {
      const v = fs.readFileSync(p, "utf-8").trim();
      if (v) return v;
    } catch {
      // try next
    }
  }
  return "unknown";
}

export function readStateFile(stateFile: string = resolveStateFilePath()): DaemonState | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf-8")) as DaemonState;
  } catch {
    return null;
  }
}

export function writeStateFile(
  state: DaemonState,
  stateFile: string = resolveStateFilePath(),
): void {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, stateFile);
}

export function removeStateFile(stateFile: string = resolveStateFilePath()): void {
  try {
    fs.unlinkSync(stateFile);
  } catch {
    // already gone
  }
}

export interface HealthOk {
  ok: true;
  version: string;
  uptime: number;
  boards: number;
  activeBoards: number;
}

export async function healthCheck(
  port: number,
  timeoutMs: number = 2000,
): Promise<HealthOk | null> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as Partial<HealthOk> | null;
    if (body && body.ok === true && typeof body.version === "string") {
      return body as HealthOk;
    }
    return null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    // EPERM means it exists, we just can't signal it. ESRCH means it's gone.
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    return code === "EPERM";
  }
}

/**
 * Read the cmdline of a running process. Returns "" on any error.
 * Linux: /proc/<pid>/cmdline (NUL-separated argv). macOS: `ps -p PID -o command=`.
 */
export function readCmdline(pid: number): string {
  if (!isProcessAlive(pid)) return "";
  try {
    if (process.platform === "linux") {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8");
      return raw.replace(/\0/g, " ").trim();
    }
    if (process.platform === "darwin") {
      return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * True only when the process at `pid` has `marker` in its cmdline. Used to
 * avoid SIGTERMing an unrelated process that happens to have inherited a
 * PID from a stale state file (the Codex PID-reuse concern). On systems
 * where readCmdline is unsupported (or fails), this returns false — safer
 * to skip the signal than to risk killing the wrong process.
 */
export function verifyIdentity(pid: number, marker: string): boolean {
  if (!marker) return false;
  return readCmdline(pid).includes(marker);
}

/**
 * Acquire an exclusive lock on `lockPath`. Returns a release function, or
 * null if held by another live process. Stale locks (PID dead) are reclaimed
 * once; if reclaim also fails the caller waits and retries via state re-read.
 */
export function acquireLock(lockPath: string): (() => void) | null {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // 'wx' = create exclusive, fail if exists. Atomic check-and-create.
    const fd = fs.openSync(lockPath, "wx");
    fs.writeSync(fd, `${process.pid}\n`);
    fs.closeSync(fd);
    return () => {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // already gone
      }
    };
  } catch {
    // Held — check if holder is alive
    try {
      const holderPid = parseInt(fs.readFileSync(lockPath, "utf-8").trim(), 10);
      if (holderPid && isProcessAlive(holderPid)) return null;
      // Stale, reclaim
      fs.unlinkSync(lockPath);
      return acquireLock(lockPath);
    } catch {
      return null;
    }
  }
}
