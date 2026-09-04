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
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
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
    timeout: 30_000,
  });
  return { code: r.status ?? 0, stderr: r.stderr ?? "" };
}

/**
 * Env override that puts `binDir` first on the search path, for tests that
 * shadow a real binary with a stub.
 *
 * Two portability details, both of which a hardcoded `PATH: "dir:" + ...`
 * gets wrong (mirrors `prependPath` in test/gstack-brain-context-load.test.ts):
 *   - The separator is `;` on Windows, not `:`. Using the literal produces one
 *     unparseable entry, so the stub is never found and the REAL binary runs —
 *     a test that silently passes through rather than failing loudly.
 *   - Windows env keys are case-insensitive and commonly spelled `Path`. Adding
 *     a second `PATH` key alongside an inherited `Path` leaves which one wins up
 *     to the spawn implementation, so reuse whichever key already exists.
 */
function prependPath(binDir: string): Record<string, string> {
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") || "PATH";
  return { [pathKey]: `${binDir}${path.delimiter}${process.env[pathKey] || ""}` };
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

  // POSIX-only, for two independent reasons. `spawnSync` reports
  // `status === null` only when a child dies from a signal, and Windows has no
  // equivalent — a force-killed process surfaces a non-zero exit code there — so
  // the branch this test names is unreachable. The stub below is also a
  // `#!/bin/sh` file named `git`, which Windows will not execute at all, since
  // process creation resolves commands through PATHEXT (.exe/.cmd/.bat) and
  // ignores the shebang. A Windows variant would have to assert the non-zero
  // exit path instead, i.e. a different branch than the name claims, so it is
  // skipped rather than rewritten. Gate style follows
  // test/session-runner-timeout.test.ts and test/setup-emoji-font.test.ts.
  test.skipIf(process.platform === "win32")(
    "a diff killed by a signal (null status — the maxBuffer/kill class) BLOCKS",
    () => {
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
        const { code, stderr } = runHook(
          `refs/heads/main ${head} refs/heads/main ${base}\n`,
          prependPath(stubDir),
        );
        expect(code).toBe(1);
        expect(stderr).toContain("could not compute the pushed diff");
        expect(stderr).toContain("GSTACK_REDACT_PREPUSH=skip");
      } finally {
        fs.rmSync(stubDir, { recursive: true, force: true });
      }
    },
  );
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

  // #1946 / maintainer decision 6: setup asks ONCE for consent on a real TTY,
  // records the answer to the existing redact_prepush_hook key, and keeps the
  // hint-only posture everywhere else. Default stays FALSE; setup never
  // installs the hook itself (the assertion above pins that).
  describe("one-time consent prompt in setup (#1946, decision 6)", () => {
    const setup = fs.readFileSync(path.join(ROOT, "setup"), "utf8");
    const block = setup.slice(setup.indexOf("# ─── Redact pre-push guard consent"));

    test("prompt is gated on key ABSENCE and a real TTY, with a timed default-N read", () => {
      expect(block).toContain("grep -q '^redact_prepush_hook:'");
      expect(block).toContain('[ -t 0 ] && [ -t 1 ]');
      expect(block).toContain("[y/N]");
      expect(block).toContain('read -t "$_REDACT_PROMPT_TIMEOUT"');
    });

    test("an explicit answer persists true/false; timeout persists NOTHING", () => {
      expect(block).toContain("set redact_prepush_hook true");
      expect(block).toContain("set redact_prepush_hook false");
      // The timeout branch must not write the key (a silent decline would
      // permanently suppress the ask without the user ever seeing it). The
      // branch's hint TEXT mentions the command; the executable invocation is
      // the quoted "$GSTACK_CONFIG" form.
      const timeoutBranch = block.slice(block.indexOf("*)"), block.indexOf("esac"));
      expect(timeoutBranch).not.toContain('"$GSTACK_CONFIG" set redact_prepush_hook');
    });

    test("non-interactive setup keeps the hint-only posture (no prompt, no key write)", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-consent-"));
      try {
        const script = [
          "QUIET=0",
          'log() { echo "$@"; }',
          `GSTACK_CONFIG="${path.join(ROOT, "bin", "gstack-config")}"`,
          block,
        ].join("\n");
        const r = spawnSync("bash", ["-c", script], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"], // stdin not a TTY
          env: { ...process.env, GSTACK_HOME: home },
          timeout: 15_000,
        });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain("Tip:");
        expect(r.stdout).not.toContain("[y/N]");
        const cfg = path.join(home, "config.yaml");
        const cfgText = fs.existsSync(cfg) ? fs.readFileSync(cfg, "utf8") : "";
        expect(cfgText).not.toContain("redact_prepush_hook");
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("a recorded answer is never re-asked (key present → silent)", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-consent-set-"));
      try {
        fs.writeFileSync(path.join(home, "config.yaml"), "redact_prepush_hook: false\n");
        const script = [
          "QUIET=0",
          'log() { echo "$@"; }',
          `GSTACK_CONFIG="${path.join(ROOT, "bin", "gstack-config")}"`,
          block,
        ].join("\n");
        const r = spawnSync("bash", ["-c", script], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, GSTACK_HOME: home },
          timeout: 15_000,
        });
        expect(r.status).toBe(0);
        expect(r.stdout.trim()).toBe("");
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
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

    const r = spawnSync("bun", [REDACT, "install-prepush-hook"], { cwd: repo, encoding: "utf8", timeout: 30_000 });
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
    spawnSync("bun", [REDACT, "install-prepush-hook"], { cwd: repo, timeout: 30_000 });

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
      timeout: 30_000,
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
    spawnSync("bun", [REDACT, "install-prepush-hook"], { cwd: repo, timeout: 30_000 });
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
      timeout: 30_000,
    });
    expect(r.status).toBe(1);
  });

  // Regression: install returned early on ANY hook carrying the managed marker,
  // so the only writer was unreachable once a hook existed. Every fix to the
  // wrapper — including the `printf x` fail-open fix of v1.64.0.0 — stopped at
  // repos that had never had the hook. The pre-existing newline test above
  // cannot catch this: it installs into a repo with no prior managed hook, which
  // is the one case that was never broken.
  test("a stale managed hook is rewritten, and the refresh delivers the newline fix", () => {
    const hookDir = path.join(repo, ".git", "hooks");
    fs.mkdirSync(hookDir, { recursive: true });
    const hook = path.join(hookDir, "pre-push");

    // The v1.63-era wrapper, verbatim: same marker, `$(cat)` with no sentinel.
    fs.writeFileSync(
      hook,
      [
        "#!/usr/bin/env bash",
        "# gstack-redact pre-push (managed)",
        "set -euo pipefail",
        '_input="$(cat)"',
        '_local="$(git rev-parse --git-path hooks/pre-push.local)"',
        'if [ -x "$_local" ]; then',
        `  printf '%s' "$_input" | "$_local" "$@" || exit $?`,
        "fi",
        `printf '%s' "$_input" | bun ${JSON.stringify(PREPUSH)} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    // A chained local hook of the shape the old wrapper starved: a bare
    // `while read`, which never enters its body without a trailing newline.
    const seen = path.join(repo, "seen.txt");
    fs.writeFileSync(
      path.join(hookDir, "pre-push.local"),
      `#!/usr/bin/env bash\nwhile read -r a _b _c _d; do echo "$a" >> ${JSON.stringify(seen)}; done\nexit 0\n`,
      { mode: 0o755 },
    );

    const r = spawnSync("bun", [REDACT, "install-prepush-hook"], {
      timeout: 30_000,
      cwd: repo,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("refreshed stale managed pre-push hook");
    expect(fs.readFileSync(hook, "utf8")).toContain("printf x");

    // The chained hook is the user's; a refresh must not rename or rewrite it.
    expect(fs.readFileSync(path.join(hookDir, "pre-push.local"), "utf8")).toContain("while read");

    // Behavioural half: the refreshed wrapper actually feeds the final ref line.
    const sha = "c".repeat(40);
    const run = spawnSync("bash", [hook], {
      timeout: 30_000,
      cwd: repo,
      input: Buffer.from(`refs/heads/main ${sha} refs/heads/main ${ZERO}\n`),
      encoding: "utf8",
      env: { ...process.env, GSTACK_REDACT_PREPUSH: "skip" },
    });
    expect(run.status).toBe(0);
    expect(fs.readFileSync(seen, "utf8").trim()).toBe("refs/heads/main");
  });

  test("install stays idempotent: an up-to-date managed hook is not rewritten", () => {
    const hookDir = path.join(repo, ".git", "hooks");
    fs.mkdirSync(hookDir, { recursive: true });
    const hook = path.join(hookDir, "pre-push");

    spawnSync("bun", [REDACT, "install-prepush-hook"], { cwd: repo });
    const first = fs.readFileSync(hook, "utf8");
    const stamp = fs.statSync(hook).mtimeMs;

    const again = spawnSync("bun", [REDACT, "install-prepush-hook"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("already installed");
    expect(again.stdout).not.toContain("refreshed");
    expect(fs.readFileSync(hook, "utf8")).toBe(first);
    expect(fs.statSync(hook).mtimeMs).toBe(stamp);
  });

  test("uninstall restores the chained original", () => {
    const hookDir = path.join(repo, ".git", "hooks");
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(path.join(hookDir, "pre-push"), "#!/usr/bin/env bash\necho mine\n", {
      mode: 0o755,
    });
    spawnSync("bun", [REDACT, "install-prepush-hook"], { cwd: repo, timeout: 30_000 });
    spawnSync("bun", [REDACT, "uninstall-prepush-hook"], { cwd: repo, timeout: 30_000 });
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
    spawnSync("git", ["init", "-q", "--bare", "-b", "trunk", bare], { timeout: 30_000 });

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
