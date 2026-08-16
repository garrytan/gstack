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

// Assembled at runtime so the LITERAL never appears in a pushed diff — the
// repo's own pre-push scanner (correctly) blocks live-format AWS key shapes,
// and the placeholder-suppressed docs key would defeat these detection tests.
const FAKE_AWS_KEY = ['AKIA', '1234567890ABCDEF'].join('');


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
    const head = commit("config.txt", "key " + FAKE_AWS_KEY + "\n", "add key");
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

describe("repo allowlist (.gstack-redact-allowlist)", () => {
  // Mutation check (documented per gate doctrine): drop `allowlist` from the
  // scan opts in bin/gstack-redact-prepush and the first, third, and last tests
  // here go RED (the HIGH blocks again / the MEDIUM warns again); stub
  // loadRepoAllowlist to return [] and the same three fail. Delete the
  // suppression notice and the second test fails.
  const allowlist = (content: string) =>
    fs.writeFileSync(path.join(repo, ".gstack-redact-allowlist"), content);

  test("an allowlisted HIGH span passes instead of blocking", () => {
    const base = git(["rev-parse", "HEAD"]);
    const head = commit("config.txt", "key " + FAKE_AWS_KEY + "\n", "add key");
    allowlist(FAKE_AWS_KEY + "\n");
    const { code, stderr } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(code).toBe(0);
    expect(stderr).not.toContain("BLOCKED");
  });

  test("suppression is REPORTED, never silent", () => {
    const base = git(["rev-parse", "HEAD"]);
    const head = commit("config.txt", "key " + FAKE_AWS_KEY + "\n", "add key");
    allowlist("# reviewed 2026-08-16: docs sample key\n" + FAKE_AWS_KEY + "\n");
    const { stderr } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(stderr).toContain("1 finding(s) suppressed by .gstack-redact-allowlist");
  });

  test("only the exact span is cleared — a different credential still blocks", () => {
    const base = git(["rev-parse", "HEAD"]);
    const otherKey = ["AKIA", "FEDCBA0987654321"].join("");
    const head = commit(
      "config.txt",
      "ok " + FAKE_AWS_KEY + "\nleak " + otherKey + "\n",
      "one benign one real",
    );
    allowlist(FAKE_AWS_KEY + "\n");
    const { code, stderr } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(code).toBe(1);
    expect(stderr).toContain("aws.access_key");
  });

  test("comments and blank lines are ignored; entries are trimmed", () => {
    const base = git(["rev-parse", "HEAD"]);
    const head = commit("notes.md", "contact bob@corp.io\n", "add note");
    allowlist("# team contact, public in README\n\n  bob@corp.io  \n");
    const { code, stderr } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(code).toBe(0);
    expect(stderr).not.toContain("MEDIUM");
  });

  test("pushing the allowlist file itself does not block on its own entries", () => {
    // The bootstrap flow: the entry string appears verbatim in the pushed diff
    // of the allowlist file. Its own entry must suppress it.
    const base = git(["rev-parse", "HEAD"]);
    const head = commit(
      ".gstack-redact-allowlist",
      "# dev-only sample key\n" + FAKE_AWS_KEY + "\n",
      "add allowlist",
    );
    const { code } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(code).toBe(0);
  });

  test("an oversized allowlist file is ignored — scan stays STRICT, push not hard-blocked by the file", () => {
    const base = git(["rev-parse", "HEAD"]);
    const head = commit("config.txt", "key " + FAKE_AWS_KEY + "\n", "add key");
    allowlist(FAKE_AWS_KEY + "\n" + "#".repeat(65 * 1024) + "\n");
    const { code, stderr } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(code).toBe(1); // entry NOT honored: strict scan still blocks the HIGH
    expect(stderr).toContain(".gstack-redact-allowlist exceeds");
  });

  test("the block message names the allowlist as the recorded resolution path", () => {
    const base = git(["rev-parse", "HEAD"]);
    const head = commit("config.txt", "key " + FAKE_AWS_KEY + "\n", "add key");
    const { code, stderr } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(code).toBe(1);
    expect(stderr).toContain(".gstack-redact-allowlist");
    expect(stderr).toContain("Do NOT restructure code");
  });
});

