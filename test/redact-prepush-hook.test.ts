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
  args: string[] = [],
): { code: number; stderr: string } {
  const r = spawnSync("bun", [PREPUSH, ...args], {
    cwd: repo,
    input: Buffer.from(stdinLines),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status ?? 0, stderr: r.stderr ?? "" };
}

/**
 * Point a remote-tracking ref at a sha without talking to any remote — that is
 * all the hook reads to decide what the remote already has.
 */
function fakeRemoteRef(name: string, sha: string): void {
  git(["update-ref", `refs/remotes/origin/${name}`, sha]);
}

/** ~n KiB of credential-free filler, one statement per line. */
function filler(kib: number, tag: string): string {
  const line = `export const ${tag}_PAD = { retries: 3, timeout: 1500, label: "widget-factory" };`;
  const need = Math.ceil((kib * 1024) / (line.length + 8));
  return Array.from({ length: need }, (_, i) => `${line} // ${tag}-${i}`).join("\n") + "\n";
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

describe("input size tracks the PUSH, not the REPO", () => {
  // Regression: a 1-commit push of a brand-new branch was blocked with a
  // synthetic HIGH `engine.input_too_large`. The new-ref base was
  // merge-base(local, origin/HEAD); in a repo that ships from a branch other
  // than the default one, that merge-base sits hundreds of commits back, so the
  // scanner was handed the REPO instead of the DIFF and tripped its 1 MiB cap.
  // The only way past it was GSTACK_REDACT_PREPUSH=skip — a capacity bug
  // teaching people to switch a credential guard off.

  /** origin/main stale by >1 MiB; the real work happens on origin/release. */
  function staleDefaultBranchRepo(): void {
    const mainTip = git(["rev-parse", "HEAD"]);
    fakeRemoteRef("main", mainTip);
    git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    commit("bulk.ts", filler(1400, "REL"), "big work on the shipping branch");
    fakeRemoteRef("release", git(["rev-parse", "HEAD"]));
  }

  test("new ref cut from a branch the default branch is far behind is NOT reported as oversize", () => {
    staleDefaultBranchRepo();
    const head = commit("small.md", "one small honest change\n", "small change");
    const { code, stderr } = runHook(`refs/heads/feat ${head} refs/heads/feat ${ZERO}\n`, {}, [
      "origin",
    ]);
    expect(stderr).not.toContain("input_too_large");
    expect(stderr).not.toContain("BLOCKED");
    expect(code).toBe(0);
  });

  test("new ref cut from a stale-default repo still BLOCKS on a credential in the new commit", () => {
    staleDefaultBranchRepo();
    const head = commit("cfg.txt", "key AKIA1234567890ABCDEF\n", "leaky small change");
    const { code, stderr } = runHook(`refs/heads/feat ${head} refs/heads/feat ${ZERO}\n`, {}, [
      "origin",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("aws.access_key");
    expect(stderr).not.toContain("input_too_large");
  });

  test("a >1 MiB clean push is scanned in full and passes", () => {
    const base = git(["rev-parse", "HEAD"]);
    const head = commit("bulk.ts", filler(1500, "BULK"), "big clean commit");
    const { code, stderr } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(stderr).not.toContain("input_too_large");
    expect(code).toBe(0);
  });

  test("a credential PAST the 1 MiB engine cap is still found (chunking scans every byte)", () => {
    // Before the fix this whole push came back as one `engine.input_too_large`
    // and the credential was never looked at. Oversize hid real secrets.
    const base = git(["rev-parse", "HEAD"]);
    const body =
      filler(1500, "PRE") + 'const u = "postgres://user:hunter2@example.invalid:5432/db";\n';
    const head = commit("bulk.ts", body, "big commit, credential at the far end");
    const { code, stderr } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(code).toBe(1);
    expect(stderr).toContain("db.url_with_password");
    expect(stderr).not.toContain("input_too_large");
  });

  test("a single added line bigger than one chunk is windowed, not skipped", () => {
    const base = git(["rev-parse", "HEAD"]);
    const pad = "x".repeat(400 * 1024);
    const head = commit("min.js", `${pad} AKIA1234567890ABCDEF ${pad}\n`, "one giant line");
    const { code, stderr } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(code).toBe(1);
    expect(stderr).toContain("aws.access_key");
    expect(stderr).not.toContain("UNSCANNED");
  });

  test("size is never reported as a credential — oversize has its own honest wording", () => {
    // Whatever else changes, `engine.input_too_large` must not be printed under
    // the "credential(s) in the pushed diff / rotate the credential" banner.
    const src = fs.readFileSync(PREPUSH, "utf8");
    expect(src).toContain("could NOT be scanned");
    expect(src).toContain("UNSCANNED");
    expect(src).toContain("not a finding");
  });
});

describe("new-ref base = what THIS remote already has", () => {
  test("commits the remote already holds under another ref are not re-scanned", () => {
    // Pushing existing content under a new name adds nothing to the remote, so
    // there is nothing new to scan — the same rule the remote..local path has
    // always used. (This guard is documented as a pushed-diff scanner, not a
    // history scanner; history is /cso's job.)
    const head = commit("old.txt", "AKIA1234567890ABCDEF\n", "already on the remote");
    fakeRemoteRef("already-pushed", head);
    const { code } = runHook(`refs/heads/alias ${head} refs/heads/alias ${ZERO}\n`, {}, ["origin"]);
    expect(code).toBe(0);
  });

  test("with no remote-tracking refs at all, a new ref scans the whole tree", () => {
    const head = commit("feature.txt", "ghp_" + "a".repeat(36) + "\n", "feature with token");
    const { code, stderr } = runHook(`refs/heads/feat ${head} refs/heads/feat ${ZERO}\n`, {}, [
      "origin",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("github.pat");
  });

  test("the boundary is found even when the branch merged another remote branch", () => {
    const root = git(["rev-parse", "HEAD"]);
    fakeRemoteRef("main", root);
    git(["checkout", "-q", "-b", "side"]);
    const side = commit("side.txt", "side work\n", "side");
    fakeRemoteRef("side", side);
    git(["checkout", "-q", "main"]);
    commit("trunk.txt", "trunk work\n", "trunk");
    fakeRemoteRef("trunk", git(["rev-parse", "HEAD"]));
    git(["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    const head = commit("cfg.txt", "key AKIA1234567890ABCDEF\n", "new leaky commit");
    const { code, stderr } = runHook(`refs/heads/feat ${head} refs/heads/feat ${ZERO}\n`, {}, [
      "origin",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("aws.access_key");
    expect(stderr).not.toContain("input_too_large");
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
