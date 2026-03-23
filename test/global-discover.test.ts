import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

// Import normalizeRemoteUrl for unit testing
// We test the script end-to-end via CLI and normalizeRemoteUrl via import
const scriptPath = join(import.meta.dir, "..", "bin", "gstack-global-discover.ts");

describe("gstack-global-discover", () => {
  describe("normalizeRemoteUrl", () => {
    // Dynamically import to test the exported function
    let normalizeRemoteUrl: (url: string) => string;

    beforeEach(async () => {
      const mod = await import("../bin/gstack-global-discover.ts");
      normalizeRemoteUrl = mod.normalizeRemoteUrl;
    });

    test("strips .git suffix", () => {
      expect(normalizeRemoteUrl("https://github.com/user/repo.git")).toBe(
        "https://github.com/user/repo"
      );
    });

    test("converts SSH to HTTPS", () => {
      expect(normalizeRemoteUrl("git@github.com:user/repo.git")).toBe(
        "https://github.com/user/repo"
      );
    });

    test("converts SSH without .git to HTTPS", () => {
      expect(normalizeRemoteUrl("git@github.com:user/repo")).toBe(
        "https://github.com/user/repo"
      );
    });

    test("lowercases host", () => {
      expect(normalizeRemoteUrl("https://GitHub.COM/user/repo")).toBe(
        "https://github.com/user/repo"
      );
    });

    test("SSH and HTTPS for same repo normalize to same URL", () => {
      const ssh = normalizeRemoteUrl("git@github.com:garrytan/gstack.git");
      const https = normalizeRemoteUrl("https://github.com/garrytan/gstack.git");
      const httpsNoDotGit = normalizeRemoteUrl("https://github.com/garrytan/gstack");
      expect(ssh).toBe(https);
      expect(https).toBe(httpsNoDotGit);
    });

    test("handles local: URLs consistently", () => {
      const result = normalizeRemoteUrl("local:/tmp/my-repo");
      // local: gets parsed as a URL scheme — the important thing is consistency
      expect(result).toContain("/tmp/my-repo");
    });

    test("handles GitLab SSH URLs", () => {
      expect(normalizeRemoteUrl("git@gitlab.com:org/project.git")).toBe(
        "https://gitlab.com/org/project"
      );
    });
  });

  describe("CLI", () => {
    test("--help exits 0 and prints usage", () => {
      const result = spawnSync("bun", ["run", scriptPath, "--help"], {
        encoding: "utf-8",
        timeout: 10000,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("--since");
    });

    test("no args exits 1 with error", () => {
      const result = spawnSync("bun", ["run", scriptPath], {
        encoding: "utf-8",
        timeout: 10000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--since is required");
    });

    test("invalid window format exits 1", () => {
      const result = spawnSync("bun", ["run", scriptPath, "--since", "abc"], {
        encoding: "utf-8",
        timeout: 10000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Invalid window format");
    });

    test("--since 7d produces valid JSON", () => {
      const result = spawnSync(
        "bun",
        ["run", scriptPath, "--since", "7d", "--format", "json"],
        { encoding: "utf-8", timeout: 30000 }
      );
      expect(result.status).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json).toHaveProperty("window", "7d");
      expect(json).toHaveProperty("repos");
      expect(json).toHaveProperty("total_sessions");
      expect(json).toHaveProperty("total_repos");
      expect(json).toHaveProperty("tools");
      expect(Array.isArray(json.repos)).toBe(true);
    });

    test("--since 7d --format summary produces readable output", () => {
      const result = spawnSync(
        "bun",
        ["run", scriptPath, "--since", "7d", "--format", "summary"],
        { encoding: "utf-8", timeout: 30000 }
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Window: 7d");
      expect(result.stdout).toContain("Sessions:");
      expect(result.stdout).toContain("Repos:");
    });

    test("--since 1h returns results (may be empty)", () => {
      const result = spawnSync(
        "bun",
        ["run", scriptPath, "--since", "1h", "--format", "json"],
        { encoding: "utf-8", timeout: 30000 }
      );
      expect(result.status).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.total_sessions).toBeGreaterThanOrEqual(0);
    });
  });

  describe("discovery output structure", () => {
    test("repos have required fields", () => {
      const result = spawnSync(
        "bun",
        ["run", scriptPath, "--since", "30d", "--format", "json"],
        { encoding: "utf-8", timeout: 30000 }
      );
      expect(result.status).toBe(0);
      const json = JSON.parse(result.stdout);

      for (const repo of json.repos) {
        expect(repo).toHaveProperty("name");
        expect(repo).toHaveProperty("remote");
        expect(repo).toHaveProperty("paths");
        expect(repo).toHaveProperty("sessions");
        expect(Array.isArray(repo.paths)).toBe(true);
        expect(repo.paths.length).toBeGreaterThan(0);
        expect(repo.sessions).toHaveProperty("claude_code");
        expect(repo.sessions).toHaveProperty("codex");
        expect(repo.sessions).toHaveProperty("gemini");
      }
    });

    test("tools summary matches repo data", () => {
      const result = spawnSync(
        "bun",
        ["run", scriptPath, "--since", "30d", "--format", "json"],
        { encoding: "utf-8", timeout: 30000 }
      );
      const json = JSON.parse(result.stdout);

      // Total sessions should equal sum across tools
      const toolTotal =
        json.tools.claude_code.total_sessions +
        json.tools.codex.total_sessions +
        json.tools.gemini.total_sessions;
      expect(json.total_sessions).toBe(toolTotal);
    });

    test("deduplicates Conductor workspaces by remote", () => {
      const result = spawnSync(
        "bun",
        ["run", scriptPath, "--since", "30d", "--format", "json"],
        { encoding: "utf-8", timeout: 30000 }
      );
      const json = JSON.parse(result.stdout);

      // Check that no two repos share the same normalized remote
      const remotes = json.repos.map((r: any) => r.remote);
      const uniqueRemotes = new Set(remotes);
      expect(remotes.length).toBe(uniqueRemotes.size);
    });
  });
});
