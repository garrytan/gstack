import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dir, "..");
const readinessPath = join(root, "bin", "gstack-gbrain-ready");
const readiness = readFileSync(readinessPath, "utf8");
const skillStart = readFileSync(join(root, "bin", "gstack-skill-start"), "utf8");
const sessionUpdate = readFileSync(join(root, "bin", "gstack-session-update"), "utf8");
const created: string[] = [];

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(pin?: string, sourcePath?: string) {
  const base = mkdtempSync(join(tmpdir(), "gstack-gbrain-ready-"));
  created.push(base);
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  const state = join(base, "state");
  const log = join(base, "gbrain.log");
  mkdirSync(repo);
  mkdirSync(bin);
  spawnSync("git", ["init", "--quiet", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "sample.ts"), "export function alpha() { return 1; }\n");
  spawnSync("git", ["add", "sample.ts"], { cwd: repo });
  spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "fixture"], { cwd: repo });
  if (pin !== undefined) writeFileSync(join(repo, ".gbrain-source"), `${pin}\n`);

  writeFileSync(join(bin, "gbrain"), `#!/bin/sh
printf '%s\\n' "$*" >> "$GSTACK_TEST_GBRAIN_LOG"
case "$*" in
  "sources list --json") printf '%s\\n' '{"sources":[{"id":"valid-source","local_path":"${sourcePath ?? repo}"}]}' ;;
  "code-def alpha --json") printf '%s\\n' '{"ready":true,"count":1}' ;;
  "code-callers alpha --json") printf '%s\\n' '{"ready":true,"count":1}' ;;
  "serve --surface full")
    cat >/dev/null
    printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"content":[{"text":"{\\"ready\\":true,\\"result\\":\\"ok\\",\\"depth_groups\\":[{\\"nodes\\":[{\\"symbol\\":\\"alpha\\"}]}]}"}]}}'
    ;;
  *) exit 91 ;;
esac
`);
  chmodSync(join(bin, "gbrain"), 0o755);
  return { base, repo, bin, state, log };
}

function run(repo: string, bin: string, state: string, log: string, timeoutSeconds = "1") {
  const started = Date.now();
  const result = spawnSync(readinessPath, ["--check-only", "--session-key", "test-session"], {
    cwd: repo,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      GSTACK_HOME: state,
      GSTACK_TEST_GBRAIN_LOG: log,
      GSTACK_GBRAIN_READY_TIMEOUT_SECONDS: timeoutSeconds,
      PATH: `${bin}:${process.env.PATH || ""}`,
    },
  });
  return { result, elapsed: Date.now() - started };
}

describe("GBrain readiness contract", () => {
  test("a missing pin fails closed without invoking GBrain or starting repair", () => {
    const f = fixture();
    const { result } = run(f.repo, f.bin, f.state, f.log);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("reason=source_pin_missing");
    expect(existsSync(f.log)).toBe(false);
    expect(existsSync(f.state)).toBe(false);
  });

  test("an invalid source id is rejected before it reaches a command or state path", () => {
    const f = fixture("../../escape");
    const { result } = run(f.repo, f.bin, f.state, f.log);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("reason=source_pin_invalid");
    expect(existsSync(f.log)).toBe(false);
    expect(existsSync(f.state)).toBe(false);
  });

  test("a stale path fails closed after one read-only source probe", () => {
    const other = mkdtempSync(join(tmpdir(), "gstack-gbrain-other-"));
    created.push(other);
    const f = fixture("valid-source", other);
    const { result } = run(f.repo, f.bin, f.state, f.log);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("reason=source_path_mismatch");
    expect(readFileSync(f.log, "utf8").trim()).toBe("sources list --json");
  });

  test("healthy readiness uses only bounded read probes and emits partial authority", () => {
    const f = fixture("valid-source");
    const { result } = run(f.repo, f.bin, f.state, f.log);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("GBRAIN_GRAPH: partial");
    expect(result.stdout).toContain("canary=alpha");
    const commands = readFileSync(f.log, "utf8");
    expect(commands).toContain("sources list --json");
    expect(commands).toContain("code-def alpha --json");
    expect(commands).toContain("code-callers alpha --json");
    expect(commands).toContain("serve --surface full");
    expect(commands).not.toMatch(/\b(sync|dream|import|embed|edges-backfill|sources (add|attach|set-strategy))\b/);
  });

  test("a hung foreground source probe times out instead of hanging the skill", () => {
    const f = fixture("valid-source");
    writeFileSync(join(f.bin, "gbrain"), `#!/bin/sh
printf '%s\\n' "$*" >> "$GSTACK_TEST_GBRAIN_LOG"
sleep 30
`);
    chmodSync(join(f.bin, "gbrain"), 0o755);
    const { result, elapsed } = run(f.repo, f.bin, f.state, f.log, "1");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("reason=sources_probe_failed_or_timed_out");
    expect(elapsed).toBeLessThan(5_000);
  });

  test("session and skill startup never launch automatic GBrain repair", () => {
    expect(sessionUpdate).not.toContain("gstack-gbrain-ready");
    expect(skillStart).toContain('"$_GBRAIN_READY_BIN" --check-only --session-key');
    expect(skillStart).not.toMatch(/gstack-gbrain-ready[^\n]*&/);
    expect(skillStart).toContain("/sync-gbrain --full");
    expect(readiness).not.toMatch(/gstack-gbrain-sync|gbrain (sync|dream|embed|edges-backfill)|sources (add|attach|set-strategy)/);
  });

  test("every GBrain invocation in readiness is wrapped by the timeout helper", () => {
    const invocations = readiness.split("\n").filter((line) => /\bgbrain (sources|code-|serve)/.test(line));
    expect(invocations.length).toBeGreaterThanOrEqual(4);
    for (const invocation of invocations) expect(invocation).toContain("run_bounded");
  });
});
