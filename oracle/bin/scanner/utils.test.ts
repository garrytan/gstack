/**
 * utils.test.ts — Tests for shared scanner utilities
 */

import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { readPackageJson, hasDependency, resolveRelative, dirExists, fileExists } from "./utils";

describe("readPackageJson", () => {
  test("returns null for missing directory", () => {
    expect(readPackageJson("/nonexistent/path")).toBeNull();
  });

  test("returns null for directory without package.json", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-utils-"));
    expect(readPackageJson(tmpDir)).toBeNull();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("parses valid package.json", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-utils-"));
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "test-pkg", version: "1.0.0" }));
    const result = readPackageJson(tmpDir);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("test-pkg");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns null for malformed package.json", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-utils-"));
    fs.writeFileSync(path.join(tmpDir, "package.json"), "not valid json {{{");
    expect(readPackageJson(tmpDir)).toBeNull();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("hasDependency", () => {
  test("finds package in dependencies", () => {
    const pkg = { dependencies: { "react": "^18.0.0" }, devDependencies: {} };
    expect(hasDependency(pkg, "react")).toBe(true);
  });

  test("finds package in devDependencies", () => {
    const pkg = { dependencies: {}, devDependencies: { "typescript": "^5.0.0" } };
    expect(hasDependency(pkg, "typescript")).toBe(true);
  });

  test("returns false for missing package", () => {
    const pkg = { dependencies: { "react": "^18.0.0" }, devDependencies: {} };
    expect(hasDependency(pkg, "vue")).toBe(false);
  });

  test("handles missing dependencies/devDependencies fields", () => {
    const pkg = {} as Record<string, unknown>;
    expect(hasDependency(pkg, "anything")).toBe(false);
  });
});

describe("resolveRelative", () => {
  test("resolves absolute path from segments", () => {
    const result = resolveRelative("/root", "src", "index.ts");
    expect(result).toBe("/root/src/index.ts");
  });

  test("resolves nested paths", () => {
    const result = resolveRelative("/project", "src", "components", "Button.tsx");
    expect(result).toBe("/project/src/components/Button.tsx");
  });
});

describe("dirExists", () => {
  test("returns true for existing directory", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-utils-"));
    expect(dirExists(tmpDir)).toBe(true);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns false for nonexistent path", () => {
    expect(dirExists("/nonexistent/dir/path")).toBe(false);
  });

  test("returns false for file (not directory)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-utils-"));
    const filePath = path.join(tmpDir, "file.txt");
    fs.writeFileSync(filePath, "hello");
    expect(dirExists(filePath)).toBe(false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("fileExists", () => {
  test("returns true for existing file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-utils-"));
    const filePath = path.join(tmpDir, "file.txt");
    fs.writeFileSync(filePath, "hello");
    expect(fileExists(filePath)).toBe(true);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns false for nonexistent file", () => {
    expect(fileExists("/nonexistent/file.txt")).toBe(false);
  });

  test("returns false for directory (not file)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-utils-"));
    expect(fileExists(tmpDir)).toBe(false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
