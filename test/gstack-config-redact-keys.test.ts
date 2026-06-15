/**
 * Config keys for redaction (T12). Verifies gstack-config knows the two new
 * keys, validates their value domains, and does NOT expose a block_private key
 * (HIGH blocks both visibilities unconditionally — locked decision).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

const CONFIG = path.resolve(import.meta.dir, "..", "bin", "gstack-config");
let home: string;

function cfg(args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(CONFIG, args, {
    encoding: "utf8",
    env: { ...process.env, GSTACK_HOME: home },
  });
  return { code: r.status ?? 0, out: r.stdout ?? "", err: r.stderr ?? "" };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("redact config keys", () => {
  test("redact_repo_visibility default is empty (falls through to detection)", () => {
    expect(cfg(["get", "redact_repo_visibility"]).out).toBe("");
  });
  test("redact_prepush_hook default is false", () => {
    expect(cfg(["get", "redact_prepush_hook"]).out).toBe("false");
  });
  test("set + get round-trips a valid visibility", () => {
    cfg(["set", "redact_repo_visibility", "private"]);
    expect(cfg(["get", "redact_repo_visibility"]).out).toBe("private");
  });
  test("invalid visibility is rejected to unknown with a warning", () => {
    const r = cfg(["set", "redact_repo_visibility", "bogus"]);
    expect(r.err).toContain("not recognized");
    expect(cfg(["get", "redact_repo_visibility"]).out).toBe("unknown");
  });
  test("invalid prepush flag is rejected to false", () => {
    cfg(["set", "redact_prepush_hook", "maybe"]);
    expect(cfg(["get", "redact_prepush_hook"]).out).toBe("false");
  });
  test("no block_private key (HIGH blocks both visibilities unconditionally)", () => {
    // The default for an unknown key is empty string — there is no such key.
    expect(cfg(["get", "redact_prepush_hook_block_private"]).out).toBe("");
  });
});
