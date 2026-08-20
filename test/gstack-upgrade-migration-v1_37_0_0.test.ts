/**
 * Unit tests for gstack-upgrade/migrations/v1.37.0.0.sh — split-engine notice.
 *
 * Per plan D5: print a one-time discoverability notice for existing Path 4
 * (remote-http MCP) users who don't yet have a local engine, so they
 * find /setup-gbrain Step 4.5. Silent for everyone else. Idempotent.
 *
 * Test matrix (5 cases):
 *   1. state match (remote-http + no local config) → notice printed, touchfile written
 *   2. state no-match (no MCP)                     → silent, touchfile written
 *   3. state no-match (local config present)       → silent, touchfile written
 *   4. opt-out via local_code_index_offered=true   → silent, touchfile written
 *   5. idempotency: re-run after match is silent  → notice NOT re-printed
 */

import { describe, it, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  chmodSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync, spawnSync } from "child_process";

const MIGRATION = join(
  import.meta.dir,
  "..",
  "gstack-upgrade",
  "migrations",
  "v1.37.0.0.sh",
);

interface MigEnv {
  tmp: string;
  home: string;
  gstackHome: string;
  doneTouch: string;
  claudeJson: string;
  gbrainConfig: string;
  configBin: string;
  cleanup: () => void;
}

function makeEnv(opts: {
  remoteHttpMcp?: boolean;
  hasLocalConfig?: boolean;
  optedOut?: boolean;
}): MigEnv {
  const tmp = mkdtempSync(join(tmpdir(), "migration-v1340-"));
  const home = join(tmp, "home");
  const gstackHome = join(home, ".gstack");
  const gbrainDir = join(home, ".gbrain");
  const claudeSkillsBin = join(home, ".claude", "skills", "gstack", "bin");
  const claudeJson = join(home, ".claude.json");
  const gbrainConfig = join(gbrainDir, "config.json");
  const configBin = join(claudeSkillsBin, "gstack-config");

  mkdirSync(home, { recursive: true });
  mkdirSync(gstackHome, { recursive: true });
  mkdirSync(gbrainDir, { recursive: true });
  mkdirSync(claudeSkillsBin, { recursive: true });

  if (opts.remoteHttpMcp) {
    writeFileSync(
      claudeJson,
      JSON.stringify({
        mcpServers: {
          gbrain: { type: "http", url: "https://wintermute.example/mcp" },
        },
      }),
    );
  } else {
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: {} }));
  }

  if (opts.hasLocalConfig) {
    writeFileSync(gbrainConfig, JSON.stringify({ engine: "pglite" }));
  }

  // Fake gstack-config: returns "true" iff opted-out (matches the real bin's
  // `get` contract on stdout for set values).
  const optedOutResponse = opts.optedOut ? "true" : "false";
  writeFileSync(
    configBin,
    `#!/bin/sh
if [ "$1" = "get" ] && [ "$2" = "local_code_index_offered" ]; then
  echo "${optedOutResponse}"
  exit 0
fi
exit 0
`,
  );
  chmodSync(configBin, 0o755);

  return {
    tmp,
    home,
    gstackHome,
    doneTouch: join(gstackHome, ".migrations", "v1.37.0.0.done"),
    claudeJson,
    gbrainConfig,
    configBin,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

function runMigration(env: MigEnv): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("bash", [MIGRATION], {
    encoding: "utf-8",
    timeout: 5_000,
    env: {
      ...process.env,
      HOME: env.home,
      GSTACK_HOME: env.gstackHome,
      // The script looks for gstack-config at $HOME/.claude/skills/gstack/bin
      // which is already in env.home; nothing else needed.
    },
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1,
  };
}

describe("gstack-upgrade/migrations/v1.37.0.0.sh", () => {
  it("STATE MATCH: remote-http MCP + no local config → notice printed, touchfile written", () => {
    const env = makeEnv({ remoteHttpMcp: true, hasLocalConfig: false });
    try {
      const r = runMigration(env);
      expect(r.exitCode).toBe(0);
      expect(r.stdout + r.stderr).toContain("split-engine");
      expect(r.stdout + r.stderr).toContain("/setup-gbrain");
      expect(existsSync(env.doneTouch)).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("NO MATCH: no MCP at all → silent, touchfile written", () => {
    const env = makeEnv({ remoteHttpMcp: false, hasLocalConfig: false });
    try {
      const r = runMigration(env);
      expect(r.exitCode).toBe(0);
      expect(r.stdout + r.stderr).not.toContain("split-engine");
      expect(existsSync(env.doneTouch)).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("NO MATCH: local config present → silent, touchfile written", () => {
    const env = makeEnv({ remoteHttpMcp: true, hasLocalConfig: true });
    try {
      const r = runMigration(env);
      expect(r.exitCode).toBe(0);
      expect(r.stdout + r.stderr).not.toContain("split-engine");
      expect(existsSync(env.doneTouch)).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("OPT-OUT: local_code_index_offered=true → silent, touchfile written", () => {
    const env = makeEnv({ remoteHttpMcp: true, hasLocalConfig: false, optedOut: true });
    try {
      const r = runMigration(env);
      expect(r.exitCode).toBe(0);
      expect(r.stdout + r.stderr).not.toContain("split-engine");
      expect(existsSync(env.doneTouch)).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("IDEMPOTENT: second run after match is silent (touchfile already present)", () => {
    const env = makeEnv({ remoteHttpMcp: true, hasLocalConfig: false });
    try {
      const first = runMigration(env);
      expect(first.exitCode).toBe(0);
      expect(first.stdout + first.stderr).toContain("split-engine");

      const second = runMigration(env);
      expect(second.exitCode).toBe(0);
      expect(second.stdout + second.stderr).not.toContain("split-engine");
    } finally {
      env.cleanup();
    }
  });
});
