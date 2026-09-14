/**
 * Out-of-process tests for daemon-client.ts.
 *
 * Spawns real daemon subprocesses (via the fixtures helper) so we can
 * exercise: state-file discovery, /health attach vs spawn, the lock +
 * re-read-under-lock race, identity-verified SIGTERM, version mismatch
 * with and without active boards, startup-error log surfacing, and the
 * concurrent-CLIs race (two real subprocesses, one wins the lock).
 *
 * These tests are slower than daemon.test.ts (each spawn is ~200ms) so
 * they're kept in a separate file to keep the in-process suite fast.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import {
  daemonStatus,
  ensureDaemon,
  publishBoard,
  shutdownDaemon,
} from "../src/daemon-client";
import {
  acquireLock,
  CMDLINE_MARKER,
  isProcessAlive,
  readStateFile,
  resolveLockFilePath,
  verifyIdentity,
} from "../src/daemon-state";
import {
  DAEMON_SCRIPT,
  makeBoardHtml,
  makeTmpDir,
  spawnDaemonForTest,
  type SpawnedDaemon,
} from "./daemon-tests-fixtures";

let workDir: string;
let stateFile: string;
let activeDaemons: SpawnedDaemon[] = [];

beforeEach(() => {
  workDir = makeTmpDir("discovery");
  stateFile = path.join(workDir, "design.json");
  // Each test gets a private state-file path; env var ensures both the
  // client's resolver and any spawned daemons converge on the same file.
  process.env.DESIGN_DAEMON_STATE_FILE = stateFile;
});

afterEach(async () => {
  for (const d of activeDaemons.splice(0)) {
    try { await d.stop(); } catch {}
  }
  // Tear down any state file left around so the next test starts clean.
  try { fs.unlinkSync(stateFile); } catch {}
  try { fs.unlinkSync(resolveLockFilePath(stateFile)); } catch {}
  delete process.env.DESIGN_DAEMON_STATE_FILE;
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
});

async function spawn1(idleMs = 60_000): Promise<SpawnedDaemon> {
  const d = await spawnDaemonForTest({ stateFile, idleMs });
  activeDaemons.push(d);
  return d;
}

// ─── healthCheck + readStateFile basics ──────────────────────────

describe("daemon-state helpers", () => {
  test("readStateFile returns null when missing", () => {
    expect(readStateFile(stateFile)).toBeNull();
  });

  test("spawned daemon writes a usable state file", async () => {
    const d = await spawn1();
    const state = readStateFile(stateFile);
    expect(state).not.toBeNull();
    expect(state!.pid).toBe(d.proc.pid);
    expect(state!.port).toBe(d.port);
    expect(state!.cmdlineMarker).toBe(CMDLINE_MARKER);
    expect(state!.version).toBe("test-version");
  });

  test("verifyIdentity matches a real spawned daemon's cmdline", async () => {
    const d = await spawn1();
    expect(verifyIdentity(d.proc.pid!, CMDLINE_MARKER)).toBe(true);
    // wrong marker → false
    expect(verifyIdentity(d.proc.pid!, "some-other-marker-xyz")).toBe(false);
  });

  test("verifyIdentity returns false for dead pids", async () => {
    expect(verifyIdentity(999_999_999, CMDLINE_MARKER)).toBe(false);
  });
});

// ─── ensureDaemon ────────────────────────────────────────────────

describe("ensureDaemon", () => {
  test("with no state file: spawns a fresh daemon", async () => {
    const result = await ensureDaemon({
      version: "test-version",
      stateFile,
      verbose: false,
    });
    expect(result.spawned).toBe(true);
    expect(result.port).toBeGreaterThan(0);
    expect(result.version).toBe("test-version");

    const state = readStateFile(stateFile);
    expect(state).not.toBeNull();
    expect(isProcessAlive(state!.pid)).toBe(true);

    // Track for cleanup
    activeDaemons.push({
      proc: { pid: state!.pid } as any,
      port: state!.port,
      stateFile,
      stop: async () => {
        try { process.kill(state!.pid, "SIGTERM"); } catch {}
      },
    });
  });

  test("with a healthy daemon already running: attaches without spawning", async () => {
    const existing = await spawn1();
    const result = await ensureDaemon({
      version: "test-version",
      stateFile,
      verbose: false,
    });
    expect(result.spawned).toBe(false);
    expect(result.port).toBe(existing.port);
  });

  test("with a stale state file (PID dead): spawns fresh, overwrites state", async () => {
    // Synthesize a stale state file pointing at a definitely-dead pid.
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({
      pid: 999_999_998,
      port: 1, // bogus port — /health will fail fast
      startedAt: "2020-01-01T00:00:00Z",
      version: "ancient",
      serverPath: "/nope",
      cmdlineMarker: CMDLINE_MARKER,
    }));

    const result = await ensureDaemon({
      version: "test-version",
      stateFile,
      verbose: false,
    });
    expect(result.spawned).toBe(true);

    // State file should now point at the live daemon.
    const fresh = readStateFile(stateFile);
    expect(fresh!.pid).not.toBe(999_999_998);
    expect(isProcessAlive(fresh!.pid)).toBe(true);

    activeDaemons.push({
      proc: { pid: fresh!.pid } as any,
      port: fresh!.port,
      stateFile,
      stop: async () => { try { process.kill(fresh!.pid, "SIGTERM"); } catch {} },
    });
  });

  test("PID-reuse safety: stale state with an unrelated alive PID → identity-verify blocks signal, daemon spawned", async () => {
    // Use the current test process's PID — definitely alive, definitely
    // does NOT have CMDLINE_MARKER in its cmdline (it's the Bun test runner).
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({
      pid: process.pid, // alive but NOT a daemon
      port: 1,
      startedAt: "2020-01-01T00:00:00Z",
      version: "ancient",
      serverPath: "/nope",
      cmdlineMarker: CMDLINE_MARKER,
    }));

    // ensureDaemon should NOT signal process.pid (we'd kill ourselves);
    // verifyIdentity catches the cmdline mismatch and skips the kill.
    const result = await ensureDaemon({
      version: "test-version",
      stateFile,
      verbose: false,
    });

    // We're still alive (didn't get killed)
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(result.spawned).toBe(true);

    const fresh = readStateFile(stateFile);
    expect(fresh!.pid).not.toBe(process.pid);
    activeDaemons.push({
      proc: { pid: fresh!.pid } as any,
      port: fresh!.port,
      stateFile,
      stop: async () => { try { process.kill(fresh!.pid, "SIGTERM"); } catch {} },
    });
  });

  test("version mismatch with NO active boards: gracefully shuts existing down and respawns", async () => {
    const existing = await spawn1();
    // The existing daemon's version is "test-version" (set by fixture env).
    // ensureDaemon with a DIFFERENT version → should /shutdown the existing
    // (no active boards) and spawn fresh.
    const result = await ensureDaemon({
      version: "different-version",
      stateFile,
      verbose: false,
    });
    expect(result.spawned).toBe(true);
    expect(result.version).toBe("different-version");

    // existing.proc.pid should be gone by now (or soon)
    // Give it a moment for the /shutdown + SIGTERM to take effect
    await new Promise((r) => setTimeout(r, 200));
    expect(isProcessAlive(existing.proc.pid!)).toBe(false);

    // New daemon recorded
    const fresh = readStateFile(stateFile);
    expect(fresh!.pid).not.toBe(existing.proc.pid);
    activeDaemons.push({
      proc: { pid: fresh!.pid } as any,
      port: fresh!.port,
      stateFile,
      stop: async () => { try { process.kill(fresh!.pid, "SIGTERM"); } catch {} },
    });
  });

  test("version mismatch WITH active boards: refuses to kill, exits 1 with user-actionable error", async () => {
    // Run the ensureDaemon-that-would-exit-1 in a subprocess so we can
    // observe the exit code and stderr without killing the test runner.
    const existing = await spawn1();

    // Publish a board so activeBoards > 0
    const html = makeBoardHtml(workDir);
    await publishBoard({ port: existing.port, html });

    // Sanity: status should reflect the active board
    const statusResp = await fetch(`http://127.0.0.1:${existing.port}/health`);
    const status = (await statusResp.json()) as any;
    expect(status.activeBoards).toBe(1);

    // Now run a tiny script that calls ensureDaemon with a mismatched
    // version. It should print the WARNING + exit 1.
    const scriptPath = path.join(workDir, "ensure-mismatch.ts");
    fs.writeFileSync(scriptPath, `
import { ensureDaemon } from "${path.resolve(import.meta.dir, "..", "src", "daemon-client.ts").replace(/\\\\/g, "/")}";
await ensureDaemon({
  version: "totally-different-version",
  stateFile: ${JSON.stringify(stateFile)},
  verbose: true,
});
console.log("REACHED_AFTER_ENSURE — should not happen");
`);

    const child = spawn("bun", ["run", scriptPath], {
      env: { ...process.env, DESIGN_DAEMON_STATE_FILE: stateFile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderrChunks: Buffer[] = [];
    const stdoutChunks: Buffer[] = [];
    child.stderr.on("data", (c) => stderrChunks.push(c));
    child.stdout.on("data", (c) => stdoutChunks.push(c));
    const exitCode = await new Promise<number>((resolve) => {
      child.on("exit", (code) => resolve(code ?? -1));
    });
    const stderr = Buffer.concat(stderrChunks).toString();
    const stdout = Buffer.concat(stdoutChunks).toString();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("active board");
    expect(stderr).toContain("Refusing to auto-kill");
    // We must NOT have reached the post-ensure line
    expect(stdout).not.toContain("REACHED_AFTER_ENSURE");

    // And the existing daemon should still be alive
    expect(isProcessAlive(existing.proc.pid!)).toBe(true);
  }, 15_000);
});

// ─── publishBoard ────────────────────────────────────────────────

describe("publishBoard", () => {
  test("publishes a board through the real HTTP path and returns id+url+sourceDir", async () => {
    const d = await spawn1();
    const htmlPath = makeBoardHtml(workDir, "<p>via-client</p>");
    const result = await publishBoard({ port: d.port, html: htmlPath });
    expect(result.id).toMatch(/^b-/);
    expect(result.url).toBe(`http://127.0.0.1:${d.port}/boards/${result.id}/`);
    expect(result.sourceDir).toBe(fs.realpathSync(workDir));

    // Confirm the board is actually fetchable at the returned URL
    const r = await fetch(result.url);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("via-client");
  });

  test("409 surfaces existing board's id+url (returned object, no throw)", async () => {
    const d = await spawn1();
    const htmlPath = makeBoardHtml(workDir);
    const first = await publishBoard({ port: d.port, html: htmlPath });
    const htmlPath2 = makeBoardHtml(workDir, "<p>second</p>");
    const second = await publishBoard({ port: d.port, html: htmlPath2 });
    // Same sourceDir → 409 with `existing` field; publishBoard returns it
    // so the caller can attach to the existing board.
    expect(second.id).toBe(first.id);
    expect(second.url).toBe(first.url);
  });
});

// ─── shutdownDaemon / daemonStatus ───────────────────────────────

describe("shutdownDaemon + daemonStatus", () => {
  test("status reports not-running when no state file", async () => {
    const s = await daemonStatus();
    expect(s.running).toBe(false);
  });

  test("status reports running with port + version + counts when daemon alive", async () => {
    const d = await spawn1();
    const s = await daemonStatus();
    expect(s.running).toBe(true);
    if (s.running) {
      expect(s.port).toBe(d.port);
      expect(s.pid).toBe(d.proc.pid);
      expect(s.version).toBe("test-version");
      expect(s.boards).toBe(0);
      expect(s.activeBoards).toBe(0);
    }
  });

  test("shutdownDaemon succeeds when no active boards", async () => {
    const d = await spawn1();
    const r = await shutdownDaemon();
    expect(r.stopped).toBe(true);
    // Give it a moment to die
    await new Promise((res) => setTimeout(res, 300));
    expect(isProcessAlive(d.proc.pid!)).toBe(false);
  });

  test("shutdownDaemon refuses (without force) when active boards present", async () => {
    const d = await spawn1();
    await publishBoard({ port: d.port, html: makeBoardHtml(workDir) });
    const r = await shutdownDaemon();
    expect(r.stopped).toBe(false);
    expect(r.reason).toContain("active");
    expect(r.activeBoards).toBe(1);
    // Daemon still running
    expect(isProcessAlive(d.proc.pid!)).toBe(true);
  });

  test("shutdownDaemon with force=true ignores active boards", async () => {
    const d = await spawn1();
    await publishBoard({ port: d.port, html: makeBoardHtml(workDir) });
    const r = await shutdownDaemon({ force: true });
    expect(r.stopped).toBe(true);
  });
});

// ─── Real idle-shutdown behavior (spawned daemon, fast clock) ───
//
// The lastMeaningfulActivity timestamp is not observable from outside the
// daemon process, so the only way to prove "bare GETs do not reset the
// idle timer" is to spawn a real daemon with a short idle window, hit
// progress polls in a loop, and watch the process exit anyway.
//
// These tests aim for ~3-5s real time per test by setting IDLE_MS=2000
// and CHECK_MS=200. The idle-with-active-boards extension path needs a
// board in `serving` state to exercise.

describe("daemon idle-shutdown behavior (real process)", () => {
  // Wait for a child process to exit, with a deadline. Resolves true on
  // observed exit, false on timeout. Doesn't kill on timeout — caller does.
  async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  test("idle daemon (no boards) shuts itself down after IDLE_MS + CHECK_MS", async () => {
    const d = await spawnDaemonForTest({
      stateFile,
      idleMs: 2_000,
      checkMs: 200,
    });
    // Don't push to activeDaemons; the daemon should self-exit and the
    // afterEach SIGTERM would race with that. Track manually.
    try {
      // No boards published. lastMeaningfulActivity is the startup time.
      // Wait IDLE_MS + a couple CHECK_MS intervals for the timer to fire.
      const exited = await waitForExit(d.proc.pid!, 5_000);
      expect(exited).toBe(true);
      // State file removed by gracefulShutdown
      expect(readStateFile(stateFile)).toBeNull();
    } finally {
      if (isProcessAlive(d.proc.pid!)) {
        try { d.proc.kill("SIGKILL"); } catch {}
      }
    }
  }, 10_000);

  test("bare GET polling does NOT prevent idle shutdown (progress polls don't reset idle)", async () => {
    const d = await spawnDaemonForTest({
      stateFile,
      idleMs: 2_000,
      checkMs: 200,
    });
    let polling = true;
    let pollCount = 0;
    const boardDir = makeTmpDir("idle-poll");
    try {
      const board = await publishBoard({
        port: d.port,
        html: makeBoardHtml(boardDir),
      });
      // Submit so the board becomes `done` — non-done would trigger the
      // 1h extension path and keep the daemon alive past IDLE_MS.
      await fetch(`${board.url}api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ regenerated: false, preferred: "A" }),
      });
      // Hammer /api/progress every 200ms in the background. If bare GETs
      // reset meaningful activity, the daemon would never idle out.
      const pollLoop = (async () => {
        while (polling) {
          try {
            await fetch(`${board.url}api/progress`);
            pollCount += 1;
          } catch {
            // daemon went away
            break;
          }
          await new Promise((r) => setTimeout(r, 200));
        }
      })();

      const exited = await waitForExit(d.proc.pid!, 6_000);
      polling = false;
      await pollLoop;

      expect(exited).toBe(true);
      // We polled at least a few times before the daemon idled out
      expect(pollCount).toBeGreaterThan(3);
      expect(readStateFile(stateFile)).toBeNull();
    } finally {
      polling = false;
      if (isProcessAlive(d.proc.pid!)) {
        try { d.proc.kill("SIGKILL"); } catch {}
      }
      try { fs.rmSync(boardDir, { recursive: true, force: true }); } catch {}
    }
  }, 15_000);

  test("idle with active (non-done) boards triggers extension instead of shutdown", async () => {
    // With non-done boards, the daemon should NOT shut down on the first
    // idle check after IDLE_MS — it extends. Verify it's still alive past
    // the would-be-shutdown deadline. The MAX_EXTENSIONS=4 hard ceiling
    // would take 4 * 1h = 4h to exercise with default extension window,
    // so we shrink both IDLE and EXTENSION via env to test it in seconds.
    const d = await spawnDaemonForTest({
      stateFile,
      idleMs: 1_500,
      checkMs: 200,
      env: {
        DESIGN_DAEMON_EXTENSION_MS: "1500",
        DESIGN_DAEMON_MAX_EXTENSIONS: "2",
      },
    });
    const boardDir = makeTmpDir("idle-active");
    try {
      await publishBoard({ port: d.port, html: makeBoardHtml(boardDir) });
      // Daemon has 1 non-done board. After IDLE_MS, idleCheckTick should
      // extend rather than shut down. So at IDLE_MS + small margin, it's
      // still alive.
      await new Promise((r) => setTimeout(r, 2_500));
      expect(isProcessAlive(d.proc.pid!)).toBe(true);
      expect(readStateFile(stateFile)).not.toBeNull();

      // After MAX_EXTENSIONS extension windows (2 * 1500ms = 3000ms more),
      // the hard ceiling kicks in and force-shutdown fires. Total wait:
      // IDLE_MS(1500) + EXT*MAX(3000) + slack(1000) = ~5500ms. We've already
      // waited 2500ms, so 4000ms more.
      const exited = await waitForExit(d.proc.pid!, 5_500);
      expect(exited).toBe(true);
      expect(readStateFile(stateFile)).toBeNull();
    } finally {
      if (isProcessAlive(d.proc.pid!)) {
        try { d.proc.kill("SIGKILL"); } catch {}
      }
      try { fs.rmSync(boardDir, { recursive: true, force: true }); } catch {}
    }
  }, 15_000);
});

// ─── Concurrent ensureDaemon race (one wins the lock) ───────────

describe("concurrent ensureDaemon race", () => {
  test("two parallel ensureDaemon() calls converge on one daemon (one spawned, one attached)", async () => {
    // Fire two ensureDaemon calls in parallel against the same empty
    // stateFile. The fs.openSync('wx') lock should make exactly one win
    // the spawn race; the loser waits for the first to write the state
    // file, then attaches.
    const [a, b] = await Promise.all([
      ensureDaemon({ version: "test-version", stateFile, verbose: false }),
      ensureDaemon({ version: "test-version", stateFile, verbose: false }),
    ]);

    // Both got the same port (same daemon)
    expect(a.port).toBe(b.port);

    // Exactly one spawned, one attached
    const spawnedCount = [a.spawned, b.spawned].filter(Boolean).length;
    expect(spawnedCount).toBe(1);

    // Exactly one daemon process is alive at that port
    const state = readStateFile(stateFile);
    expect(state).not.toBeNull();
    expect(isProcessAlive(state!.pid)).toBe(true);

    // Lock file cleaned up (the winner released it on exit from the try block)
    expect(fs.existsSync(resolveLockFilePath(stateFile))).toBe(false);

    // Track for cleanup
    activeDaemons.push({
      proc: { pid: state!.pid } as any,
      port: state!.port,
      stateFile,
      stop: async () => {
        try { process.kill(state!.pid, "SIGTERM"); } catch {}
      },
    });
  }, 15_000);
});

// ─── Stale-lock reclaim ──────────────────────────────────────────

describe("acquireLock stale-lock reclaim", () => {
  test("reclaims a lockfile owned by a dead PID and writes our PID", () => {
    const lockPath = resolveLockFilePath(stateFile);
    // Plant a lockfile owned by a definitely-dead PID
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "999999998\n");

    const release = acquireLock(lockPath);
    expect(release).not.toBeNull();
    // Lock file now contains our PID
    expect(fs.readFileSync(lockPath, "utf-8").trim()).toBe(String(process.pid));

    release!();
    // Released = lock file gone
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("refuses to reclaim a lockfile owned by an alive (unrelated) PID", () => {
    const lockPath = resolveLockFilePath(stateFile);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // Use this test process's own PID — it's alive AND unrelated to a daemon.
    // acquireLock should refuse and return null without unlinking the lock.
    fs.writeFileSync(lockPath, `${process.pid}\n`);

    const release = acquireLock(lockPath);
    expect(release).toBeNull();
    // Lock file is untouched
    expect(fs.readFileSync(lockPath, "utf-8").trim()).toBe(String(process.pid));

    // Cleanup
    try { fs.unlinkSync(lockPath); } catch {}
  });
});
