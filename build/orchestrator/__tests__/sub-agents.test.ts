import { describe, it, expect, afterEach } from "bun:test";
import {
  parseVerdict,
  stripAnsi,
  detectTestCmd,
  parseFailureCount,
  parseJudgeVerdict,
  buildCodexImplArgv,
  buildCodexReviewArgv,
  buildClaudeTaskArgv,
  buildKimiTaskArgv,
  buildRoleTaskArgv,
  isLikelyCodexTransportFailure,
  runCodexReview,
  runTests,
  runShip,
  runSlashCommand,
} from "../sub-agents";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("stripAnsi", () => {
  it("removes ANSI color codes", () => {
    const colored =
      "\x1b[31mGATE FAIL\x1b[0m and then \x1b[32mGATE PASS\x1b[0m";
    expect(stripAnsi(colored)).toBe("GATE FAIL and then GATE PASS");
  });
  it("leaves plain text alone", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });
  it("handles complex sequences (cursor movement etc)", () => {
    expect(stripAnsi("\x1b[2K\x1b[1Goutput\x1b[0m")).toBe("output");
  });
});

describe("parseVerdict", () => {
  it("returns pass when GATE PASS is the only verdict", () => {
    expect(parseVerdict("All checks complete. GATE PASS.")).toBe("pass");
  });
  it("returns fail when GATE FAIL is the only verdict", () => {
    expect(parseVerdict("Found 3 issues. GATE FAIL.")).toBe("fail");
  });
  it("returns unclear when neither keyword present", () => {
    expect(parseVerdict("Review complete. No issues found.")).toBe("unclear");
  });
  it("returns the LAST verdict when both keywords appear", () => {
    expect(parseVerdict("GATE FAIL first pass. After fix: GATE PASS")).toBe(
      "pass",
    );
    expect(
      parseVerdict("GATE PASS initially, then GATE FAIL on closer look"),
    ).toBe("fail");
  });
  it("strips ANSI before matching", () => {
    expect(parseVerdict("\x1b[32mGATE PASS\x1b[0m")).toBe("pass");
  });
  it("case-sensitive (lowercase gate pass does NOT match)", () => {
    // Per the convention in real plans — Codex emits the keyword in caps.
    expect(parseVerdict("gate pass")).toBe("unclear");
  });
});

describe("detectTestCmd", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns "bun test" when package.json has "test": "bun test"', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-test-"));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "bun test" } }),
    );
    expect(detectTestCmd(tmpDir)).toBe("bun test");
  });

  it('returns "npm test" when package.json has "test": "npm test"', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-test-"));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "npm test" } }),
    );
    expect(detectTestCmd(tmpDir)).toBe("npm test");
  });

  it('maps a raw package script with local binaries to "npm test" by default', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-test-"));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );
    expect(detectTestCmd(tmpDir)).toBe("npm test");
  });

  it('uses pnpm test when pnpm-lock.yaml exists and package script is raw', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-test-"));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );
    fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    expect(detectTestCmd(tmpDir)).toBe("pnpm test");
  });

  it('uses bun run test when bun.lock exists and package script is raw', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-test-"));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );
    fs.writeFileSync(path.join(tmpDir, "bun.lock"), "");
    expect(detectTestCmd(tmpDir)).toBe("bun run test");
  });

  it('uses yarn test when packageManager declares yarn and package script is raw', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-test-"));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        packageManager: "yarn@4.5.0",
        scripts: { test: "vitest run" },
      }),
    );
    expect(detectTestCmd(tmpDir)).toBe("yarn test");
  });

  it('uses bun run test when packageManager declares bun and package script is raw', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-test-"));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        packageManager: "bun@1.3.12",
        scripts: { test: "vitest run" },
      }),
    );
    expect(detectTestCmd(tmpDir)).toBe("bun run test");
  });

  it('returns "pytest" when pytest.ini exists', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-test-"));
    fs.writeFileSync(path.join(tmpDir, "pytest.ini"), "[pytest]");
    expect(detectTestCmd(tmpDir)).toBe("pytest");
  });

  it('returns "pytest" when pyproject.toml has [tool.pytest.ini_options]', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-test-"));
    fs.writeFileSync(
      path.join(tmpDir, "pyproject.toml"),
      "[tool.pytest.ini_options]\n",
    );
    expect(detectTestCmd(tmpDir)).toBe("pytest");
  });

  it('returns "go test ./..." when go.mod exists', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-test-"));
    fs.writeFileSync(path.join(tmpDir, "go.mod"), "module test\n");
    expect(detectTestCmd(tmpDir)).toBe("go test ./...");
  });

  it('returns "cargo test" when Cargo.toml exists', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-test-"));
    fs.writeFileSync(path.join(tmpDir, "Cargo.toml"), "[package]\n");
    expect(detectTestCmd(tmpDir)).toBe("cargo test");
  });

  it("returns null when no known files exist", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-test-"));
    expect(detectTestCmd(tmpDir)).toBeNull();
  });
});

