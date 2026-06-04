/**
 * CLI-side client for the design daemon.
 *
 * Responsible for the lifecycle dance that `$D compare --serve` (default
 * path) goes through:
 *
 *   ensureDaemon() → publishBoard(html, opts) → openBrowser(url) → exit 0
 *
 * Mirrors browse/src/cli.ts:317-415 — same health-check-first attach
 * decision, same fs.openSync('wx') lock, same re-read-under-lock guard.
 * Adds two design-specific safety properties Codex flagged on the daemon
 * plan:
 *
 *   1. Identity verification before any SIGTERM. Browse signals on PID
 *      alone; here we require the cmdline to contain CMDLINE_MARKER so a
 *      stale state file pointing at a reused PID doesn't kill an
 *      unrelated process.
 *
 *   2. Refuse-to-kill on version mismatch with active boards. Browse will
 *      restart on version drift; here in-memory boards would be lost, so
 *      we exit 1 with a user-actionable message instead of silent loss.
 *
 * Spawn uses Node's child_process.spawn with detached: true + stdio
 * pointed at a log file. Bun.spawn().unref() has macOS session-detach
 * quirks browse already discovered (browse/src/cli.ts:225-275).
 */

import { spawn as nodeSpawn } from "child_process";
import fs from "fs";
import path from "path";
import { setTimeout as delay } from "timers/promises";

import {
  acquireLock,
  CMDLINE_MARKER,
  healthCheck,
  isProcessAlive,
  readStateFile,
  readVersionString,
  resolveLockFilePath,
  resolveStartupLogPath,
  resolveStateFilePath,
  verifyIdentity,
} from "./daemon-state";

const MAX_START_WAIT_MS = parseInt(
  process.env.DESIGN_DAEMON_START_TIMEOUT_MS || "8000",
  10,
);
const POLL_INTERVAL_MS = 100;
const SIGTERM_GRACE_MS = 2000;

export interface EnsureDaemonOptions {
  /** Default: package version. Used for version-match check. */
  version?: string;
  /** Default: `<repo>/design/src/daemon.ts`. */
  daemonScript?: string;
  /** Extra env vars passed to the spawned daemon. */
  daemonEnv?: Record<string, string>;
  /** Print noisy progress to stderr. Default true. */
  verbose?: boolean;
  /**
   * Override the state-file path. Default: resolveStateFilePath() (env
   * DESIGN_DAEMON_STATE_FILE or .gstack/design.json under the git root /
   * cwd). Tests inject a per-test path; the same path is forwarded to the
   * spawned daemon via env so client + daemon agree.
   */
  stateFile?: string;
}

export interface EnsureDaemonResult {
  port: number;
  version: string;
  spawned: boolean;
}

function log(verbose: boolean, msg: string): void {
  if (verbose) process.stderr.write(`[design-daemon] ${msg}\n`);
}

/**
 * Ensure a design daemon is reachable on the project's state file. Returns
 * the port to talk to. Spawns a new daemon under an exclusive lock when
 * needed; attaches to an existing healthy daemon otherwise.
 *
 * Exits with code 1 (not throws) on the refuse-kill-with-active-boards
 * branch — that's a user-actionable situation, not a programming error.
 */
