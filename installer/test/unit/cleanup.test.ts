import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, rmTmpDir, readJson, write } from "../helpers.js";
import {
  scrubSettingsJson,
  projectGstackArtifacts,
  cleanupHostSymlinks,
  removeGstackInstall,
} from "../../src/lib/cleanup.js";
import type { InstallPaths } from "../../src/lib/paths.js";

describe("scrubSettingsJson", () => {
  let tmp: string;
  beforeEach(() => (tmp = makeTmpDir()));
  afterEach(() => rmTmpDir(tmp));

  test("returns false when file does not exist", () => {
    expect(scrubSettingsJson(path.join(tmp, "nope.json"))).toBe(false);
  });

  test("returns false when settings have no hooks", () => {
    const file = write(tmp, "settings.json", JSON.stringify({ theme: "dark" }));
    expect(scrubSettingsJson(file)).toBe(false);
  });

  test("returns false when settings have no gstack hooks", () => {
    const file = write(
      tmp,
      "settings.json",
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "echo safe" }] },
          ],
        },
      }),
    );
    expect(scrubSettingsJson(file)).toBe(false);
  });

  test("removes gstack check-gstack hook entry but keeps others", () => {
    const file = write(
      tmp,
      "settings.json",
      JSON.stringify({
        theme: "dark",
        hooks: {
          PreToolUse: [
            {
              matcher: "Skill",
              hooks: [{ type: "command", command: "/path/to/check-gstack.sh" }],
            },
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "echo other" }],
            },
          ],
        },
      }),
    );
    expect(scrubSettingsJson(file)).toBe(true);
    const after = readJson<{ theme: string; hooks: { PreToolUse: unknown[] } }>(file);
    expect(after.theme).toBe("dark");
    expect(after.hooks.PreToolUse).toHaveLength(1);
    expect(JSON.stringify(after.hooks.PreToolUse)).toContain("echo other");
    expect(JSON.stringify(after.hooks.PreToolUse)).not.toContain("check-gstack");
  });

  test("removes gstack-session-update hook entry", () => {
    const file = write(
      tmp,
      "settings.json",
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "~/.gstack/bin/gstack-session-update" }] },
          ],
        },
      }),
    );
    expect(scrubSettingsJson(file)).toBe(true);
    const after = readJson<{ hooks?: unknown }>(file);
    expect(after.hooks).toBeUndefined();
  });

  test("removes hooks object entirely when all phases become empty", () => {
    const file = write(
      tmp,
      "settings.json",
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { hooks: [{ type: "command", command: "check-gstack" }] },
          ],
        },
      }),
    );
    expect(scrubSettingsJson(file)).toBe(true);
    const after = readJson<{ hooks?: unknown }>(file);
    expect(after.hooks).toBeUndefined();
  });
});

describe("projectGstackArtifacts", () => {
  let tmp: string;
  beforeEach(() => (tmp = makeTmpDir()));
  afterEach(() => rmTmpDir(tmp));

  test("returns empty when no artifacts exist", () => {
    expect(projectGstackArtifacts(tmp)).toEqual([]);
  });

  test("detects vendored skills dir", () => {
    fs.mkdirSync(path.join(tmp, ".claude", "skills", "gstack"), { recursive: true });
    const artifacts = projectGstackArtifacts(tmp);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toContain(".claude/skills/gstack");
  });

  test("detects check-gstack hook script", () => {
    write(tmp, ".claude/hooks/check-gstack.sh", "#!/bin/bash");
    const artifacts = projectGstackArtifacts(tmp);
    expect(artifacts.some((a) => a.endsWith("check-gstack.sh"))).toBe(true);
  });

  test("detects .gstack dir", () => {
    fs.mkdirSync(path.join(tmp, ".gstack"));
    const artifacts = projectGstackArtifacts(tmp);
    expect(artifacts.some((a) => a.endsWith(".gstack"))).toBe(true);
  });
});

