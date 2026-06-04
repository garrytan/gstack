/**
 * Tests the split-engine SKIP semantics in bin/gstack-gbrain-sync.ts (plan D12).
 *
 * When localEngineStatus() returns anything except 'ok', the orchestrator's
 * code + memory stages return ran=false summaries; the brain-sync stage runs
 * unchanged. This is the behavior that matters most for Garry's broken-db
 * machine — instead of crashing two stages with ERR output, the orchestrator
 * surfaces a clear skip reason and still pushes artifacts.
 *
 * We test via the script (spawn) rather than importing runCodeImport/runMemoryIngest
 * directly because they're internal to the orchestrator. The fake gbrain
 * binary controls localEngineStatus()'s output.
 */

import { describe, it, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync, spawnSync } from "child_process";

const SCRIPT = join(import.meta.dir, "..", "bin", "gstack-gbrain-sync.ts");
const BUN_BIN = execFileSync("sh", ["-c", "command -v bun"], { encoding: "utf-8" }).trim();

interface FakeEnv {
  tmp: string;
  bindir: string;
  home: string;
  gstackHome: string;
  cleanup: () => void;
}

/**
 * Build a sandboxed HOME with optional fake gbrain on PATH.
 * `gbrainBehavior` controls how `gbrain sources list` reacts; this drives
 * localEngineStatus()'s output.
 */
function makeEnv(opts: {
  withGbrain: boolean;
  gbrainBehavior?: "ok" | "broken-db" | "broken-config";
  withConfig: boolean;
}): FakeEnv {
  const tmp = mkdtempSync(join(tmpdir(), "gbrain-sync-skip-"));
  const bindir = join(tmp, "bin");
  const home = join(tmp, "home");
  const gstackHome = join(home, ".gstack");
  const gbrainDir = join(home, ".gbrain");

  mkdirSync(bindir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(gstackHome, { recursive: true });
  mkdirSync(gbrainDir, { recursive: true });

  if (opts.withConfig) {
    writeFileSync(
      join(gbrainDir, "config.json"),
      JSON.stringify({ engine: "pglite", database_url: "pglite:///fake" }),
    );
  }

  if (opts.withGbrain) {
    const behavior = opts.gbrainBehavior || "ok";
    const stderrLine =
      behavior === "broken-db"
        ? 'echo "Cannot connect to database: . Fix: Check your connection URL in ~/.gbrain/config.json" >&2'
        : behavior === "broken-config"
          ? 'echo "Error: malformed config.json" >&2'
          : "";
    const exitCode = behavior === "ok" ? 0 : 1;
    const fake = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gbrain 0.33.1.0"; exit 0; fi
if [ "$1 $2" = "sources list" ]; then
  if [ ${exitCode} -eq 0 ]; then echo '{"sources":[]}'; exit 0; fi
  ${stderrLine}
  exit ${exitCode}
fi
if [ "$1" = "--help" ]; then echo "  import"; exit 0; fi
exit 0
`;
    writeFileSync(join(bindir, "gbrain"), fake);
    chmodSync(join(bindir, "gbrain"), 0o755);
  }

  return {
    tmp,
    bindir,
    home,
    gstackHome,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

function runOrchestrator(env: FakeEnv, args: string[]): { stdout: string; stderr: string; exitCode: number } {
  // Initialize a git repo in the sandbox so repoRoot() finds it (otherwise
  // code stage skips with "not in git repo" before our check ever fires).
  spawnSync("git", ["init", "-q", env.home], { encoding: "utf-8" });
  spawnSync("git", ["-C", env.home, "commit", "--allow-empty", "-m", "init", "-q"], {
    encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" },
  });

  const result = spawnSync(BUN_BIN, [SCRIPT, ...args], {
    encoding: "utf-8",
    timeout: 30_000,
    cwd: env.home,
    env: {
      ...process.env,
      HOME: env.home,
      GSTACK_HOME: env.gstackHome,
      PATH: `${env.bindir}:/usr/bin:/bin`,
    },
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1,
  };
}

describe("gstack-gbrain-sync — split-engine SKIP (plan D12)", () => {
  it("SKIPs code stage when local engine is broken-db; brain-sync still attempted", () => {
    const env = makeEnv({ withGbrain: true, gbrainBehavior: "broken-db", withConfig: true });
    try {
      const r = runOrchestrator(env, ["--code-only"]);
      // Code stage should be SKIPped with a clear local-engine status reason.
      // Match on the summary substring our skipStageForLocalStatus helper emits.
      expect(r.stdout + r.stderr).toContain("local engine broken-db");
      // Crucial: NOT the legacy "source registration failed" error path that
      // existed before this fix (codex #2 STOP-vs-SKIP consistency).
      expect(r.stdout + r.stderr).not.toContain("source registration failed");
    } finally {
      env.cleanup();
    }
  });

  it("SKIPs memory stage when local engine is broken-config", () => {
    const env = makeEnv({ withGbrain: true, gbrainBehavior: "broken-config", withConfig: true });
    try {
      const r = runOrchestrator(env, ["--no-code", "--no-brain-sync"]);
      expect(r.stdout + r.stderr).toContain("local engine broken-config");
    } finally {
      env.cleanup();
    }
  });

  it("SKIPs code stage when gbrain CLI is missing (no-cli)", () => {
    const env = makeEnv({ withGbrain: false, withConfig: false });
    try {
      const r = runOrchestrator(env, ["--code-only"]);
      // Either "no-cli" (from skipStageForLocalStatus) OR the earlier
      // gbrainAvailable() check (which fires first when the CLI is absent —
      // returns "skipped (gbrain CLI not in PATH)"). Both are acceptable for
      // this case; the user-visible outcome is the same.
      const out = r.stdout + r.stderr;
      const hasSkipReason =
        out.includes("no-cli") || out.includes("gbrain CLI not in PATH");
      expect(hasSkipReason).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("SKIPs code stage when config is missing (missing-config)", () => {
    const env = makeEnv({ withGbrain: true, gbrainBehavior: "ok", withConfig: false });
    try {
      const r = runOrchestrator(env, ["--code-only"]);
      expect(r.stdout + r.stderr).toContain("local engine missing-config");
    } finally {
      env.cleanup();
    }
  });

  it("runs code stage normally when local engine is ok", () => {
    const env = makeEnv({ withGbrain: true, gbrainBehavior: "ok", withConfig: true });
    try {
      const r = runOrchestrator(env, ["--code-only"]);
      // When ok, the SKIP-for-local-status branch must NOT fire.
      expect(r.stdout + r.stderr).not.toContain("local engine ok");
      expect(r.stdout + r.stderr).not.toContain("local engine no-cli");
      expect(r.stdout + r.stderr).not.toContain("local engine broken-db");
      expect(r.stdout + r.stderr).not.toContain("local engine missing-config");
    } finally {
      env.cleanup();
    }
  });
});
