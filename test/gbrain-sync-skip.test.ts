/**
 * Tests the split-engine boundaries in bin/gstack-gbrain-sync.ts.
 *
 * The repository stage now proves the released GBrain version and one strict
 * source snapshot directly, so version/source probe failures are terminal and
 * later stages do not run. Memory and dream keep the older local-engine SKIP
 * behavior because they are independent downstream stages.
 *
 * We test via the script (spawn) because the stage runners are internal to the
 * orchestrator. The fake gbrain binary controls both the strict repository
 * probe and localEngineStatus() used by downstream stages.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync, spawnSync } from "child_process";
import { REQUIRED_GBRAIN_REPOSITORY_INDEX_VERSION } from "../lib/gbrain-repository-index";

const SCRIPT = join(import.meta.dir, "..", "bin", "gstack-gbrain-sync.ts");
const BUN_BIN = execFileSync("sh", ["-c", "command -v bun"], {
  encoding: "utf-8",
}).trim();

interface FakeEnv {
  tmp: string;
  bindir: string;
  home: string;
  gstackHome: string;
  cleanup: () => void;
}

/**
 * Build a sandboxed HOME with optional fake gbrain on PATH.
 * `gbrainBehavior` controls how `gbrain sources list` reacts; this drives both
 * the strict repository source probe and localEngineStatus().
 */
function makeEnv(opts: {
  withGbrain: boolean;
  gbrainBehavior?:
    "ok" | "broken-db" | "broken-config" | "engine-locked" | "slow";
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
    // "slow": healthy engine, cold pooler connection (#1964) — sleeps past the
    // (test-lowered) probe timeout on `sources list`, then answers fine.
    const sourcesBlock =
      behavior === "slow"
        ? `  sleep 2
  echo '{"sources":[]}'
  exit 0`
        : behavior === "ok"
          ? `  echo '{"sources":[]}'
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
if [ "$1" = "--version" ]; then echo "gbrain ${REQUIRED_GBRAIN_REPOSITORY_INDEX_VERSION}"; exit 0; fi
if [ "$1 $2" = "sources list" ]; then
${sourcesBlock}
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

function runOrchestrator(
  env: FakeEnv,
  args: string[],
  extraEnv: Record<string, string> = {},
): { stdout: string; stderr: string; exitCode: number } {
  // Initialize a git repo in the sandbox so repoRoot() finds it (otherwise
  // code stage skips with "not in git repo" before our check ever fires).
  spawnSync("git", ["init", "-q", env.home], { encoding: "utf-8" });
  spawnSync(
    "git",
    ["-C", env.home, "commit", "--allow-empty", "-m", "init", "-q"],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "T",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    },
  );

  const result = spawnSync(BUN_BIN, [SCRIPT, ...args], {
    encoding: "utf-8",
    timeout: 30_000,
    cwd: env.home,
    env: {
      ...process.env,
      HOME: env.home,
      GSTACK_HOME: env.gstackHome,
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

describe("gstack-gbrain-sync — strict repository and downstream SKIP boundaries", () => {
  it("repository stage uses its strict source probe instead of the local-engine timeout shortcut", () => {
    const env = makeEnv({
      withGbrain: true,
      gbrainBehavior: "slow",
      withConfig: true,
    });
    try {
      const r = runOrchestrator(env, ["--code-only"], {
        GSTACK_GBRAIN_PROBE_TIMEOUT_MS: "300",
      });
      const out = r.stdout + r.stderr;
      expect(r.exitCode).toBe(2);
      expect(out).not.toContain("local engine timeout");
      expect(out).not.toContain("config.json is malformed");
      expect(out).not.toContain("GSTACK_GBRAIN_PROBE_TIMEOUT_MS");
      expect(out).toContain("ERROR [source_registered]");
      expect(out).toContain("State changed: registry_only");
    } finally {
      env.cleanup();
    }
  }, 30_000);

  it("memory stage also PROCEEDS (with warning) on probe timeout (#1964)", () => {
    const env = makeEnv({
      withGbrain: true,
      gbrainBehavior: "slow",
      withConfig: true,
    });
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
    const env = makeEnv({
      withGbrain: true,
      gbrainBehavior: "slow",
      withConfig: true,
    });
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

  it("repository source-probe failure is terminal when the engine is broken-db", () => {
    const env = makeEnv({
      withGbrain: true,
      gbrainBehavior: "broken-db",
      withConfig: true,
    });
    try {
      const r = runOrchestrator(env, ["--code-only"]);
      const out = r.stdout + r.stderr;
      expect(r.exitCode).toBe(1);
      expect(out).toContain("ERROR [source_probe_failed]");
      expect(out).toContain("Cannot connect to database");
      expect(out).toContain("State changed: none");
      expect(out).not.toContain("local engine broken-db");
    } finally {
      env.cleanup();
    }
  });

  it("SKIPs memory stage when local engine is broken-config", () => {
    const env = makeEnv({
      withGbrain: true,
      gbrainBehavior: "broken-config",
      withConfig: true,
    });
    try {
      const r = runOrchestrator(env, ["--no-code", "--no-brain-sync"]);
      expect(r.stdout + r.stderr).toContain("local engine broken-config");
    } finally {
      env.cleanup();
    }
  });

  it("repository source-probe timeout fails closed when PGLite is held (#2194)", () => {
    const env = makeEnv({
      withGbrain: true,
      gbrainBehavior: "engine-locked",
      withConfig: true,
    });
    try {
      const r = runOrchestrator(env, ["--code-only"]);
      const out = r.stdout + r.stderr;
      expect(r.exitCode).toBe(1);
      expect(out).toContain("ERROR [source_probe_failed]");
      expect(out).toContain("connect timed out");
      expect(out).toContain("State changed: none");
      expect(out).not.toContain("local engine engine-locked");
      expect(out).not.toContain("config.json is malformed");
    } finally {
      env.cleanup();
    }
  });

  it("repository stage refuses before source mutation when gbrain CLI is missing", () => {
    const env = makeEnv({ withGbrain: false, withConfig: false });
    try {
      const r = runOrchestrator(env, ["--code-only"]);
      const out = r.stdout + r.stderr;
      expect(r.exitCode).toBe(1);
      expect(out).toContain("ERROR [unsupported_version]");
      expect(out).toContain("State changed: none");
      expect(out).toContain("Next command: gbrain --version");
      expect(out).not.toContain("local engine no-cli");
    } finally {
      env.cleanup();
    }
  });

  it("repository stage trusts successful direct probes even when config is absent", () => {
    const env = makeEnv({
      withGbrain: true,
      gbrainBehavior: "ok",
      withConfig: false,
    });
    try {
      const r = runOrchestrator(env, ["--code-only"]);
      const out = r.stdout + r.stderr;
      expect(r.exitCode).toBe(2);
      expect(out).toContain("ERROR [source_registered]");
      expect(out).toContain("State changed: registry_only");
      expect(out).not.toContain("local engine missing-config");
    } finally {
      env.cleanup();
    }
  });

  it("registers an absent source once when direct repository probes succeed", () => {
    const env = makeEnv({
      withGbrain: true,
      gbrainBehavior: "ok",
      withConfig: true,
    });
    try {
      const r = runOrchestrator(env, ["--code-only"]);
      const out = r.stdout + r.stderr;
      expect(r.exitCode).toBe(2);
      expect(out).toContain("ERROR [source_registered]");
      expect(out).toContain("State changed: registry_only");
      expect(out).not.toContain("local engine ok");
    } finally {
      env.cleanup();
    }
  });
});
