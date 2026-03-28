/**
 * oracle.test.ts — Tests for PRODUCT_CONSCIENCE_READ and PRODUCT_CONSCIENCE_WRITE resolvers
 */

import { describe, test, expect } from "bun:test";
import { generateProductConscienceRead, generateProductConscienceWrite } from "./oracle";
import type { TemplateContext } from "./types";
import { HOST_PATHS } from "./types";

function makeCtx(host: "claude" | "codex" = "claude"): TemplateContext {
  return {
    skillName: "test-skill",
    tmplPath: "test/SKILL.md.tmpl",
    host,
    paths: HOST_PATHS[host],
  };
}

describe("generateProductConscienceRead", () => {
  test("returns non-empty string", () => {
    const result = generateProductConscienceRead(makeCtx());
    expect(result.length).toBeGreaterThan(0);
  });

  test("contains product map path check", () => {
    const result = generateProductConscienceRead(makeCtx());
    expect(result).toContain("docs/oracle/PRODUCT_MAP.md");
  });

  test("contains spot-check instruction", () => {
    const result = generateProductConscienceRead(makeCtx());
    expect(result).toMatch(/spot.check|grep/i);
  });

  test("contains anti-pattern warning", () => {
    const result = generateProductConscienceRead(makeCtx());
    expect(result).toMatch(/anti.pattern/i);
  });

  test("mentions /oracle bootstrap when no map", () => {
    const result = generateProductConscienceRead(makeCtx());
    expect(result).toContain("/oracle");
  });

  test("contains bash block for detection", () => {
    const result = generateProductConscienceRead(makeCtx());
    expect(result).toContain("```bash");
    expect(result).toContain("```");
  });

  test("READ output is host-agnostic (no host-specific paths)", () => {
    const claude = generateProductConscienceRead(makeCtx("claude"));
    const codex = generateProductConscienceRead(makeCtx("codex"));
    // READ just checks for docs/oracle/PRODUCT_MAP.md — no host-specific paths needed
    expect(claude).toContain("docs/oracle/PRODUCT_MAP.md");
    expect(codex).toContain("docs/oracle/PRODUCT_MAP.md");
  });

  test("output is lean (under 30 lines)", () => {
    const result = generateProductConscienceRead(makeCtx());
    const lineCount = result.split("\n").length;
    expect(lineCount).toBeLessThan(30);
  });
});

describe("generateProductConscienceWrite", () => {
  test("returns non-empty string", () => {
    const result = generateProductConscienceWrite(makeCtx());
    expect(result.length).toBeGreaterThan(0);
  });

  test("contains product map path check", () => {
    const result = generateProductConscienceWrite(makeCtx());
    expect(result).toContain("docs/oracle/PRODUCT_MAP.md");
  });

  test("contains lifecycle status instructions", () => {
    const result = generateProductConscienceWrite(makeCtx());
    expect(result).toMatch(/PLANNED.*BUILDING.*SHIPPED/);
  });

  test("contains compression instructions", () => {
    const result = generateProductConscienceWrite(makeCtx());
    expect(result).toMatch(/compress|3 months/i);
  });

  test("contains breadcrumb write", () => {
    const result = generateProductConscienceWrite(makeCtx());
    expect(result).toContain(".product-map-last-write");
  });

  test("specifies silent write (no user interaction)", () => {
    const result = generateProductConscienceWrite(makeCtx());
    expect(result).toMatch(/silent|do not ask/i);
  });

  test("skips when no map exists", () => {
    const result = generateProductConscienceWrite(makeCtx());
    expect(result).toMatch(/skip.*silent|no.*map/i);
  });

  test("claude host uses gstack-slug path", () => {
    const result = generateProductConscienceWrite(makeCtx("claude"));
    expect(result).toContain("~/.claude/skills/gstack");
  });

  test("codex host uses GSTACK_BIN path in slug command", () => {
    const result = generateProductConscienceWrite(makeCtx("codex"));
    expect(result).toContain("$GSTACK_BIN");
  });

  test("output is lean (under 30 lines)", () => {
    const result = generateProductConscienceWrite(makeCtx());
    const lineCount = result.split("\n").length;
    expect(lineCount).toBeLessThan(30);
  });

  test("does not contain AskUserQuestion", () => {
    const result = generateProductConscienceWrite(makeCtx());
    expect(result).not.toContain("AskUserQuestion");
  });
});

describe("scanner/utils.ts", () => {
  // Import utils for testing
  const { readPackageJson, hasDependency, fileExists, dirExists, resolveRelative } =
    require("../../oracle/bin/scanner/utils");

  test("readPackageJson returns null for missing file", () => {
    expect(readPackageJson("/nonexistent/path")).toBeNull();
  });

  test("readPackageJson parses valid package.json", () => {
    const result = readPackageJson(process.cwd());
    expect(result).not.toBeNull();
    expect(result?.name).toBe("gstack");
  });

  test("hasDependency finds dependencies", () => {
    const pkg = { dependencies: { "playwright": "^1.0" }, devDependencies: {} };
    expect(hasDependency(pkg, "playwright")).toBe(true);
    expect(hasDependency(pkg, "nonexistent")).toBe(false);
  });

  test("hasDependency finds devDependencies", () => {
    const pkg = { dependencies: {}, devDependencies: { "typescript": "^5.0" } };
    expect(hasDependency(pkg, "typescript")).toBe(true);
  });

  test("fileExists returns true for existing files", () => {
    expect(fileExists("package.json")).toBe(true);
    expect(fileExists("nonexistent.txt")).toBe(false);
  });

  test("dirExists returns true for existing directories", () => {
    expect(dirExists("oracle")).toBe(true);
    expect(dirExists("nonexistent-dir")).toBe(false);
  });

  test("resolveRelative produces absolute paths", () => {
    const result = resolveRelative("/root", "src", "index.ts");
    expect(result).toBe("/root/src/index.ts");
  });
});
