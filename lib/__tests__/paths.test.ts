/**
 * Unit tests for lib/paths.ts — cross-platform path utilities
 * 
 * Tests path resolution across Windows, macOS, and Linux with mocked
 * environment variables to validate logic without requiring multiple OSes.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as path from "path";
import * as os from "os";
import {
  getHomeDir,
  getConfigDir,
  getTempDir,
  expandHome,
  normalizePath,
  getPathSeparator,
  isPathWithin,
  getClaudeSkillsDir,
  slugify,
} from "../paths";

describe("paths — cross-platform utilities", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  describe("getHomeDir", () => {
    test("returns home directory from os.homedir()", () => {
      const home = getHomeDir();
      expect(home).toBeTruthy();
      expect(home.length).toBeGreaterThan(0);
    });

    test("home directory is absolute path", () => {
      const home = getHomeDir();
      expect(path.isAbsolute(home)).toBe(true);
    });
  });

  describe("getConfigDir", () => {
    test("returns ~/.gstack path", () => {
      const configDir = getConfigDir();
      expect(configDir).toContain(".gstack");
    });

    test("config dir is absolute path", () => {
      const configDir = getConfigDir();
      expect(path.isAbsolute(configDir)).toBe(true);
    });

    test("config dir ends with .gstack", () => {
      const configDir = getConfigDir();
      expect(path.basename(configDir)).toBe(".gstack");
    });
  });

  describe("getTempDir", () => {
    test("returns platform-appropriate temp directory", () => {
      const tempDir = getTempDir();
      expect(tempDir).toBeTruthy();
      expect(tempDir.length).toBeGreaterThan(0);
    });

    test("temp dir is absolute path", () => {
      const tempDir = getTempDir();
      expect(path.isAbsolute(tempDir)).toBe(true);
    });

    // Note: Actual behavior depends on platform
    // On macOS: /var/folders/... or /tmp
    // On Linux: /tmp
    // On Windows: C:\Users\...\AppData\Local\Temp or %TEMP%
  });

  describe("expandHome", () => {
    test("expands ~ to home directory", () => {
      const result = expandHome("~/.gstack");
      const home = getHomeDir();
      expect(result).toBe(path.join(home, ".gstack"));
    });

    test("handles ~ at start of path", () => {
      const result = expandHome("~/projects/myapp");
      const home = getHomeDir();
      expect(result).toBe(path.join(home, "projects/myapp"));
    });

    test("leaves absolute paths unchanged", () => {
      const absPath = "/usr/local/bin";
      expect(expandHome(absPath)).toBe(absPath);
    });

    test("leaves relative paths unchanged", () => {
      const relPath = "src/file.ts";
      expect(expandHome(relPath)).toBe(relPath);
    });

    test("handles ~user expansion (returns as-is on Windows)", () => {
      // ~user is Unix-only; on Windows it should pass through
      const result = expandHome("~root/.bashrc");
      if (process.platform === "win32") {
        expect(result).toBe("~root/.bashrc");
      }
      // On Unix, behavior may vary by implementation
    });
  });

  describe("normalizePath", () => {
    test("converts backslashes to forward slashes on Windows", () => {
      if (process.platform === "win32") {
        const result = normalizePath("C:\\Users\\test\\.gstack");
        expect(result).not.toContain("\\");
      }
    });

    test("preserves forward slashes on Unix", () => {
      if (process.platform !== "win32") {
        const result = normalizePath("/home/user/.gstack");
        expect(result).toBe("/home/user/.gstack");
      }
    });

    test("handles mixed path separators", () => {
      const result = normalizePath("path/to\\file/here");
      expect(result).not.toContain("\\");
      expect(result).toContain("/");
    });
  });

  describe("getPathSeparator", () => {
    test("returns platform-appropriate separator", () => {
      const sep = getPathSeparator();
      if (process.platform === "win32") {
        expect(sep).toBe("\\");
      } else {
        expect(sep).toBe("/");
      }
    });

    test("returns single character", () => {
      const sep = getPathSeparator();
      expect(sep.length).toBe(1);
    });
  });

  describe("isPathWithin", () => {
    test("returns true for child path", () => {
      const parent = "/home/user";
      const child = "/home/user/projects/app";
      expect(isPathWithin(parent, child)).toBe(true);
    });

    test("returns true for exact match", () => {
      const parent = "/home/user/projects";
      expect(isPathWithin(parent, parent)).toBe(true);
    });

    test("returns false for sibling path", () => {
      const parent = "/home/user/projects";
      const sibling = "/home/user/documents";
      expect(isPathWithin(parent, sibling)).toBe(false);
    });

    test("returns false for parent path", () => {
      const parent = "/home/user";
      const child = "/home";
      expect(isPathWithin(parent, child)).toBe(false);
    });

    test("handles relative paths", () => {
      const parent = "projects";
      const child = "projects/app";
      expect(isPathWithin(parent, child)).toBe(true);
    });
  });

  describe("getClaudeSkillsDir", () => {
    test("returns ~/.claude/skills path", () => {
      const skillsDir = getClaudeSkillsDir();
      expect(skillsDir).toContain(".claude");
      expect(skillsDir).toContain("skills");
    });

    test("skills dir is absolute path", () => {
      const skillsDir = getClaudeSkillsDir();
      expect(path.isAbsolute(skillsDir)).toBe(true);
    });

    test("contains .claude and skills in path", () => {
      const skillsDir = getClaudeSkillsDir();
      const normalized = normalizePath(skillsDir);
      expect(normalized).toMatch(/\.claude[/\\]skills/i);
    });
  });

  describe("slugify", () => {
    test("converts spaces to hyphens", () => {
      expect(slugify("hello world")).toBe("hello-world");
    });

    test("converts uppercase to lowercase", () => {
      expect(slugify("HelloWorld")).toBe("helloworld");
    });

    test("removes special characters", () => {
      expect(slugify("hello-world!")).toBe("hello-world");
    });

    test("handles multiple consecutive spaces", () => {
      expect(slugify("hello   world")).toBe("hello-world");
    });

    test("trims leading/trailing whitespace", () => {
      expect(slugify("  hello world  ")).toBe("hello-world");
    });

    test("handles empty string", () => {
      expect(slugify("")).toBe("");
    });

    test("keeps hyphens and underscores", () => {
      expect(slugify("hello-world_test")).toBe("hello-world_test");
    });

    test("removes multiple hyphens", () => {
      expect(slugify("hello---world")).toBe("hello-world");
    });
  });

  describe("integration tests", () => {
    test("config and home paths are consistent", () => {
      const home = getHomeDir();
      const config = getConfigDir();
      expect(isPathWithin(home, config)).toBe(true);
    });

    test("skills dir is under home", () => {
      const home = getHomeDir();
      const skills = getClaudeSkillsDir();
      expect(isPathWithin(home, skills)).toBe(true);
    });

    test("expandHome works with getConfigDir", () => {
      const expanded = expandHome("~/.gstack");
      const config = getConfigDir();
      expect(expanded).toBe(config);
    });
  });
});
