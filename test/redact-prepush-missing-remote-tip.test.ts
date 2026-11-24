/**
 * gstack-redact-prepush when the remote tip of the pushed branch is not in
 * this repository (#4790): the remote moved since the last fetch, or the
 * branch exists on the remote but was never fetched here.
 *
 * Before the fix the hook scanned the whole tree of the pushed commit from the
 * empty tree. On a large repository that overflowed the 64 MiB diff buffer and
 * blocked the push with ENOBUFS; on any repository it reported credentials
 * already on the remote as if this push added them.
 *
 * The hook works out what is being pushed from what this machine last fetched
 * of the push remote: the merge-base with that branch's tracking ref, else with
 * the remote's default branch, else the commits no tracking ref of the push
 * remote reaches. Strictness for the pushed commits is unchanged: a secret in a
 * pushed commit still blocks, and a range it cannot read fails closed with a
 * message that says why and what to do.
 *
 * Every test runs the real hook against real repositories on disk.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gitEnv } from "./helpers/git-env";

const PREPUSH = path.resolve(import.meta.dir, "..", "bin", "gstack-redact-prepush");
const KEY_ON_REMOTE = ["AKIA", "1234567890ABCDEF"].join("");
const KEY_PUSHED = ["AKIA", "FEDCBA0987654321"].join("");
const MISSING_TIP = "1".repeat(40);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 60_000, env: gitEnv(), maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prepush-missing-tip-"));
  roots.push(root);
  return root;
}

function newRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Fixture");
  git(dir, "config", "user.email", "fixture@example.test");
  return dir;
}

function commit(repo: string, file: string, body: string | Buffer, message: string): string {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), body);
  git(repo, "add", file);
  git(repo, "commit", "-qm", message);
  return git(repo, "rev-parse", "HEAD");
}

/** Run the hook as git does: argv is the push remote's name and URL, stdin the ref lines. */
function hook(repo: string, remote: string, url: string, line: string): { code: number | null; stderr: string } {
  const r = spawnSync("bun", [PREPUSH, remote, url], {
    cwd: repo, input: line, encoding: "utf8", timeout: 120_000, env: gitEnv(),
  });
  return { code: r.status, stderr: r.stderr ?? "" };
}

/**
 * The issue's repro: clone a lands a token fixture on main, clone b lands an
 * unrelated commit, and clone a, which never fetched b's commit, pushes its
 * own change. The remote tip is b's commit, which a does not have.
 */
function staleClone(): { root: string; remote: string; a: string; remoteTip: string } {
  const root = tempRoot();
  const remote = path.join(root, "remote.git");
  git(root, "init", "--bare", "-q", "-b", "main", remote);
  const a = newRepo(path.join(root, "a"));
  git(a, "remote", "add", "origin", remote);
  commit(a, "README.md", "base\n", "root");
  commit(a, "fixture.env", `TOKEN=${KEY_ON_REMOTE}\n`, "fixture already on main");
  git(a, "push", "-q", "origin", "main");
  const b = path.join(root, "b");
  git(root, "clone", "-q", remote, b);
  git(b, "config", "user.name", "Other");
  git(b, "config", "user.email", "other@example.test");
  const remoteTip = commit(b, "other.txt", "other\n", "someone else lands on main");
  git(b, "push", "-q", "origin", "main");
  return { root, remote, a, remoteTip };
}

describe("remote tip missing: the remote moved since the last fetch", () => {
  test("content already on the remote is not reported as part of this push", () => {
    const { remote, a, remoteTip } = staleClone();
    const head = commit(a, "mine.txt", "mine\n", "my change");
    expect(spawnSync("git", ["cat-file", "-e", remoteTip], { cwd: a, env: gitEnv() }).status).not.toBe(0);
    const r = hook(a, "origin", remote, `refs/heads/main ${head} refs/heads/main ${remoteTip}\n`);
    expect(r.stderr).not.toContain("aws.access_key");
    expect(r.stderr).not.toContain("BLOCKED");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("git fetch");
  });

  test("a secret in the pushed commit still blocks", () => {
    const { remote, a, remoteTip } = staleClone();
    const head = commit(a, "leak.txt", `key ${KEY_PUSHED}\n`, "my change with a key");
    const r = hook(a, "origin", remote, `refs/heads/main ${head} refs/heads/main ${remoteTip}\n`);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("credential(s) in the pushed diff");
    expect(r.stderr).toContain("aws.access_key");
  });

  test("a catch-up merge of the fetched default branch is not re-scanned", () => {
    const { remote, a } = staleClone();
    git(a, "checkout", "-q", "-b", "feature", "HEAD~1");
    commit(a, "feature.txt", "feature v1\n", "feature work");
    git(a, "push", "-q", "origin", "feature");
    git(a, "fetch", "-q", "origin");
    git(a, "merge", "-q", "--no-edit", "origin/main");
    const head = commit(a, "feature.txt", "feature v2\n", "more feature work");
    const r = hook(a, "origin", remote, `refs/heads/feature ${head} refs/heads/feature ${MISSING_TIP}\n`);
    expect(r.stderr).not.toContain("aws.access_key");
    expect(r.code, r.stderr).toBe(0);
  });

  test("a secret that only reached another remote is still scanned on its way to this one", () => {
    const { a } = staleClone();
    const publish = path.join(path.dirname(a), "publish.git");
    git(path.dirname(a), "init", "--bare", "-q", "-b", "main", publish);
    git(a, "remote", "add", "publish", publish);
    const head = commit(a, "mine.txt", "mine\n", "my change");
    const r = hook(a, "publish", publish, `refs/heads/main ${head} refs/heads/main ${MISSING_TIP}\n`);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("aws.access_key");
  });

  test("a push by URL has no fetched copy to anchor on, so everything is scanned", () => {
    const { remote, a, remoteTip } = staleClone();
    const head = commit(a, "mine.txt", "mine\n", "my change");
    const r = hook(a, remote, remote, `refs/heads/main ${head} refs/heads/main ${remoteTip}\n`);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("aws.access_key");
  });
});

