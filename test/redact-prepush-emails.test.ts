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
function commitFile(fx: Fixture, cwd: string, file: string, body: string, email = "me@corp.io"): string {
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
  if (opts.selfEmail !== null) git(fx, fx.repo, ["config", "user.email", opts.selfEmail ?? "me@corp.io"]);
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

describe("MEDIUM findings are listed one per line", () => {
  test("control: a stranger's address is reported with rule, file, line and fix, never the address", () => {
    const fx = fixture();
    commitFile(fx, fx.repo, "notes.md", "line one\nline two\ncontact stranger@corp.io\n");
    const { code, stderr } = push(fx, ["origin", "main"]);
    expect(code).toBe(0);
    expect(stderr).toMatch(/1 MEDIUM finding/);
    const lines = mediumLines(stderr);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("pii.email");
    expect(lines[0]).toContain("notes.md:3");
    expect(stderr).not.toContain("stranger@corp.io");
  });

  test("control: a stranger's address in the first push of a repo with no history is reported", () => {
    const fx = fixture({ seed: false });
    commitFile(fx, fx.repo, "notes.md", "contact stranger@corp.io\n");
    const { code, stderr } = push(fx, ["origin", "main"]);
    expect(code).toBe(0);
    const lines = mediumLines(stderr);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("notes.md:1");
  });
});

describe("MEDIUM lines point at the real file line (ENG-8)", () => {
  test("separated hunks in one file report each hunk's own line", () => {
    const fx = fixture();
    const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    commitFile(fx, fx.repo, "notes.md", body.join("\n") + "\n");
    expect(push(fx, ["origin", "main"]).code).toBe(0);
    body[4] = "ask first@corp.io";
    body[24] = "ask second@corp.io";
    commitFile(fx, fx.repo, "notes.md", body.join("\n") + "\n");
    const found = mediumLines(push(fx, ["origin", "main"]).stderr);
    expect(found).toHaveLength(2);
    expect(found[0]).toContain("notes.md:5");
    expect(found[1]).toContain("notes.md:25");
  });

  test("a finding past a scan chunk boundary reports its file line", () => {
    const fx = fixture();
    const filler = Array.from({ length: 20_000 }, (_, i) => `filler line ${i} ${"x".repeat(40)}`);
    filler.push("ask late@corp.io");
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
    const added = commitFile(fx, fx.repo, "notes.md", "start\nask gone@corp.io\n");
    commitFile(fx, fx.repo, "notes.md", "start\n");
    git(fx, fx.repo, ["merge", "-q", "--no-edit", "main"], as("me@corp.io"));
    const found = mediumLines(push(fx, ["origin", "feature"]).stderr);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("notes.md:2");
    expect(found[0]).toContain(added.slice(0, 12));
  });
});