describe("diff direction + special refs", () => {
  test("only NEW content is scanned (remote..local), not pre-existing", () => {
    // Put a secret in the FIRST commit (already on remote), then push a clean commit.
    const withSecret = commit("old.txt", FAKE_AWS_KEY + "\n", "old secret already pushed");
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
    const head = commit("secrets.txt", "key " + FAKE_AWS_KEY + "\n", "leaky commit");
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
    const head = commit("config.txt", "key " + FAKE_AWS_KEY + "\n", "add key");
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

  // Regression: `_input="$(cat)"` strips the trailing newline, so a chained
  // shell hook using `while read` never entered its loop body for the final
  // (usually only) ref line — it saw zero refs and exited 0, failing OPEN.
  test("chained pre-push.local receives the final ref line (trailing newline preserved)", () => {
    const hookDir = path.join(repo, ".git", "hooks");
    fs.mkdirSync(hookDir, { recursive: true });
    spawnSync("bun", [REDACT, "install-prepush-hook"], { cwd: repo });

    const seen = path.join(repo, "seen.txt");
    fs.writeFileSync(
      path.join(hookDir, "pre-push.local"),
      `#!/usr/bin/env bash\nwhile read -r a b c d; do echo "$a $b $c $d" >> ${JSON.stringify(seen)}; done\nexit 0\n`,
      { mode: 0o755 },
    );

    const sha = "a".repeat(40);
    const line = `refs/heads/main ${sha} refs/heads/main ${ZERO}\n`;
    const r = spawnSync("bash", [path.join(hookDir, "pre-push")], {
      cwd: repo,
      input: Buffer.from(line),
      encoding: "utf8",
      env: { ...process.env, GSTACK_REDACT_PREPUSH: "skip" },
    });
    expect(r.status).toBe(0);
    expect(fs.existsSync(seen)).toBe(true);
    expect(fs.readFileSync(seen, "utf8").trim()).toBe(
      `refs/heads/main ${sha} refs/heads/main ${ZERO}`,
    );
  });

  test("a blocking pre-push.local still short-circuits the push", () => {
    const hookDir = path.join(repo, ".git", "hooks");
    fs.mkdirSync(hookDir, { recursive: true });
    spawnSync("bun", [REDACT, "install-prepush-hook"], { cwd: repo });
    fs.writeFileSync(
      path.join(hookDir, "pre-push.local"),
      "#!/usr/bin/env bash\nwhile read -r _a _b _c _d || [ -n \"${_a:-}\" ]; do exit 1; done\nexit 0\n",
      { mode: 0o755 },
    );
    const r = spawnSync("bash", [path.join(hookDir, "pre-push")], {
      cwd: repo,
      input: Buffer.from(`refs/heads/main ${"b".repeat(40)} refs/heads/main ${ZERO}\n`),
      encoding: "utf8",
      env: { ...process.env, GSTACK_REDACT_PREPUSH: "skip" },
    });
    expect(r.status).toBe(1);
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

describe("base resolution when the default branch is neither main nor master", () => {
  test("a new branch scans its own commits, not the whole repository", () => {
    // The remote's default branch is `trunk` and origin/HEAD is unset, so
    // defaultRemoteBranch() falls through to `origin/main` — a ref that does
    // not exist — and merge-base fails. The EMPTY_TREE fallback then treats the
    // WHOLE repository as added lines, re-scanning history that is already on
    // the remote. Two consequences, both bad: a secret long since pushed gets
    // re-reported as if this push introduced it, and on any real repository the
    // input blows past the engine's byte cap, so `engine.input_too_large`
    // blocks the push having scanned NOTHING — the "scans more, never less"
    // fallback inverting into "scans nothing".
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "prepush-remote-"));
    spawnSync("git", ["init", "-q", "--bare", "-b", "trunk", bare]);

    git(["branch", "-M", "trunk"]);
    const old = commit("legacy.txt", FAKE_AWS_KEY + "\n", "secret already on the remote");
    git(["remote", "add", "origin", bare]);
    git(["push", "-q", "origin", "trunk"]);

    // The remote HAS the old commit, and the default-branch guess is unresolvable.
    expect(git(["rev-parse", "origin/trunk"])).toBe(old);
    expect(git(["rev-parse", "--verify", "origin/main"])).toBe("");
    expect(git(["symbolic-ref", "refs/remotes/origin/HEAD"])).toBe("");

    git(["checkout", "-q", "-b", "feat"]);
    const head = commit("feature.txt", "totally clean\n", "clean feature commit");

    const { code, stderr } = runHook(`refs/heads/feat ${head} refs/heads/feat ${ZERO}\n`);
    fs.rmSync(bare, { recursive: true, force: true });

    // The only NEW content is a clean file. The already-pushed secret must not
    // be attributed to this push.
    expect(stderr).not.toContain("aws.access_key");
    expect(code).toBe(0);
  });

  test("a genuinely new repository with no remote refs still scans everything", () => {
    // Nothing is on any remote, so every commit IS new content: scanning the
    // full history is correct here. The narrowing must not open a hole in the
    // case the EMPTY_TREE fallback exists for.
    const head = commit("secrets.txt", FAKE_AWS_KEY + "\n", "secret in a fresh repo");
    const { code, stderr } = runHook(`refs/heads/feat ${head} refs/heads/feat ${ZERO}\n`);
    expect(code).toBe(1);
    expect(stderr).toContain("aws.access_key");
  });
});

describe("diff-extraction bypasses (#2498, minimal reimplementation)", () => {
  test("a diff.external driver cannot blank the scanned diff", () => {
    // With diff.external set, plain `git diff` emits the driver's output —
    // typically zero '+' lines — so an unhardened scanner reads an empty diff
    // and allows a push full of secrets. --no-ext-diff must neutralize it.
    const head = commit("leak.txt", FAKE_AWS_KEY + "\n", "secret behind ext driver");
    git(["config", "diff.external", "/usr/bin/true"]);
    const { code, stderr } = runHook(`refs/heads/feat ${head} refs/heads/feat ${ZERO}\n`);
    git(["config", "--unset", "diff.external"]);
    expect(code).toBe(1);
    expect(stderr).toContain("aws.access_key");
  });

  test("an added content line starting with ++ is still scanned", () => {
    // Content "++AKIA…" renders in the diff as "+++AKIA…", which a blanket
    // startsWith('+++') header skip silently dropped from the scan.
    const head = commit("notes.txt", "++" + FAKE_AWS_KEY + "\n", "content line looks like a header");
    const { code, stderr } = runHook(`refs/heads/feat ${head} refs/heads/feat ${ZERO}\n`);
    expect(code).toBe(1);
    expect(stderr).toContain("aws.access_key");
  });

  test("an unparseable pre-push ref line fails closed", () => {
    commit("ok.txt", "clean\n", "clean commit");
    const { code, stderr } = runHook(`refs/heads/feat not-a-sha\n`);
    expect(code).toBe(1);
    expect(stderr).toContain("could not parse");
  });
});
