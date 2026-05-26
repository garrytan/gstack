/**
 * Shape regression test for bin/gstack-gbrain-detect.
 *
 * After the bash→TS rewrite (codex #5), the TS output must stay
 * key/type/semantics backward-compatible with the bash version. Downstream
 * callers across most gstack skill preambles shell out to this script and
 * pipe through jq. Key order may differ between bash+jq and JSON.stringify;
 * key NAMES and TYPES must not.
 *
 * Asserts:
 *   1. All 9 pre-existing keys are present
 *   2. Each pre-existing key has the same primitive type/union as the bash version
 *   3. The new key (gbrain_local_status) is present and a string
 *   4. Output is parseable JSON
 *   5. No keys removed/renamed
 */

import { describe, it, expect } from "bun:test";
import { execFileSync } from "child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const DETECT_BIN = join(import.meta.dir, "..", "bin", "gstack-gbrain-detect");

/** Absolute bun path resolved once at module load (uses the test runner's PATH). */
const BUN_BIN = execFileSync("sh", ["-c", "command -v bun"], { encoding: "utf-8" }).trim();

/**
 * Run detect with a controlled HOME + PATH so the output is deterministic.
 * We invoke via `bun run <path>` instead of the shebang so the test doesn't
 * need bun on its PATH. The script's child-process probes still respect
 * the controlled PATH.
 */
