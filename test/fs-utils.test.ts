/**
 * mkdirpSync + install-prepush-hook under bun-on-Windows EEXIST semantics
 * (#2635).
 *
 * bun on Windows throws EEXIST from fs.mkdirSync(dir, { recursive: true })
 * when dir already exists - Node treats it as a no-op - which crashed
 * `gstack-redact install-prepush-hook` on any repo whose .git/hooks already
 * existed. The CLI regression test below emulates those Windows semantics via
 * a `bun --preload` fixture (test/helpers/emulate-bun-windows-eexist.ts), so
 * the crash path runs on any platform, including CI Linux.
 */
import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { mkdirpSync } from "../lib/fs-utils";

const REDACT = path.resolve(import.meta.dir, "..", "bin", "gstack-redact");
const EEXIST_PRELOAD = path.resolve(
  import.meta.dir,
  "helpers",
  "emulate-bun-windows-eexist.ts",
);

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fs-utils-"));
}

describe("mkdirpSync", () => {
  test("creates missing nested directories", () => {
    const base = tmpdir();
    try {
      const dir = path.join(base, "a", "b", "c");
      mkdirpSync(dir);
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test("tolerates the directory already existing", () => {
    const base = tmpdir();
    try {
      mkdirpSync(base); // exists -> must be a no-op, not EEXIST
      mkdirpSync(base); // and idempotent on repeat calls
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test("still throws EEXIST when a regular file occupies the path", () => {
    const base = tmpdir();
    try {
      const file = path.join(base, "occupied");
      fs.writeFileSync(file, "x");
      expect(() => mkdirpSync(file)).toThrow(/EEXIST/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("swept mkdirp sites under bun-on-Windows EEXIST semantics (#2635)", () => {
  const DECISION_LOG = path.resolve(import.meta.dir, "..", "bin", "gstack-decision-log");

  test("decision-log still writes when its projects dir already exists", () => {
    // Proves the sweep WIRING, not just the helper: the first call creates
    // ~/.gstack/projects/<slug>/, the second hits the emulated Windows EEXIST
    // on that pre-existing dir — bare mkdirSync crashed here before the sweep.
    const base = tmpdir();
    try {
      const work = path.join(base, "work");
      fs.mkdirSync(work, { recursive: true });
      const payload = '{"decision":"eexist probe","rationale":"r","scope":"repo","source":"user"}';
      const env = { ...process.env, HOME: base };
      const first = spawnSync("bun", [DECISION_LOG, payload], { cwd: work, encoding: "utf8", env });
      expect(first.status).toBe(0);
      const second = spawnSync(
        "bun", ["--preload", EEXIST_PRELOAD, DECISION_LOG, payload],
        { cwd: work, encoding: "utf8", env },
      );
      expect(second.status).toBe(0);
      expect(second.stderr ?? "").not.toContain("EEXIST");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("install-prepush-hook under bun-on-Windows EEXIST semantics (#2635)", () => {
  test("install succeeds when .git/hooks already exists, existing hook preserved", () => {
    const base = tmpdir();
    try {
      const repo = path.join(base, "repo");
      spawnSync("git", ["init", "-q", repo]);
      const hookDir = path.join(repo, ".git", "hooks");
      fs.mkdirSync(hookDir, { recursive: true });
      const hookPath = path.join(hookDir, "pre-push");
      fs.writeFileSync(hookPath, "#!/usr/bin/env bash\necho mine\n", { mode: 0o755 });

      // Under the emulated bun-on-Windows fs, the bare
      // fs.mkdirSync(dir, { recursive: true }) in installPrepushHook() throws
      // EEXIST (the #2635 crash). With mkdirpSync it must install cleanly.
      const r = spawnSync("bun", ["--preload", EEXIST_PRELOAD, REDACT, "install-prepush-hook"], {
        cwd: repo,
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      expect(r.stderr ?? "").not.toContain("EEXIST");
      expect(fs.readFileSync(hookPath, "utf8")).toContain("gstack-redact pre-push (managed)");
      expect(fs.readFileSync(path.join(hookDir, "pre-push.local"), "utf8")).toContain("echo mine");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