describe("runTests", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("runs commands through a shell so quoted arguments survive", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-tests-"));
    const result = await runTests({
      testCmd:
        "node -e \"if (process.argv[1] !== 'hello world') process.exit(7)\" \"hello world\"",
      cwd: tmpDir,
      slug: "run-tests-quoted",
      phaseNumber: "1",
      iteration: 1,
    });

    expect(result.exitCode).toBe(0);
  });
});

describe("parseFailureCount (dual-impl test outcome scoring)", () => {
  it("counts ✗ markers (bun-style)", () => {
    const out = "✗ test 1 failed\n✗ test 2 failed\n✗ test 3 failed\n";
    expect(parseFailureCount(out)).toBe(3);
  });

  it("counts FAIL markers (jest/pytest-style) when no ✗ present", () => {
    const out = "PASS test 1\nFAIL test 2\nFAIL test 3\n";
    expect(parseFailureCount(out)).toBe(2);
  });

  it("returns undefined on output with no failure markers (no signal)", () => {
    expect(parseFailureCount("All tests passed.")).toBeUndefined();
  });

  it("returns undefined on empty output", () => {
    expect(parseFailureCount("")).toBeUndefined();
  });

  it("uses larger of ✗ vs FAIL counts when both appear (no summary line)", () => {
    const out = "✗ a\n✗ b\nFAIL c\n";
    expect(parseFailureCount(out)).toBe(2);
  });

  it('prefers explicit summary line ("3 failed") over marker counts', () => {
    // bun summary line beats a few stray ✗ in stack traces
    const out = "✗ test 1\n✗ test 2\n--- summary ---\n3 failed, 1 passed\n";
    expect(parseFailureCount(out)).toBe(3);
  });

  it('matches pytest summary "===== 2 failed in 0.10s ====="', () => {
    const out = `FAILED test_foo.py::test_bar - AssertionError\nFAILED test_baz.py::test_qux - ValueError\n===== 2 failed in 0.10s =====\n`;
    expect(parseFailureCount(out)).toBe(2);
  });

  it('matches pytest summary with mixed pass/fail "===== 3 failed, 5 passed in 1.2s ====="', () => {
    const out = `===== 3 failed, 5 passed in 1.2s =====\n`;
    expect(parseFailureCount(out)).toBe(3);
  });

  it("counts FAILED markers as fallback when no summary line", () => {
    const out = "FAILED test_a\nFAILED test_b\nFAILED test_c\n";
    expect(parseFailureCount(out)).toBe(3);
  });
});