function runDetect(env: Partial<NodeJS.ProcessEnv>): string {
  return execFileSync(BUN_BIN, ["run", DETECT_BIN], {
    encoding: "utf-8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
}

interface DetectShape {
  gbrain_on_path: boolean;
  gbrain_version: string | null;
  gbrain_config_exists: boolean;
  gbrain_engine: string | null;
  gbrain_doctor_ok: boolean;
  gbrain_mcp_mode: string;
  gstack_brain_sync_mode: string;
  gstack_brain_git: boolean;
  gstack_artifacts_remote: string;
  gbrain_local_status: string;
}

describe("bin/gstack-gbrain-detect — shape regression", () => {
  it("emits valid JSON", () => {
    const tmp = mkdtempSync(join(tmpdir(), "detect-shape-"));
    try {
      const out = runDetect({
        HOME: tmp,
        PATH: "/usr/bin:/bin",
        GSTACK_HOME: tmp,
      });
      expect(() => JSON.parse(out)).not.toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("contains all 9 pre-existing keys + the new gbrain_local_status key", () => {
    const tmp = mkdtempSync(join(tmpdir(), "detect-shape-"));
    try {
      const out = runDetect({
        HOME: tmp,
        PATH: "/usr/bin:/bin",
        GSTACK_HOME: tmp,
      });
      const parsed = JSON.parse(out) as DetectShape;

      // 9 pre-existing keys (must not be removed/renamed):
      expect(parsed).toHaveProperty("gbrain_on_path");
      expect(parsed).toHaveProperty("gbrain_version");
      expect(parsed).toHaveProperty("gbrain_config_exists");
      expect(parsed).toHaveProperty("gbrain_engine");
      expect(parsed).toHaveProperty("gbrain_doctor_ok");
      expect(parsed).toHaveProperty("gbrain_mcp_mode");
      expect(parsed).toHaveProperty("gstack_brain_sync_mode");
      expect(parsed).toHaveProperty("gstack_brain_git");
      expect(parsed).toHaveProperty("gstack_artifacts_remote");

      // 1 new key (added by this fix):
      expect(parsed).toHaveProperty("gbrain_local_status");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("preserves field types from the bash version", () => {
    const tmp = mkdtempSync(join(tmpdir(), "detect-shape-"));
    try {
      const out = runDetect({
        HOME: tmp,
        PATH: "/usr/bin:/bin",
        GSTACK_HOME: tmp,
      });
      const parsed = JSON.parse(out) as Record<string, unknown>;

      // Booleans (bash: `true`/`false`; TS: boolean)
      expect(typeof parsed.gbrain_on_path).toBe("boolean");
      expect(typeof parsed.gbrain_config_exists).toBe("boolean");
      expect(typeof parsed.gbrain_doctor_ok).toBe("boolean");
      expect(typeof parsed.gstack_brain_git).toBe("boolean");

      // String | null unions (bash: `null` when absent; TS: null when absent)
      const versionType = parsed.gbrain_version === null ? "null" : typeof parsed.gbrain_version;
      expect(versionType === "string" || versionType === "null").toBe(true);
      const engineType = parsed.gbrain_engine === null ? "null" : typeof parsed.gbrain_engine;
      expect(engineType === "string" || engineType === "null").toBe(true);

      // Strings (bash: always emits a string, never null)
      expect(typeof parsed.gbrain_mcp_mode).toBe("string");
      expect(typeof parsed.gstack_brain_sync_mode).toBe("string");
      expect(typeof parsed.gstack_artifacts_remote).toBe("string");

      // New field: string enum
      expect(typeof parsed.gbrain_local_status).toBe("string");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("gbrain_mcp_mode is one of the three documented values", () => {
    const tmp = mkdtempSync(join(tmpdir(), "detect-shape-"));
    try {
      const out = runDetect({
        HOME: tmp,
        PATH: "/usr/bin:/bin",
        GSTACK_HOME: tmp,
      });
      const parsed = JSON.parse(out) as DetectShape;
      expect(["local-stdio", "remote-http", "none"]).toContain(parsed.gbrain_mcp_mode);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("gstack_brain_sync_mode is one of the three documented values", () => {
    const tmp = mkdtempSync(join(tmpdir(), "detect-shape-"));
    try {
      const out = runDetect({
        HOME: tmp,
        PATH: "/usr/bin:/bin",
        GSTACK_HOME: tmp,
      });
      const parsed = JSON.parse(out) as DetectShape;
      expect(["off", "artifacts-only", "full"]).toContain(parsed.gstack_brain_sync_mode);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("gbrain_local_status is one of the five documented values", () => {
    const tmp = mkdtempSync(join(tmpdir(), "detect-shape-"));
    try {
      const out = runDetect({
        HOME: tmp,
        PATH: "/usr/bin:/bin",
        GSTACK_HOME: tmp,
      });
      const parsed = JSON.parse(out) as DetectShape;
      expect(["ok", "no-cli", "missing-config", "broken-config", "broken-db"]).toContain(
        parsed.gbrain_local_status,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("with no gbrain on PATH, returns gbrain_on_path=false and gbrain_local_status=no-cli", () => {
    const tmp = mkdtempSync(join(tmpdir(), "detect-shape-"));
    try {
      const out = runDetect({
        HOME: tmp,
        PATH: "/usr/bin:/bin", // no gbrain on this PATH
        GSTACK_HOME: tmp,
        GSTACK_DETECT_NO_CACHE: "1",
      });
      const parsed = JSON.parse(out) as DetectShape;
      expect(parsed.gbrain_on_path).toBe(false);
      expect(parsed.gbrain_version).toBeNull();
      expect(parsed.gbrain_local_status).toBe("no-cli");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("with fake gbrain that returns valid JSON, returns gbrain_on_path=true and gbrain_local_status=ok", () => {
    const tmp = mkdtempSync(join(tmpdir(), "detect-shape-"));
    const bindir = join(tmp, "bin");
    const home = join(tmp, "home");
    const configDir = join(home, ".gbrain");
    const configPath = join(configDir, "config.json");
    try {
      mkdirSync(bindir, { recursive: true });
      mkdirSync(home, { recursive: true });
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify({ engine: "pglite" }));

      // Fake gbrain: prints valid sources-list JSON
      const fake = `#!/bin/sh
case "$1 $2" in
  "--version ")        echo "gbrain 0.33.1.0"; exit 0 ;;
  "sources list")      echo '{"sources":[]}'; exit 0 ;;
  "doctor "*)          echo '{"status":"ok","checks":[]}'; exit 0 ;;
esac
exit 0
`;
      const gbrainPath = join(bindir, "gbrain");
      writeFileSync(gbrainPath, fake);
      chmodSync(gbrainPath, 0o755);

      const out = runDetect({
        HOME: home,
        PATH: `${bindir}:/usr/bin:/bin`,
        GSTACK_HOME: tmp,
        GSTACK_DETECT_NO_CACHE: "1",
      });
      const parsed = JSON.parse(out) as DetectShape;
      expect(parsed.gbrain_on_path).toBe(true);
      expect(parsed.gbrain_version).toBe("gbrain0.33.1.0");
      expect(parsed.gbrain_config_exists).toBe(true);
      expect(parsed.gbrain_engine).toBe("pglite");
      expect(parsed.gbrain_local_status).toBe("ok");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
