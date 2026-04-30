import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

test("SKILL.md.tmpl contains TDD changes", () => {
  const tmplPath = path.resolve(import.meta.dir, "../../SKILL.md.tmpl");
  const content = fs.readFileSync(tmplPath, "utf-8");

  expect(content.includes('**Test Specification')).toBe(true);
  expect(content.includes('version: 1.19.0')).toBe(true);
  expect(content.includes('Verify Red')).toBe(true);
  expect(content.includes('Test Specification (test-writer role)')).toBe(true);
  expect(content.includes('gemini-testspec-input')).toBe(true);
  expect(content.includes('gemini-testspec-output')).toBe(true);
  expect(content.includes('test-fix-input')).toBe(true);
  expect(content.includes('test-fix-output')).toBe(true);
  expect(content.includes('all three sub-checkboxes')).toBe(true);
  expect(content.includes('*-gstack/inbox/living-plan')).toBe(true);
  expect(content.includes('--project-root "$_PROJECT_ROOT"')).toBe(true);
  expect(content.includes('Archive Plans')).toBe(true);
  expect(content.includes('## Feature X: [Feature Name]')).toBe(true);
  expect(content.includes('Origin Plan Feature Verification')).toBe(true);
});

test("generated SKILL.md reflects TDD changes", () => {
  const skillPath = path.resolve(import.meta.dir, "../../SKILL.md");
  const content = fs.readFileSync(skillPath, "utf-8");

  expect(content.includes('**Test Specification')).toBe(true);
  expect(content.includes('1.18.0')).toBe(true);
  expect(content.includes('Verify Red')).toBe(true);
  expect(content.includes('*-gstack/inbox/living-plan')).toBe(true);
  expect(content.includes('--project-root "$_PROJECT_ROOT"')).toBe(true);
  expect(content.includes('## Feature X: [Feature Name]')).toBe(true);
  expect(content.includes('Origin Plan Feature Verification')).toBe(true);
});

test("build skill and CLI do not hardcode default model names", () => {
  const files = [
    path.resolve(import.meta.dir, "../../SKILL.md.tmpl"),
    path.resolve(import.meta.dir, "../../SKILL.md"),
    path.resolve(import.meta.dir, "../cli.ts"),
  ];
  const forbidden = /(claude-opus|gemini-\d|gpt-\d|Claude Opus|Gemini 3|Codex GPT|Opus|Sonnet|--model sonnet)/;

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    expect(content).not.toMatch(forbidden);
  }
  expect(fs.readFileSync(files[0], "utf-8")).toContain("configure.cm");
  expect(fs.readFileSync(files[1], "utf-8")).toContain("configure.cm");
});
