/**
 * Contract tests for bin/gstack-redact — exit codes, JSON shape, flags,
 * auto-redact mode, oversize fail-closed. Spawns the shim via `bun`.
 */
import { describe, test, expect } from "bun:test";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const BIN = path.resolve(import.meta.dir, "..", "bin", "gstack-redact");

// A synthetic AWS access key for feeding the scanner. Derived by
// concatenation so the contiguous credential-shaped literal never appears in
// this file's source — the CI quality gate scans every ADDED diff line with
// this same engine, and a raw fixture literal here fails the gate it exists
// to test (#2610 port fallout). The scanner still sees the assembled bytes.
const FAKE_AWS_KEY = ["AKIA", "1234567890ABCDEF"].join("");

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
    expect(run([], `key ${FAKE_AWS_KEY}`).code).toBe(3);
  });
  test("MEDIUM only → 2", () => {
    expect(run(["--repo-visibility", "public"], "mail bob@corp.io").code).toBe(2);
  });
});

describe("gstack-redact --json", () => {
  test("emits valid JSON with findings + counts", () => {
    const { stdout, code } = run(["--json"], `key ${FAKE_AWS_KEY}`);
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
    fs.writeFileSync(allow, FAKE_AWS_KEY + "\n");
    const { code } = run(["--allowlist", allow], `key ${FAKE_AWS_KEY}`);
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

describe("gstack-redact argv dispatch", () => {
  // The bug: main() recognised exactly two subcommands and let everything else
  // fall through to the stdin scan, which reports "no findings" and exits 0.
  // So `install-prepush-hooks` (plural typo) installed no hook and still looked
  // like success — the credential guard silently absent while the operator
  // believes it is armed. A guard that no-ops must never exit 0.
  test("a typo'd install subcommand fails loudly instead of exiting 0", () => {
    const { code, stderr } = run(["install-prepush-hooks"], "");
    expect(code).not.toBe(0);
    expect(stderr).toContain("unknown subcommand");
  });

  test("an unknown positional never reports a clean scan", () => {
    const { code, stdout } = run(["totally-bogus"], "");
    expect(code).not.toBe(0);
    expect(stdout).not.toContain("HIGH=0");
  });

  // Usage errors must not collide with the findings codes (2 = MEDIUM,
  // 3 = HIGH); a caller gating on those would read a typo as "findings".
  test("usage errors exit 1, not a findings code", () => {
    expect(run(["totally-bogus"], "").code).toBe(1);
  });

  test("--help prints usage and exits 0 without scanning", () => {
    const { code, stdout } = run(["--help"], `key ${FAKE_AWS_KEY}`);
    expect(code).toBe(0);
    expect(stdout).toContain("STDIN");
    expect(stdout).not.toContain("HIGH=1");
  });

  // "scan" is what the human output header ("gstack-redact scan — repo …")
  // invites people to type, so it stays an accepted alias for the default
  // filter mode. Rejecting it would break that muscle memory for no gain.
  test("the 'scan' alias still scans normally", () => {
    expect(run(["scan"], `key ${FAKE_AWS_KEY}`).code).toBe(3);
    expect(run(["scan"], "just prose").code).toBe(0);
  });

  test("flags are still parsed, not mistaken for subcommands", () => {
    expect(run(["--json"], "just prose").code).toBe(0);
  });
});
