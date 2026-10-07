/**
 * gstack-redact-prepush: which email addresses the push guard reports, and
 * where it says they are (#3060, CEO-7, CEO-23, DX-9, DX-17, ENG-8).
 *
 * An address that is the pusher's own, or already sits in the destination's
 * commit metadata, is not a new leak, so `pii.email` must not report it. Every
 * relaxation here has a paired control that still reports: a stranger's
 * address, an address only another remote knows, a URL push that cannot vouch
 * for tracking refs, and a HIGH secret next to an allowed address.
 *
 * The fixtures are real repositories with explicit per-commit identities and
 * an isolated git config, so the machine's own identity can never leak in.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PREPUSH = path.resolve(import.meta.dir, "../bin/gstack-redact-prepush");
const REDACT = path.resolve(import.meta.dir, "../bin/gstack-redact");
const ZERO = "0".repeat(40);
const AWS_KEY = ["AKIA", "1234567890ABCDEF"].join("");
// Fixture addresses are assembled at runtime so this file's own pushed diff
// carries no address literal for the repo's pre-push scan to list.
const at = (name: string): string => `${name}@corp.io`;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function baseEnv(root: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^GIT_(AUTHOR|COMMITTER)_/.test(k) || k.startsWith("GSTACK_REDACT_PREPUSH")) continue;
    env[k] = v;
  }
  const globalConfig = path.join(root, "global.gitconfig");
  if (!fs.existsSync(globalConfig)) fs.writeFileSync(globalConfig, "");
  return { ...env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" };
}

interface Fixture { root: string; repo: string; origin: string; env: Record<string, string> }

function git(fx: Fixture, cwd: string, args: string[], extraEnv: Record<string, string> = {}): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...fx.env, ...extraEnv }, timeout: 60_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

function as(email: string): Record<string, string> {
  return { GIT_AUTHOR_NAME: "Someone", GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: "Someone", GIT_COMMITTER_EMAIL: email };
}

let clock = 1_800_000_000;

/**
 * Commit `file` as `email`. The commit object is written by hand rather than
 * by `git commit`, so a git wrapper that exports its own GIT_AUTHOR_* (some CI
 * and agent machines do) cannot replace the identity under test.
 */
function commitFile(fx: Fixture, cwd: string, file: string, body: string, email = at("me")): string {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), body);
  git(fx, cwd, ["add", file]);
  const tree = git(fx, cwd, ["write-tree"]);
  const parent = spawnSync("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd, encoding: "utf8", env: fx.env, timeout: 30_000 }).stdout?.trim();
  const stamp = `${clock++} +0000`;
  const object = [`tree ${tree}`, ...(parent ? [`parent ${parent}`] : []), `author Someone <${email}> ${stamp}`, `committer Someone <${email}> ${stamp}`, "", `edit ${file}`, ""].join("\n");
  const made = spawnSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd, input: object, encoding: "utf8", env: fx.env, timeout: 30_000 });
  if (made.status !== 0) throw new Error(`hash-object failed: ${made.stderr}`);
  const sha = made.stdout.trim();
  git(fx, cwd, ["update-ref", "HEAD", sha]);
  return sha;
}

/** A working repo with an origin that already holds one seed commit, and the managed hook installed. */
function fixture(opts: { selfEmail?: string | null; seed?: boolean } = {}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prepush-emails-"));
  roots.push(root);
  const fx: Fixture = { root, repo: path.join(root, "repo"), origin: path.join(root, "origin.git"), env: baseEnv(root) };
  fs.mkdirSync(fx.repo);
  git(fx, root, ["init", "--bare", "-q", "-b", "main", fx.origin]);
  git(fx, fx.repo, ["init", "-q", "-b", "main"]);
  git(fx, fx.repo, ["config", "user.name", "Me"]);
  if (opts.selfEmail !== null) git(fx, fx.repo, ["config", "user.email", opts.selfEmail ?? at("me")]);
  git(fx, fx.repo, ["remote", "add", "origin", fx.origin]);
  if (opts.seed !== false) {
    commitFile(fx, fx.repo, "README.md", "seed\n", "seed@example.com");
    git(fx, fx.repo, ["push", "-q", "origin", "main"]);
  }
  const install = spawnSync("bun", [REDACT, "install-prepush-hook"], { cwd: fx.repo, encoding: "utf8", env: fx.env, timeout: 30_000 });
  expect(install.status).toBe(0);
  return fx;
}

