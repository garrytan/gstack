/**
 * Tests the .bak-rollback contract used by /setup-gbrain Step 1.5 (broken-db
 * repair) and Step 4.5 (Path 4 opt-in to local PGLite), per plan D7.
 *
 * These code paths live in the skill TEMPLATE, not in a TypeScript helper —
 * the skill follows AI-readable instructions. The instructions specify the
 * exact sequence:
 *
 *   1. mv ~/.gbrain/config.json ~/.gbrain/config.json.gstack-bak-$(date +%s)
 *   2. gbrain init --pglite --json
 *   3. on non-zero exit: mv .bak back; surface error
 *
 * This test extracts that sequence as a shell function and verifies the
 * rollback contract using a fake `gbrain` binary that fails on init. It's
 * the test that proves "what the skill template says, when followed
 * mechanically, actually preserves the user's broken config on failure."
 *
 * Per plan codex #10 / explicit rollback scope: we only promise to restore
 * the config.json file. The PGLite directory at ~/.gbrain/pglite/ may end
 * up in a partial state — that's documented to the user, not auto-cleaned.
 */

import { describe, it, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  chmodSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

interface RollbackEnv {
  tmp: string;
  home: string;
  configPath: string;
  bindir: string;
  cleanup: () => void;
}

function makeEnv(opts: { gbrainBehavior: "succeeds" | "fails" }): RollbackEnv {
  const tmp = mkdtempSync(join(tmpdir(), "gbrain-init-rollback-"));
  const home = join(tmp, "home");
  const gbrainDir = join(home, ".gbrain");
  const configPath = join(gbrainDir, "config.json");
  const bindir = join(tmp, "bin");
  mkdirSync(gbrainDir, { recursive: true });
  mkdirSync(bindir, { recursive: true });

  // Seed the broken-db config we want to preserve on failure / replace on success.
  writeFileSync(
    configPath,
    JSON.stringify({
      engine: "postgres",
      database_url: "postgresql://stale:test@localhost:5435/gbrain_test",
    }),
  );

  const exitCode = opts.gbrainBehavior === "fails" ? 1 : 0;
  const onInitSuccess =
    opts.gbrainBehavior === "succeeds"
      ? `cat > "${configPath}" <<JSON
{"engine":"pglite","database_url":"pglite://${gbrainDir}/pglite"}
JSON
mkdir -p "${gbrainDir}/pglite"
echo '{"status":"ok"}'`
      : `echo "Error: disk full" >&2`;
  const fake = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gbrain 0.33.1.0"; exit 0; fi
if [ "$1 $2" = "init --pglite" ]; then
  ${onInitSuccess}
  exit ${exitCode}
fi
exit 0
`;
  writeFileSync(join(bindir, "gbrain"), fake);
  chmodSync(join(bindir, "gbrain"), 0o755);

  return {
    tmp,
    home,
    configPath,
    bindir,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

/**
 * Verbatim reimplementation of the skill template's Step 1.5 / 4.5 rollback
 * sequence. The skill instructs the model to execute this bash; we execute
 * the same bash here in a sandboxed environment and assert the contract.
 *
 * If gbrain templates rewrite this sequence, this test should fail until
 * the shell here is updated too. That's the point — keep the test and the
 * skill template aligned.
 */
function runRollbackSequence(env: RollbackEnv): { exitCode: number; stderr: string } {
  const script = `
set -u
BACKUP="${env.configPath}.gstack-bak-$(date +%s)-$$"
if [ -f "${env.configPath}" ]; then
  mv "${env.configPath}" "$BACKUP"
fi
if ! gbrain init --pglite --json; then
  if [ -n "\${BACKUP:-}" ] && [ -f "$BACKUP" ]; then
    mv "$BACKUP" "${env.configPath}"
  fi
  echo "gbrain init failed. Existing config (if any) was restored." >&2
  exit 1
fi
echo "ok"
`;
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: env.home,
      PATH: `${env.bindir}:/usr/bin:/bin`,
    },
  });
  return {
    exitCode: result.status ?? 1,
    stderr: result.stderr || "",
  };
}

describe("Step 1.5 / 4.5 .bak-rollback contract (plan D7)", () => {
  it("FAILURE PATH: when `gbrain init` fails, broken config is restored to original path", () => {
    const env = makeEnv({ gbrainBehavior: "fails" });
    try {
      const originalContent = readFileSync(env.configPath, "utf-8");

      const r = runRollbackSequence(env);

      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("restored");

      // Original config is back at the original path.
      expect(existsSync(env.configPath)).toBe(true);
      const after = readFileSync(env.configPath, "utf-8");
      expect(after).toBe(originalContent);

      // No leftover .bak — it was renamed back to the original path.
      const baks = readdirSync(join(env.home, ".gbrain")).filter((f) =>
        f.includes(".gstack-bak-"),
      );
      expect(baks).toEqual([]);
    } finally {
      env.cleanup();
    }
  });

  it("SUCCESS PATH: when `gbrain init` succeeds, the .bak survives for audit", () => {
    const env = makeEnv({ gbrainBehavior: "succeeds" });
    try {
      const r = runRollbackSequence(env);

      expect(r.exitCode).toBe(0);

      // New config is in place (fake gbrain wrote pglite engine).
      expect(existsSync(env.configPath)).toBe(true);
      const after = JSON.parse(readFileSync(env.configPath, "utf-8")) as {
        engine: string;
      };
      expect(after.engine).toBe("pglite");

      // The .bak survives — user can audit before deleting.
      const baks = readdirSync(join(env.home, ".gbrain")).filter((f) =>
        f.includes(".gstack-bak-"),
      );
      expect(baks.length).toBe(1);
    } finally {
      env.cleanup();
    }
  });

  it("PGLite directory partial state is NOT auto-cleaned (codex #10 scoped rollback)", () => {
    // Per the rollback scope: we only restore config.json. If gbrain init
    // started writing a PGLite dir before failing, we leave it alone and
    // surface the cleanup hint to the user.
    const env = makeEnv({ gbrainBehavior: "fails" });
    try {
      // Simulate gbrain having created a partial PGLite dir before failure
      const partial = join(env.home, ".gbrain", "pglite");
      mkdirSync(partial, { recursive: true });
      writeFileSync(join(partial, "partial-write.tmp"), "");

      const r = runRollbackSequence(env);

      expect(r.exitCode).toBe(1);
      // The partial dir is left in place — user gets the hint, we don't
      // assume responsibility for cleanup.
      expect(existsSync(partial)).toBe(true);
      expect(existsSync(join(partial, "partial-write.tmp"))).toBe(true);
    } finally {
      env.cleanup();
    }
  });
});
