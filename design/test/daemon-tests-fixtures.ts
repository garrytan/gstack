/**
 * Shared helpers for daemon + daemon-client tests.
 *
 * Two test styles live here:
 *   - In-process: import fetchHandler from daemon.ts and call it with a
 *     synthesized Request. Fast, no spawn, no HTTP. Covers routing +
 *     handler semantics. Used by most of daemon.test.ts.
 *   - Out-of-process: spawn `bun run design/src/daemon.ts` with a tmp
 *     state file + env overrides, then HTTP against the bound port.
 *     Slow but only path that proves real spawn + state file + signal
 *     handling work. Used by daemon-discovery.test.ts.
 */

import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { __testInternals__ } from "../src/daemon";

export const DAEMON_SCRIPT = path.join(import.meta.dir, "..", "src", "daemon.ts");

export function makeTmpDir(prefix = "design-daemon-test"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

export function makeBoardHtml(tmpDir: string, body = "<p>Test board</p>"): string {
  const p = path.join(tmpDir, "design-board.html");
  fs.writeFileSync(
    p,
    `<!DOCTYPE html><html><head></head><body>${body}</body></html>`,
  );
  return p;
}

/** Reset the in-process daemon state between tests. */
export function resetDaemon(): void {
  __testInternals__.resetForTest();
}

/** Build a Request for the in-process fetchHandler tests. */
export function req(method: string, urlPath: string, body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  return new Request(`http://127.0.0.1:1234${urlPath}`, init);
}

export interface SpawnedDaemon {
  proc: ChildProcess;
  port: number;
  stateFile: string;
  stop: () => Promise<void>;
}

/**
 * Spawn a real daemon process pointed at a per-test state file, with an
 * aggressive idle window so idle-shutdown tests don't take 24h. Resolves
 * when stdout emits `DAEMON_STARTED port=<N>`.
 */
export async function spawnDaemonForTest(
  opts: { stateFile?: string; idleMs?: number; checkMs?: number; env?: Record<string, string> } = {},
): Promise<SpawnedDaemon> {
  const stateFile = opts.stateFile ?? path.join(makeTmpDir("daemon-state"), "design.json");
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // DESIGN_DAEMON_STATE_FILE points both daemon and any same-process
    // discovery at this test's state file (overrides resolveStateFilePath).
    DESIGN_DAEMON_STATE_FILE: stateFile,
    DESIGN_DAEMON_IDLE_MS: String(opts.idleMs ?? 60_000),
    DESIGN_DAEMON_CHECK_MS: String(opts.checkMs ?? 1000),
    DESIGN_DAEMON_VERSION: "test-version",
    ...(opts.env ?? {}),
  };

  // Spawn with a marker in argv so cmdline-based identity verification
  // exercises the real CMDLINE_MARKER ("gstack-design-daemon").
  const proc = spawn(
    "bun",
    ["run", DAEMON_SCRIPT, "--marker", "gstack-design-daemon"],
    {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: path.dirname(stateFile),
    },
  );

  const port = await new Promise<number>((resolve, reject) => {
    const onTimeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("Daemon failed to emit DAEMON_STARTED within 5s"));
    }, 5000);
    proc.stdout!.on("data", (chunk: Buffer) => {
      const line = chunk.toString();
      const m = line.match(/DAEMON_STARTED port=(\d+)/);
      if (m) {
        clearTimeout(onTimeout);
        resolve(parseInt(m[1]!, 10));
      }
    });
    proc.on("error", (e) => {
      clearTimeout(onTimeout);
      reject(e);
    });
    proc.on("exit", (code) => {
      clearTimeout(onTimeout);
      reject(new Error(`Daemon exited early with code ${code}`));
    });
  });

  return {
    proc,
    port,
    stateFile,
    stop: async () => {
      proc.kill("SIGTERM");
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // gone
          }
          r();
        }, 2000);
        proc.on("exit", () => {
          clearTimeout(t);
          r();
        });
      });
    },
  };
}
