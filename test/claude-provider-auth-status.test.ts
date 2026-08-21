import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ADAPTER = path.join(import.meta.dir, "helpers", "providers", "claude.ts");

describe("ClaudeAdapter.available() auth status", () => {
  let fakeHome: string;
  let shimDir: string;
  let claudeLog: string;
  let securityLog: string;
  let claudeShim: string;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-auth-home-"));
    shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-auth-bin-"));
    claudeLog = path.join(shimDir, "claude-argv.log");
    securityLog = path.join(shimDir, "security-argv.log");
    claudeShim = path.join(shimDir, "claude-shim.ts");
    fs.writeFileSync(
      claudeShim,
      `import { appendFileSync } from "fs";
appendFileSync(process.env.FAKE_CLAUDE_LOG!, process.argv.slice(2).join(" ") + "\\n");
process.stdout.write((process.env.FAKE_CLAUDE_AUTH_OUTPUT ?? "") + "\\n");
process.exit(Number(process.env.FAKE_CLAUDE_AUTH_EXIT ?? "0"));
`,
    );
  });

  afterEach(() => {
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(shimDir, { recursive: true, force: true });
  });

  function runAvailable(opts: {
    authOutput?: string;
    authExit?: number;
    anthropicKey?: string;
    credentialsFile?: boolean;
    keychainExit?: number;
    binaryMissing?: boolean;
  } = {}): { ok: boolean; reason?: string } {
    if (opts.credentialsFile) {
      fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(fakeHome, ".claude", ".credentials.json"), "{}");
    }
    if (opts.keychainExit !== undefined) {
      fs.writeFileSync(
        path.join(shimDir, "security"),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "${securityLog}"\nexit ${opts.keychainExit}\n`,
        { mode: 0o755 },
      );
    }

    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: opts.binaryMissing ? fakeHome : shimDir,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      GSTACK_CLAUDE_BIN: opts.binaryMissing ? undefined : process.execPath,
      CLAUDE_BIN: undefined,
      GSTACK_CLAUDE_BIN_ARGS: opts.binaryMissing ? undefined : JSON.stringify([claudeShim]),
      CLAUDE_BIN_ARGS: undefined,
      ANTHROPIC_API_KEY: opts.anthropicKey,
      FAKE_CLAUDE_AUTH_OUTPUT: opts.authOutput ?? JSON.stringify({ loggedIn: false }),
      FAKE_CLAUDE_AUTH_EXIT: String(opts.authExit ?? 0),
      FAKE_CLAUDE_LOG: claudeLog,
    };
    for (const key of Object.keys(env)) {
      if (env[key] === undefined) delete env[key];
    }

    const driver = `const { ClaudeAdapter } = await import(${JSON.stringify(ADAPTER)});
const check = await new ClaudeAdapter().available();
console.log(JSON.stringify(check));`;
    const result = spawnSync(process.execPath, ["-e", driver], {
      cwd: fakeHome,
      encoding: "utf-8",
      env: env as Record<string, string>,
      timeout: 30_000,
    });
    if (result.status !== 0) {
      throw new Error(`driver failed (${result.status}): ${result.stderr}`);
    }
    return JSON.parse(result.stdout.trim()) as { ok: boolean; reason?: string };
  }

  test("OAuth login reported by Claude CLI is available", () => {
    const check = runAvailable({ authOutput: JSON.stringify({ loggedIn: true }) });

    expect(check).toEqual({ ok: true });
    expect(fs.readFileSync(claudeLog, "utf-8").trim()).toBe("auth status --json");
  });

  test("logged-in JSON is authoritative even when the CLI exits nonzero", () => {
    const check = runAvailable({
      authOutput: JSON.stringify({ loggedIn: true }),
      authExit: 1,
    });

    expect(check).toEqual({ ok: true });
  });

  test("ANTHROPIC_API_KEY remains a fast path", () => {
    const check = runAvailable({
      anthropicKey: "sk-ant-test-not-a-real-key",
      authExit: 1,
    });

    expect(check).toEqual({ ok: true });
    expect(fs.existsSync(claudeLog)).toBe(false);
  });

  test("logged-out status is unavailable even if a stale credentials file exists", () => {
    const check = runAvailable({
      authOutput: JSON.stringify({ loggedIn: false }),
      authExit: 1,
      credentialsFile: true,
    });

    expect(check.ok).toBe(false);
    expect(check.reason).toContain("No Claude auth found");
  });

  test("failed auth-status probe is unavailable", () => {
    const check = runAvailable({ authExit: 1 });

    expect(check.ok).toBe(false);
    expect(check.reason).toContain("No Claude auth found");
  });

  test("unsupported auth-status command falls back to the credentials file", () => {
    const check = runAvailable({
      authOutput: "",
      authExit: 1,
      credentialsFile: true,
      keychainExit: 0,
    });

    expect(check).toEqual({ ok: true });
    expect(fs.existsSync(securityLog)).toBe(false);
  });

  test("darwin: unsupported auth-status command falls back to Keychain", () => {
    if (process.platform !== "darwin") return;

    const check = runAvailable({ authOutput: "", authExit: 1, keychainExit: 0 });

    expect(check).toEqual({ ok: true });
    expect(fs.readFileSync(securityLog, "utf-8").trim()).toBe(
      "find-generic-password -s Claude Code-credentials",
    );
  });

  test("malformed auth-status output is unavailable", () => {
    const check = runAvailable({ authOutput: "not json" });

    expect(check.ok).toBe(false);
    expect(check.reason).toContain("No Claude auth found");
  });

  test("parses the final JSON line after CLI notices", () => {
    const check = runAvailable({
      authOutput: `Update available\n${JSON.stringify({ loggedIn: true })}`,
    });

    expect(check).toEqual({ ok: true });
  });

  test("parses logged-out JSON before a trailing CLI notice", () => {
    const check = runAvailable({
      authOutput: `${JSON.stringify({ loggedIn: false })}\nUpdate available`,
      credentialsFile: true,
    });

    expect(check.ok).toBe(false);
  });

  test("missing Claude CLI is reported before auth detection", () => {
    const check = runAvailable({ binaryMissing: true });

    expect(check.ok).toBe(false);
    expect(check.reason).toContain("claude CLI not found on PATH");
    expect(fs.existsSync(claudeLog)).toBe(false);
  });
});
