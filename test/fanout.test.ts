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
  expect(tmpl).toContain("### Step 9: Write the per-slab prompt files + worktree-dispatch.sh");
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

test("fanout/SKILL.md.tmpl carries the v0.1 hardening guardrails", () => {
  const tmpl = readFileSync(TMPL, "utf-8");
  // L1: collision-proof worktree/branch naming via doc-path hash suffix
  expect(tmpl).toContain("<sha8>");
  // L2: CHANGELOG/VERSION named as expected-conflict files
  expect(tmpl).toContain("expected-conflict files");
  // L3: contract ownership survives Slab 0 promotion
  expect(tmpl).toContain("Contract ownership survives promotion");
  // L4: over-decomposition guard
  expect(tmpl).toContain("parallelism-confidence check");
  // L5: table-cell pipe escaping
  expect(tmpl).toContain("\\|");
  // L6: per-slab prompt files; no heredocs left in the dispatch script
  expect(tmpl).toContain(".prompt.md");
  expect(tmpl).not.toContain("<<'EOF");
  // Trust boundary from the first review survives
  expect(tmpl).toContain("Trust boundary");
});

test("fanout/SKILL.md.tmpl reserves correct tools", () => {
  const tmpl = readFileSync(TMPL, "utf-8");
  for (const tool of ["Read", "Write", "Edit", "Bash", "AskUserQuestion"]) {
    expect(tmpl).toContain(`- ${tool}`);
  }
});
