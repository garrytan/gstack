import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import * as path from "path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const GATE_SCRIPT = path.join(REPO_ROOT, "test", "redact-prepush-fail-open.sh");

describe("pre-push fail-open regression gate", () => {
  test.skipIf(!Bun.which("git") || !Bun.which("bun") || !Bun.which("python3"))(
    "executes full prepush fail-open gate cleanly (exit 0)",
    () => {
      const r = spawnSync("bash", [GATE_SCRIPT], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 180_000,
        env: { ...process.env },
      });
      if (r.status !== 0) {
        console.error("Gate stdout:\n", r.stdout);
        console.error("Gate stderr:\n", r.stderr);
      }
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("GATE: PASS");
    },
    200_000,
  );
});
