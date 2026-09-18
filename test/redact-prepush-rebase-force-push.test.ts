/**
 * gstack-redact-prepush — the REBASED FORCE-PUSH shape (#2573).
 *
 * After `git rebase origin/main`, the remote tip of the feature branch still
 * exists locally (it is the pre-rebase tip) but is no longer an ancestor of
 * HEAD. The old `remoteSha..localSha` range therefore swept in every upstream
 * commit rebased onto — content already published and already scanned when it
 * reached the remote. Reported as #2573: a 23-commit branch rebased onto a
 * main that advanced 23 commits scanned 1.14 MiB instead of 0.27 MiB, tripped
 * the engine's 1 MiB cap, and blocked the push with engine.input_too_large —
 * a HIGH that was the engine saying it never ran, not a finding.
 *
 * The catch-up-merge narrowing (`rev-list localSha --not remoteSha --remotes`)
 * covers this shape too: the upstream commits are reachable from origin/main's
 * remote-tracking ref, which exists by construction — you cannot have rebased
 * onto origin/main without it. These tests PROVE that, end-to-end through the
 * actual hook binary with the real pre-push stdin protocol, in both
 * directions: upstream content is not re-scanned (a HIGH-shaped credential
 * someone else already published does not block a clean rebased push), and
 * narrowing does not narrow coverage (a HIGH in a rebased commit of our own
 * still blocks).
 *
 * Analyzed non-gap, recorded for the next reader: a rebased force-push where
 * the upstream commits sit in NO remote-tracking ref cannot arise from the
 * standard flow — rebasing onto origin/<branch> requires the tracking ref,
 * and rebasing onto a purely local branch means the "upstream" commits were
 * never published, so scanning them is correct, not a false positive.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

const PREPUSH = path.resolve(import.meta.dir, "..", "bin", "gstack-redact-prepush");

let repo: string;
let remote: string;

function git(args: string[], cwd = repo): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}\n${r.stderr}`);
  return r.stdout?.trim() ?? "";
}

function commit(file: string, content: string, msg: string): string {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
  git(["add", file]);
  git(["commit", "-q", "-m", msg]);
  return git(["rev-parse", "HEAD"]);
}

function runHook(stdinLines: string): { code: number; stderr: string } {
  const r = spawnSync("bun", [PREPUSH], {
    cwd: repo,
    input: Buffer.from(stdinLines),
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env },
  });
  return { code: r.status ?? 0, stderr: r.stderr ?? "" };
}

// Assembled at runtime so the LITERAL never appears in a pushed diff — the
// repo's own pre-push scanner (correctly) blocks live-format AWS key shapes.
const FAKE_AWS_KEY = ["AKIA", "1234567890ABCDEF"].join("");

/**
 * Build the #2573 shape:
 *   1. feature branch pushed → remote + tracking ref hold the pre-rebase tip
 *   2. main advances with someone else's already-published HIGH-shaped
 *      fixture, pushed and fetched
 *   3. feature rebases onto origin/main
 * Returns the pre-rebase tip (what git hands the hook as remoteSha on the
 * force-push) — it still EXISTS locally but is no longer an ancestor of HEAD.
 */
function buildRebasedForcePush(): { preRebaseTip: string } {
  git(["checkout", "-q", "-b", "feature"]);
  commit("mine.ts", "export const mine = 1;\n", "my clean work");
  git(["push", "-q", "-u", "origin", "feature"]);
  const preRebaseTip = git(["rev-parse", "HEAD"]);

  // Someone else lands a HIGH-shaped placeholder on main. It is published:
  // pushed to the remote, fetched into origin/main.
  git(["checkout", "-q", "main"]);
  commit("fixtures/foreign.txt", `key ${FAKE_AWS_KEY}\n`, "someone else's fixture");
  git(["push", "-q", "origin", "main"]);
  git(["fetch", "-q", "origin"]);

  git(["checkout", "-q", "feature"]);
  git(["rebase", "-q", "origin/main"]);
  return { preRebaseTip };
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "prepush-rebase-"));
  remote = fs.mkdtempSync(path.join(os.tmpdir(), "prepush-rebase-remote-"));
  git(["init", "-q", "--bare", "-b", "main"], remote);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "T"]);
  commit("README.md", "seed\n", "seed");
  git(["remote", "add", "origin", remote]);
  git(["push", "-q", "-u", "origin", "main"]);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(remote, { recursive: true, force: true });
});

describe("rebased force-push does not re-scan upstream commits (#2573)", () => {
  test("fixture sanity: the old two-dot range WOULD have swept in the upstream credential", () => {
    const { preRebaseTip } = buildRebasedForcePush();
    // The rebased tip exists locally and is NOT an ancestor of HEAD — the
    // exact condition #2573 identified as the untested third branch.
    expect(git(["cat-file", "-t", preRebaseTip])).toBe("commit");
    const isAncestor = spawnSync("git", ["merge-base", "--is-ancestor", preRebaseTip, "HEAD"], { cwd: repo, timeout: 30_000 });
    expect(isAncestor.status).not.toBe(0);
    // What the OLD range would scan: upstream's published fixture included.
    const oldDiff = git(["diff", "--unified=0", `${preRebaseTip}..HEAD`]);
    expect(oldDiff).toContain(FAKE_AWS_KEY);
  });

  test("a clean rebased force-push passes: the published upstream credential does not block", () => {
    const { preRebaseTip } = buildRebasedForcePush();
    const head = git(["rev-parse", "HEAD"]);
    const { code, stderr } = runHook(`refs/heads/feature ${head} refs/heads/feature ${preRebaseTip}\n`);
    expect(stderr).not.toContain("BLOCKED");
    expect(code).toBe(0);
  });

  test("narrowing does not narrow coverage: a HIGH in a REBASED commit of our own still blocks", () => {
    const { preRebaseTip } = buildRebasedForcePush();
    commit("leak.txt", `key ${FAKE_AWS_KEY}\n`, "oops, my own leak");
    const head = git(["rev-parse", "HEAD"]);
    const { code, stderr } = runHook(`refs/heads/feature ${head} refs/heads/feature ${preRebaseTip}\n`);
    expect(code).toBe(1);
    expect(stderr).toContain("BLOCKED");
  });

  test("the scanned commit set is exactly the rebased own commits, none of upstream's", () => {
    // Pin the range arithmetic itself (the #2573 measurement, in miniature):
    // the narrowed set excludes every commit reachable from a remote-tracking
    // ref, so the 1.14 MiB-vs-0.27 MiB pathology cannot recur — scan size is
    // proportional to OUR commits, not to how busy main was.
    const { preRebaseTip } = buildRebasedForcePush();
    const narrowed = git(["rev-list", "HEAD", "--not", preRebaseTip, "--remotes"])
      .split("\n").filter(Boolean);
    expect(narrowed).toHaveLength(1); // the rebased copy of "my clean work"
    const subject = git(["log", "-1", "--format=%s", narrowed[0]]);
    expect(subject).toBe("my clean work");
  });
});
