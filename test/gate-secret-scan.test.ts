/**
 * CI secret gate contract (R4/R9, fork port wave 2).
 *
 * .github/scripts/gate-secret-scan.mjs pipes a unified diff's ADDED lines
 * into bin/gstack-redact and enforces: HIGH fails (exit 1), MEDIUM is an
 * advisory count only (no human in CI to confirm, so it must never fail
 * the check), clean passes. The workflow-level pathspec excludes keep the
 * planted-bug fixtures out of the diff entirely; this pins the script's
 * own exit contract with live subprocess runs.
 */

import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, ".github", "scripts", "gate-secret-scan.mjs");

function scan(diff: string, cwd: string = ROOT): { code: number; out: string } {
  const res = spawnSync("node", [SCRIPT], {
    cwd,
    input: diff,
    encoding: "utf-8",
    timeout: 60_000,
  });
  return { code: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
}

describe("gate-secret-scan.mjs exit contract", () => {
  test("clean added lines pass", () => {
    const r = scan("+const x = 1;\n+++ b/file.ts\n+// harmless\n");
    expect(r.code).toBe(0);
    expect(r.out).toContain("0 high");
  });

  // The planted PEM is assembled at runtime — header split included — so this
  // FILE never carries a live-format private key: the repo's own prepush
  // credential guard scans pushed diffs and (correctly) blocks any one-line
  // BEGIN…END spelling regardless of body. The scanner under test still
  // receives the true live shape.
  const PEM_BEGIN = ["-----BEGIN RSA ", "PRIVATE KEY-----"].join("");
  const PEM_END = ["-----END RSA ", "PRIVATE KEY-----"].join("");
  const PLANTED_PEM_BODY = ["MIIEow", "IBAAKC", "AQEA"].join("");

  test("a HIGH credential in an added line fails the gate", () => {
    const r = scan(
      `+${PEM_BEGIN}\n+${PLANTED_PEM_BODY}\n+${PEM_END}\n`,
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain("1 high");
  });

  test("removed lines and context are ignored — only additions are scanned", () => {
    const r = scan(
      `-${PEM_BEGIN}\n-${PLANTED_PEM_BODY}\n${PEM_END}\n+just an addition\n`,
    );
    expect(r.code).toBe(0);
  });

  test("MEDIUM findings are advisory only — never fail CI", () => {
    // A Stripe publishable-key shape sits at MEDIUM in the taxonomy
    // (context-variable; a human confirms interactively, CI cannot).
    const r = scan(`+const key = "pk_live_${"a".repeat(24)}";\n`);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\d+ advisory/);
  });
});

describe("gate-secret-scan.mjs fail-closed legs", () => {
  test("oversize diff (report.oversize) fails the gate", () => {
    // The script pins --max-bytes 16000000; bin/gstack-redact refuses to scan
    // anything larger and reports oversize:true (fail-closed). The gate must
    // exit 1 rather than pass unscanned bytes. ~17MB of added lines guarantees
    // the joined additions exceed the cap.
    const line = `+${"a".repeat(8190)}\n`;
    const r = scan(line.repeat(2100));
    expect(r.code).toBe(1);
    // Proves the failure came from the parsed report (the engine surfaces
    // oversize as a fail-closed HIGH), not from a crashed subprocess.
    expect(r.out).toContain("1 high");
  }, 60_000);

  test("unexpected gstack-redact exit code fails the gate even when the report is clean", () => {
    // Stub bin/gstack-redact that emits a CLEAN JSON report but exits 1 —
    // not one of the contract codes (0 clean / 2 MEDIUM / 3 HIGH). The gate
    // must treat the unexpected exit as failure: a broken scanner reporting
    // "all clear" is exactly the fail-open shape this leg guards against.
    const dir = mkdtempSync(join(tmpdir(), "gate-secret-scan-stub-"));
    try {
      mkdirSync(join(dir, "bin"));
      writeFileSync(
        join(dir, "bin", "gstack-redact"),
        [
          "#!/usr/bin/env bun",
          'let input = "";',
          'process.stdin.setEncoding("utf8");',
          'process.stdin.on("data", (c) => { input += c; });',
          'process.stdin.on("end", () => {',
          '  console.log(JSON.stringify({ findings: [], counts: { HIGH: 0, MEDIUM: 0, LOW: 0, WARN: 0 }, repoVisibility: "public", oversize: false }));',
          "  process.exit(1);",
          "});",
          "",
        ].join("\n"),
      );
      const r = scan("+const x = 1;\n", dir);
      expect(r.out).toContain("0 high"); // the clean report WAS parsed...
      expect(r.code).toBe(1); // ...and the gate still failed on the exit code
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing gstack-redact (spawn crash, empty stdout) exits nonzero — never fail-open", () => {
    // cwd with no bin/gstack-redact at all: bun exits module-not-found with
    // empty stdout. Whatever the exact failure shape, the gate must not
    // report success.
    const dir = mkdtempSync(join(tmpdir(), "gate-secret-scan-absent-"));
    try {
      const r = scan("+const x = 1;\n", dir);
      expect(r.code).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
