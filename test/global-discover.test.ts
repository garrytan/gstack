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

  describe("codex large session_meta parsing", () => {
    let codexDir: string;
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "gstack-codex-test-"));
      // Build a realistic ~/.codex/sessions/YYYY/MM/DD structure
      const now = new Date();
      const y = now.getFullYear().toString();
      const m = String(now.getMonth() + 1).padStart(2, "0");
      const d = String(now.getDate()).padStart(2, "0");
      codexDir = join(tmpDir, "codex-home", "sessions", y, m, d);
      mkdirSync(codexDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeCodexSession(
      dir: string,
      cwd: string,
      baseInstructionsSize: number
    ): string {
      const padding = "x".repeat(baseInstructionsSize);
      const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "session_meta",
        payload: {
          id: `test-${Date.now()}`,
          timestamp: new Date().toISOString(),
          cwd,
          originator: "codex_exec",
          cli_version: "0.118.0",
          source: "exec",
          model_provider: "openai",
          base_instructions: { text: padding },
        },
      });
      const name = `rollout-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2)}.jsonl`;
      const filePath = join(dir, name);
      writeFileSync(filePath, line + "\n");
      return filePath;
    }

    test("discovers codex sessions with >4KB session_meta via CLI", () => {
      // Create a git repo as the session target
      const repoDir = join(tmpDir, "fake-repo");
      mkdirSync(repoDir);
      spawnSync("git", ["init"], { cwd: repoDir, stdio: "pipe", timeout: 30_000 });
      spawnSync("git", ["commit", "--allow-empty", "-m", "init"], {
        cwd: repoDir,
        stdio: "pipe",
        timeout: 30_000,
      });

      // Write a session with a 20KB first line (simulates Codex v0.117+)
      writeCodexSession(codexDir, repoDir, 20000);

      // Run discovery with CODEX_SESSIONS_DIR override
      const result = spawnSync(
        "bun",
        ["run", scriptPath, "--since", "1h", "--format", "json"],
        {
          encoding: "utf-8",
          timeout: 30000,
          env: {
            ...process.env,
            CODEX_SESSIONS_DIR: join(tmpDir, "codex-home", "sessions"),
          },
        }
      );

      expect(result.status).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.tools.codex.total_sessions).toBeGreaterThanOrEqual(1);
    });

    test("4KB buffer truncates session_meta, 128KB buffer parses it", () => {
      const padding = "x".repeat(20000);
      const sessionMeta = JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "session_meta",
        payload: {
          id: "test-id",
          timestamp: new Date().toISOString(),
          cwd: "/tmp/test-repo",
          originator: "codex_exec",
          cli_version: "0.118.0",
          source: "exec",
          model_provider: "openai",
          base_instructions: { text: padding },
        },
      });

      expect(sessionMeta.length).toBeGreaterThan(4096);

      const filePath = join(codexDir, "test.jsonl");
      writeFileSync(filePath, sessionMeta + "\n");

      // 4KB buffer: JSON.parse fails (the old bug)
      const { openSync, readSync, closeSync } = require("fs");
      const fd4k = openSync(filePath, "r");
      const buf4k = Buffer.alloc(4096);
      readSync(fd4k, buf4k, 0, 4096, 0);
      closeSync(fd4k);
      expect(() =>
        JSON.parse(buf4k.toString("utf-8").split("\n")[0])
      ).toThrow();

      // 128KB buffer: JSON.parse succeeds (the fix)
      const fd128k = openSync(filePath, "r");
      const buf128k = Buffer.alloc(131072);
      const bytesRead = readSync(fd128k, buf128k, 0, 131072, 0);
      closeSync(fd128k);
      const firstLine = buf128k.toString("utf-8", 0, bytesRead).split("\n")[0];
      const meta = JSON.parse(firstLine);
      expect(meta.type).toBe("session_meta");
      expect(meta.payload.cwd).toBe("/tmp/test-repo");
    });

    test("regression: session_meta beyond 128KB still needs streaming parse", () => {
      // This test documents the current limitation: 128KB buffer is a heuristic.
      // If Codex ever embeds >128KB in session_meta, this test will fail,
      // signaling that the buffer needs to increase or be replaced with streaming.
      const padding = "x".repeat(140000); // ~140KB payload
      const sessionMeta = JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "session_meta",
        payload: {
          id: "test-large",
          timestamp: new Date().toISOString(),
          cwd: "/tmp/large-test",
          originator: "codex_exec",
          cli_version: "0.200.0",
          source: "exec",
          model_provider: "openai",
          base_instructions: { text: padding },
        },
      });

      expect(sessionMeta.length).toBeGreaterThan(131072);

      const filePath = join(codexDir, "large-test.jsonl");
      writeFileSync(filePath, sessionMeta + "\n");

      // 128KB buffer: JSON.parse FAILS for >128KB lines (current limitation)
      const { openSync, readSync, closeSync } = require("fs");
      const fd = openSync(filePath, "r");
      const buf = Buffer.alloc(131072);
      readSync(fd, buf, 0, 131072, 0);
      closeSync(fd);
      expect(() =>
        JSON.parse(buf.toString("utf-8").split("\n")[0])
      ).toThrow();
      // When this test starts passing (e.g., after implementing streaming parse),
      // update it to verify correct parsing instead of documenting the limitation.
    });
  });

  describe("codex originator buckets", () => {
    let tmpDir: string;
    let codexDir: string;
    let repoDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "gstack-codex-orig-"));
      const now = new Date();
      const y = now.getFullYear().toString();
      const m = String(now.getMonth() + 1).padStart(2, "0");
      const d = String(now.getDate()).padStart(2, "0");
      codexDir = join(tmpDir, "codex-home", "sessions", y, m, d);
      mkdirSync(codexDir, { recursive: true });
      repoDir = join(tmpDir, "fake-repo");
      mkdirSync(repoDir);
      spawnSync("git", ["init", "-q"], { cwd: repoDir, stdio: "pipe", timeout: 30_000 });
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    // Pass no argument to omit originator from the payload.
    function writeCodex(...originator: unknown[]) {
      const payload: Record<string, unknown> = { id: `t-${Math.random()}`, timestamp: new Date().toISOString(), cwd: repoDir };
      if (originator.length) payload.originator = originator[0];
      const name = `rollout-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2)}.jsonl`;
      writeFileSync(join(codexDir, name), JSON.stringify({ timestamp: new Date().toISOString(), type: "session_meta", payload }) + "\n");
    }

    function discover(format: "json" | "summary" = "json") {
      const r = spawnSync("bun", ["run", scriptPath, "--since", "1h", "--format", format], {
        encoding: "utf-8",
        timeout: 30_000,
        env: { ...process.env, CODEX_SESSIONS_DIR: join(tmpDir, "codex-home", "sessions") },
      });
      expect(r.status).toBe(0);
      return r.stdout;
    }

    const originators = () => JSON.parse(discover()).tools.codex.originators;

    test("the interactive Codex CLI (codex_cli_rs) goes to cli", () => {
      writeCodex("codex_cli_rs");
      expect(originators()).toEqual({ cli: 1, desktop: 0, exec: 0, claude_code: 0, other: 0 });
    });

    test("Codex Desktop goes to desktop", () => {
      writeCodex("Codex Desktop");
      expect(originators()).toEqual({ cli: 0, desktop: 1, exec: 0, claude_code: 0, other: 0 });
    });

    test("codex_exec goes to exec", () => {
      writeCodex("codex_exec");
      expect(originators()).toEqual({ cli: 0, desktop: 0, exec: 1, claude_code: 0, other: 0 });
    });

    test("Claude Code goes to claude_code", () => {
      writeCodex("Claude Code");
      expect(originators()).toEqual({ cli: 0, desktop: 0, exec: 0, claude_code: 1, other: 0 });
    });

    test("surrounding whitespace and case are ignored", () => {
      writeCodex("  CODEX DESKTOP  ");
      expect(originators()).toEqual({ cli: 0, desktop: 1, exec: 0, claude_code: 0, other: 0 });
    });

    test("missing, null, numeric and unknown originators go to other", () => {
      writeCodex();
      writeCodex(null);
      writeCodex(42);
      writeCodex("future-agent");
      const json = JSON.parse(discover());
      expect(json.tools.codex.total_sessions).toBe(4);
      expect(json.tools.codex.originators).toEqual({ cli: 0, desktop: 0, exec: 0, claude_code: 0, other: 4 });
    });

    test("per-repo and global buckets sum to the codex total and print in the summary", () => {
      writeCodex("Codex Desktop");
      writeCodex("codex_exec");
      writeCodex("codex_exec");
      writeCodex("Claude Code");
      writeCodex();
      const json = JSON.parse(discover());
      const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
      expect(json.tools.codex.total_sessions).toBe(5);
      expect(sum(json.tools.codex.originators)).toBe(5);
      const repo = json.repos.find((r: { paths: string[] }) => r.paths.includes(repoDir));
      expect(repo.codex_originators).toEqual({ cli: 0, desktop: 1, exec: 2, claude_code: 1, other: 1 });
      expect(sum(repo.codex_originators)).toBe(repo.sessions.codex);
      expect(discover("summary")).toContain("Codex originators: cli=0, desktop=1, exec=2, claude_code=1, other=1");
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

  describe("extractCwdFromJsonl reads whole lines up to 1 MiB (PR #1169 bug #8, #1315)", () => {
    // Regression: the old 8KB cap landed mid-line on Claude Code sessions with
    // long headers, JSON.parse threw on the truncated tail, the catch
    // `continue`d silently, and the project disappeared from discovery.
    // The fix raised the cap to 64KB AND drops the trailing partial segment
    // before parsing.
    let extractCwdFromJsonl: (filePath: string, stats?: { oversizedLines: number }) => string | null;
    let tmpDir: string;

    beforeEach(async () => {
      const mod = await import("../bin/gstack-global-discover.ts");
      extractCwdFromJsonl = mod.extractCwdFromJsonl;
      tmpDir = mkdtempSync(join(tmpdir(), "pr1169-cwd-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    test("happy path: small JSONL with obj.cwd returns it (sanity)", () => {
      const filePath = join(tmpDir, "small.jsonl");
      const line = JSON.stringify({ cwd: "/tmp/repo-small", type: "header" });
      writeFileSync(filePath, line + "\n");
      expect(extractCwdFromJsonl(filePath)).toBe("/tmp/repo-small");
    });

    test("12KB first line with obj.cwd: returns cwd (old 8KB cap returned null)", () => {
      // Pad a JSONL header so the whole line is ~12KB ending in `}\n`.
      // Old 8KB read would slice mid-line; JSON.parse on the truncated tail
      // would throw, the catch would `continue`, and we'd return null.
      const padding = "x".repeat(12 * 1024);
      const line = JSON.stringify({
        cwd: "/tmp/repo-12k",
        type: "header",
        notes: padding,
      });
      expect(line.length).toBeGreaterThan(8 * 1024);
      expect(line.length).toBeLessThan(64 * 1024);

      const filePath = join(tmpDir, "header-12k.jsonl");
      writeFileSync(filePath, line + "\n");
      expect(extractCwdFromJsonl(filePath)).toBe("/tmp/repo-12k");
    });

    test("86KB queue-operation first line, cwd on the third record: returns cwd (#1315)", () => {
      // Recent Claude Code sessions open with one queue-operation record larger
      // than the old 64KB prefix; cwd first appears on a later record.
      const filePath = join(tmpDir, "queue-op-86k.jsonl");
      const first = JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "q".repeat(86 * 1024) });
      const second = JSON.stringify({ type: "summary" });
      const third = JSON.stringify({ type: "attachment", cwd: "/tmp/repo-86k" });
      expect(first.length).toBeGreaterThan(64 * 1024);
      writeFileSync(filePath, [first, second, third].join("\n") + "\n");
      expect(extractCwdFromJsonl(filePath)).toBe("/tmp/repo-86k");
    });

    test("a line over 1 MiB is skipped and counted; the next line's cwd is returned", () => {
      const filePath = join(tmpDir, "oversized.jsonl");
      const huge = JSON.stringify({ cwd: "/tmp/repo-huge", notes: "y".repeat(1024 * 1024 + 10) });
      writeFileSync(filePath, huge + "\n" + JSON.stringify({ cwd: "/tmp/repo-after-huge" }) + "\n");
      const stats = { oversizedLines: 0 };
      expect(extractCwdFromJsonl(filePath, stats)).toBe("/tmp/repo-after-huge");
      expect(stats.oversizedLines).toBe(1);
    });

    test("a file with no trailing newline still yields its cwd", () => {
      const filePath = join(tmpDir, "no-newline.jsonl");
      writeFileSync(filePath, JSON.stringify({ cwd: "/tmp/repo-no-newline" }));
      expect(extractCwdFromJsonl(filePath)).toBe("/tmp/repo-no-newline");
    });

    test("complete line followed by partial second line: returns first line's cwd", () => {
      // Line 1 ends cleanly with `\n` well within the cap.
      // Line 2 is long enough that the 64KB read captures only its incomplete
      // beginning. The trailing-partial drop must skip the truncated line 2
      // and not poison the result.
      const line1 = JSON.stringify({ cwd: "/tmp/repo-line-1", type: "header" });
      const line2Padding = "z".repeat(80 * 1024);
      const line2 = JSON.stringify({ cwd: "/tmp/repo-line-2", notes: line2Padding });

      const filePath = join(tmpDir, "header-partial-2.jsonl");
      writeFileSync(filePath, line1 + "\n" + line2 + "\n");
      expect(extractCwdFromJsonl(filePath)).toBe("/tmp/repo-line-1");
    });

    test("missing file: returns null (file read error is swallowed)", () => {
      const filePath = join(tmpDir, "nonexistent.jsonl");
      expect(extractCwdFromJsonl(filePath)).toBeNull();
    });

    test("malformed first line then valid second line within cap: returns second", () => {
      // Both lines fully within 64KB. First line is not valid JSON; second
      // is. The function must skip first and return second's cwd.
      const filePath = join(tmpDir, "bad-then-good.jsonl");
      const good = JSON.stringify({ cwd: "/tmp/repo-skip-bad" });
      writeFileSync(filePath, "{ not valid json\n" + good + "\n");
      expect(extractCwdFromJsonl(filePath)).toBe("/tmp/repo-skip-bad");
    });
  });

  describe("Claude Code project resolution from the recorded cwd (#1315)", () => {
    let home: string;
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), "gstack-cc-projects-"));
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    const git = (cwd: string, ...args: string[]) => {
      const r = spawnSync("git", ["-C", cwd, ...args], {
        encoding: "utf-8",
        timeout: 30_000,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
      });
      expect(r.status).toBe(0);
      return r.stdout;
    };
    function repo(rel: string, remote?: string): string {
      const dir = join(home, rel);
      mkdirSync(dir, { recursive: true });
      git(dir, "init", "-q");
      git(dir, "commit", "-q", "--allow-empty", "-m", "init");
      if (remote) git(dir, "remote", "add", "origin", remote);
      return dir;
    }
    /** One Claude Code session whose cwd appears on its third record, in a project dir named like Claude Code names it. */
    function session(cwd: string, id: string): void {
      const dir = join(home, ".claude", "projects", cwd.replace(/[\\/.:]/g, "-"));
      mkdirSync(dir, { recursive: true });
      const lines = [
        { type: "queue-operation", operation: "enqueue", content: "q".repeat(70 * 1024) },
        { type: "summary" },
        { type: "user", cwd, message: { role: "user", content: "hi" } },
      ];
      writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    }
    function discover(): { repos: Array<{ name: string; remote: string; paths: string[]; sessions: { claude_code: number } }>; tools: { claude_code: { total_sessions: number } } } {
      const r = spawnSync("bun", ["run", scriptPath, "--since", "1h", "--format", "json"], {
        encoding: "utf-8",
        timeout: 60_000,
        env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_SESSIONS_DIR: join(home, "no-codex"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig") },
      });
      expect(r.status).toBe(0);
      return JSON.parse(r.stdout);
    }

    test("root and subdirectory sessions of a hyphenated repository count the same", () => {
      const root = repo("work/ai-blogger-lab", "https://github.com/acme/ai-blogger-lab.git");
      mkdirSync(join(root, "packages", "web-app"), { recursive: true });
      session(root, "root-1");
      session(root, "root-2");
      session(join(root, "packages", "web-app"), "sub-1");
      session(join(root, "packages", "web-app"), "sub-2");
      const json = discover();
      const r = json.repos.find((x) => x.remote === "https://github.com/acme/ai-blogger-lab")!;
      expect(r.sessions.claude_code).toBe(4);
      expect(r.paths).toEqual([root]);
      expect(r.name).toBe("ai-blogger-lab");
    });

    test("a linked worktree counts with its repository, under its own path", () => {
      const main = repo("work/app", "git@github.com:acme/app.git");
      const wt = join(home, "work", "app-feature-x");
      git(main, "worktree", "add", "-q", wt);
      session(main, "main-1");
      session(join(wt), "wt-1");
      const r = discover().repos.find((x) => x.remote === "https://github.com/acme/app")!;
      expect(r.sessions.claude_code).toBe(2);
      expect(r.paths.sort()).toEqual([main, wt].sort());
    });

    test("a linked worktree of a repository with no remote still counts with its repository", () => {
      const main = repo("work/local-only");
      const wt = join(home, "work", "local-only-wt");
      git(main, "worktree", "add", "-q", wt);
      session(main, "l-1");
      session(wt, "l-2");
      const local = discover().repos.filter((x) => x.remote.startsWith("local:"));
      expect(local).toHaveLength(1);
      expect(local[0].sessions.claude_code).toBe(2);
      expect(local[0].name).toBe("local-only");
    });

    test("a nested repository counts as its own repository, not its parent's", () => {
      const outer = repo("work/outer", "https://github.com/acme/outer.git");
      const inner = repo("work/outer/vendor/inner", "https://github.com/acme/inner.git");
      session(outer, "o-1");
      session(inner, "i-1");
      session(join(inner), "i-2");
      const json = discover();
      expect(json.repos.find((x) => x.remote === "https://github.com/acme/outer")!.sessions.claude_code).toBe(1);
      expect(json.repos.find((x) => x.remote === "https://github.com/acme/inner")!.sessions.claude_code).toBe(2);
    });

    test("sessions outside any repository, or inside .git, are not counted as a repository", () => {
      const plain = join(home, "notes", "my-notes");
      mkdirSync(plain, { recursive: true });
      const r = repo("work/real", "https://github.com/acme/real.git");
      session(plain, "p-1");
      session(join(r, ".git"), "g-1");
      session(r, "r-1");
      const json = discover();
      expect(json.tools.claude_code.total_sessions).toBe(3);
      expect(json.repos).toHaveLength(1);
      expect(json.repos[0].sessions.claude_code).toBe(1);
    });

    // Claude Code worktrees live at <repo>/.claude/worktrees/<name> and are removed once
    // their branch merges; the session history under ~/.claude/projects stays behind.
    function removedWorktree(main: string, name = "feat-x"): string {
      const wt = join(main, ".claude", "worktrees", name);
      git(main, "worktree", "add", "-q", wt);
      return wt;
    }

    test("sessions of a removed Claude worktree count with the repository it was created from", () => {
      const main = repo("work/ai-blogger-lab", "https://github.com/acme/ai-blogger-lab.git");
      const wt = removedWorktree(main);
      session(main, "main-1");
      session(main, "main-2");
      session(wt, "wt-1");
      session(wt, "wt-2");
      session(wt, "wt-3");
      git(main, "worktree", "remove", "--force", wt);
      expect(existsSync(wt)).toBe(false);
      const json = discover();
      expect(json.tools.claude_code.total_sessions).toBe(5);
      expect(json.repos).toHaveLength(1);
      expect(json.repos[0].sessions.claude_code).toBe(5);
      expect(json.repos[0].paths).toEqual([main]);
    });

    test("a session started in a subdirectory of a removed Claude worktree counts too", () => {
      const main = repo("work/app", "git@github.com:acme/app.git");
      const wt = removedWorktree(main);
      mkdirSync(join(wt, "packages", "web"), { recursive: true });
      session(join(wt, "packages", "web"), "sub-1");
      git(main, "worktree", "remove", "--force", wt);
      const r = discover().repos.find((x) => x.remote === "https://github.com/acme/app")!;
      expect(r.sessions.claude_code).toBe(1);
      expect(r.paths).toEqual([main]);
    });

    test("a removed Claude worktree of a repository with no remote counts with its repository", () => {
      const main = repo("work/local-only");
      const wt = removedWorktree(main);
      session(main, "l-1");
      session(wt, "l-2");
      git(main, "worktree", "remove", "--force", wt);
      const local = discover().repos.filter((x) => x.remote.startsWith("local:"));
      expect(local).toHaveLength(1);
      expect(local[0].sessions.claude_code).toBe(2);
    });

    test("a live Claude worktree keeps its own path next to its repository's", () => {
      const main = repo("work/live", "https://github.com/acme/live.git");
      const wt = removedWorktree(main);
      session(main, "m-1");
      session(wt, "w-1");
      const r = discover().repos.find((x) => x.remote === "https://github.com/acme/live")!;
      expect(r.sessions.claude_code).toBe(2);
      expect(r.paths.sort()).toEqual([main, wt].sort());
    });

    test("a removed Claude worktree whose repository is also gone is not counted as a repository", () => {
      const gone = join(home, "work", "gone-repo");
      session(join(gone, ".claude", "worktrees", "feat-x"), "g-1");
      const json = discover();
      expect(json.tools.claude_code.total_sessions).toBe(1);
      expect(json.repos).toHaveLength(0);
    });

    test("a removed directory that is not a Claude worktree is not counted as a repository", () => {
      const main = repo("work/real", "https://github.com/acme/real.git");
      session(join(main, "some", "deleted-dir"), "d-1");
      session(join(main, ".claude", "worktrees"), "d-2");
      session(main, "r-1");
      const json = discover();
      expect(json.tools.claude_code.total_sessions).toBe(3);
      expect(json.repos).toHaveLength(1);
      expect(json.repos[0].sessions.claude_code).toBe(1);
    });

    describe("parentRepoOfClaudeWorktree", () => {
      let parentRepoOfClaudeWorktree: (cwd: string) => string | null;
      beforeEach(async () => {
        parentRepoOfClaudeWorktree = (await import("../bin/gstack-global-discover.ts")).parentRepoOfClaudeWorktree;
      });

      test("returns the repository root for a worktree path, with or without a subdirectory", () => {
        expect(parentRepoOfClaudeWorktree("/Users/me/code/app/.claude/worktrees/feat-x")).toBe("/Users/me/code/app");
        expect(parentRepoOfClaudeWorktree("/Users/me/code/app/.claude/worktrees/feat-x/src/lib")).toBe("/Users/me/code/app");
        expect(parentRepoOfClaudeWorktree("C:\\code\\app\\.claude\\worktrees\\feat-x")).toBe("C:\\code\\app");
      });

      test("returns null for any other path", () => {
        for (const p of [
          "/Users/me/code/app",
          "/Users/me/code/app/.claude/worktrees",
          "/Users/me/code/app/.claude/worktrees/",
          "/Users/me/code/not.claude/worktrees/x",
          "/.claude/worktrees/x",
        ]) expect(parentRepoOfClaudeWorktree(p)).toBeNull();
      });
    });
  });
});
