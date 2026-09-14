/**
 * Free unit tests for the ClaudeAdapter auth sniff in
 * test/helpers/providers/claude.ts — specifically the macOS Keychain branch
 * (#1890): the default subscription install stores OAuth under the
 * generic-password service "Claude Code-credentials" and never writes
 * ~/.claude/.credentials.json, so availability must consult
 * `security find-generic-password -s "Claude Code-credentials"` when neither
 * the creds file nor ANTHROPIC_API_KEY exists.
 *
 * The `security` spawn is darwin-gated in the adapter (the probe only runs
 * when process.platform === 'darwin'), so the keychain-branch tests skip
 * elsewhere; the creds-file / env-key / no-auth verdicts run on every
 * platform.
 *
 * Harness note: available() spawns `security` without an explicit `env:`, and
 * Bun resolves such spawns against the PROCESS STARTUP env — mutating
 * process.env.PATH in-test cannot shadow the real /usr/bin/security (verified;
 * same Bun property lib/gbrain-exec.ts documents for DATABASE_URL). So each
 * case runs available() in a child `bun -e` whose env (and PATH shim) the test
 * fully controls; the fake `security` logs its argv, so the operator's real
 * Keychain is never consulted and a logged-in machine can't false-pass the
 * "no auth" cases. cwd is the fake home so Bun doesn't autoload the repo .env
 * (which defines ANTHROPIC_API_KEY).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ADAPTER = path.join(import.meta.dir, "helpers", "providers", "claude.ts");

describe("ClaudeAdapter.available() — auth sniff incl. macOS Keychain branch (#1890)", () => {
  let fakeHome: string;
  let shimDir: string;
  let securityLog: string;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-auth-home-"));
    shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-auth-bin-"));
    securityLog = path.join(shimDir, "security-argv.log");
  });

  afterEach(() => {
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(shimDir, { recursive: true, force: true });
  });

  /** Fake `security` that logs its argv and exits with `exitCode`. */
  function writeFakeSecurity(exitCode: number): void {
    fs.writeFileSync(
      path.join(shimDir, "security"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "${securityLog}"
exit ${exitCode}
`,
      { mode: 0o755 },
    );
  }

  /** Run `new ClaudeAdapter().available()` in a child bun with a controlled env. */
  function runAvailable(opts: { anthropicKey?: string; bareShimPath?: boolean } = {}): { ok: boolean; reason?: string } {
    const env: Record<string, string | undefined> = {
      ...process.env,
      // Shim dir first so a fake `security` shadows /usr/bin/security; the
      // bare variant drops the inherited PATH entirely (no `claude` findable).
      PATH: opts.bareShimPath ? shimDir : `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
      // os.homedir() honors $HOME (POSIX) / %USERPROFILE% (Windows), so the
      // adapter's ~/.claude/.credentials.json check reads the fake home.
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      // Absolute-path override satisfies resolveClaudeCommand() without a real
      // claude install — available() never spawns it, only resolves it. The
      // bare-PATH case clears it to exercise the not-found branch.
      GSTACK_CLAUDE_BIN: opts.bareShimPath ? undefined : path.join(shimDir, "claude"),
      CLAUDE_BIN: undefined,
      GSTACK_CLAUDE_BIN_ARGS: undefined,
      CLAUDE_BIN_ARGS: undefined,
      ANTHROPIC_API_KEY: opts.anthropicKey,
    };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const driver = `const { ClaudeAdapter } = await import(${JSON.stringify(ADAPTER)});
const check = await new ClaudeAdapter().available();
console.log(JSON.stringify(check));`;
    // process.execPath (absolute bun binary): the bare-PATH case strips the
    // inherited PATH, so a name-based "bun" lookup would ENOENT.
    const res = spawnSync(process.execPath, ["-e", driver], {
      encoding: "utf-8",
      timeout: 30_000,
      cwd: fakeHome, // no .env here — the repo root's would inject ANTHROPIC_API_KEY
      env: env as Record<string, string>,
    });
    if (res.status !== 0) throw new Error(`driver failed (${res.status}): ${res.stderr}`);
    return JSON.parse(res.stdout.trim()) as { ok: boolean; reason?: string };
  }

  test("creds file present → available, and the Keychain is never consulted", () => {
    fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, ".claude", ".credentials.json"), "{}");
    // A fake security that would report NOT FOUND — if the probe ran anyway,
    // ok would still be true, so the no-spawn pin is the argv log staying empty.
    writeFakeSecurity(1);
    const check = runAvailable();
    expect(check.ok).toBe(true);
    expect(fs.existsSync(securityLog)).toBe(false);
  });

  test("ANTHROPIC_API_KEY set → available without creds file or Keychain probe", () => {
    writeFakeSecurity(1);
    const check = runAvailable({ anthropicKey: "sk-ant-test-not-a-real-key" });
    expect(check.ok).toBe(true);
    expect(fs.existsSync(securityLog)).toBe(false);
  });

  test("darwin: Keychain hit (security exit 0) → available, probed with the exact service name", () => {
    if (process.platform !== "darwin") return; // keychain branch is darwin-gated in the adapter
    writeFakeSecurity(0);
    const check = runAvailable();
    expect(check.ok).toBe(true);
    // Exactly one metadata-only probe, against the service subscription installs use.
    const argv = fs.readFileSync(securityLog, "utf-8").trim().split("\n");
    expect(argv).toEqual(["find-generic-password -s Claude Code-credentials"]);
    expect(argv[0]).not.toContain("-w"); // never reads the secret itself
  });

  test("darwin: Keychain miss (security exit 1) → not available with the no-auth reason", () => {
    if (process.platform !== "darwin") return;
    writeFakeSecurity(1);
    const check = runAvailable();
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("No Claude auth found");
    // The probe DID run (this is the miss path, not a skipped probe).
    expect(fs.readFileSync(securityLog, "utf-8")).toContain("find-generic-password");
  });

  test("non-darwin: no creds file + no env key → not available (no Keychain to consult)", () => {
    if (process.platform === "darwin") return; // darwin covered by the shimmed miss case above
    const check = runAvailable();
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("No Claude auth found");
  });

  test("claude CLI unresolvable → not-found reason, before any auth sniff", () => {
    writeFakeSecurity(0); // even a keychain HIT can't rescue a missing binary
    const check = runAvailable({ bareShimPath: true });
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("claude CLI not found on PATH");
    expect(fs.existsSync(securityLog)).toBe(false); // returned before the auth sniff
  });
});