describe("a new branch", () => {
  test("a branch the remote lacks (zero tip) scans only its own commits", () => {
    const { remote, a } = staleClone();
    git(a, "checkout", "-q", "-b", "topic");
    const head = commit(a, "topic.txt", "topic\n", "topic work");
    const r = hook(a, "origin", remote, `refs/heads/topic ${head} refs/heads/topic ${"0".repeat(40)}\n`);
    expect(r.stderr).not.toContain("aws.access_key");
    expect(r.code, r.stderr).toBe(0);
  });

  test("a branch on the remote this clone never fetched anchors on the default branch", () => {
    const { remote, a } = staleClone();
    git(a, "checkout", "-q", "-b", "topic");
    const head = commit(a, "topic.txt", "topic\n", "topic work");
    const r = hook(a, "origin", remote, `refs/heads/topic ${head} refs/heads/topic ${MISSING_TIP}\n`);
    expect(r.stderr).not.toContain("aws.access_key");
    expect(r.code, r.stderr).toBe(0);
  });

  test("a new branch still blocks on its own secret", () => {
    const { remote, a } = staleClone();
    git(a, "checkout", "-q", "-b", "topic");
    const head = commit(a, "topic.txt", `key ${KEY_PUSHED}\n`, "topic with a key");
    const r = hook(a, "origin", remote, `refs/heads/topic ${head} refs/heads/topic ${MISSING_TIP}\n`);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("aws.access_key");
  });
});

/** About 70 MB of old history: more diff than the hook's 64 MiB buffer holds. */
function hugeHistory(repo: string): void {
  const line = "x".repeat(99) + "\n";
  commit(repo, "big/history.txt", Buffer.from(line.repeat(700_000)), "huge old history");
}

describe("a huge history", () => {
  test("one secret in the newest commit is reported, without reading the old history", () => {
    const root = tempRoot();
    const repo = newRepo(path.join(root, "repo"));
    const url = path.join(root, "remote.git");
    git(repo, "remote", "add", "origin", url);
    hugeHistory(repo);
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    const clean = commit(repo, "clean.txt", "clean\n", "clean change");
    const ok = hook(repo, "origin", url, `refs/heads/main ${clean} refs/heads/main ${MISSING_TIP}\n`);
    expect(ok.code, ok.stderr).toBe(0);
    const head = commit(repo, "leak.txt", `key ${KEY_PUSHED}\n`, "newest commit with a key");
    const r = hook(repo, "origin", url, `refs/heads/main ${head} refs/heads/main ${MISSING_TIP}\n`);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain("could not compute the pushed diff");
    expect(r.stderr).toContain("credential(s) in the pushed diff");
    expect(r.stderr).toContain("aws.access_key");
  }, 180_000);
});

describe("a repository with no remote refs", () => {
  test("every commit is new as far as it can tell, so an old secret is still reported", () => {
    const root = tempRoot();
    const repo = newRepo(path.join(root, "repo"));
    const url = path.join(root, "remote.git");
    git(repo, "remote", "add", "origin", url);
    commit(repo, "config.txt", `key ${KEY_ON_REMOTE}\n`, "old");
    const head = commit(repo, "mine.txt", "mine\n", "new");
    const r = hook(repo, "origin", url, `refs/heads/main ${head} refs/heads/main ${MISSING_TIP}\n`);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("aws.access_key");
  });

  test("a range too large to read fails closed and says to fetch first", () => {
    const root = tempRoot();
    const repo = newRepo(path.join(root, "repo"));
    const url = path.join(root, "remote.git");
    git(repo, "remote", "add", "origin", url);
    hugeHistory(repo);
    const head = commit(repo, "mine.txt", "mine\n", "new");
    const r = hook(repo, "origin", url, `refs/heads/main ${head} refs/heads/main ${MISSING_TIP}\n`);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("BLOCKED");
    expect(r.stderr).toContain("more than 64 MiB");
    expect(r.stderr).toContain("git fetch");
  }, 180_000);
});
