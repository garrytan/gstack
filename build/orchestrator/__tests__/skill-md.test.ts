import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

test("SKILL.md.tmpl contains TDD changes", () => {
  const tmplPath = path.resolve(import.meta.dir, "../../SKILL.md.tmpl");
  const content = fs.readFileSync(tmplPath, "utf-8");

  expect(content.includes('**Test Specification')).toBe(true);
  expect(content.includes('version: 1.14.0')).toBe(true);
  expect(content.includes('Verify Red')).toBe(true);
  expect(content.includes('Test Specification (Gemini Sub-agent)')).toBe(true);
  expect(content.includes('gemini-testspec-input')).toBe(true);
  expect(content.includes('gemini-testspec-output')).toBe(true);
  expect(content.includes('gemini-fix-input')).toBe(true);
  expect(content.includes('gemini-fix-output')).toBe(true);
  expect(content.includes('all three sub-checkboxes')).toBe(true);
});

test("generated SKILL.md reflects TDD changes", () => {
  const skillPath = path.resolve(import.meta.dir, "../../SKILL.md");
  const content = fs.readFileSync(skillPath, "utf-8");

  expect(content.includes('**Test Specification')).toBe(true);
  expect(content.includes('1.14.0')).toBe(true);
  expect(content.includes('Verify Red')).toBe(true);
});
