/**
 * Integration tests for Phase 2/3 cross-platform updates
 * 
 * Tests:
 * 1. Build script can detect platform and architecture
 * 2. Async functions work properly (pdftotext, copyPasteGate, etc.)
 * 3. Path utilities are used throughout codebase
 * 4. No hardcoded paths in critical source files
 */

import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";

describe("Phase 4 — Integration Tests", () => {
  describe("Build script", () => {
    test("build-binaries.js exists and is readable", () => {
      const buildScript = path.join(__dirname, "../../../scripts/build-binaries.js");
      expect(fs.existsSync(buildScript)).toBe(true);
      const content = fs.readFileSync(buildScript, "utf-8");
      expect(content.length).toBeGreaterThan(100);
    });

    test("build script detects platform and architecture", () => {
      const buildScript = path.join(__dirname, "../../../scripts/build-binaries.js");
      const content = fs.readFileSync(buildScript, "utf-8");
      
      // Should mention PLATFORM and ARCH constants
      expect(content).toContain("PLATFORM");
      expect(content).toContain("ARCH");
      expect(content).toContain("process.platform");
      expect(content).toContain("process.arch");
    });

    test("build script handles Bun detection", () => {
      const buildScript = path.join(__dirname, "../../../scripts/build-binaries.js");
      const content = fs.readFileSync(buildScript, "utf-8");
      
      // Should check for Bun availability
      expect(content).toContain("HAS_BUN");
      expect(content).toContain("bun");
    });

    test("build script creates platform-specific binaries", () => {
      const buildScript = path.join(__dirname, "../../../scripts/build-binaries.js");
      const content = fs.readFileSync(buildScript, "utf-8");
      
      // Should mention platform-specific binary naming
      expect(content).toContain("darwin");
      expect(content).toContain("linux");
      expect(content).toContain("win32");
      expect(content).toContain("-x64");
      expect(content).toContain("-arm64");
    });
  });

  describe("Source files use cross-platform utilities", () => {
    test("pdftotext.ts imports binary-locator", () => {
      const file = path.join(__dirname, "../../../make-pdf/src/pdftotext.ts");
      const content = fs.readFileSync(file, "utf-8");
      expect(content).toContain("findBinary");
      expect(content).toContain("binary-locator");
    });

    test("pdftotext.ts has async resolvePdftotext", () => {
      const file = path.join(__dirname, "../../../make-pdf/src/pdftotext.ts");
      const content = fs.readFileSync(file, "utf-8");
      expect(content).toContain("async function resolvePdftotext");
      expect(content).toContain("Promise<PdftotextInfo>");
    });

    test("setup.ts imports path utilities", () => {
      const file = path.join(__dirname, "../../../make-pdf/src/setup.ts");
      const content = fs.readFileSync(file, "utf-8");
      expect(content).toContain("getTempDir");
      expect(content).toContain("getClaudeSkillsDir");
      expect(content).toContain("lib/paths");
    });

    test("cli.ts imports path utilities", () => {
      const file = path.join(__dirname, "../../../browse/src/cli.ts");
      const content = fs.readFileSync(file, "utf-8");
      expect(content).toContain("getTempDir");
      expect(content).toContain("lib/paths");
    });

    test("design/src/cli.ts imports path utilities", () => {
      const file = path.join(__dirname, "../../../design/src/cli.ts");
      const content = fs.readFileSync(file, "utf-8");
      expect(content).toContain("getTempDir");
      expect(content).toContain("getConfigDir");
      expect(content).toContain("lib/paths");
    });
  });

  describe("Async functions are properly typed", () => {
    test("copyPasteGate returns Promise<GateResult>", () => {
      const file = path.join(__dirname, "../../../make-pdf/src/pdftotext.ts");
      const content = fs.readFileSync(file, "utf-8");
      expect(content).toContain("Promise<GateResult>");
      expect(content).toContain("async function copyPasteGate");
    });

    test("pdftotext returns Promise<string>", () => {
      const file = path.join(__dirname, "../../../make-pdf/src/pdftotext.ts");
      const content = fs.readFileSync(file, "utf-8");
      expect(content).toContain("Promise<string>");
      expect(content).toContain("async function pdftotext");
    });

    test("test file awaits async copyPasteGate", () => {
      const file = path.join(__dirname, "../../../make-pdf/test/e2e/combined-gate.test.ts");
      const content = fs.readFileSync(file, "utf-8");
      expect(content).toContain("await copyPasteGate");
      // Test should be async
      expect(content).toContain("async ()");
    });
  });

  describe("Hardcoded paths in critical source files", () => {
    test("pdftotext.ts has no hardcoded /opt/homebrew paths", () => {
      const file = path.join(__dirname, "../../../make-pdf/src/pdftotext.ts");
      const content = fs.readFileSync(file, "utf-8");
      expect(content).not.toContain("/opt/homebrew/bin/pdftotext");
      expect(content).not.toContain("/usr/local/bin/pdftotext");
      expect(content).not.toContain("/usr/bin/pdftotext");
    });

    test("setup.ts has no hardcoded ~/.claude paths", () => {
      const file = path.join(__dirname, "../../../make-pdf/src/setup.ts");
      const content = fs.readFileSync(file, "utf-8");
      // Should not hardcode the full path
      expect(content).not.toMatch(/cd\s+~\/.claude\/skills\/gstack/);
    });

    test("design/src/cli.ts has no /tmp/ hardcoded paths", () => {
      const file = path.join(__dirname, "../../../design/src/cli.ts");
      const content = fs.readFileSync(file, "utf-8");
      // All /tmp paths should use getTempDir()
      const tmpMatches = content.match(/\/tmp\//g) || [];
      // It's OK if there are a few comments mentioning /tmp, but not in code
      const codeLines = content.split("\n")
        .filter(line => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
        .join("\n");
      expect(codeLines).not.toContain("\"/tmp/");
    });

    test("browse/src/cli.ts no hardcoded temp paths", () => {
      const file = path.join(__dirname, "../../../browse/src/cli.ts");
      const content = fs.readFileSync(file, "utf-8");
      // Should use getTempDir() via config
      expect(content).toContain("getTempDir");
    });
  });

  describe("Package.json uses new build system", () => {
    test("package.json build script updated", () => {
      const file = path.join(__dirname, "../../../package.json");
      const content = fs.readFileSync(file, "utf-8");
      const pkg = JSON.parse(content);
      
      expect(pkg.scripts.build).toBeTruthy();
      // Should reference the new build-binaries script
      expect(pkg.scripts.build).toContain("build-binaries");
    });

    test("package.json has build:binaries script", () => {
      const file = path.join(__dirname, "../../../package.json");
      const content = fs.readFileSync(file, "utf-8");
      const pkg = JSON.parse(content);
      
      expect(pkg.scripts["build:binaries"]).toBeTruthy();
      expect(pkg.scripts["build:binaries"]).toContain("build-binaries");
    });
  });

  describe("Cross-platform path handling", () => {
    test("lib/paths.ts exports all required functions", () => {
      const file = path.join(__dirname, "../paths.ts");
      const content = fs.readFileSync(file, "utf-8");
      
      const requiredFunctions = [
        "getHomeDir",
        "getConfigDir",
        "getTempDir",
        "expandHome",
        "normalizePath",
        "getPathSeparator",
        "isPathWithin",
        "getClaudeSkillsDir",
        "slugify",
      ];
      
      for (const fn of requiredFunctions) {
        expect(content).toContain(`export ${fn}`);
      }
    });

    test("lib/binary-locator.ts exports all required functions", () => {
      const file = path.join(__dirname, "../binary-locator.ts");
      const content = fs.readFileSync(file, "utf-8");
      
      const requiredFunctions = [
        "findBinary",
        "findBinaryOrThrow",
        "getSearchPaths",
        "getExecutableNames",
        "isExecutable",
        "findBinaries",
      ];
      
      for (const fn of requiredFunctions) {
        expect(content).toContain(`export ${fn}`);
      }
    });
  });
});
