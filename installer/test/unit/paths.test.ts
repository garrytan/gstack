import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { makeTmpDir, rmTmpDir } from "../helpers.js";
import { findGitRoot, isGitRepo, isInstalled, readVersion } from "../../src/lib/paths.js";
import type { InstallPaths } from "../../src/lib/paths.js";

describe("findGitRoot", () => {
  let tmp: string;
  beforeEach(() => (tmp = makeTmpDir()));
  afterEach(() => rmTmpDir(tmp));

  test("returns null when not in a git repo", () => {
    expect(findGitRoot(tmp)).toBeNull();
  });

  test("returns repo root from repo root", () => {
    execSync("git init -q", { cwd: tmp });
    const root = findGitRoot(tmp);
    expect(root).toBeTruthy();
    expect(fs.realpathSync(root!)).toBe(fs.realpathSync(tmp));
  });

  test("walks up from subdirectory", () => {
    execSync("git init -q", { cwd: tmp });
    const sub = path.join(tmp, "a", "b", "c");
    fs.mkdirSync(sub, { recursive: true });
    const root = findGitRoot(sub);
    expect(root).toBeTruthy();
    expect(fs.realpathSync(root!)).toBe(fs.realpathSync(tmp));
  });
});

describe("isGitRepo", () => {
  let tmp: string;
  beforeEach(() => (tmp = makeTmpDir()));
  afterEach(() => rmTmpDir(tmp));

  test("false for non-repo", () => {
    expect(isGitRepo(tmp)).toBe(false);
  });

  test("true for repo", () => {
    execSync("git init -q", { cwd: tmp });
    expect(isGitRepo(tmp)).toBe(true);
  });
});

describe("isInstalled", () => {
  let tmp: string;
  beforeEach(() => (tmp = makeTmpDir()));
  afterEach(() => rmTmpDir(tmp));

  function makePaths(gstackDir: string): InstallPaths {
    return {
      home: tmp,
      claudeDir: path.join(tmp, ".claude"),
      claudeSkillsDir: path.join(tmp, ".claude", "skills"),
      gstackDir,
      gstackStateDir: path.join(tmp, ".gstack"),
      claudeMd: path.join(tmp, ".claude", "CLAUDE.md"),
    };
  }

  test("false when directory is missing", () => {
    expect(isInstalled(makePaths(path.join(tmp, "nope")))).toBe(false);
  });

  test("true for real directory", () => {
    const dir = path.join(tmp, "gstack");
    fs.mkdirSync(dir);
    expect(isInstalled(makePaths(dir))).toBe(true);
  });

  test("true for symlink to directory", () => {
    const target = path.join(tmp, "target");
    const link = path.join(tmp, "link");
    fs.mkdirSync(target);
    fs.symlinkSync(target, link);
    expect(isInstalled(makePaths(link))).toBe(true);
  });
});

describe("readVersion", () => {
  let tmp: string;
  beforeEach(() => (tmp = makeTmpDir()));
  afterEach(() => rmTmpDir(tmp));

  test("returns null when VERSION is missing", () => {
    const paths: InstallPaths = {
      home: tmp,
      claudeDir: tmp,
      claudeSkillsDir: tmp,
      gstackDir: tmp,
      gstackStateDir: tmp,
      claudeMd: path.join(tmp, "CLAUDE.md"),
    };
    expect(readVersion(paths)).toBeNull();
  });

  test("reads and trims VERSION file", () => {
    fs.writeFileSync(path.join(tmp, "VERSION"), "1.2.3.4\n");
    const paths: InstallPaths = {
      home: tmp,
      claudeDir: tmp,
      claudeSkillsDir: tmp,
      gstackDir: tmp,
      gstackStateDir: tmp,
      claudeMd: path.join(tmp, "CLAUDE.md"),
    };
    expect(readVersion(paths)).toBe("1.2.3.4");
  });
});
