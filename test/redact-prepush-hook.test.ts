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

describe("fail closed on unscannable diffs (#1946)", () => {
  test("a diff git cannot compute BLOCKS the push and names the escape valve", () => {
    // Bogus-but-well-formed SHAs: git diff exits non-zero, the old git()
    // helper returned "" and the push sailed through unscanned.
    const bogusLocal = "a".repeat(40);
    const bogusRemote = "b".repeat(40);
    const { code, stderr } = runHook(
      `refs/heads/main ${bogusLocal} refs/heads/main ${bogusRemote}\n`,
    );
    expect(code).toBe(1);
    expect(stderr).toContain("could not compute the pushed diff");
    expect(stderr).toContain("GSTACK_REDACT_PREPUSH=skip");
  });

  test("an empty-but-successful diff still passes (no-op push)", () => {
    const head = git(["rev-parse", "HEAD"]);
    // remote == local: diff succeeds and is empty — must NOT block.
    const { code } = runHook(`refs/heads/main ${head} refs/heads/main ${head}\n`);
    expect(code).toBe(0);
  });

  test("a remote sha absent locally (shallow clone / stale fetch) falls back to scanning MORE, not blocking", () => {
    // Adversarial review finding 8: remote..local can't resolve when the
    // remote tip object isn't in the local odb. The fallback scans the
    // merge-base/empty-tree range — a secret in the pushed content still
    // blocks; a clean push passes instead of hard-failing.
    const fakeRemoteSha = "c".repeat(40);
    const head = commit("secrets.txt", "key AKIA1234567890ABCDEF\n", "leaky commit");
    const { code, stderr } = runHook(`refs/heads/main ${head} refs/heads/main ${fakeRemoteSha}\n`);
    expect(code).toBe(1); // fallback range still catches the credential
    expect(stderr).toContain("aws.access_key");
    expect(stderr).not.toContain("could not compute the pushed diff");
  });

  test("a diff killed by a signal (null status — the maxBuffer/kill class) BLOCKS", () => {
    // Stub git: probes delegate to the real git; the diff invocation kills
    // itself, producing spawnSync status === null. This is the exact branch
    // gitStrict's docstring names (oversized-diff overflow is delivered the
    // same way) — pre-landing review flagged it as untested.
    const realGit = Bun.which("git") || "/usr/bin/git";
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "prepush-stubgit-"));
    try {
      const stub = `#!/bin/sh\nif [ "$1" = "diff" ]; then kill -KILL $$; fi\nexec "${realGit}" "$@"\n`;
      fs.writeFileSync(path.join(stubDir, "git"), stub);
      fs.chmodSync(path.join(stubDir, "git"), 0o755);

      const base = git(["rev-parse", "HEAD"]);
      const head = commit("clean.txt", "clean content\n", "clean commit");
      const { code, stderr } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`, {
        PATH: `${stubDir}:${process.env.PATH}`,
      });
      expect(code).toBe(1);
      expect(stderr).toContain("could not compute the pushed diff");
      expect(stderr).toContain("GSTACK_REDACT_PREPUSH=skip");
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });
});

describe("install UX surfaces (#1946 / eng review D3+D10)", () => {
  const ROOT = path.resolve(import.meta.dir, "..");

  test("setup carries the hint only — never a per-repo install (it runs in the wrong repo)", () => {
    const setup = fs.readFileSync(path.join(ROOT, "setup"), "utf8");
    expect(setup).toContain("redact_prepush_hook");
    // The hint must not invoke the installer from setup.
    expect(setup).not.toContain("install-prepush-hook");
  });

  test("ship template owns per-repo install: silent-install path + one-time offer marker", () => {
    const tmpl = fs.readFileSync(path.join(ROOT, "ship", "SKILL.md.tmpl"), "utf8");
    expect(tmpl).toContain("install-prepush-hook");
    expect(tmpl).toContain(".redact-prepush-prompted");
    expect(tmpl).toContain("redact_prepush_hook");
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

describe("path-ignore for generated data files (#1946 follow-up)", () => {
  // A blob larger than the engine's 1 MiB scan cap. Without an ignore rule this
  // trips a false-positive HIGH engine.input_too_large and blocks the push.
  const BIG = "x,y\n".repeat(400_000); // ~1.5 MiB

  function writeIgnoreFile(globs: string): void {
    fs.mkdirSync(path.join(repo, ".gstack"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".gstack", "redact-prepush-ignore"), globs);
  }

  test("(a) an ignored large file passes, and the skip is reported on stderr", () => {
    writeIgnoreFile("# generated exports\nprospecting/exports/**/*.csv\n");
    const base = git(["rev-parse", "HEAD"]);
    fs.mkdirSync(path.join(repo, "prospecting", "exports", "CA"), { recursive: true });
    fs.writeFileSync(path.join(repo, "prospecting", "exports", "CA", "suspects-1.csv"), BIG);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "big export + ignore rule"]);
    const head = git(["rev-parse", "HEAD"]);
    const { code, stderr } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(code).toBe(0);
    expect(stderr).toContain("skipped 1 path(s)");
    expect(stderr).toContain("suspects-1.csv");
    expect(stderr).toContain(".gstack/redact-prepush-ignore");
  });

  test("(b) a non-ignored large file still blocks fail-closed", () => {
    writeIgnoreFile("prospecting/exports/**/*.csv\n");
    const base = git(["rev-parse", "HEAD"]);
    // Matches no ignore glob → must still oversize-block.
    fs.writeFileSync(path.join(repo, "bigdata.txt"), BIG);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "big non-ignored file"]);
    const head = git(["rev-parse", "HEAD"]);
    const { code, stderr } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(code).toBe(1);
    expect(stderr).toContain("BLOCKED");
    expect(stderr).toContain("engine.input_too_large");
  });

  test("(c) a real secret in a non-ignored file still blocks even with ignore rules present", () => {
    writeIgnoreFile("prospecting/exports/**/*.csv\n");
    const base = git(["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(repo, "config.env"), "key AKIA1234567890ABCDEF\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "secret in code"]);
    const head = git(["rev-parse", "HEAD"]);
    const { code, stderr } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(code).toBe(1);
    expect(stderr).toContain("BLOCKED");
    expect(stderr).toContain("aws.access_key");
  });

  test("(d) an explicit ignore glob exempts its file even when it holds a secret (auditable opt-in)", () => {
    // The tradeoff is intentional and loud: an ignore glob is a versioned,
    // reviewable opt-in, and the skip is always reported. Anything NOT matched
    // stays fail-closed (see tests b + c).
    writeIgnoreFile("prospecting/exports/**/*.csv\n");
    const base = git(["rev-parse", "HEAD"]);
    fs.mkdirSync(path.join(repo, "prospecting", "exports", "CA"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "prospecting", "exports", "CA", "x.csv"),
      "AKIA1234567890ABCDEF\n",
    );
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "secret inside ignored export"]);
    const head = git(["rev-parse", "HEAD"]);
    const { code, stderr } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(code).toBe(0);
    expect(stderr).toContain("skipped 1 path(s)");
    expect(stderr).not.toContain("aws.access_key");
  });

  test("(e) the machine-local config key is an additional ignore source", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ghome-cfg-"));
    const cfg = path.resolve(import.meta.dir, "..", "bin", "gstack-config");
    spawnSync(cfg, ["set", "redact_prepush_ignore_globs", "data/**/*.parquet"], {
      env: { ...process.env, GSTACK_HOME: home },
    });
    const base = git(["rev-parse", "HEAD"]);
    fs.mkdirSync(path.join(repo, "data"), { recursive: true });
    fs.writeFileSync(path.join(repo, "data", "big.parquet"), BIG);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "big parquet, no committed ignore file"]);
    const head = git(["rev-parse", "HEAD"]);
    const { code, stderr } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`, {
      GSTACK_HOME: home,
    });
    expect(code).toBe(0);
    expect(stderr).toContain("skipped 1 path(s)");
    expect(stderr).toContain("big.parquet");
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("(f) no ignore rules → default behavior unchanged (large file blocks)", () => {
    const base = git(["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(repo, "export.csv"), BIG);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "big csv, no ignore rules"]);
    const head = git(["rev-parse", "HEAD"]);
    const { code, stderr } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(code).toBe(1);
    expect(stderr).toContain("engine.input_too_large");
    expect(stderr).not.toContain("skipped");
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
