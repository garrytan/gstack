/**
 * Locale-independent key validation tests for bin/gstack-config.
 *
 * POSIX bracket ranges such as a-z follow the active collation order. Under
 * GNU grep with tr_TR.UTF-8, that excludes the ASCII letter i and silently
 * breaks most stored preferences. macOS BSD grep does not reproduce the bug,
 * so the source-level tripwire pins the C-locale boundary on every platform.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = path.resolve(import.meta.dir, "..");
const CONFIG = path.join(ROOT, "bin", "gstack-config");

let stateRoot: string;

function run(args: string[]) {
  const result = spawnSync(CONFIG, args, {
    encoding: "utf8",
    // GSTACK_SETUP_RUNNING suppresses `set skill_prefix`'s auto-relink side
    // effect. Without it, this test invokes the REPO's gstack-config, whose
    // auto-relink resolves the install dir from its own path — i.e. the repo —
    // and gstack-patch-names rewrites all 52 tracked SKILL.md files to
    // gstack-prefixed names, poisoning every downstream test that reads the
    // live tree (observed in the free-tests CI job). Relink behavior itself is
    // covered in isolation by test/relink.test.ts's mock install.
    env: { ...process.env, GSTACK_STATE_ROOT: stateRoot, GSTACK_SETUP_RUNNING: "1" },
    timeout: 30_000,
  });

  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

beforeEach(() => {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-config-locale-"));
});

afterEach(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

describe("gstack-config key validation is locale-independent", () => {
  test("get, has, and set all validate ASCII ranges under the C locale", () => {
    const source = fs.readFileSync(CONFIG, "utf8");
    const guardedValidators = source.match(
      /LC_ALL=C grep -qE '\^\[a-zA-Z0-9_\]\+\(@\[a-zA-Z0-9\]\+\)\?\$'/g,
    );

    expect(guardedValidators).toHaveLength(3);
  });

  test("round-trips existing keys that contain i", () => {
    expect(run(["set", "skill_prefix", "true"]).status).toBe(0);

    const get = run(["get", "skill_prefix"]);
    expect(get.status).toBe(0);
    expect(get.stdout).toBe("true");
  });

  test("accepts an existing endpoint-scoped ASCII key", () => {
    expect(run(["set", "brain_trust_policy@local", "personal"]).status).toBe(0);

    const get = run(["get", "brain_trust_policy@local"]);
    expect(get.status).toBe(0);
    expect(get.stdout).toBe("personal");
  });

  test("continues to reject non-ASCII keys", () => {
    const set = run(["set", "skïll_prefix", "true"]);
    expect(set.status).toBe(1);
    expect(set.stderr).toContain("key must contain only alphanumeric characters");

    const get = run(["get", "skïll_prefix"]);
    expect(get.status).toBe(1);
    expect(get.stderr).toContain("key must contain only alphanumeric characters");
  });
});
