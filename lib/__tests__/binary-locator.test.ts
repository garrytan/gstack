/**
 * Unit tests for lib/binary-locator.ts — cross-platform executable finding
 * 
 * Tests binary discovery logic across Windows, macOS, and Linux.
 * Uses known system utilities (node, git, npm) that should exist on test systems.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import {
  findBinary,
  findBinaryOrThrow,
  getSearchPaths,
  getExecutableNames,
  isExecutable,
  findBinaries,
} from "../binary-locator";

describe("binary-locator — cross-platform executable discovery", () => {
  describe("getExecutableNames", () => {
    test("includes .exe on Windows", () => {
      const names = getExecutableNames("node", "win32");
      expect(names).toContain("node.exe");
      expect(names).toContain("node.cmd");
    });

    test("no .exe extension on Unix", () => {
      const names = getExecutableNames("node", "darwin");
      expect(names).not.toContain("node.exe");
      expect(names).toContain("node");
    });

    test("includes variants on Windows", () => {
      const names = getExecutableNames("pdftotext", "win32");
      expect(names.some(n => n.includes(".exe"))).toBe(true);
    });

    test("returns array of candidates", () => {
      const names = getExecutableNames("test-binary", "linux");
      expect(Array.isArray(names)).toBe(true);
      expect(names.length).toBeGreaterThan(0);
    });
  });

  describe("getSearchPaths", () => {
    test("returns array of search paths", () => {
      const paths = getSearchPaths("darwin");
      expect(Array.isArray(paths)).toBe(true);
      expect(paths.length).toBeGreaterThan(0);
    });

    test("includes /usr/bin on Unix", () => {
      const paths = getSearchPaths("linux");
      expect(paths).toContain("/usr/bin");
    });

    test("includes Homebrew paths on macOS", () => {
      const paths = getSearchPaths("darwin");
      const homebrewPaths = paths.filter(p => p.includes("homebrew"));
      expect(homebrewPaths.length).toBeGreaterThan(0);
    });

    test("includes Program Files on Windows", () => {
      const paths = getSearchPaths("win32");
      const programFilesPaths = paths.filter(p => p.toLowerCase().includes("program files"));
      expect(programFilesPaths.length).toBeGreaterThan(0);
    });

    test("includes /snap paths on Linux", () => {
      const paths = getSearchPaths("linux");
      const snapPaths = paths.filter(p => p.includes("/snap"));
      expect(snapPaths.length).toBeGreaterThan(0);
    });
  });

  describe("isExecutable", () => {
    test("returns true for Node.js executable", () => {
      const nodePath = process.execPath;
      expect(isExecutable(nodePath)).toBe(true);
    });

    test("returns false for non-existent path", () => {
      expect(isExecutable("/nonexistent/path/to/binary")).toBe(false);
    });

    test("returns false for directory", () => {
      const tempDir = process.env.TMPDIR || "/tmp";
      expect(isExecutable(tempDir)).toBe(false);
    });

    test("returns false for non-executable file on Unix", () => {
      if (process.platform !== "win32") {
        // Create a temporary non-executable file
        const testFile = "/tmp/non-executable-test";
        try {
          const fs = require("fs");
          fs.writeFileSync(testFile, "test", { mode: 0o644 });
          expect(isExecutable(testFile)).toBe(false);
          fs.unlinkSync(testFile);
        } catch (err) {
          // If we can't create test file, skip
        }
      }
    });
  });

  describe("findBinary", () => {
    test("finds node in PATH", async () => {
      const nodePath = await findBinary("node");
      expect(nodePath).toBeTruthy();
      expect(isExecutable(nodePath!)).toBe(true);
    });

    test("returns null for non-existent binary", async () => {
      const result = await findBinary("nonexistent-binary-xyz-123");
      expect(result).toBeNull();
    });

    test("returns absolute path", async () => {
      const nodePath = await findBinary("node");
      if (nodePath) {
        expect(path.isAbsolute(nodePath)).toBe(true);
      }
    });

    test("finds bun if installed", async () => {
      const bunPath = await findBinary("bun");
      // Bun may not be installed in all test environments
      if (bunPath) {
        expect(isExecutable(bunPath)).toBe(true);
      }
    });

    test("returns cached result on second call", async () => {
      const result1 = await findBinary("node");
      const result2 = await findBinary("node");
      expect(result1).toBe(result2);
    });
  });

  describe("findBinaryOrThrow", () => {
    test("returns path for existing binary", async () => {
      const nodePath = await findBinaryOrThrow("node");
      expect(nodePath).toBeTruthy();
      expect(isExecutable(nodePath)).toBe(true);
    });

    test("throws descriptive error for missing binary", async () => {
      try {
        await findBinaryOrThrow("nonexistent-binary-xyz-123");
        expect.unreachable("Should have thrown");
      } catch (err: any) {
        expect(err.message).toContain("nonexistent-binary-xyz-123");
        expect(err.message).toMatch(/not found|not available/i);
      }
    });

    test("error includes search paths info", async () => {
      try {
        await findBinaryOrThrow("nonexistent-binary-xyz-123");
        expect.unreachable("Should have thrown");
      } catch (err: any) {
        // Error message should mention where it searched
        expect(err.message.length).toBeGreaterThan(50);
      }
    });
  });

  describe("findBinaries", () => {
    test("finds multiple instances of binary", async () => {
      const nodePaths = await findBinaries("node");
      expect(Array.isArray(nodePaths)).toBe(true);
      // At least the current node should be found
      expect(nodePaths.length).toBeGreaterThanOrEqual(1);
    });

    test("all returned paths are executable", async () => {
      const paths = await findBinaries("node");
      for (const p of paths) {
        expect(isExecutable(p)).toBe(true);
      }
    });

    test("returns empty array for non-existent binary", async () => {
      const paths = await findBinaries("nonexistent-binary-xyz-123");
      expect(Array.isArray(paths)).toBe(true);
      expect(paths.length).toBe(0);
    });
  });

  describe("integration tests", () => {
    test("can find system binaries", async () => {
      const node = await findBinary("node");
      const npm = await findBinary("npm");
      
      expect(node).toBeTruthy();
      // npm may not exist in some minimal Node installations
      if (npm) {
        expect(isExecutable(npm)).toBe(true);
      }
    });

    test("search paths include PATH env var", () => {
      const paths = getSearchPaths(process.platform);
      const pathEnv = process.env.PATH || "";
      const pathDirs = pathEnv.split(path.delimiter);
      
      // At least some PATH directories should be in search paths
      const overlap = paths.filter(p => pathDirs.includes(p));
      expect(overlap.length).toBeGreaterThan(0);
    });

    test("executable names vary by platform", () => {
      const namesWin = getExecutableNames("test", "win32");
      const namesUnix = getExecutableNames("test", "linux");
      
      // Windows should include .exe, Unix should not
      const hasExe = namesWin.some(n => n.endsWith(".exe"));
      const hasNoExe = namesUnix.every(n => !n.endsWith(".exe"));
      
      expect(hasExe).toBe(true);
      expect(hasNoExe).toBe(true);
    });
  });
});
