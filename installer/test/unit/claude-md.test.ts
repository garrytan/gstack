import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, rmTmpDir, read } from "../helpers.js";
import {
  buildGstackBlock,
  upsertClaudeMd,
  removeGstackBlock,
} from "../../src/lib/claude-md.js";
import type { InstallPaths } from "../../src/lib/paths.js";

function makePaths(home: string): InstallPaths {
  return {
    home,
    claudeDir: path.join(home, ".claude"),
    claudeSkillsDir: path.join(home, ".claude", "skills"),
    gstackDir: path.join(home, ".claude", "skills", "gstack"),
    gstackStateDir: path.join(home, ".gstack"),
    claudeMd: path.join(home, ".claude", "CLAUDE.md"),
  };
}

describe("buildGstackBlock", () => {
  let tmp: string;
  beforeEach(() => (tmp = makeTmpDir()));
  afterEach(() => rmTmpDir(tmp));

  test("includes fence markers", () => {
    const paths = makePaths(tmp);
    const block = buildGstackBlock(paths);
    expect(block).toContain("<!-- gstack:begin -->");
    expect(block).toContain("<!-- gstack:end -->");
  });

  test("falls back to `run list` hint when no skills found", () => {
    const paths = makePaths(tmp);
    const block = buildGstackBlock(paths);
    expect(block).toMatch(/Available skills:.*list/);
  });

  test("lists discovered skills", () => {
    const paths = makePaths(tmp);
    fs.mkdirSync(paths.gstackDir, { recursive: true });
    fs.mkdirSync(path.join(paths.gstackDir, "qa"));
    fs.writeFileSync(
      path.join(paths.gstackDir, "qa", "SKILL.md"),
      "---\nname: qa\ndescription: QA skill\n---\n",
    );
    const block = buildGstackBlock(paths);
    expect(block).toContain("/qa");
  });
});

describe("upsertClaudeMd", () => {
  let tmp: string;
  beforeEach(() => (tmp = makeTmpDir()));
  afterEach(() => rmTmpDir(tmp));

  test("creates file when absent", () => {
    const target = path.join(tmp, "CLAUDE.md");
    const result = upsertClaudeMd(target, "BLOCK\n");
    expect(result.action).toBe("created");
    expect(read(target)).toBe("BLOCK\n");
  });

  test("appends when existing file has no gstack block", () => {
    const target = path.join(tmp, "CLAUDE.md");
    fs.writeFileSync(target, "# My Project\n\nExisting content.\n");
    const result = upsertClaudeMd(target, "<!-- gstack:begin -->\nnew\n<!-- gstack:end -->\n");
    expect(result.action).toBe("inserted");
    const content = read(target);
    expect(content).toContain("# My Project");
    expect(content).toContain("Existing content");
    expect(content).toContain("<!-- gstack:begin -->");
  });

  test("replaces existing gstack block in place", () => {
    const target = path.join(tmp, "CLAUDE.md");
    fs.writeFileSync(
      target,
      "# Head\n\n<!-- gstack:begin -->\nold\n<!-- gstack:end -->\n\n# Tail\n",
    );
    const block = "<!-- gstack:begin -->\nnew\n<!-- gstack:end -->\n";
    const result = upsertClaudeMd(target, block);
    expect(result.action).toBe("updated");
    const content = read(target);
    expect(content).toContain("# Head");
    expect(content).toContain("# Tail");
    expect(content).toContain("new");
    expect(content).not.toContain("old");
  });

  test("idempotent when block is unchanged", () => {
    const target = path.join(tmp, "CLAUDE.md");
    const block = "<!-- gstack:begin -->\nsame\n<!-- gstack:end -->\n";
    fs.writeFileSync(target, block);
    const result = upsertClaudeMd(target, block);
    expect(result.action).toBe("unchanged");
  });
});

describe("removeGstackBlock", () => {
  let tmp: string;
  beforeEach(() => (tmp = makeTmpDir()));
  afterEach(() => rmTmpDir(tmp));

  test("returns false when file does not exist", () => {
    expect(removeGstackBlock(path.join(tmp, "nope.md"))).toBe(false);
  });

  test("returns false when no gstack block present", () => {
    const target = path.join(tmp, "CLAUDE.md");
    fs.writeFileSync(target, "# Just a file\n");
    expect(removeGstackBlock(target)).toBe(false);
  });

  test("removes block and preserves surrounding content", () => {
    const target = path.join(tmp, "CLAUDE.md");
    fs.writeFileSync(
      target,
      "# Head\n\n<!-- gstack:begin -->\nmiddle\n<!-- gstack:end -->\n\n# Tail\n",
    );
    expect(removeGstackBlock(target)).toBe(true);
    const content = read(target);
    expect(content).toContain("# Head");
    expect(content).toContain("# Tail");
    expect(content).not.toContain("gstack:");
    expect(content).not.toContain("middle");
  });
});
