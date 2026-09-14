/**
 * #538: the office-hours founder-resources pitch takes no for an answer.
 *
 * The reporter found that memory instructions telling the agent to stop
 * showing the 34-resource pool kept being overridden on every update. The
 * fix is a config key — `founder_resources` — that session context cannot
 * override: `false` skips the entire section silently, forever, until the
 * user re-enables it.
 *
 * Pins: (1) the config key's default, persistence, and validation through
 * the real bin/gstack-config subprocess; (2) the generated section gates on
 * the key BEFORE any resource content; (3) the opt-out write is verified
 * before the skill may promise "never again" (R6 — a failed write must not
 * produce a false promise).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = path.resolve(import.meta.dir, "..");
const CONFIG_BIN = path.join(ROOT, "bin", "gstack-config");
const SECTION = path.join(ROOT, "office-hours", "sections", "design-and-handoff.md");

let tmpHome: string;
beforeEach(() => { tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-538-")); });
afterEach(() => { fs.rmSync(tmpHome, { recursive: true, force: true }); });

function cfg(args: string[]): string {
  return execFileSync(CONFIG_BIN, args, {
    timeout: 30_000,
    encoding: "utf-8",
    env: { ...process.env, GSTACK_HOME: tmpHome },
  }).trim();
}

describe("founder_resources config key (#538)", () => {
  test("defaults to true (pitch stays on for everyone who never opted out)", () => {
    expect(cfg(["get", "founder_resources"])).toBe("true");
  });

  test("set false persists and reads back — the write-verify contract", () => {
    cfg(["set", "founder_resources", "false"]);
    expect(cfg(["get", "founder_resources"])).toBe("false");
  });

  test("invalid values are rejected to the default, never persisted as-is", () => {
    execFileSync(CONFIG_BIN, ["set", "founder_resources", "banana"], {
      timeout: 30_000,
      encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GSTACK_HOME: tmpHome },
    });
    expect(cfg(["get", "founder_resources"])).toBe("true");
  });
});

describe("office-hours section gates on the key (#538)", () => {
  const src = fs.readFileSync(SECTION, "utf-8");

  test("the opt-out check precedes any resource content", () => {
    const gate = src.indexOf("gstack-config get founder_resources");
    const pool = src.indexOf("Resource Pool");
    expect(gate).toBeGreaterThan(-1);
    expect(pool).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(pool);
  });

  test("skip is silent and permanent — never means never", () => {
    expect(src).toContain("skip this entire section silently");
    expect(src).toContain("gstack-config set founder_resources true");
  });

  test("the opt-out write is verified before any promise (R6)", () => {
    expect(src).toContain("VERIFY the write");
    expect(src).toMatch(/read back\s*\n?`false`/);
  });
});
