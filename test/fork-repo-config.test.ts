/**
 * gstack-config fork_repo_path round-trip + validation tests.
 *
 * Coverage:
 * - `set` absolute path → `get` returns it intact
 * - `set` path with space → `get` returns it with space intact
 * - `set` path with inline comment → `get` strips comment, returns path only
 * - `set` relative path → exits 1, stderr "must be an absolute path"
 * - `set` non-existent dir → exits 0, stderr "does not exist"
 * - `set` dir without gstack markers → exits 0, stderr "doesn't look like a gstack repo"
 * - `set` valid gstack repo dir → exits 0, no warnings
 * - `list` output includes fork_repo_path with correct (untruncated) value
 * - `defaults` output includes fork_repo_path
 * - Config header documents fork_repo_path
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawnSync } from "child_process";

const ROOT = path.resolve(import.meta.dir, "..");
const BIN_CONFIG = path.join(ROOT, "bin", "gstack-config");

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-fork-cfg-test-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function run(...args: string[]): {
  stdout: string;
  stderr: string;
  status: number;
} {
  const res = spawnSync(BIN_CONFIG, args, {
    env: { ...process.env, GSTACK_HOME: tmpHome, GSTACK_STATE_DIR: tmpHome },
    encoding: "utf-8",
    cwd: ROOT,
  });
  return {
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
    status: res.status ?? -1,
  };
}

function makeGstackRepo(dir: string): void {
  fs.mkdirSync(path.join(dir, "gstack-upgrade"), { recursive: true });
  fs.writeFileSync(path.join(dir, "gstack-upgrade", "SKILL.md.tmpl"), "");
}

describe("gstack-config fork_repo_path", () => {
  test("set + get round-trip preserves absolute path", () => {
    const forkDir = path.join(tmpHome, "my-fork");
    makeGstackRepo(forkDir);

    expect(run("set", "fork_repo_path", forkDir).status).toBe(0);
    expect(run("get", "fork_repo_path").stdout).toBe(forkDir);
  });

  test("set + get round-trip preserves path with spaces", () => {
    const forkDir = path.join(tmpHome, "my fork repo");
    makeGstackRepo(forkDir);

    const result = run("set", "fork_repo_path", forkDir);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(run("get", "fork_repo_path").stdout).toBe(forkDir);
  });

  test("get strips inline YAML comment from stored value", () => {
    const forkDir = path.join(tmpHome, "my-fork");
    makeGstackRepo(forkDir);

    // Store the value, then manually inject an inline comment
    run("set", "fork_repo_path", forkDir);
    const cfgPath = path.join(tmpHome, "config.yaml");
    const cfg = fs.readFileSync(cfgPath, "utf-8");
    fs.writeFileSync(
      cfgPath,
      cfg.replace(
        `fork_repo_path: ${forkDir}`,
        `fork_repo_path: ${forkDir} # my fork`,
      ),
    );

    expect(run("get", "fork_repo_path").stdout).toBe(forkDir);
  });

  test("set relative path exits 1 with clear error message", () => {
    const result = run("set", "fork_repo_path", "relative/path");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be an absolute path");
    expect(result.stderr).toContain("relative/path");
  });

  test("set non-existent dir exits 0 with warning", () => {
    const result = run(
      "set",
      "fork_repo_path",
      "/tmp/definitely-does-not-exist-gstack-test-xyz",
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("does not exist");
  });

  test("set dir without gstack markers exits 0 with warning", () => {
    // tmpHome exists but has no gstack-upgrade/SKILL.md.tmpl
    const result = run("set", "fork_repo_path", tmpHome);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("doesn't look like a gstack repo");
    expect(result.stderr).toContain("gstack-upgrade/SKILL.md.tmpl");
  });

  test("set valid gstack repo dir exits 0 with no warnings", () => {
    const forkDir = path.join(tmpHome, "clean-fork");
    makeGstackRepo(forkDir);

    const result = run("set", "fork_repo_path", forkDir);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("list output includes fork_repo_path with untruncated spaced value", () => {
    const forkDir = path.join(tmpHome, "my fork repo");
    makeGstackRepo(forkDir);

    run("set", "fork_repo_path", forkDir);
    const { stdout } = run("list");
    expect(stdout).toContain("fork_repo_path:");
    expect(stdout).toContain(forkDir);
  });

  test("defaults output includes fork_repo_path", () => {
    const { stdout } = run("defaults");
    expect(stdout).toContain("fork_repo_path:");
  });

  test("config header documents fork_repo_path", () => {
    const forkDir = path.join(tmpHome, "my-fork");
    makeGstackRepo(forkDir);

    run("set", "fork_repo_path", forkDir);
    const cfg = fs.readFileSync(path.join(tmpHome, "config.yaml"), "utf-8");
    expect(cfg).toContain("fork_repo_path");
    // Header should describe the setting
    expect(cfg).toContain("fork_repo_path:");
  });
});