export async function ensureDaemon(
  opts: EnsureDaemonOptions = {},
): Promise<EnsureDaemonResult> {
  const verbose = opts.verbose !== false;
  const expectedVersion = opts.version ?? readPackageVersion();
  const stateFile = opts.stateFile ?? resolveStateFilePath();

  const existing = readStateFile(stateFile);
  if (existing) {
    const health = await healthCheck(existing.port);
    if (health) {
      if (health.version === expectedVersion) {
        log(verbose, `attached to existing daemon pid=${existing.pid} port=${existing.port}`);
        return { port: existing.port, version: health.version, spawned: false };
      }
      // Version mismatch: refuse if active boards exist (Codex finding).
      if (health.activeBoards > 0) {
        process.stderr.write(
          `[design-daemon] WARNING: existing daemon is gstack ${health.version}; this CLI is ${expectedVersion}.\n` +
            `[design-daemon] ${health.activeBoards} active board(s) detected. Refusing to auto-kill.\n` +
            `[design-daemon] Submit or close the open boards, then re-run.\n` +
            `[design-daemon] Or force restart: $D daemon stop (will drop in-memory history).\n`,
        );
        process.exit(1);
      }
      // No active boards — safe to graceful-shutdown and respawn.
      log(verbose, `daemon version mismatch (${health.version} vs ${expectedVersion}); shutting down`);
      await gracefulShutdownExistingDaemon(existing.port);
      await killByPidWithIdentity(existing.pid, existing.cmdlineMarker, verbose);
    } else {
      // State file points at an unresponsive port. Either the daemon
      // crashed or the PID got reused. Identity-verify before any SIGTERM
      // so we don't kill an unrelated process (Codex finding).
      log(verbose, `state file present (pid=${existing.pid}) but /health unresponsive`);
      await killByPidWithIdentity(existing.pid, existing.cmdlineMarker, verbose);
    }
  }

  // Spawn under exclusive lock; re-read state INSIDE the lock so we don't
  // race a concurrent CLI that won the lock first.
  const lockPath = resolveLockFilePath(stateFile);
  const release = acquireLock(lockPath);
  if (!release) {
    // Another process is starting the daemon. Wait for it.
    log(verbose, "another CLI is spawning the daemon; waiting…");
    const start = Date.now();
    while (Date.now() - start < MAX_START_WAIT_MS) {
      const fresh = readStateFile(stateFile);
      if (fresh) {
        const h = await healthCheck(fresh.port);
        if (h) return { port: fresh.port, version: h.version, spawned: false };
      }
      await delay(POLL_INTERVAL_MS);
    }
    throw new Error("Timed out waiting for concurrent daemon spawn");
  }

  try {
    // Re-read under lock. Another caller may have already finished spawning
    // between our first check and our lock acquisition.
    const fresh = readStateFile(stateFile);
    if (fresh) {
      const h = await healthCheck(fresh.port);
      if (h && h.version === expectedVersion) {
        log(verbose, `another CLI won the lock; attaching pid=${fresh.pid} port=${fresh.port}`);
        return { port: fresh.port, version: h.version, spawned: false };
      }
    }

    log(verbose, "spawning new daemon");
    const port = await spawnDaemon({
      script: opts.daemonScript,
      env: { ...opts.daemonEnv, DESIGN_DAEMON_STATE_FILE: stateFile },
      stateFile,
      expectedVersion,
    });
    return { port, version: expectedVersion, spawned: true };
  } finally {
    release();
  }
}

/**
 * Publish a board to the daemon and return its URL. Wraps the HTTP POST
 * with a friendlier error surface than raw fetch.
 */
export interface PublishBoardOptions {
  port: number;
  html: string;
  title?: string;
  publisherPid?: number;
}

export interface PublishBoardResult {
  id: string;
  url: string;
  sourceDir: string;
}

export async function publishBoard(opts: PublishBoardOptions): Promise<PublishBoardResult> {
  const body: Record<string, unknown> = {
    html: opts.html,
    publisherPid: opts.publisherPid ?? process.pid,
  };
  if (opts.title) body.title = opts.title;
  const resp = await fetch(`http://127.0.0.1:${opts.port}/api/boards`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    let errText: string;
    try {
      const j = (await resp.json()) as { error?: string; existing?: { id: string; url: string } };
      if (j.existing) {
        // 409: surface the existing-board URL so the caller can reuse it
        return { id: j.existing.id, url: j.existing.url, sourceDir: "" };
      }
      errText = j.error || `HTTP ${resp.status}`;
    } catch {
      errText = `HTTP ${resp.status}`;
    }
    throw new Error(`Daemon refused publish: ${errText}`);
  }
  return (await resp.json()) as PublishBoardResult;
}

// ─── Internals ───────────────────────────────────────────────────

function readPackageVersion(): string {
  return readVersionString();
}

function defaultDaemonScript(): string {
  // design/src/daemon-client.ts → daemon.ts is a sibling. Only used in dev
  // when this process is `bun run cli.ts`; the compiled-binary path
  // self-execs instead (see resolveSpawnCommand).
  return path.join(import.meta.dir, "daemon.ts");
}

/**
 * Compute the argv to spawn the daemon. Two modes:
 *
 *   Compiled binary (`design/dist/design`): re-exec ourselves with
 *   --daemon-mode. process.execPath IS the compiled design binary;
 *   spawning it again with the flag runs the daemon (see the
 *   --daemon-mode branch at the bottom of cli.ts).
 *
 *   Dev (`bun run design/src/cli.ts`): process.execPath is bun, so we
 *   invoke `bun run <daemon.ts> --marker ...` directly.
 *
 * Tests can override the dev script via opts.script.
 */
function resolveSpawnCommand(scriptOverride: string | undefined): {
  command: string;
  args: string[];
} {
  const execBase = path.basename(process.execPath).toLowerCase();
  const isCompiledHost = execBase !== "bun" && execBase !== "bun.exe" && execBase !== "node";
  if (isCompiledHost && !scriptOverride) {
    return {
      command: process.execPath,
      args: ["--daemon-mode", "--marker", CMDLINE_MARKER],
    };
  }
  const script = scriptOverride ?? defaultDaemonScript();
  return {
    command: "bun",
    args: ["run", script, "--marker", CMDLINE_MARKER],
  };
}