describe("cleanupHostSymlinks", () => {
  let tmp: string;
  beforeEach(() => (tmp = makeTmpDir()));
  afterEach(() => rmTmpDir(tmp));

  function makePaths(home: string): InstallPaths {
    const gstackDir = path.join(home, ".claude", "skills", "gstack");
    return {
      home,
      claudeDir: path.join(home, ".claude"),
      claudeSkillsDir: path.join(home, ".claude", "skills"),
      gstackDir,
      gstackStateDir: path.join(home, ".gstack"),
      claudeMd: path.join(home, ".claude", "CLAUDE.md"),
    };
  }

  test("removes symlinks pointing into gstack install", () => {
    const paths = makePaths(tmp);
    fs.mkdirSync(paths.gstackDir, { recursive: true });
    fs.mkdirSync(path.join(paths.gstackDir, "qa"), { recursive: true });
    fs.writeFileSync(path.join(paths.gstackDir, "qa", "SKILL.md"), "---\nname: qa\n---\n");

    const linkPath = path.join(paths.claudeSkillsDir, "qa");
    fs.symlinkSync(path.join(paths.gstackDir, "qa"), linkPath);

    const result = cleanupHostSymlinks(paths);
    expect(result.removedSymlinks).toContain(linkPath);
    expect(fs.existsSync(linkPath)).toBe(false);
  });

  test("removes directories with SKILL.md symlinks pointing into gstack", () => {
    const paths = makePaths(tmp);
    fs.mkdirSync(paths.gstackDir, { recursive: true });
    fs.writeFileSync(path.join(paths.gstackDir, "SKILL.md"), "---\nname: gstack\n---\n");

    const linkDir = path.join(paths.claudeSkillsDir, "my-skill");
    fs.mkdirSync(linkDir);
    fs.symlinkSync(path.join(paths.gstackDir, "SKILL.md"), path.join(linkDir, "SKILL.md"));

    const result = cleanupHostSymlinks(paths);
    expect(result.removedDirs).toContain(linkDir);
    expect(fs.existsSync(linkDir)).toBe(false);
  });

  test("follows realpath when gstack dir is under a symlinked parent", () => {
    const paths = makePaths(tmp);
    const realGstack = path.join(tmp, "real-home", ".claude", "skills", "gstack");
    fs.mkdirSync(path.dirname(realGstack), { recursive: true });
    fs.mkdirSync(realGstack);
    fs.writeFileSync(path.join(realGstack, "SKILL.md"), "---\nname: g\n---\n");
    fs.rmSync(paths.claudeDir, { recursive: true, force: true });
    fs.symlinkSync(path.join(tmp, "real-home", ".claude"), paths.claudeDir);

    const linkDir = path.join(paths.claudeSkillsDir, "sk");
    fs.mkdirSync(linkDir);
    fs.symlinkSync(path.join(realGstack, "SKILL.md"), path.join(linkDir, "SKILL.md"));

    const result = cleanupHostSymlinks(paths);
    expect(result.removedDirs.some((d) => d.endsWith("/sk"))).toBe(true);
  });

  test("leaves unrelated symlinks alone", () => {
    const paths = makePaths(tmp);
    fs.mkdirSync(paths.gstackDir, { recursive: true });
    fs.mkdirSync(path.join(tmp, "other"), { recursive: true });

    const unrelated = path.join(paths.claudeSkillsDir, "other-skill");
    fs.mkdirSync(path.dirname(unrelated), { recursive: true });
    fs.symlinkSync(path.join(tmp, "other"), unrelated);

    cleanupHostSymlinks(paths);
    expect(fs.existsSync(unrelated)).toBe(true);
  });
});

describe("removeGstackInstall", () => {
  let tmp: string;
  beforeEach(() => (tmp = makeTmpDir()));
  afterEach(() => rmTmpDir(tmp));

  test("returns false when install does not exist", () => {
    const paths: InstallPaths = {
      home: tmp,
      claudeDir: path.join(tmp, ".claude"),
      claudeSkillsDir: path.join(tmp, ".claude", "skills"),
      gstackDir: path.join(tmp, "nonexistent"),
      gstackStateDir: path.join(tmp, ".gstack"),
      claudeMd: path.join(tmp, ".claude", "CLAUDE.md"),
    };
    expect(removeGstackInstall(paths)).toBe(false);
  });

  test("removes install directory", () => {
    const gstackDir = path.join(tmp, ".claude", "skills", "gstack");
    fs.mkdirSync(gstackDir, { recursive: true });
    fs.writeFileSync(path.join(gstackDir, "VERSION"), "1.0.0");
    const paths: InstallPaths = {
      home: tmp,
      claudeDir: path.join(tmp, ".claude"),
      claudeSkillsDir: path.join(tmp, ".claude", "skills"),
      gstackDir,
      gstackStateDir: path.join(tmp, ".gstack"),
      claudeMd: path.join(tmp, ".claude", "CLAUDE.md"),
    };
    expect(removeGstackInstall(paths)).toBe(true);
    expect(fs.existsSync(gstackDir)).toBe(false);
  });
});