describe("parseJudgeVerdict (tournament judge output)", () => {
  it("extracts WINNER: primary + REASONING from valid output", () => {
    const out =
      "Reviewing both implementations...\nWINNER: primary\nREASONING: cleaner code, fewer abstractions\n";
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe("primary");
    expect(result.reasoning).toContain("cleaner code");
  });

  it("extracts WINNER: secondary + REASONING from valid output", () => {
    const out =
      "WINNER: secondary\nREASONING: handles edge cases better and is more concise";
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe("secondary");
    expect(result.reasoning).toContain("edge cases");
  });

  it("returns verdict=null when WINNER line is missing (caller must fail-closed)", () => {
    const out = "The judge output is malformed somehow";
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBeNull();
    expect(result.reasoning).toMatch(/no anchored WINNER|fail-closed/i);
  });

  it("rejects legacy gemini/codex winner values", () => {
    expect(parseJudgeVerdict("WINNER: gemini\nREASONING: ok").verdict).toBeNull();
    expect(parseJudgeVerdict("WINNER: codex\nREASONING: ok").verdict).toBeNull();
  });

  it("returns verdict=null when WINNER appears mid-sentence (must be anchored)", () => {
    const out = "I think the WINNER: primary is the better choice here.";
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBeNull();
  });

  it("handles missing REASONING (still extracts verdict)", () => {
    const out = "WINNER: secondary\n";
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe("secondary");
    expect(result.reasoning).toBe("");
  });

  it("case-insensitive WINNER value", () => {
    const out = "WINNER: PRIMARY\nREASONING: ok";
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe("primary");
  });

  it("returns verdict=null for empty string (P2-3: emptyFileIsError stdout='' path)", () => {
    // mergeOutputFile sets stdout='' when the judge output file is empty.
    // parseJudgeVerdict must return null so the caller fails-closed (falls back
    // to gemini) rather than extracting a false WINNER from an error message.
    const result = parseJudgeVerdict("");
    expect(result.verdict).toBeNull();
  });

  it("returns verdict=null for diagnostic text that does not contain WINNER: (safety check)", () => {
    // Verify that the error message format used in the old code (before P2-3)
    // would not accidentally produce a verdict even if it appeared in stdout.
    const diagnosticMsg =
      "Judge did not write expected output to /tmp/judge-out.md. Original shell stdout:\nLoading model...";
    const result = parseJudgeVerdict(diagnosticMsg);
    expect(result.verdict).toBeNull();
  });

  it("extracts HARDENING notes when all three sections are present", () => {
    const out =
      "WINNER: primary\nREASONING: cleaner implementation\nHARDENING:\n- Handle null input in processPayment\n- Guard against empty worktree path\n";
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe("primary");
    expect(result.reasoning).toContain("cleaner implementation");
    expect(result.hardeningNotes).toContain("Handle null input");
    expect(result.hardeningNotes).toContain(
      "Guard against empty worktree path",
    );
  });

  it("returns empty hardeningNotes when HARDENING section is absent", () => {
    const out = "WINNER: secondary\nREASONING: fewer abstractions\n";
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe("secondary");
    expect(result.hardeningNotes).toBe("");
  });

  it("REASONING does not bleed into HARDENING section", () => {
    const out =
      "WINNER: primary\nREASONING: good structure\nHARDENING:\n- edge case A\n";
    const result = parseJudgeVerdict(out);
    expect(result.reasoning).not.toContain("edge case A");
    expect(result.hardeningNotes).toContain("edge case A");
  });

  it("extracts HARDENING when it appears before REASONING (order variation)", () => {
    const out =
      "WINNER: secondary\nHARDENING:\n- null check missing\nREASONING: overall better approach\n";
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe("secondary");
    expect(result.hardeningNotes).toContain("null check missing");
    expect(result.reasoning).toContain("overall better approach");
  });

  it("parses correctly when input has Windows CRLF line endings", () => {
    const out =
      "WINNER: primary\r\nREASONING: clean impl\r\nHARDENING:\r\n- guard null path\r\n";
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe("primary");
    expect(result.reasoning).toContain("clean impl");
    expect(result.hardeningNotes).toContain("guard null path");
  });

  it("HARDENING: -> none identified inline sentinel is captured and does not bleed into REASONING", () => {
    const out =
      "WINNER: secondary\n" +
      "REASONING: both implementations are clean with no major differences.\n" +
      "HARDENING: -> none identified\n";
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe("secondary");
    expect(result.reasoning).not.toContain("none identified");
    expect(result.hardeningNotes).toContain("none identified");
  });

  it('REASONING does not truncate when "HARDENING:" appears mid-sentence in prose', () => {
    // Fix #3: tightened regex requires HARDENING: to be standalone or bullet-prefixed.
    // A sentence containing "HARDENING:" as prose should not end the REASONING block.
    const out =
      "WINNER: primary\n" +
      "REASONING: The key concern is HARDENING: this is prose, not a section. More text here.\n" +
      "HARDENING:\n" +
      "- actual hardening note\n";
    const result = parseJudgeVerdict(out);
    expect(result.verdict).toBe("primary");
    expect(result.reasoning).toContain("HARDENING: this is prose");
    expect(result.hardeningNotes).toContain("actual hardening note");
  });
});