function push(fx: Fixture, args: string[]): { code: number; stderr: string } {
  const r = spawnSync("git", ["push", ...args], { cwd: fx.repo, encoding: "utf8", env: fx.env, timeout: 60_000 });
  return { code: r.status ?? -1, stderr: r.stderr ?? "" };
}

/** Run the hook binary directly with git's argv and stdin, for fixtures that stub `git`. */
function runHook(fx: Fixture, stdin: string, argv: string[], extraEnv: Record<string, string> = {}): { code: number; stderr: string } {
  const r = spawnSync(process.execPath, [PREPUSH, ...argv], {
    cwd: fx.repo, input: stdin, encoding: "utf8", env: { ...fx.env, ...extraEnv }, timeout: 60_000,
  });
  return { code: r.status ?? -1, stderr: r.stderr ?? "" };
}

const mediumLines = (stderr: string): string[] => stderr.split("\n").filter((l) => /^\s+MEDIUM\s/.test(l));
const limitedLine = /existing-email suppression was limited for this push/;

/** A producer clone that pushes `branch` with one commit by `email` to `remote`. */
function publishForeignBranch(fx: Fixture, remote: string, branch: string, email: string): void {
  const producer = path.join(fx.root, `producer-${branch}`);
  git(fx, fx.root, ["clone", "-q", remote, producer]);
  commitFile(fx, producer, `${branch}.txt`, "their work\n", email);
  git(fx, producer, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
}

describe("own and already-public addresses are not reported (#3060)", () => {
  test("the pusher's own address (git config user.email) is not reported", () => {
    const fx = fixture({ selfEmail: at("me") });
    commitFile(fx, fx.repo, "AUTHORS.md", `Maintainer: ${at("me")}\n`, at("colleague"));
    const { code, stderr } = push(fx, ["origin", "main"]);
    expect(code).toBe(0);
    expect(stderr).not.toContain("MEDIUM");
  });

  test("an address that authored a commit the remote already has is not reported", () => {
    const fx = fixture();
    commitFile(fx, fx.repo, "lib.txt", "code\n", at("colleague"));
    expect(push(fx, ["origin", "main"]).code).toBe(0);
    commitFile(fx, fx.repo, "CODEOWNERS", `* ${at("colleague")}\n`);
    const { code, stderr } = push(fx, ["origin", "main"]);
    expect(code).toBe(0);
    expect(stderr).not.toContain("MEDIUM");
  });

  test("an address that authors one of the pushed commits is not reported", () => {
    const fx = fixture();
    commitFile(fx, fx.repo, "package.json", `{ "author": "${at("newcomer")}" }\n`, at("newcomer"));
    const { code, stderr } = push(fx, ["origin", "main"]);
    expect(code).toBe(0);
    expect(stderr).not.toContain("MEDIUM");
  });

  test("mailmapped author addresses count as already public", () => {
    const fx = fixture();
    commitFile(fx, fx.repo, "lib.txt", "code\n", at("old-name"));
    expect(push(fx, ["origin", "main"]).code).toBe(0);
    fs.writeFileSync(path.join(fx.repo, ".mailmap"), `Someone <${at("current")}> <${at("old-name")}>\n`);
    commitFile(fx, fx.repo, "docs/contact.md", `Ask ${at("current")}\n`);
    const { stderr } = push(fx, ["origin", "main"]);
    expect(stderr).not.toContain("MEDIUM");
  });

  test("control: a stranger's address is reported with rule, file, line and fix, never the address", () => {
    const fx = fixture();
    commitFile(fx, fx.repo, "notes.md", `line one\nline two\ncontact ${at("stranger")}\n`);
    const { code, stderr } = push(fx, ["origin", "main"]);
    expect(code).toBe(0);
    expect(stderr).toMatch(/1 MEDIUM finding/);
    const lines = mediumLines(stderr);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("pii.email");
    expect(lines[0]).toContain("notes.md:3");
    expect(lines[0]).toContain("git config --add gstack.redact.allowEmail <address>");
    expect(stderr).not.toContain(at("stranger"));
  });

  test("control: a stranger's address in the first push of a repo with no history is reported", () => {
    const fx = fixture({ seed: false });
    commitFile(fx, fx.repo, "notes.md", `contact ${at("stranger")}\n`);
    const { code, stderr } = push(fx, ["origin", "main"]);
    expect(code).toBe(0);
    const lines = mediumLines(stderr);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("notes.md:1");
  });
});

describe("history scope follows the push destination (CEO-7, ENG-8)", () => {
  test("a new branch to a configured remote counts authors on that remote's tracking refs", () => {
    const fx = fixture();
    publishForeignBranch(fx, fx.origin, "other", at("colleague"));
    git(fx, fx.repo, ["fetch", "-q", "origin"]);
    git(fx, fx.repo, ["checkout", "-q", "-b", "feature"]);
    commitFile(fx, fx.repo, "CODEOWNERS", `* ${at("colleague")}\n`);
    const { code, stderr } = push(fx, ["origin", "feature"]);
    expect(code).toBe(0);
    expect(stderr).not.toContain("MEDIUM");
  });

  test("control: a URL push does not count the tracking refs of a remote that happens to match", () => {
    const fx = fixture();
    publishForeignBranch(fx, fx.origin, "other", at("colleague"));
    git(fx, fx.repo, ["fetch", "-q", "origin"]);
    git(fx, fx.repo, ["checkout", "-q", "-b", "feature"]);
    commitFile(fx, fx.repo, "CODEOWNERS", `* ${at("colleague")}\n`);
    const { code, stderr } = push(fx, [fx.origin, "feature"]);
    expect(code).toBe(0);
    expect(mediumLines(stderr)).toHaveLength(1);
  });

  test("control: an address only another remote's history holds is still reported", () => {
    const fx = fixture();
    const upstream = path.join(fx.root, "upstream.git");
    git(fx, fx.root, ["init", "--bare", "-q", "-b", "main", upstream]);
    git(fx, fx.repo, ["push", "-q", upstream, "main"]);
    publishForeignBranch(fx, upstream, "other", at("private-colleague"));
    git(fx, fx.repo, ["remote", "add", "upstream", upstream]);
    git(fx, fx.repo, ["fetch", "-q", "upstream"]);
    git(fx, fx.repo, ["checkout", "-q", "-b", "feature"]);
    commitFile(fx, fx.repo, "CODEOWNERS", `* ${at("private-colleague")}\n`);
    const { code, stderr } = push(fx, ["origin", "feature"]);
    expect(code).toBe(0);
    expect(mediumLines(stderr)).toHaveLength(1);
  });

  test("a force-push counts authors in the history of the remote tip it replaces", () => {
    const fx = fixture();
    commitFile(fx, fx.repo, "draft.txt", "draft\n", at("reviewer"));
    expect(push(fx, ["origin", "main"]).code).toBe(0);
    git(fx, fx.repo, ["reset", "-q", "--hard", "HEAD~1"]);
    commitFile(fx, fx.repo, "CODEOWNERS", `* ${at("reviewer")}\n`);
    const { code, stderr } = push(fx, ["--force", "origin", "main"]);
    expect(code).toBe(0);
    expect(stderr).not.toContain("MEDIUM");
  });

  test("hitting the 50,000-commit cap uses the newest authors and stays quiet about it", () => {
    const fx = fixture({ seed: false });
    const count = 50_001;
    const lines: string[] = [];
    for (let i = 1; i <= count; i++) {
      const email = i === 1 ? at("oldest") : "filler@example.com";
      lines.push("commit refs/heads/main", `mark :${i}`, `committer Someone <${email}> ${1_700_000_000 + i} +0000`, "data 1", "c");
      if (i > 1) lines.push(`from :${i - 1}`);
      lines.push("");
    }
    const imported = spawnSync("git", ["fast-import", "--quiet"], {
      cwd: fx.repo, input: lines.join("\n"), encoding: "utf8", env: fx.env, timeout: 120_000,
    });
    expect(imported.status).toBe(0);
    git(fx, fx.repo, ["reset", "-q", "--hard", "main"]);
    const head = commitFile(fx, fx.repo, "CODEOWNERS", `* ${at("oldest")}\n* ${at("newest")}\n`, at("newest"));
    const { code, stderr } = runHook(fx, `refs/heads/main ${head} refs/heads/main ${ZERO}\n`, []);
    expect(code).toBe(0);
    const found = mediumLines(stderr);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("CODEOWNERS:1");
    expect(stderr).not.toMatch(limitedLine);
  }, 120_000);
});

describe("each input fails on its own (CEO-23, DX-9)", () => {
  /** A `git` that fails or hangs only for `git log`, so every other call is real. */
  function stubGitLog(fx: Fixture, behavior: "fail" | "hang"): Record<string, string> {
    const realGit = Bun.which("git");
    if (!realGit) throw new Error("git not found");
    const bin = path.join(fx.root, "stub-bin");
    fs.mkdirSync(bin, { recursive: true });
    const action = behavior === "fail" ? 'echo "fatal: stub" >&2; exit 128' : "exec sleep 30";
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\nif [ "$1" = "log" ]; then ${action}; fi\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    const pathKey = Object.keys(fx.env).find((k) => k.toLowerCase() === "path") || "PATH";
    return { [pathKey]: `${bin}${path.delimiter}${fx.env[pathKey] ?? ""}` };
  }

  function pushedRange(fx: Fixture): string {
    const base = git(fx, fx.repo, ["rev-parse", "origin/main"]);
    const head = git(fx, fx.repo, ["rev-parse", "HEAD"]);
    return `refs/heads/main ${head} refs/heads/main ${base}\n`;
  }

  test("without user.email, already-public authors are still not reported", () => {
    const fx = fixture({ selfEmail: null });
    commitFile(fx, fx.repo, "lib.txt", "code\n", at("colleague"));
    expect(push(fx, ["origin", "main"]).code).toBe(0);
    commitFile(fx, fx.repo, "CODEOWNERS", `* ${at("colleague")}\n* ${at("stranger")}\n`, at("colleague"));
    const { code, stderr } = push(fx, ["origin", "main"]);
    expect(code).toBe(0);
    const found = mediumLines(stderr);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("CODEOWNERS:2");
  });

  // stubGitLog puts a POSIX shell `git` wrapper first on PATH; Windows CreateProcess cannot exec it.
  for (const behavior of ["fail", "hang"] as const) {
    test.skipIf(process.platform === "win32")(`a history read that ${behavior === "fail" ? "errors" : "times out"} still honors the pusher's own address and says suppression was limited`, () => {
      const fx = fixture({ selfEmail: at("me") });
      commitFile(fx, fx.repo, "lib.txt", "code\n", at("colleague"));
      expect(push(fx, ["origin", "main"]).code).toBe(0);
      git(fx, fx.repo, ["fetch", "-q", "origin"]);
      commitFile(fx, fx.repo, "CODEOWNERS", `* ${at("me")}\n* ${at("colleague")}\n`, at("colleague"));
      const started = Date.now();
      const { code, stderr } = runHook(fx, pushedRange(fx), ["origin", fx.origin], stubGitLog(fx, behavior));
      expect(Date.now() - started).toBeLessThan(25_000);
      expect(code).toBe(0);
      const found = mediumLines(stderr);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain("CODEOWNERS:2");
      expect(stderr.split("\n").filter((l) => limitedLine.test(l))).toHaveLength(1);
      expect(stderr).toContain(behavior === "fail" ? "reading commit history failed" : "reading commit history took over 5 s");
    }, 40_000);
  }
});

describe("per-address allowlist (DX-17)", () => {
  test("an allowed address is not reported; a different address still is", () => {
    const fx = fixture();
    git(fx, fx.repo, ["config", "--add", "gstack.redact.allowEmail", at("Team")]);
    commitFile(fx, fx.repo, "CONTACT.md", `${at("team")}\n${at("other")}\n`);
    const { code, stderr } = push(fx, ["origin", "main"]);
    expect(code).toBe(0);
    const found = mediumLines(stderr);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("CONTACT.md:2");
  });

  test("a HIGH secret next to an allowed address still blocks", () => {
    const fx = fixture();
    git(fx, fx.repo, ["config", "--add", "gstack.redact.allowEmail", at("team")]);
    commitFile(fx, fx.repo, "deploy.env", `OWNER=${at("team")}\nkey ${AWS_KEY}\n`);
    const { code, stderr } = push(fx, ["origin", "main"]);
    expect(code).toBe(1);
    expect(stderr).toContain("aws.access_key");
  });
});

describe("MEDIUM lines point at the real file line (ENG-8)", () => {
  test("separated hunks in one file report each hunk's own line", () => {
    const fx = fixture();
    const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    commitFile(fx, fx.repo, "notes.md", body.join("\n") + "\n");
    expect(push(fx, ["origin", "main"]).code).toBe(0);
    body[4] = `ask ${at("first")}`;
    body[24] = `ask ${at("second")}`;
    commitFile(fx, fx.repo, "notes.md", body.join("\n") + "\n");
    const found = mediumLines(push(fx, ["origin", "main"]).stderr);
    expect(found).toHaveLength(2);
    expect(found[0]).toContain("notes.md:5");
    expect(found[1]).toContain("notes.md:25");
  });

  test("a finding past a scan chunk boundary reports its file line", () => {
    const fx = fixture();
    const filler = Array.from({ length: 20_000 }, (_, i) => `filler line ${i} ${"x".repeat(40)}`);
    filler.push(`ask ${at("late")}`);
    commitFile(fx, fx.repo, "big.txt", filler.join("\n") + "\n");
    const found = mediumLines(push(fx, ["origin", "main"]).stderr);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("big.txt:20001");
  });

  test("content removed before the pushed tip names the commit that added it", () => {
    const fx = fixture();
    git(fx, fx.repo, ["checkout", "-q", "-b", "feature"]);
    commitFile(fx, fx.repo, "notes.md", "start\n");
    expect(push(fx, ["origin", "feature"]).code).toBe(0);
    git(fx, fx.repo, ["checkout", "-q", "main"]);
    commitFile(fx, fx.repo, "upstream.txt", "landed upstream\n");
    expect(push(fx, ["origin", "main"]).code).toBe(0);
    git(fx, fx.repo, ["checkout", "-q", "feature"]);
    const added = commitFile(fx, fx.repo, "notes.md", `start\nask ${at("gone")}\n`);
    commitFile(fx, fx.repo, "notes.md", "start\n");
    git(fx, fx.repo, ["merge", "-q", "--no-edit", "main"], as(at("me")));
    const found = mediumLines(push(fx, ["origin", "feature"]).stderr);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("notes.md:2");
    expect(found[0]).toContain(added.slice(0, 12));
  });
});
