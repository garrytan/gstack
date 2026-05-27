import { test, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..");
const TMPL = join(ROOT, "fanout", "SKILL.md.tmpl");
const MD = join(ROOT, "fanout", "SKILL.md");

test("fanout/SKILL.md.tmpl exists", () => {
  expect(existsSync(TMPL)).toBe(true);
});

test("fanout/SKILL.md exists (generated)", () => {
  expect(existsSync(MD)).toBe(true);
});

test("fanout frontmatter has required fields", () => {
  const skill = readFileSync(MD, "utf-8");
  expect(skill).toMatch(/^---\n(?:[\s\S]*?\n)?name: fanout\n/);
  expect(skill).toMatch(/\ndescription: /);
  expect(skill).toMatch(/\nallowed-tools:/);
});

test("fanout/SKILL.md.tmpl has core sections", () => {
  const tmpl = readFileSync(TMPL, "utf-8");
  expect(tmpl).toContain("## Inputs");
  expect(tmpl).toContain("## Process");
  expect(tmpl).toContain("### Step 1: Read the file");
  expect(tmpl).toContain("### Step 8: Write the Parallel Execution Plan section");
  expect(tmpl).toContain("### Step 9: Write worktree-dispatch.sh");
  expect(tmpl).toContain("## Edge cases");
  expect(tmpl).toContain("## Rules");
});

test("fanout/SKILL.md.tmpl mentions key concepts", () => {
  const tmpl = readFileSync(TMPL, "utf-8");
  expect(tmpl).toContain("Slab 0");
  expect(tmpl).toContain("worktree-dispatch.sh");
  expect(tmpl).toContain("AskUserQuestion");
  expect(tmpl).toContain("--max");
  expect(tmpl).toContain("Parallel Execution Plan");
});

test("fanout/SKILL.md.tmpl reserves correct tools", () => {
  const tmpl = readFileSync(TMPL, "utf-8");
  for (const tool of ["Read", "Write", "Edit", "Bash", "AskUserQuestion"]) {
    expect(tmpl).toContain(`- ${tool}`);
  }
});