describe("isLikelyCodexTransportFailure", () => {
  it("detects stream disconnects with TLS handshake EOF", () => {
    expect(
      isLikelyCodexTransportFailure({
        stdout: "",
        stderr:
          "ERROR: stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses): tls handshake eof",
      }),
    ).toBe(true);
  });

  it("detects websocket connection failures", () => {
    expect(
      isLikelyCodexTransportFailure({
        stdout: "",
        stderr: "failed to connect to websocket: connection closed",
      }),
    ).toBe(true);
  });

  it("rejects normal review gate failures", () => {
    expect(
      isLikelyCodexTransportFailure({
        stdout: "Review found a correctness issue.\nGATE FAIL",
        stderr: "",
      }),
    ).toBe(false);
  });

  it("rejects local sandbox permission failures", () => {
    expect(
      isLikelyCodexTransportFailure({
        stdout: "Chromium failed: mach_port_rendezvous Permission denied",
        stderr: "",
      }),
    ).toBe(false);
  });
});

describe("buildCodexImplArgv (codex exec invocation shape)", () => {
  it("builds argv with exec + workspace-write default + worktree cwd", () => {
    const argv = buildCodexImplArgv({
      inputFilePath: "/tmp/in.md",
      outputFilePath: "/tmp/out.md",
      cwd: "/tmp/gstack-dual-myslug-p1-1234567890/gemini",
    });
    expect(argv[0]).toBe("exec");
    expect(argv).toContain("-s");
    // Default is workspace-write — danger-full-access was unsafe in linked
    // worktrees (shared .git dir + remotes). Override via opts.sandbox or env.
    expect(argv).toContain("workspace-write");
    expect(argv).toContain("-C");
    expect(argv).toContain("/tmp/gstack-dual-myslug-p1-1234567890/gemini");
  });

  it("uses high reasoning effort (thinking mode) by default", () => {
    const argv = buildCodexImplArgv({
      inputFilePath: "/tmp/in.md",
      outputFilePath: "/tmp/out.md",
      cwd: "/tmp/wt",
    });
    expect(argv).toContain('model_reasoning_effort="high"');
  });

  it("honors opts.sandbox override (e.g. danger-full-access when explicitly opted in)", () => {
    const argv = buildCodexImplArgv({
      inputFilePath: "/tmp/in.md",
      outputFilePath: "/tmp/out.md",
      cwd: "/tmp/wt",
      sandbox: "danger-full-access",
    });
    expect(argv).toContain("danger-full-access");
    expect(argv).not.toContain("workspace-write");
  });

  it("embeds inputFilePath and outputFilePath into the prompt arg", () => {
    const argv = buildCodexImplArgv({
      inputFilePath: "/tmp/MY_INPUT.md",
      outputFilePath: "/tmp/MY_OUTPUT.md",
      cwd: "/tmp/worktree",
    });
    const prompt = argv[1];
    expect(prompt).toContain("/tmp/MY_INPUT.md");
    expect(prompt).toContain("/tmp/MY_OUTPUT.md");
  });

  it("includes -m <model> when model is specified", () => {
    const argv = buildCodexImplArgv({
      inputFilePath: "/tmp/in.md",
      outputFilePath: "/tmp/out.md",
      cwd: "/tmp/wt",
      model: "codex-model-under-test",
    });
    const mIdx = argv.indexOf("-m");
    expect(mIdx).toBeGreaterThan(-1);
    expect(argv[mIdx + 1]).toBe("codex-model-under-test");
  });

  it("omits -m when model is not specified", () => {
    const argv = buildCodexImplArgv({
      inputFilePath: "/tmp/in.md",
      outputFilePath: "/tmp/out.md",
      cwd: "/tmp/wt",
    });
    expect(argv).not.toContain("-m");
  });

  it("-m appears before -s so model is set before sandbox flags", () => {
    const argv = buildCodexImplArgv({
      inputFilePath: "/tmp/in.md",
      outputFilePath: "/tmp/out.md",
      cwd: "/tmp/wt",
      model: "codex-model-under-test",
    });
    const mIdx = argv.indexOf("-m");
    const sIdx = argv.indexOf("-s");
    expect(mIdx).toBeGreaterThan(-1);
    expect(sIdx).toBeGreaterThan(mIdx);
  });
});

