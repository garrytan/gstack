/**
 * gstack-redact-prepush — WHICH commits get scanned.
 *
 * `remoteSha..localSha` is "everything new on this branch", not "everything new
 * to the remote". Merge origin/main into a feature branch and every commit main
 * gained since the last push becomes an added line: already published, already
 * scanned, not this push's doing. That produces false HIGH findings on other
 * people's merged fixtures, and blows the engine's size cap on busy repos.
 *
 * These tests build real repositories on disk, because the behaviour under test
 * IS the git plumbing — a mocked `git` would test the mock. Each asserts on the
 * added-line text the hook would scan.
 *
 * The direction that matters most is the LAST describe block: narrowing the
 * range must not narrow COVERAGE. A secret in a new commit, or introduced while
 * resolving a merge, still has to be seen.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

let dir: string;
const run = (args: string[], cwd = dir): string => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}\n${r.stderr}`);
  return r.stdout ?? "";
};
const commit = (file: string, body: string, msg: string, cwd = dir) => {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), body);
  run(["add", file], cwd);
  run(["commit", "-q", "-m", msg], cwd);
};

/**
 * The range the fixed hook uses: commits reachable from HEAD and from no
 * remote-tracking ref, each diffed alone with --cc.
 */
function addedLinesFromNewCommits(cwd: string): string {
  const listed = run(["rev-list", "HEAD", "--not", "--remotes"], cwd).trim();
  if (!listed) return "";
  const out: string[] = [];
  for (const sha of listed.split("\n").filter(Boolean)) {
    out.push(run([
      "show", "--unified=0", "--no-color", "--no-ext-diff", "--no-textconv",
      "--cc", "--format=", sha,
    ], cwd));
  }
  return out.join("\n");
}

/** The old behaviour, for contrast. */
function addedLinesFromTwoDot(cwd: string, remoteRef: string): string {
  return run([
    "diff", "--unified=0", "--no-color", "--no-ext-diff", "--no-textconv",
    `${remoteRef}..HEAD`,
  ], cwd);
}

const addedOnly = (diff: string): string =>
  diff.split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .join("\n");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gstack-prepush-"));
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "t@example.com"]);
  run(["config", "user.name", "T"]);
  commit("README.md", "seed\n", "seed");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Give the repo an "origin" whose main carries a fixture we did not write. */
function setUpRemoteWithForeignFixture(): void {
  const remote = mkdtempSync(join(tmpdir(), "gstack-prepush-remote-"));
  run(["init", "-q", "--bare", "-b", "main"], remote);
  run(["remote", "add", "origin", remote]);
  run(["push", "-q", "origin", "main"]);
  // Someone else lands a placeholder connection string on main.
  commit("fixtures/db.ts", 'export const URL = "postgresql://user:pass@db.example.com/x";\n', "someone else's fixture");
  run(["push", "-q", "origin", "main"]);
  run(["fetch", "-q", "origin"]);
}

describe("a catch-up merge does not re-scan already-published content", () => {
  test("the foreign fixture is absent from the scanned text", () => {
    setUpRemoteWithForeignFixture();
    // Branch from BEFORE that fixture, then merge main in to catch up.
    run(["checkout", "-q", "-b", "feature", "HEAD~1"]);
    commit("mine.ts", "export const mine = 1;\n", "my work");
    run(["merge", "-q", "--no-edit", "main"]);

    const scanned = addedOnly(addedLinesFromNewCommits(dir));
    expect(scanned).toContain("export const mine = 1;");
    expect(scanned).not.toContain("postgresql://user:pass@db.example.com/x");
  });

  test("the old two-dot range DID re-scan it — this is the bug", () => {
    setUpRemoteWithForeignFixture();
    run(["checkout", "-q", "-b", "feature", "HEAD~1"]);
    commit("mine.ts", "export const mine = 1;\n", "my work");
    run(["merge", "-q", "--no-edit", "main"]);

    // origin/feature does not exist yet, so the old code diffed against the
    // remote's main — dragging in every catch-up commit.
    const scanned = addedOnly(addedLinesFromTwoDot(dir, "HEAD~2"));
    expect(scanned).toContain("postgresql://user:pass@db.example.com/x");
  });
});

describe("narrowing the range does not narrow coverage", () => {
  test("a secret in a new commit is still scanned", () => {
    setUpRemoteWithForeignFixture();
    run(["checkout", "-q", "-b", "feature", "main"]);
    commit("leak.ts", 'const k = "AKIAIOSFODNN7SECRETX";\n', "oops");

    expect(addedOnly(addedLinesFromNewCommits(dir))).toContain("AKIAIOSFODNN7SECRETX");
  });

  test("a secret introduced while RESOLVING a merge is still scanned", () => {
    // A combined diff shows only content present in no parent — exactly the
    // conflict resolution — so this must not slip through.
    //
    // Note for anyone hardening this later: removing `--cc` from the
    // implementation does NOT fail this test, because `git show` already
    // defaults to a combined diff for merge commits. The explicit flag is
    // self-documenting, not load-bearing, and no test can pin it. What this
    // test does pin is the coverage itself.
    setUpRemoteWithForeignFixture();
    run(["checkout", "-q", "-b", "feature", "HEAD~1"]);
    commit("conflict.txt", "mine\n", "mine");
    run(["checkout", "-q", "main"]);
    commit("conflict.txt", "theirs\n", "theirs");
    run(["push", "-q", "origin", "main"]);
    run(["fetch", "-q", "origin"]);
    run(["checkout", "-q", "feature"]);
    spawnSync("git", ["merge", "--no-edit", "main"], { cwd: dir, encoding: "utf8" }); // conflicts
    writeFileSync(join(dir, "conflict.txt"), 'resolved AKIAIOSFODNN7RESOLV\n');
    run(["add", "conflict.txt"]);
    run(["commit", "-q", "--no-edit"]);

    expect(addedOnly(addedLinesFromNewCommits(dir))).toContain("AKIAIOSFODNN7RESOLV");
  });

  test("everything is scanned when no remote exists at all", () => {
    commit("leak.ts", 'const k = "AKIAIOSFODNN7NOREMOT";\n', "no remote");
    expect(addedOnly(addedLinesFromNewCommits(dir))).toContain("AKIAIOSFODNN7NOREMOT");
  });
});