interface SpawnDaemonOpts {
  script?: string;
  env?: Record<string, string>;
  stateFile: string;
  expectedVersion: string;
}

async function spawnDaemon(opts: SpawnDaemonOpts): Promise<number> {
  const logPath = resolveStartupLogPath();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  // Truncate the startup log on each spawn so a later read finds only THIS
  // attempt's output (mirrors browse's per-spawn log truncation).
  fs.writeFileSync(logPath, "");
  const logFd = fs.openSync(logPath, "a");

  const { command, args } = resolveSpawnCommand(opts.script);

  const child = nodeSpawn(command, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      DESIGN_DAEMON_VERSION: opts.expectedVersion,
      ...(opts.env ?? {}),
    },
  });
  child.unref();
  fs.closeSync(logFd);

  // Poll the state file + /health until the daemon is up, or until timeout.
  const deadline = Date.now() + MAX_START_WAIT_MS;
  while (Date.now() < deadline) {
    const fresh = readStateFile(opts.stateFile);
    if (fresh) {
      const h = await healthCheck(fresh.port);
      if (h) return fresh.port;
    }
    await delay(POLL_INTERVAL_MS);
  }

  // Timed out — surface the startup log so the user sees the actual error
  // instead of "daemon failed silently."
  let tail = "";
  try {
    tail = fs.readFileSync(logPath, "utf-8").trim();
  } catch {
    // log file may not exist
  }
  throw new Error(
    `Design daemon failed to start within ${MAX_START_WAIT_MS}ms.\n` +
      `Startup log (${logPath}):\n${tail || "(empty)"}`,
  );
}

async function gracefulShutdownExistingDaemon(port: number): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Daemon may have already exited or be unresponsive — fall through
    // to the SIGTERM path with identity verification.
  }
}

/**
 * Send SIGTERM (then SIGKILL) to `pid`, but ONLY if the running cmdline
 * contains `marker`. Prevents a stale state file from causing us to signal
 * an unrelated process that inherited the PID.
 */
async function killByPidWithIdentity(
  pid: number,
  marker: string,
  verbose: boolean,
): Promise<void> {
  if (!pid || pid <= 0) return;
  if (!isProcessAlive(pid)) return;
  if (!verifyIdentity(pid, marker || CMDLINE_MARKER)) {
    log(
      verbose,
      `pid ${pid} is alive but cmdline doesn't match marker '${marker || CMDLINE_MARKER}'; skipping signal (possible PID reuse)`,
    );
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
    return;
  }
  // Give it a grace period; SIGKILL if still alive AND still ours.
  const deadline = Date.now() + SIGTERM_GRACE_MS;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await delay(50);
  }
  if (isProcessAlive(pid) && verifyIdentity(pid, marker || CMDLINE_MARKER)) {
    log(verbose, `pid ${pid} survived SIGTERM; SIGKILL`);
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // raced with exit
    }
  }
}

/**
 * Public: $D daemon stop. Posts /shutdown if no active boards; otherwise
 * reports refusal. Used by the CLI sub-command (next commit).
 */
export async function shutdownDaemon(opts: { force?: boolean } = {}): Promise<{
  stopped: boolean;
  reason?: string;
  activeBoards?: number;
}> {
  const stateFile = resolveStateFilePath();
  const existing = readStateFile(stateFile);
  if (!existing) return { stopped: false, reason: "no daemon running" };
  const health = await healthCheck(existing.port);
  if (!health) {
    // unresponsive: try SIGTERM via identity-checked path
    await killByPidWithIdentity(existing.pid, existing.cmdlineMarker, true);
    return { stopped: true, reason: "unresponsive daemon killed via SIGTERM" };
  }
  if (health.activeBoards > 0 && !opts.force) {
    return {
      stopped: false,
      reason: "active boards present",
      activeBoards: health.activeBoards,
    };
  }
  await gracefulShutdownExistingDaemon(existing.port);
  // Best-effort: SIGTERM if /shutdown didn't take effect
  if (isProcessAlive(existing.pid)) {
    await killByPidWithIdentity(existing.pid, existing.cmdlineMarker, true);
  }
  return { stopped: true };
}

/** $D daemon status — for the CLI sub-command. */
export async function daemonStatus(): Promise<
  | { running: false }
  | { running: true; port: number; pid: number; version: string; boards: number; activeBoards: number; uptime: number }
> {
  const existing = readStateFile();
  if (!existing) return { running: false };
  const h = await healthCheck(existing.port);
  if (!h) return { running: false };
  return {
    running: true,
    port: existing.port,
    pid: existing.pid,
    version: h.version,
    boards: h.boards,
    activeBoards: h.activeBoards,
    uptime: h.uptime,
  };
}
