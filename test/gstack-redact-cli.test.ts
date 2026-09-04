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
    timeout: 30_000,
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
    const proc = Bun.spawnSync(["bun", BIN, "--from-file", f, "--json"], { timeout: 30_000 });
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

describe("large report survives a piped consumer (bd621cc0 regression)", () => {
  // The bin used to call `process.exit(code)` right after writing the report.
  // For output bigger than the 64 KiB kernel pipe buffer with a consumer that
  // hadn't started reading yet, exit discarded everything still queued in
  // userland: the consumer received EXACTLY 65,536 bytes, JSON.parse blew up,
  // and the CI quality gate failed CLOSED on a clean scan. Fixed by setting
  // process.exitCode and letting the runtime drain stdout.
  //
  // Reproducing the pressure needs a consumer that provably is NOT reading at
  // the moment the child writes and exits. A plain spawn/spawnSync parent
  // cannot arrange that: Bun eagerly drains child pipes into parent memory,
  // which relieves the pipe and masks the bug. A shell pipeline whose consumer
  // sleeps before its first read (`| { sleep 1.5; cat …; }`) guarantees the
  // child faces a full pipe at its exit point — the sleep comfortably outlasts
  // the ~0.5 s scan. Verified to catch the regression: with process.exit
  // restored, both tests below receive a 65,536-byte truncated stream.
  // (If a loaded machine ever stretches the scan past the sleep, the fixed bin
  // still passes — only regression detection would weaken, never green runs.)
  //
  // The pipeline's own exit status belongs to `cat`, so the subshell writes
  // the bin's real exit code to a file. This harness is POSIX-only, which is
  // fine: this file is already excluded from the Windows curated subset
  // (it spawns a bin/ shebang script).
  function runSlowPipe(dir: string, inFile: string, flags: string): { code: string; out: string } {
    const outFile = path.join(dir, "pipe-out.bin");
    const codeFile = path.join(dir, "pipe-code.txt");
    const script =
      `( bun "$REDACT_BIN" --from-file "$IN_FILE" ${flags} --repo-visibility private; ` +
      `echo $? > "$CODE_FILE" ) | { sleep 1.5; cat > "$OUT_FILE"; }`;
    const proc = Bun.spawnSync(["sh", "-c", script], {
      env: {
        ...process.env,
        REDACT_BIN: BIN,
        IN_FILE: inFile,
        CODE_FILE: codeFile,
        OUT_FILE: outFile,
      },
      timeout: 30_000,
    });
    expect(proc.exitCode).toBe(0); // the plumbing itself (sh, cat) must succeed
    return {
      code: fs.readFileSync(codeFile, "utf8").trim(),
      out: fs.readFileSync(outFile, "utf8"),
    };
  }

  test(
    "--json: a 900-finding report (>200 KB) arrives complete with exit 2",
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redact-pipe-json-"));
      try {
        // 900 DISTINCT emails → 900 MEDIUM pii.email findings (~259 KB of
        // pretty-printed JSON from ~31 KB of input). @example.* and noreply@
        // are engine-allowlisted; corp<i>.io is not. Visibility never mutates
        // the tier, so MEDIUM → exit 2 holds under --repo-visibility private.
        const N = 900;
        const lines: string[] = [];
        for (let i = 0; i < N; i++) lines.push(`contact user${i}@corp${i}.io for details`);
        const inFile = path.join(dir, "input.txt");
        fs.writeFileSync(inFile, lines.join("\n") + "\n");

        const { code, out } = runSlowPipe(dir, inFile, "--json");
        expect(code).toBe("2"); // MEDIUM present, no HIGH
        expect(Buffer.byteLength(out)).toBeGreaterThan(200_000); // real pipe pressure
        const parsed = JSON.parse(out); // truncation → SyntaxError right here
        expect(parsed.findings.length).toBe(N);
        expect(parsed.counts.MEDIUM).toBe(N);
        expect(parsed.repoVisibility).toBe("private");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  test(
    "--auto-redact: a >200 KB redacted body arrives complete with exit 0",
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redact-pipe-ar-"));
      try {
        // Same truncation class, other output path: --auto-redact streams the
        // redacted BODY to stdout (and a ~400 KB diff to stderr, which the
        // spawnSync parent drains eagerly — only stdout has the slow consumer).
        // Pad each line with plain prose (nothing pattern-shaped) so the body
        // itself exceeds 200 KB. Pre-fix, the consumer got a 65,536-byte
        // prefix: 216 of 700 redactions and no sentinel.
        const N = 700;
        const pad =
          "the quarterly report covers infrastructure spend growth and the migration " +
          "plan across three regions with notes on rollout sequencing and support " +
          "rotation for the on call schedule during the transition window plus follow " +
          "up items from the retrospective circulated last week";
        const lines: string[] = [];
        for (let i = 0; i < N; i++) lines.push(`row ${i} reach user${i}@corp${i}.io ${pad}`);
        lines.push("END-OF-REPORT-SENTINEL");
        const body = lines.join("\n") + "\n";
        expect(Buffer.byteLength(body)).toBeGreaterThan(200_000);
        const inFile = path.join(dir, "input.txt");
        fs.writeFileSync(inFile, body);

        const { code, out } = runSlowPipe(dir, inFile, "--auto-redact pii.email");
        expect(code).toBe("0"); // auto-redact mode always exits 0
        // Every planted marker accounted for, and the final byte arrived.
        expect(out.split("<REDACTED-EMAIL>").length - 1).toBe(N);
        expect(out).not.toMatch(/user\d+@corp\d+\.io/);
        expect(out.endsWith("END-OF-REPORT-SENTINEL\n")).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
