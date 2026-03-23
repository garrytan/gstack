import { describe, test, expect } from "bun:test";
import { execSync } from "child_process";

/**
 * Test the setup-check CLI subcommand.
 * These tests verify the output format and error messages, not the actual
 * dependency detection (which depends on the host machine).
 */

describe("setup-check", () => {
  const CLI_PATH = new URL("../src/cli.ts", import.meta.url).pathname;

  test("runs without crashing", () => {
    try {
      execSync(`bun run "${CLI_PATH}" setup-check`, {
        encoding: "utf-8",
        timeout: 15000,
      });
    } catch (err: unknown) {
      // setup-check may exit with code 1 if deps are missing — that's fine
      const error = err as { stdout?: string; stderr?: string; status?: number };
      expect(error.status).toBeLessThanOrEqual(1);
    }
  });

  test("output mentions all required dependencies", () => {
    let output = "";
    try {
      output = execSync(`bun run "${CLI_PATH}" setup-check 2>&1`, {
        encoding: "utf-8",
        timeout: 15000,
      });
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string };
      output = (error.stdout || "") + (error.stderr || "");
    }

    expect(output).toContain("Java");
    expect(output).toContain("JAVA_HOME");
    expect(output).toContain("Appium");
    expect(output).toContain("xcuitest");
    expect(output).toContain("Xcode");
  });

  test("output uses consistent format (OK or MISSING)", () => {
    let output = "";
    try {
      output = execSync(`bun run "${CLI_PATH}" setup-check 2>&1`, {
        encoding: "utf-8",
        timeout: 15000,
      });
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string };
      output = (error.stdout || "") + (error.stderr || "");
    }

    // Each line should have [+] or [x] status
    const lines = output.split("\n").filter((l) => l.includes("["));
    for (const line of lines) {
      const hasOk = line.includes("[+]");
      const hasMissing = line.includes("[x]");
      expect(hasOk || hasMissing).toBe(true);
    }
  });

  test("missing dependencies include fix commands", () => {
    let output = "";
    try {
      output = execSync(`bun run "${CLI_PATH}" setup-check 2>&1`, {
        encoding: "utf-8",
        timeout: 15000,
      });
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string };
      output = (error.stdout || "") + (error.stderr || "");
    }

    // If anything is missing, there should be "Fix:" lines
    const missingLines = output.split("\n").filter((l) => l.includes("[x]"));
    if (missingLines.length > 0) {
      expect(output).toContain("Fix:");
    }
  });
});

describe("CLI help", () => {
  const CLI_PATH = new URL("../src/cli.ts", import.meta.url).pathname;

  test("shows help with no arguments", () => {
    const output = execSync(`bun run "${CLI_PATH}" --help 2>&1`, {
      encoding: "utf-8",
      timeout: 10000,
    });

    expect(output).toContain("browse-mobile");
    expect(output).toContain("goto");
    expect(output).toContain("click");
    expect(output).toContain("snapshot");
    expect(output).toContain("screenshot");
  });
});
