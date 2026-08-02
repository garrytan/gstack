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
  readFileSync,
  realpathSync,
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
  gbrainBehavior?: "ok" | "broken-db" | "broken-config" | "engine-locked" | "slow";
  withConfig: boolean;
  syncExit?: number;
  syncTerminal?: "success" | "blocked" | "partial" | "unknown";
  reindexExit?: number;
  reindexFailed?: number;
  reindexHasFailureDetail?: boolean;
  attachExit?: number;
  syncNoiseLines?: number;
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
    const syncExit = opts.syncExit ?? 0;
    const syncTerminal = opts.syncTerminal ?? "success";
    const reindexExit = opts.reindexExit ?? 0;
    const reindexFailed = opts.reindexFailed ?? 0;
    const attachExit = opts.attachExit ?? 0;
    const syncNoise = opts.syncNoiseLines
      ? `yes 'trace-0123456789abcdef-0123456789abcdef-0123456789abcdef-0123456789abcdef' | head -n ${opts.syncNoiseLines}`
      : "";
    const reindexFailuresJson = opts.reindexHasFailureDetail
      ? ',"failures":[{"slug":"code/example","error":"fixture failure"}]'
      : "";
    const syncTerminalLine = syncTerminal === "blocked"
      ? "Sync BLOCKED at 01234567: 1 file(s) failed to parse."
      : syncTerminal === "partial"
        ? "Sync PARTIAL at 01234567: imported 1 of 2 file(s), reason=timeout."
        : syncTerminal === "unknown"
          ? "Sync finished with a future terminal status."
          : "Already up to date.";
    // "slow": healthy engine, cold pooler connection (#1964) — sleeps past the
    // (test-lowered) probe timeout on `sources list`, then answers fine.
    const sourcesBlock =
      behavior === "slow"
        ? `  sleep 2
  echo '{"sources":[]}'
  exit 0`
        : behavior === "ok"
          ? `  if [ -n "$FAKE_GBRAIN_SYNCED_SOURCE_FILE" ] && [ -f "$FAKE_GBRAIN_SYNCED_SOURCE_FILE" ]; then
    synced_source=$(cat "$FAKE_GBRAIN_SYNCED_SOURCE_FILE")
    printf '{"sources":[{"id":"%s","local_path":"%s","page_count":2}]}\\n' "$synced_source" "$FAKE_GBRAIN_EXISTING_PATH"
  elif [ -n "$FAKE_GBRAIN_EXISTING_SOURCE" ]; then
    printf '{"sources":[{"id":"%s","local_path":"%s"}]}\\n' "$FAKE_GBRAIN_EXISTING_SOURCE" "$FAKE_GBRAIN_EXISTING_PATH"
  else
    echo '{"sources":[]}'
  fi
  exit 0`
          : behavior === "engine-locked"
            ? `  echo "gbrain sources: connect timed out (default 10000ms; pass --timeout=Ns to override)." >&2
  exit 124`
          : `  ${
              behavior === "broken-db"
                ? 'echo "Cannot connect to database: . Fix: Check your connection URL in ~/.gbrain/config.json" >&2'
                : 'echo "Error: malformed config.json" >&2'
            }
  exit 1`;
    const fake = `#!/bin/sh
if [ -n "$FAKE_GBRAIN_LOG" ]; then printf '%s\\n' "$*" >> "$FAKE_GBRAIN_LOG"; fi
if [ "$1" = "--version" ]; then echo "gbrain 0.33.1.0"; exit 0; fi
if [ "$1 $2" = "sources list" ]; then
${sourcesBlock}
fi
if [ "$1 $2 $3" = "sync --strategy auto" ]; then
  if [ -n "$FAKE_GBRAIN_SYNC_ENV_LOG" ]; then
    printf '%s\n' "$GBRAIN_EMBEDDING_MULTIMODAL" > "$FAKE_GBRAIN_SYNC_ENV_LOG"
  fi
  if [ -n "$FAKE_GBRAIN_SYNCED_SOURCE_FILE" ]; then
    printf '%s\n' "$5" > "$FAKE_GBRAIN_SYNCED_SOURCE_FILE"
  fi
  ${syncNoise}
  printf '%s\n' '${syncTerminalLine}'
  exit ${syncExit}
fi
if [ "$1" = "reindex-code" ]; then
  printf '%s\n' '{"status":"ok","codePages":2,"reindexed":2,"skipped":0,"failed":${reindexFailed},"totalTokens":20,"costUsd":0,"model":"fixture"${reindexFailuresJson}}'
  exit ${reindexExit}
fi
if [ "$1 $2" = "sources attach" ]; then exit ${attachExit}; fi
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

function runOrchestrator(
  env: FakeEnv,
  args: string[],
  extraEnv: Record<string, string> = {},
): { stdout: string; stderr: string; exitCode: number } {
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
      FAKE_GBRAIN_LOG: join(env.tmp, "gbrain.log"),
      PATH: `${env.bindir}:/usr/bin:/bin`,
      ...extraEnv,
    },
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1,
  };
}

describe("gstack-gbrain-sync — split-engine SKIP (plan D12)", () => {
  it("PROCEEDS (with warning) when the engine probe times out — slow is not broken (#1964)", () => {
    const env = makeEnv({ withGbrain: true, gbrainBehavior: "slow", withConfig: true });
    try {
      const r = runOrchestrator(env, ["--code-only"], {
        GSTACK_GBRAIN_PROBE_TIMEOUT_MS: "300",
      });
      const out = r.stdout + r.stderr;
      // The stage must NOT be skipped with the local-engine reason...
      expect(out).not.toContain("local engine timeout");
      expect(out).not.toContain("config.json is malformed");
      // ...and the proceed-with-warning line must name the env knob.
      expect(out).toContain("GSTACK_GBRAIN_PROBE_TIMEOUT_MS");
    } finally {
      env.cleanup();
    }
  }, 30_000); // proceeding runs the real code-import path against the slow fake (~11s)

  it("memory stage also PROCEEDS (with warning) on probe timeout (#1964)", () => {
    const env = makeEnv({ withGbrain: true, gbrainBehavior: "slow", withConfig: true });
    try {
      const r = runOrchestrator(env, ["--no-code", "--no-brain-sync"], {
        GSTACK_GBRAIN_PROBE_TIMEOUT_MS: "300",
      });
      const out = r.stdout + r.stderr;
      expect(out).not.toContain("local engine timeout");
      expect(out).toContain("memory: engine probe timed out");
    } finally {
      env.cleanup();
    }
  }, 30_000);

  it("dream stage also PROCEEDS (with warning) on probe timeout (#1964)", () => {
    const env = makeEnv({ withGbrain: true, gbrainBehavior: "slow", withConfig: true });
    try {
      const r = runOrchestrator(
        env,
        ["--dream", "--no-code", "--no-memory", "--no-brain-sync"],
        { GSTACK_GBRAIN_PROBE_TIMEOUT_MS: "300" },
      );
      const out = r.stdout + r.stderr;
      expect(out).not.toContain("local engine timeout");
      expect(out).toContain("dream: engine probe timed out");
    } finally {
      env.cleanup();
    }
  }, 30_000);

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

  it("SKIPs with actionable guidance when PGLite is held by gbrain serve (#2194)", () => {
    const env = makeEnv({ withGbrain: true, gbrainBehavior: "engine-locked", withConfig: true });
    try {
      const r = runOrchestrator(env, ["--code-only"]);
      const out = r.stdout + r.stderr;
      expect(out).toContain("local engine engine-locked");
      expect(out).toContain("gbrain serve");
      expect(out).toContain("outside the live Claude session");
      expect(out).not.toContain("config.json is malformed");
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

  it("executes the exact docs-aware argv without re-registering an ordinary source", () => {
    const env = makeEnv({ withGbrain: true, gbrainBehavior: "ok", withConfig: true });
    try {
      const preview = runOrchestrator(env, ["--dry-run", "--code-only", "--quiet"]);
      const sourceId = preview.stdout.match(/gbrain sources add (gstack-code-[a-z0-9-]+)/)?.[1];
      expect(sourceId).toBeTruthy();
      writeFileSync(join(env.tmp, "gbrain.log"), "");

      const r = runOrchestrator(env, ["--code-only", "--quiet"], {
        FAKE_GBRAIN_EXISTING_SOURCE: sourceId!,
        FAKE_GBRAIN_EXISTING_PATH: realpathSync(env.home),
        FAKE_GBRAIN_SYNC_ENV_LOG: join(env.tmp, "sync-env.log"),
        GBRAIN_EMBEDDING_MULTIMODAL: "true",
      });
      const commands = readFileSync(join(env.tmp, "gbrain.log"), "utf-8").trim().split("\n");

      expect(r.exitCode).toBe(0);
      expect(commands.some((command) => /^sync --strategy auto --source gstack-code-/.test(command))).toBe(true);
      expect(commands.some((command) => command.includes("sync --strategy code"))).toBe(false);
      expect(commands.filter((command) => command.startsWith(`sources remove ${sourceId} `))).toEqual([]);
      expect(commands.filter((command) => command.startsWith(`sources add ${sourceId} `))).toEqual([]);
      expect(readFileSync(join(env.tmp, "sync-env.log"), "utf-8").trim()).toBe("false");
    } finally {
      env.cleanup();
    }
  });

  it("runs full mode as auto sync, then code reindex, then attach", () => {
    const env = makeEnv({ withGbrain: true, gbrainBehavior: "ok", withConfig: true });
    try {
      const r = runOrchestrator(env, ["--full", "--code-only", "--no-dream"]);
      const commands = readFileSync(join(env.tmp, "gbrain.log"), "utf-8").trim().split("\n");
      const syncIndex = commands.findIndex((command) => /^sync --strategy auto --source gstack-code-/.test(command));
      const reindexIndex = commands.findIndex((command) => /^reindex-code --source gstack-code-.* --yes --json$/.test(command));
      const attachIndex = commands.findIndex((command) => /^sources attach gstack-code-/.test(command));

      expect(r.exitCode).toBe(0);
      expect(syncIndex).toBeGreaterThanOrEqual(0);
      expect(reindexIndex).toBeGreaterThan(syncIndex);
      expect(attachIndex).toBeGreaterThan(reindexIndex);
    } finally {
      env.cleanup();
    }
  });

  it("does not reindex or attach when the docs-aware sync fails", () => {
    const env = makeEnv({
      withGbrain: true,
      gbrainBehavior: "ok",
      withConfig: true,
      syncExit: 17,
    });
    try {
      const r = runOrchestrator(env, ["--full", "--code-only", "--no-dream"]);
      const commands = readFileSync(join(env.tmp, "gbrain.log"), "utf-8").trim().split("\n");

      expect(r.stdout + r.stderr).toContain("gbrain sync --strategy auto");
      expect(r.stdout + r.stderr).toContain("exited 17");
      expect(commands.some((command) => command.startsWith("reindex-code "))).toBe(false);
      expect(commands.some((command) => command.startsWith("sources attach "))).toBe(false);
      expect(commands.some((command) => command.startsWith("sources remove "))).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  for (const terminal of ["blocked", "partial", "unknown"] as const) {
    it(`fails closed on zero-exit ${terminal} sync and does not reindex or attach`, () => {
      const env = makeEnv({
        withGbrain: true,
        gbrainBehavior: "ok",
        withConfig: true,
        syncTerminal: terminal,
      });
      try {
        const r = runOrchestrator(env, ["--full", "--code-only", "--no-dream"]);
        const commands = readFileSync(join(env.tmp, "gbrain.log"), "utf-8").trim().split("\n");

        expect(r.exitCode).toBe(1);
        expect(r.stdout + r.stderr).toContain(`reported ${terminal === "blocked" ? "blocked_by_failures" : terminal}`);
        expect(commands.some((command) => command.startsWith("reindex-code "))).toBe(false);
        expect(commands.some((command) => command.startsWith("sources attach "))).toBe(false);
        expect(commands.some((command) => command.startsWith("sources remove "))).toBe(false);
      } finally {
        env.cleanup();
      }
    });
  }

  it("does not attach when reindex-code exits non-zero", () => {
    const env = makeEnv({
      withGbrain: true,
      gbrainBehavior: "ok",
      withConfig: true,
      reindexExit: 23,
    });
    try {
      const r = runOrchestrator(env, ["--full", "--code-only", "--no-dream"]);
      const commands = readFileSync(join(env.tmp, "gbrain.log"), "utf-8").trim().split("\n");

      expect(r.exitCode).toBe(1);
      expect(r.stdout + r.stderr).toContain("reindex-code");
      expect(r.stdout + r.stderr).toContain("exited 23");
      expect(commands.some((command) => command.startsWith("sources attach "))).toBe(false);
      expect(commands.some((command) => command.startsWith("sources remove "))).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it("does not attach when reindex-code exits zero with failed pages", () => {
    const env = makeEnv({
      withGbrain: true,
      gbrainBehavior: "ok",
      withConfig: true,
      reindexFailed: 1,
      reindexHasFailureDetail: true,
    });
    try {
      const r = runOrchestrator(env, ["--full", "--code-only", "--no-dream"]);
      const commands = readFileSync(join(env.tmp, "gbrain.log"), "utf-8").trim().split("\n");

      expect(r.exitCode).toBe(1);
      expect(r.stdout + r.stderr).toContain("incomplete result");
      expect(commands.some((command) => command.startsWith("sources attach "))).toBe(false);
      expect(commands.some((command) => command.startsWith("sources remove "))).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it("does not remove legacy sources when attach fails after a successful walk", () => {
    const env = makeEnv({
      withGbrain: true,
      gbrainBehavior: "ok",
      withConfig: true,
      attachExit: 29,
    });
    try {
      const r = runOrchestrator(env, ["--code-only"]);
      const commands = readFileSync(join(env.tmp, "gbrain.log"), "utf-8").trim().split("\n");

      expect(r.exitCode).toBe(1);
      expect(r.stdout + r.stderr).toContain("attach FAILED");
      expect(commands.some((command) => command.startsWith("sources remove "))).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it("removes a legacy source only after sync, attach, and positive page-count proof", () => {
    const env = makeEnv({ withGbrain: true, gbrainBehavior: "ok", withConfig: true });
    try {
      const r = runOrchestrator(env, ["--code-only", "--quiet"], {
        FAKE_GBRAIN_EXISTING_SOURCE: "gstack-code-home",
        FAKE_GBRAIN_EXISTING_PATH: realpathSync(env.home),
        FAKE_GBRAIN_SYNCED_SOURCE_FILE: join(env.tmp, "synced-source"),
      });
      const commands = readFileSync(join(env.tmp, "gbrain.log"), "utf-8").trim().split("\n");
      const syncIndex = commands.findIndex((command) => command.startsWith("sync --strategy auto "));
      const attachIndex = commands.findIndex((command) => command.startsWith("sources attach "));
      const removeIndex = commands.findIndex((command) =>
        command.startsWith("sources remove gstack-code-home --confirm-destructive"),
      );

      expect(r.exitCode).toBe(0);
      expect(syncIndex).toBeGreaterThanOrEqual(0);
      expect(attachIndex).toBeGreaterThan(syncIndex);
      expect(removeIndex).toBeGreaterThan(attachIndex);
    } finally {
      env.cleanup();
    }
  });

  it("handles sync output larger than spawnSync's buffer with a bounded terminal tail", () => {
    const env = makeEnv({
      withGbrain: true,
      gbrainBehavior: "ok",
      withConfig: true,
      syncNoiseLines: 20_000,
    });
    try {
      const r = runOrchestrator(env, ["--code-only", "--quiet"]);
      const commands = readFileSync(join(env.tmp, "gbrain.log"), "utf-8").trim().split("\n");

      expect(r.exitCode).toBe(0);
      expect(commands.some((command) => command.startsWith("sources attach "))).toBe(true);
    } finally {
      env.cleanup();
    }
  });
});
