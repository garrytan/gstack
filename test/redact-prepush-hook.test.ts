/**
 * Pre-push hook tests (T9). Builds a throwaway local "remote" + working repo,
 * drives the hook with realistic stdin ref-lines, and checks: HIGH blocks,
 * MEDIUM warns (non-blocking), correct remote..local diff direction, new-branch
 * zero-SHA handling, branch-delete skip, escape valve, and hook chaining.
 *
 * We invoke bin/gstack-redact-prepush directly with the git pre-push stdin
 * protocol rather than going through `git push`, which keeps the test fast and
 * deterministic while exercising the exact code path git would.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

const PREPUSH = path.resolve(import.meta.dir, "..", "bin", "gstack-redact-prepush");
const REDACT = path.resolve(import.meta.dir, "..", "bin", "gstack-redact");

let repo: string;

function git(args: string[], cwd = repo): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.stdout?.trim() ?? "";
}

function commit(file: string, content: string, msg: string): string {
  fs.writeFileSync(path.join(repo, file), content);
  git(["add", file]);
  git(["commit", "-q", "-m", msg]);
  return git(["rev-parse", "HEAD"]);
}

function runHook(
  stdinLines: string,
  env: Record<string, string> = {},
): { code: number; stderr: string } {
  const r = spawnSync("bun", [PREPUSH], {
    cwd: repo,
    input: Buffer.from(stdinLines),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status ?? 0, stderr: r.stderr ?? "" };
}

const ZERO = "0000000000000000000000000000000000000000";

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "prepush-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "T"]);
  commit("README.md", "hello\n", "init");
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("pre-push hook gating", () => {
  test("HIGH credential in pushed diff blocks (exit 1)", () => {
    const base = git(["rev-parse", "HEAD"]);
    const head = commit("config.txt", "key AKIA1234567890ABCDEF\n", "add key");
    const { code, stderr } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(code).toBe(1);
    expect(stderr).toContain("BLOCKED");
    expect(stderr).toContain("aws.access_key");
  });

  test("clean diff passes (exit 0)", () => {
    const base = git(["rev-parse", "HEAD"]);
    const head = commit("doc.md", "just documentation\n", "add doc");
    const { code } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(code).toBe(0);
  });

  test("MEDIUM warns but does not block", () => {
    const base = git(["rev-parse", "HEAD"]);
    const head = commit("notes.md", "contact bob@corp.io\n", "add note");
    const { code, stderr } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(code).toBe(0);
    expect(stderr).toContain("MEDIUM");
  });
});

describe("diff direction + special refs", () => {
  test("only NEW content is scanned (remote..local), not pre-existing", () => {
    // Put a secret in the FIRST commit (already on remote), then push a clean commit.
    const withSecret = commit("old.txt", "AKIA1234567890ABCDEF\n", "old secret already pushed");
    const clean = commit("new.txt", "totally clean\n", "new clean commit");
    // remote already has withSecret; we push only the clean commit on top.
    const { code } = runHook(`refs/heads/main ${clean} refs/heads/main ${withSecret}\n`);
    expect(code).toBe(0); // pre-existing secret is not in the pushed delta
  });

  test("new branch (zero remote sha) scans commits unique to the branch", () => {
    const head = commit("feature.txt", "ghp_" + "a".repeat(36) + "\n", "feature with token");
    const { code, stderr } = runHook(`refs/heads/feat ${head} refs/heads/feat ${ZERO}\n`);
    expect(code).toBe(1);
    expect(stderr).toContain("github.pat");
  });

  test("branch delete (zero local sha) is skipped", () => {
    const { code } = runHook(`(delete) ${ZERO} refs/heads/old ${git(["rev-parse", "HEAD"])}\n`);
    expect(code).toBe(0);
  });
});

describe("escape valve", () => {
  test("GSTACK_REDACT_PREPUSH=skip bypasses + logs", () => {
    const base = git(["rev-parse", "HEAD"]);
    const head = commit("config.txt", "key AKIA1234567890ABCDEF\n", "add key");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ghome-"));
    const { code } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`, {
      GSTACK_REDACT_PREPUSH: "skip",
      GSTACK_HOME: home,
    });
    expect(code).toBe(0);
    const log = fs.readFileSync(path.join(home, "security", "prepush-skip.jsonl"), "utf8");
    expect(log).toContain("env-skip");
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("install / chaining", () => {
  test("install creates a managed hook; existing hook preserved + chained", () => {
    const hookDir = path.join(repo, ".git", "hooks");
    fs.mkdirSync(hookDir, { recursive: true });
    const existing = path.join(hookDir, "pre-push");
    fs.writeFileSync(existing, "#!/usr/bin/env bash\necho mine\n", { mode: 0o755 });

    const r = spawnSync("bun", [REDACT, "install-prepush-hook"], { cwd: repo, encoding: "utf8" });
    expect(r.status).toBe(0);
    const installed = fs.readFileSync(existing, "utf8");
    expect(installed).toContain("gstack-redact pre-push (managed)");
    expect(fs.existsSync(path.join(hookDir, "pre-push.local"))).toBe(true);
    expect(fs.readFileSync(path.join(hookDir, "pre-push.local"), "utf8")).toContain("echo mine");
  });

  test("uninstall restores the chained original", () => {
    const hookDir = path.join(repo, ".git", "hooks");
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(path.join(hookDir, "pre-push"), "#!/usr/bin/env bash\necho mine\n", {
      mode: 0o755,
    });
    spawnSync("bun", [REDACT, "install-prepush-hook"], { cwd: repo });
    spawnSync("bun", [REDACT, "uninstall-prepush-hook"], { cwd: repo });
    const restored = fs.readFileSync(path.join(hookDir, "pre-push"), "utf8");
    expect(restored).toContain("echo mine");
    expect(restored).not.toContain("managed");
  });
});