describe("buildCodexReviewArgv (codex review invocation shape)", () => {
  it("uses high reasoning effort (thinking mode) by default", () => {
    const argv = buildCodexReviewArgv({
      inputFilePath: "/tmp/review-in.md",
      outputFilePath: "/tmp/review-out.md",
      cwd: "/tmp/wt",
    });
    expect(argv).toContain('model_reasoning_effort="high"');
  });

  it("includes -m <model> when model is specified", () => {
    const argv = buildCodexReviewArgv({
      inputFilePath: "/tmp/review-in.md",
      outputFilePath: "/tmp/review-out.md",
      cwd: "/tmp/wt",
      model: "codex-review-model-under-test",
    });
    const mIdx = argv.indexOf("-m");
    expect(mIdx).toBeGreaterThan(-1);
    expect(argv[mIdx + 1]).toBe("codex-review-model-under-test");
  });

  it("omits -m when model is not specified", () => {
    const argv = buildCodexReviewArgv({
      inputFilePath: "/tmp/review-in.md",
      outputFilePath: "/tmp/review-out.md",
      cwd: "/tmp/wt",
    });
    expect(argv).not.toContain("-m");
  });

  it("-m appears before -s so model is set before sandbox flags", () => {
    const argv = buildCodexReviewArgv({
      inputFilePath: "/tmp/review-in.md",
      outputFilePath: "/tmp/review-out.md",
      cwd: "/tmp/wt",
      model: "codex-review-model-under-test",
    });
    const mIdx = argv.indexOf("-m");
    const sIdx = argv.indexOf("-s");
    expect(mIdx).toBeGreaterThan(-1);
    expect(sIdx).toBeGreaterThan(mIdx);
  });

  it("embeds custom command in the prompt arg", () => {
    const argv = buildCodexReviewArgv({
      inputFilePath: "/tmp/review-in.md",
      outputFilePath: "/tmp/review-out.md",
      cwd: "/tmp/wt",
      command: "/gstack-qa",
    });
    const prompt = argv[1];
    expect(prompt).toContain("/gstack-qa");
    expect(prompt).not.toContain("/gstack-review");
  });

  it("honors sandbox override (read-only)", () => {
    const argv = buildCodexReviewArgv({
      inputFilePath: "/tmp/review-in.md",
      outputFilePath: "/tmp/review-out.md",
      cwd: "/tmp/wt",
      sandbox: "read-only",
    });
    expect(argv).toContain("read-only");
    expect(argv).not.toContain("workspace-write");
  });

  it("honors reasoning override (high overrides xhigh default)", () => {
    const argv = buildCodexReviewArgv({
      inputFilePath: "/tmp/review-in.md",
      outputFilePath: "/tmp/review-out.md",
      cwd: "/tmp/wt",
      reasoning: "high",
    });
    expect(argv).toContain('model_reasoning_effort="high"');
    expect(argv).not.toContain('model_reasoning_effort="xhigh"');
  });

  describe("GSTACK_BUILD_CODEX_REVIEW_SANDBOX env var", () => {
    const ENV_VAR = "GSTACK_BUILD_CODEX_REVIEW_SANDBOX";
    afterEach(() => {
      delete process.env[ENV_VAR];
    });

    it("uses env var sandbox when opts.sandbox is not set", () => {
      process.env[ENV_VAR] = "danger-full-access";
      const argv = buildCodexReviewArgv({
        inputFilePath: "/tmp/review-in.md",
        outputFilePath: "/tmp/review-out.md",
        cwd: "/tmp/wt",
      });
      expect(argv).toContain("danger-full-access");
      expect(argv).not.toContain("workspace-write");
    });

    it("opts.sandbox takes precedence over env var", () => {
      process.env[ENV_VAR] = "danger-full-access";
      const argv = buildCodexReviewArgv({
        inputFilePath: "/tmp/review-in.md",
        outputFilePath: "/tmp/review-out.md",
        cwd: "/tmp/wt",
        sandbox: "read-only",
      });
      expect(argv).toContain("read-only");
      expect(argv).not.toContain("danger-full-access");
    });

    it("falls back to workspace-write when env var is unset", () => {
      const argv = buildCodexReviewArgv({
        inputFilePath: "/tmp/review-in.md",
        outputFilePath: "/tmp/review-out.md",
        cwd: "/tmp/wt",
      });
      expect(argv).toContain("workspace-write");
    });
  });
});

