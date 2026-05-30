/**
 * Contract tests for bin/gstack-redact — exit codes, JSON shape, flags,
 * auto-redact mode, oversize fail-closed. Spawns the shim via `bun`.
 */
import { describe, test, expect } from "bun:test";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const BIN = path.resolve(import.meta.dir, "..", "bin", "gstack-redact");

function run(
  args: string[],
  stdin: string,
): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", BIN, ...args], {
    stdin: Buffer.from(stdin),
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("gstack-redact exit codes", () => {
  test("clean → 0", () => {
    expect(run([], "just some prose").code).toBe(0);
  });
  test("HIGH → 3", () => {
    expect(run([], "key AKIA1234567890ABCDEF").code).toBe(3);
  });
  test("MEDIUM only → 2", () => {
    expect(run(["--repo-visibility", "public"], "mail bob@corp.io").code).toBe(2);
  });
});

describe("gstack-redact --json", () => {
  test("emits valid JSON with findings + counts", () => {
    const { stdout, code } = run(["--json"], "key AKIA1234567890ABCDEF");
    expect(code).toBe(3);
    const parsed = JSON.parse(stdout);
    expect(parsed.findings[0].id).toBe("aws.access_key");
    expect(parsed.counts.HIGH).toBe(1);
    expect(parsed.repoVisibility).toBe("unknown");
  });
});

describe("gstack-redact --auto-redact", () => {
  test("prints redacted body to stdout, exits 0", () => {
    const { stdout, code } = run(["--auto-redact", "pii.email"], "ping bob@corp.io please");
    expect(code).toBe(0);
    expect(stdout).toContain("<REDACTED-EMAIL>");
    expect(stdout).not.toContain("bob@corp.io");
  });
});

describe("gstack-redact --allowlist", () => {
  test("allowlisted span is suppressed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redact-allow-"));
    const allow = path.join(dir, "allow.txt");
    fs.writeFileSync(allow, "AKIA1234567890ABCDEF\n");
    const { code } = run(["--allowlist", allow], "key AKIA1234567890ABCDEF");
    expect(code).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("gstack-redact --self-email", () => {
  test("own email is not flagged", () => {
    const { code } = run(
      ["--repo-visibility", "public", "--self-email", "me@garry.dev"],
      "from me@garry.dev",
    );
    expect(code).toBe(0);
  });
});

describe("gstack-redact --from-file", () => {
  test("reads input from a file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redact-file-"));
    const f = path.join(dir, "spec.md");
    fs.writeFileSync(f, "leaked ghp_" + "a".repeat(36));
    const proc = Bun.spawnSync(["bun", BIN, "--from-file", f, "--json"]);
    const parsed = JSON.parse(proc.stdout.toString());
    expect(parsed.findings[0].id).toBe("github.pat");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("gstack-redact oversize fails closed", () => {
  test("input over --max-bytes blocks (exit 3)", () => {
    const { code, stdout } = run(["--max-bytes", "100"], "a".repeat(500));
    expect(code).toBe(3);
    expect(stdout).toContain("too large");
  });
});
