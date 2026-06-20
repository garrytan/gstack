// supervisor/console/bash-wrapper.test.ts
// Bun test wrapper that runs bash-wrapper.test.sh and reports pass/fail.
// AC1 (check_risk) and AC2 (poll_approval) are exercised inside the shell script.
import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "bash-wrapper.test.sh");

describe("bash-wrapper.test.sh", () => {
  test("script exists and is executable", () => {
    expect(existsSync(SCRIPT)).toBe(true);
    const mode = statSync(SCRIPT).mode;
    // At least one execute bit must be set.
    expect(mode & 0o111).toBeGreaterThan(0);
  });

  test(
    "all check_risk and poll_approval cases pass (AC1 + AC2)",
    () => {
      const result = spawnSync("bash", [SCRIPT], {
        encoding: "utf8",
        stdio: "pipe",
        timeout: 30_000,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      expect(result.status).toBe(0);
    },
    30_000,
  );
});
