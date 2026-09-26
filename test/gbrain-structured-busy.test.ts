import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

const ROOT = join(import.meta.dir, "..");
const busy = { error: "pglite_busy", retryable: true, reason: "live_serve", next_action: "Wait for the current command or server to close, then retry. Do not remove a live lock." };

function fixture(response: { stdout?: unknown; stderr?: string; exit?: number }, engine = "pglite", remote = false) {
  const home = mkdtempSync(join(tmpdir(), "gbrain-busy-"));
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, ".gbrain"));
  mkdirSync(join(home, ".gstack"));
  writeFileSync(join(home, ".gbrain/config.json"), JSON.stringify({ engine }));
  if (remote) writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { gbrain: { type: "http", url: "https://brain.example.invalid/mcp" } } }));
  writeFileSync(join(home, "response.json"), JSON.stringify(response));
  writeFileSync(join(home, "bin/gbrain"), `#!${process.execPath}
import { appendFileSync, readFileSync } from "fs";
if (process.argv[2] === "--version") { console.log("gbrain 0.51.4.0"); process.exit(0); }
if (process.argv.slice(2).join(" ") === "sources list --json") {
  appendFileSync(process.env.HOME + "/calls", "sources\\n");
  const r = JSON.parse(readFileSync(process.env.HOME + "/response.json", "utf8"));
  if (r.stdout !== undefined) console.log(typeof r.stdout === "string" ? r.stdout : JSON.stringify(r.stdout));
  if (r.stderr) console.error(r.stderr);
  process.exit(r.exit ?? 1);
}
process.exit(1);
`, { mode: 0o700 });
  const env = {
    ...process.env, HOME: home, GSTACK_HOME: join(home, ".gstack"), GBRAIN_HOME: "",
    CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"),
    PATH: `${home}/bin:${dirname(process.execPath)}:/usr/bin:/bin`, GSTACK_DETECT_NO_CACHE: "1",
  };
  return {
    home, env,
    detect(args: string[] = [], cached = false) {
      return spawnSync(process.execPath, [join(ROOT, "bin/gstack-gbrain-detect"), ...args], {
        cwd: home, env: { ...env, GSTACK_DETECT_NO_CACHE: cached ? "0" : "1" }, encoding: "utf8", timeout: 20_000,
      });
    },
    cleanup() { rmSync(home, { recursive: true, force: true }); },
  };
}

describe("structured gbrain busy errors through the detector", () => {
  for (const [label, response, engine, remote, expected, usable] of [
    ["stdout busy", { stdout: busy }, "pglite", false, "engine-locked", 0],
    ["postgres busy", { stdout: busy }, "postgres", false, "broken-db", 1],
    ["legacy stderr", { stderr: "GBrain's local database is already open through gbrain serve" }, "pglite", false, "engine-locked", 0],
    ["healthy", { stdout: { sources: [] }, exit: 0 }, "pglite", false, "ok", 0],
    ["config error", { stderr: "Error: malformed config.json" }, "pglite", false, "broken-config", 1],
    ["database error", { stderr: "Cannot connect to database" }, "postgres", false, "broken-db", 1],
    ["malformed JSON", { stdout: '{"error":"pglite_busy"' }, "pglite", false, "broken-config", 1],
    ["unrelated JSON mentions busy", { stdout: { error: "config_error", message: "pglite_busy" } }, "pglite", false, "broken-config", 1],
    ["remote MCP fallback", { stdout: busy }, "pglite", true, "thin-client", 0],
  ] as const) {
    test(label, () => {
      const f = fixture(response, engine, remote);
      try {
        const result = f.detect();
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).gbrain_local_status).toBe(expected);
        expect(f.detect(["--is-ok"]).status).toBe(usable);
      } finally { f.cleanup(); }
    });
  }

  test("busy state retains the 60-second cache and explicit bypass", () => {
    const f = fixture({ stdout: busy });
    try {
      expect(JSON.parse(f.detect([], true).stdout).gbrain_local_status).toBe("engine-locked");
      writeFileSync(join(f.home, "response.json"), JSON.stringify({ stdout: { sources: [] }, exit: 0 }));
      expect(JSON.parse(f.detect([], true).stdout).gbrain_local_status).toBe("engine-locked");
      expect(readFileSync(join(f.home, "calls"), "utf8").trim().split("\n")).toHaveLength(1);
      const path = join(f.env.GSTACK_HOME, ".gbrain-local-status-cache.json");
      const cache = JSON.parse(readFileSync(path, "utf8"));
      cache.cached_at = Date.now() - 60_001;
      writeFileSync(path, JSON.stringify(cache));
      expect(JSON.parse(f.detect([], true).stdout).gbrain_local_status).toBe("ok");
      writeFileSync(join(f.home, "response.json"), JSON.stringify({ stdout: busy }));
      expect(JSON.parse(f.detect().stdout).gbrain_local_status).toBe("engine-locked");
    } finally { f.cleanup(); }
  });

  for (const [label, response, brainAware] of [
    ["busy", { stdout: busy }, true],
    ["broken config control", { stderr: "Error: malformed config.json" }, false],
  ] as const) {
    test(`actual detector output drives isolated rendered guidance: ${label}`, () => {
      const f = fixture(response);
      try {
        const result = f.detect();
        expect(result.status).toBe(0);
        writeFileSync(join(f.env.GSTACK_HOME, "gbrain-detection.json"), result.stdout);
        const output = join(f.home, "rendered");
        const render = spawnSync(process.execPath, ["run", "scripts/gen-skill-docs.ts", "--host", "claude", "--respect-detection", "--out-dir", output], {
          cwd: ROOT, env: f.env, encoding: "utf8", timeout: 30_000,
        });
        expect(render.status).toBe(0);
        expect(readFileSync(join(output, "office-hours/SKILL.md"), "utf8").includes("## Brain Context Load")).toBe(brainAware);
      } finally { f.cleanup(); }
    }, 40_000);
  }
});