describe("runCodexReview transport retry", () => {
  it("retries once on transient Codex transport failure using the same output protocol", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-review-"));
    const slug = `codex-review-${process.pid}-${Date.now()}`;
    const oldPath = process.env.PATH;
    try {
      const fakeCodex = path.join(tmpDir, "codex");
      const callsPath = path.join(tmpDir, "calls.txt");
      fs.writeFileSync(
        fakeCodex,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const prompt = args[1] || "";
const match = prompt.match(/Write your full review report to (.+?\\.md)\\./);
if (!match) {
  console.error("missing output path in prompt");
  process.exit(2);
}
const outputPath = match[1];
const callCount = fs.existsSync("${callsPath}") ? Number(fs.readFileSync("${callsPath}", "utf8")) : 0;
fs.writeFileSync("${callsPath}", String(callCount + 1));
if (callCount === 0) {
  fs.writeFileSync(outputPath, "STALE GATE FAIL\\n");
  console.error("ERROR: stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses): tls handshake eof");
  process.exit(1);
}
if (fs.readFileSync(outputPath, "utf8") !== "") {
  console.error("staged output was not cleared before retry");
  process.exit(3);
}
fs.writeFileSync(outputPath, "GATE PASS\\n");
process.stdout.write(outputPath);
`,
      );
      fs.chmodSync(fakeCodex, 0o755);
      process.env.PATH = `${tmpDir}${path.delimiter}${oldPath ?? ""}`;

      const inputFilePath = path.join(tmpDir, "input.md");
      const outputFilePath = path.join(tmpDir, "output.md");
      fs.writeFileSync(inputFilePath, "review context");
      fs.writeFileSync(outputFilePath, "");

      const result = await runCodexReview({
        inputFilePath,
        outputFilePath,
        cwd: tmpDir,
        slug,
        phaseNumber: "1",
        iteration: 1,
        command: "/review",
        logPrefix: "review",
        gate: true,
      });

      expect(result.exitCode).toBe(0);
      expect(result.retries).toBe(1);
      expect(result.logPath).toContain("transport-retry");
      expect(result.stdout).toBe("GATE PASS\n");
      expect(fs.readFileSync(callsPath, "utf8")).toBe("2");
      expect(fs.readFileSync(outputFilePath, "utf8")).toBe("GATE PASS\n");
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(path.join(os.homedir(), ".gstack", "build-state", slug), {
        recursive: true,
        force: true,
      });
    }
  });
});

describe("buildClaudeTaskArgv (claude role invocation shape)", () => {
  it("builds a configured /review gate prompt with xhigh thinking", () => {
    const argv = buildClaudeTaskArgv({
      inputFilePath: "/tmp/review-in.md",
      outputFilePath: "/tmp/review-out.md",
      command: "/review",
      model: "claude-role-model-under-test",
      reasoning: "xhigh",
      gate: true,
    });
    expect(argv).toContain("--model");
    expect(argv[argv.indexOf("--model") + 1]).toBe(
      "claude-role-model-under-test",
    );
    const prompt = argv[argv.indexOf("-p") + 1];
    expect(prompt).toContain("Use xhigh thinking");
    expect(prompt).toContain("/review");
    expect(prompt).toContain("GATE PASS");
  });

  it("builds a configured /codex review second-opinion prompt", () => {
    const argv = buildClaudeTaskArgv({
      inputFilePath: "/tmp/review-in.md",
      outputFilePath: "/tmp/review-out.md",
      command: "/codex review",
      model: "claude-role-model-under-test",
      reasoning: "xhigh",
      gate: true,
    });
    const prompt = argv[argv.indexOf("-p") + 1];
    expect(prompt).toContain("/codex review");
  });
});

describe("buildRoleTaskArgv", () => {
  it("builds a configured /ship prompt with file-path I/O and yolo", () => {
    const argv = buildRoleTaskArgv({
      inputFilePath: "/tmp/ship-in.md",
      outputFilePath: "/tmp/ship-out.md",
      command: "/ship",
      model: "role-model-under-test",
    });
    expect(argv).toContain("-p");
    expect(argv).toContain("-m");
    expect(argv[argv.indexOf("-m") + 1]).toBe("role-model-under-test");
    expect(argv).toContain("--yolo");
    const prompt = argv[argv.indexOf("-p") + 1];
    expect(prompt).toContain("Read instructions at /tmp/ship-in.md");
    expect(prompt).toContain("Run /ship");
    expect(prompt).toContain("Write your complete output to /tmp/ship-out.md");
  });

  it("includes a gate verdict instruction when requested", () => {
    const argv = buildRoleTaskArgv({
      inputFilePath: "/tmp/role-in.md",
      outputFilePath: "/tmp/role-out.md",
      command: "/review",
      model: "role-model-under-test",
      gate: true,
    });
    const prompt = argv[argv.indexOf("-p") + 1];
    expect(prompt).toContain("GATE PASS");
    expect(prompt).toContain("GATE FAIL");
    expect(prompt).toContain("Write your complete output to /tmp/role-out.md");
  });
});

describe("buildKimiTaskArgv", () => {
  it("builds a Kimi file-path prompt with workspace scoping and print mode", () => {
    const argv = buildKimiTaskArgv({
      workDir: "/repo",
      addDir: "/tmp/kimi-stage",
      inputFilePath: "/tmp/kimi-stage/ship-in.md",
      outputFilePath: "/tmp/kimi-stage/ship-out.md",
      command: "/ship",
      model: "kimi-code/kimi-for-coding",
      gate: true,
    });
    expect(argv).toContain("--work-dir");
    expect(argv[argv.indexOf("--work-dir") + 1]).toBe("/repo");
    expect(argv).toContain("--add-dir");
    expect(argv[argv.indexOf("--add-dir") + 1]).toBe("/tmp/kimi-stage");
    expect(argv).toContain("-m");
    expect(argv[argv.indexOf("-m") + 1]).toBe("kimi-code/kimi-for-coding");
    expect(argv).toContain("--yolo");
    expect(argv).toContain("--print");
    expect(argv).toContain("--final-message-only");
    const prompt = argv[argv.indexOf("-p") + 1];
    expect(prompt).toContain("Read instructions at /tmp/kimi-stage/ship-in.md");
    expect(prompt).toContain("Run /ship");
    expect(prompt).toContain("GATE PASS");
    expect(prompt).toContain("Write your complete output to /tmp/kimi-stage/ship-out.md");
  });
});

describe("runSlashCommand (kimi role dispatch)", () => {
  it("runs configured slash-command roles through the kimi CLI", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-role-"));
    const slug = `kimi-role-${process.pid}-${Date.now()}`;
    const oldKimiBin = process.env.KIMI_BIN;
    try {
      const fakeKimi = path.join(tmpDir, "kimi");
      fs.writeFileSync(
        fakeKimi,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (!args.includes("--work-dir") || !args.includes("--add-dir")) {
  console.error("missing kimi workspace flags");
  process.exit(2);
}
const prompt = args[args.indexOf("-p") + 1] || "";
const match = prompt.match(/Write your complete output to (.+?\\.md)\\./);
if (!match) {
  console.error("missing output path in prompt");
  process.exit(2);
}
fs.writeFileSync(match[1], "fake kimi ran /ship\\n");
process.stdout.write(match[1]);
`,
      );
      fs.chmodSync(fakeKimi, 0o755);
      process.env.KIMI_BIN = fakeKimi;

      const inputFilePath = path.join(tmpDir, "input.md");
      const outputFilePath = path.join(tmpDir, "output.md");
      fs.writeFileSync(inputFilePath, "ship context");
      fs.writeFileSync(outputFilePath, "");

      const result = await runSlashCommand({
        inputFilePath,
        outputFilePath,
        cwd: tmpDir,
        slug,
        logPrefix: "ship",
        role: {
          provider: "kimi",
          model: "kimi-code/kimi-for-coding",
          reasoning: "high",
          command: "/ship",
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("fake kimi ran /ship\n");
      expect(fs.readFileSync(outputFilePath, "utf8")).toBe(
        "fake kimi ran /ship\n",
      );
      expect(fs.existsSync(result.logPath)).toBe(true);
      expect(fs.readFileSync(result.logPath, "utf8")).toContain(
        path.join(".kimi", "tmp", "gstack", slug),
      );
      const stagingDir = path.join(os.homedir(), ".kimi", "tmp", "gstack", slug);
      const leftovers = fs.existsSync(stagingDir)
        ? fs.readdirSync(stagingDir)
        : [];
      expect(leftovers).toEqual([]);
    } finally {
      if (oldKimiBin === undefined) delete process.env.KIMI_BIN;
      else process.env.KIMI_BIN = oldKimiBin;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(path.join(os.homedir(), ".gstack", "build-state", slug), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(os.homedir(), ".kimi", "tmp", "gstack", slug), {
        recursive: true,
        force: true,
      });
    }
  });
});

describe("runSlashCommand (gemini role dispatch)", () => {
  it("runs configured slash-command roles through the gemini CLI", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-role-"));
    const slug = `gemini-role-${process.pid}-${Date.now()}`;
    const oldGeminiBin = process.env.GEMINI_BIN;
    try {
      const fakeGemini = path.join(tmpDir, "gemini");
      fs.writeFileSync(
        fakeGemini,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1] || "";
const match = prompt.match(/Write your complete output to (.+?\\.md)\\./);
if (!match) {
  console.error("missing output path in prompt");
  process.exit(2);
}
fs.writeFileSync(match[1], "fake gemini ran /ship\\n");
process.stdout.write(match[1]);
`,
      );
      fs.chmodSync(fakeGemini, 0o755);
      process.env.GEMINI_BIN = fakeGemini;

      const inputFilePath = path.join(tmpDir, "input.md");
      const outputFilePath = path.join(tmpDir, "output.md");
      fs.writeFileSync(inputFilePath, "ship context");
      fs.writeFileSync(outputFilePath, "");

      const result = await runSlashCommand({
        inputFilePath,
        outputFilePath,
        cwd: tmpDir,
        slug,
        logPrefix: "ship",
        role: {
          provider: "gemini",
          model: "role-model-under-test",
          reasoning: "high",
          command: "/ship",
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("fake gemini ran /ship\n");
      expect(fs.readFileSync(outputFilePath, "utf8")).toBe(
        "fake gemini ran /ship\n",
      );
      expect(fs.existsSync(result.logPath)).toBe(true);
      expect(fs.readFileSync(result.logPath, "utf8")).toContain(
        path.join(".gemini", "tmp", "gstack", slug),
      );
      const stagingDir = path.join(
        os.homedir(),
        ".gemini",
        "tmp",
        "gstack",
        slug,
      );
      const leftovers = fs.existsSync(stagingDir)
        ? fs.readdirSync(stagingDir)
        : [];
      expect(leftovers).toEqual([]);
    } finally {
      if (oldGeminiBin === undefined) delete process.env.GEMINI_BIN;
      else process.env.GEMINI_BIN = oldGeminiBin;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(path.join(os.homedir(), ".gstack", "build-state", slug), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(os.homedir(), ".gemini", "tmp", "gstack", slug), {
        recursive: true,
        force: true,
      });
    }
  });
});

describe("runShip (gemini role dispatch)", () => {
  it("runs ship then land slash-command roles through the configured CLI", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-ship-"));
    const slug = `gemini-ship-${process.pid}-${Date.now()}`;
    const oldGeminiBin = process.env.GEMINI_BIN;
    try {
      const fakeGemini = path.join(tmpDir, "gemini");
      const callsPath = path.join(tmpDir, "calls.txt");
      fs.writeFileSync(
        fakeGemini,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1] || "";
const match = prompt.match(/Write your complete output to (.+?\\.md)\\./);
if (!match) {
  console.error("missing output path in prompt");
  process.exit(2);
}
const command = prompt.includes("Run /land-and-deploy.")
  ? "/land-and-deploy"
  : prompt.includes("Run /ship.")
    ? "/ship"
    : "unknown";
fs.appendFileSync(${JSON.stringify(callsPath)}, command + "\\n");
fs.writeFileSync(match[1], "fake gemini ran " + command + "\\n");
process.stdout.write(match[1]);
`,
      );
      fs.chmodSync(fakeGemini, 0o755);
      process.env.GEMINI_BIN = fakeGemini;

      const result = await runShip({
        cwd: tmpDir,
        slug,
        ship: {
          provider: "gemini",
          model: "role-model-under-test",
          reasoning: "high",
          command: "/ship",
        },
        land: {
          provider: "gemini",
          model: "role-model-under-test",
          reasoning: "high",
          command: "/land-and-deploy",
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("fake gemini ran /land-and-deploy\n");
      expect(fs.readFileSync(callsPath, "utf8")).toBe(
        "/ship\n/land-and-deploy\n",
      );
      expect(fs.existsSync(result.logPath)).toBe(true);
    } finally {
      if (oldGeminiBin === undefined) delete process.env.GEMINI_BIN;
      else process.env.GEMINI_BIN = oldGeminiBin;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(path.join(os.homedir(), ".gstack", "build-state", slug), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(os.homedir(), ".gemini", "tmp", "gstack", slug), {
        recursive: true,
        force: true,
      });
    }
  });
});
