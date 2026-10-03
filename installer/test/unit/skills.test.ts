import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, rmTmpDir, writeSkill } from "../helpers.js";
import { scanSkills, skillCommandList } from "../../src/lib/skills.js";
import type { InstallPaths } from "../../src/lib/paths.js";

function makePaths(home: string): InstallPaths {
  const gstackDir = path.join(home, "gstack");
  fs.mkdirSync(gstackDir, { recursive: true });
  return {
    home,
    claudeDir: path.join(home, ".claude"),
    claudeSkillsDir: path.join(home, ".claude", "skills"),
    gstackDir,
    gstackStateDir: path.join(home, ".gstack"),
    claudeMd: path.join(home, ".claude", "CLAUDE.md"),
  };
}

describe("scanSkills", () => {
  let tmp: string;
  beforeEach(() => (tmp = makeTmpDir()));
  afterEach(() => rmTmpDir(tmp));

  test("returns empty for missing install", () => {
    const paths: InstallPaths = {
      home: tmp,
      claudeDir: path.join(tmp, ".claude"),
      claudeSkillsDir: path.join(tmp, ".claude", "skills"),
      gstackDir: path.join(tmp, "nonexistent"),
      gstackStateDir: path.join(tmp, ".gstack"),
      claudeMd: path.join(tmp, ".claude", "CLAUDE.md"),
    };
    expect(scanSkills(paths)).toEqual([]);
  });

  test("discovers skills with SKILL.md", () => {
    const paths = makePaths(tmp);
    writeSkill(paths.gstackDir, "qa", { name: "qa", description: "QA skill" });
    writeSkill(paths.gstackDir, "ship", { name: "ship", description: "Ship skill" });
    const skills = scanSkills(paths);
    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.skillName).sort()).toEqual(["qa", "ship"]);
  });

  test("uses frontmatter name when different from directory", () => {
    const paths = makePaths(tmp);
    writeSkill(paths.gstackDir, "run-tests", { name: "test", description: "Test runner" });
    const skills = scanSkills(paths);
    expect(skills[0].skillName).toBe("test");
    expect(skills[0].dirName).toBe("run-tests");
  });

  test("parses YAML block scalar descriptions (description: |)", () => {
    const paths = makePaths(tmp);
    fs.mkdirSync(path.join(paths.gstackDir, "autoplan"));
    fs.writeFileSync(
      path.join(paths.gstackDir, "autoplan", "SKILL.md"),
      `---
name: autoplan
description: |
  First line of the description.
  Second line that continues.
---
body
`,
    );
    const skills = scanSkills(paths);
    expect(skills[0].description).toContain("First line");
    expect(skills[0].description).toContain("Second line");
  });

  test("parses folded scalar (description: >)", () => {
    const paths = makePaths(tmp);
    fs.mkdirSync(path.join(paths.gstackDir, "folded"));
    fs.writeFileSync(
      path.join(paths.gstackDir, "folded", "SKILL.md"),
      `---
name: folded
description: >
  wrapped
  text
  here
---
`,
    );
    const skills = scanSkills(paths);
    expect(skills[0].description).toBe("wrapped text here");
  });

  test("strips quotes from quoted description", () => {
    const paths = makePaths(tmp);
    writeSkill(paths.gstackDir, "q", { name: "q", description: '"quoted value"' });
    const skills = scanSkills(paths);
    expect(skills[0].description).toBe("quoted value");
  });

  test("skips node_modules and other infra dirs", () => {
    const paths = makePaths(tmp);
    writeSkill(paths.gstackDir, "node_modules", { name: "n", description: "d" });
    writeSkill(paths.gstackDir, "browse", { name: "b", description: "d" });
    writeSkill(paths.gstackDir, "scripts", { name: "s", description: "d" });
    writeSkill(paths.gstackDir, "real-skill", { name: "real-skill", description: "d" });
    const skills = scanSkills(paths);
    expect(skills.map((s) => s.dirName)).toEqual(["real-skill"]);
  });

  test("skips dirs without SKILL.md", () => {
    const paths = makePaths(tmp);
    fs.mkdirSync(path.join(paths.gstackDir, "empty"));
    writeSkill(paths.gstackDir, "filled", { name: "filled", description: "d" });
    const skills = scanSkills(paths);
    expect(skills.map((s) => s.dirName)).toEqual(["filled"]);
  });

  test("skips dotfiles", () => {
    const paths = makePaths(tmp);
    writeSkill(paths.gstackDir, ".agents", { name: "a", description: "d" });
    writeSkill(paths.gstackDir, "visible", { name: "visible", description: "d" });
    const skills = scanSkills(paths);
    expect(skills.map((s) => s.dirName)).toEqual(["visible"]);
  });
});

describe("skillCommandList", () => {
  let tmp: string;
  beforeEach(() => (tmp = makeTmpDir()));
  afterEach(() => rmTmpDir(tmp));

  test("returns /-prefixed names", () => {
    const paths = makePaths(tmp);
    writeSkill(paths.gstackDir, "qa", { name: "qa", description: "d" });
    writeSkill(paths.gstackDir, "ship", { name: "ship", description: "d" });
    const commands = skillCommandList(paths);
    expect(commands).toContain("/qa");
    expect(commands).toContain("/ship");
  });
});
