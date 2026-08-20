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

// Live-FORMAT fakes assembled at runtime so the pushed diff of THIS file never
// contains a credential-shaped literal — the pre-push guard scans diff bytes,
// and the v1.64 wave's dogfood rule stands: assemble the fixture, never bypass
// the guard. The runtime strings stay live-format for the hook under test.
const FAKE_DB_URL = ["postgresql://user:pass", "@db.example.com/x"].join("");
const FAKE_AWS_SECRETX = ["AKIA", "IOSFODNN7SECRETX"].join("");
const FAKE_AWS_RESOLV = ["AKIA", "IOSFODNN7RESOLV"].join("");
const FAKE_AWS_NOREMOT = ["AKIA", "IOSFODNN7NOREMOT"].join("");

/** Give the repo an "origin" whose main carries a fixture we did not write. */
function setUpRemoteWithForeignFixture(): void {
  const remote = mkdtempSync(join(tmpdir(), "gstack-prepush-remote-"));
  run(["init", "-q", "--bare", "-b", "main"], remote);
  run(["remote", "add", "origin", remote]);
  run(["push", "-q", "origin", "main"]);
  // Someone else lands a placeholder connection string on main.
  commit("fixtures/db.ts", `export const URL = "${FAKE_DB_URL}";\n`, "someone else's fixture");
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
    expect(scanned).not.toContain(FAKE_DB_URL);
  });

  test("the old two-dot range DID re-scan it — this is the bug", () => {
    setUpRemoteWithForeignFixture();
    run(["checkout", "-q", "-b", "feature", "HEAD~1"]);
    commit("mine.ts", "export const mine = 1;\n", "my work");
    run(["merge", "-q", "--no-edit", "main"]);

    // origin/feature does not exist yet, so the old code diffed against the
    // remote's main — dragging in every catch-up commit.
    const scanned = addedOnly(addedLinesFromTwoDot(dir, "HEAD~2"));
    expect(scanned).toContain(FAKE_DB_URL);
  });
});

describe("narrowing the range does not narrow coverage", () => {
  test("a secret in a new commit is still scanned", () => {
    setUpRemoteWithForeignFixture();
    run(["checkout", "-q", "-b", "feature", "main"]);
    commit("leak.ts", `const k = "${FAKE_AWS_SECRETX}";\n`, "oops");

    expect(addedOnly(addedLinesFromNewCommits(dir))).toContain(FAKE_AWS_SECRETX);
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
    writeFileSync(join(dir, "conflict.txt"), `resolved ${FAKE_AWS_RESOLV}\n`);
    run(["add", "conflict.txt"]);
    run(["commit", "-q", "--no-edit"]);

    expect(addedOnly(addedLinesFromNewCommits(dir))).toContain(FAKE_AWS_RESOLV);
  });

  test("everything is scanned when no remote exists at all", () => {
    commit("leak.ts", `const k = "${FAKE_AWS_NOREMOT}";\n`, "no remote");
    expect(addedOnly(addedLinesFromNewCommits(dir))).toContain(FAKE_AWS_NOREMOT);
  });
});

// ── S1: the exclusion is scoped to the PUSH TARGET's remote ─────────────────
//
// A bare `--remotes` excludes commits reachable from ANY remote-tracking ref,
// so a secret that had only ever reached a private/local-path remote was never
// scanned when pushed to a PUBLIC remote. Git hands pre-push the push remote's
// name as $1; the hook now scopes the exclusion to `--remotes=<name>/*`.
// These run END-TO-END through the hook binary with the real argv + stdin
// protocol, because the behavior under test is the argv threading itself.
describe("S1: exclusion scoped to the push-target remote", () => {
  const PREPUSH = join(import.meta.dir, "..", "bin", "gstack-redact-prepush");
  const FAKE_AWS_OTHERREM = ["AKIA", "IOSFODNN7OTHERRM"].join("");

  function runHook(stdinLines: string, argv: string[]): { code: number; stderr: string } {
    const r = spawnSync("bun", [PREPUSH, ...argv], {
      cwd: dir,
      input: Buffer.from(stdinLines),
      encoding: "utf8",
      env: { ...process.env },
    });
    return { code: r.status ?? 0, stderr: r.stderr ?? "" };
  }

  /**
   * Build the S1 shape. Returns the feature branch's last-pushed origin tip
   * (what git hands the hook as remoteSha):
   *   1. main + feature pushed to origin (T0 = feature's origin tip)
   *   2. a HIGH-shaped secret commit reaches a SECOND remote only
   *      (pushed there, fetched back → other/leaky tracking ref)
   *   3. feature merges the secret commit — the next push to origin is
   *      the first time this content heads anywhere public
   */
  function buildSecretOnSecondRemote(): { originTip: string } {
    const origin = mkdtempSync(join(tmpdir(), "gstack-prepush-origin-"));
    run(["init", "-q", "--bare", "-b", "main"], origin);
    run(["remote", "add", "origin", origin]);
    run(["push", "-q", "origin", "main"]);
    run(["checkout", "-q", "-b", "feature"]);
    commit("mine.ts", "export const mine = 1;\n", "my work");
    run(["push", "-q", "-u", "origin", "feature"]);
    const originTip = run(["rev-parse", "HEAD"]).trim();

    const other = mkdtempSync(join(tmpdir(), "gstack-prepush-other-"));
    run(["init", "-q", "--bare", "-b", "main"], other);
    run(["remote", "add", "other", other]);
    run(["checkout", "-q", "-b", "leaky"]);
    commit("leak.ts", `const k = "${FAKE_AWS_OTHERREM}";\n`, "secret to private remote only");
    run(["push", "-q", "other", "leaky"]);
    run(["fetch", "-q", "other"]);

    run(["checkout", "-q", "feature"]);
    // --no-ff: a fast-forward would make the secret commit the branch TIP,
    // where the remoteSha two-dot fallback catches it regardless of the
    // --remotes exclusion. The hole shape needs a real merge commit, so the
    // narrowed path (per-commit --cc diffs) is what decides coverage.
    run(["merge", "-q", "--no-ff", "--no-edit", "leaky"]);
    return { originTip };
  }

  test("a commit known only to a SECOND remote IS scanned when pushing to origin", () => {
    const { originTip } = buildSecretOnSecondRemote();
    const head = run(["rev-parse", "HEAD"]).trim();
    const { code, stderr } = runHook(
      `refs/heads/feature ${head} refs/heads/feature ${originTip}\n`,
      ["origin", "file:///ignored"],
    );
    expect(code).toBe(1);
    expect(stderr).toContain("BLOCKED");
    expect(stderr).toContain("aws.access_key");
  });

  test("origin-published commits still are NOT re-scanned (catch-up merge, #2592 kept)", () => {
    setUpRemoteWithForeignFixture();
    run(["checkout", "-q", "-b", "feature", "HEAD~1"]);
    commit("mine.ts", "export const mine = 1;\n", "my work");
    run(["push", "-q", "-u", "origin", "feature"]);
    const originTip = run(["rev-parse", "HEAD"]).trim();
    run(["merge", "-q", "--no-edit", "main"]); // catch-up merge brings the foreign fixture

    const head = run(["rev-parse", "HEAD"]).trim();
    const { code, stderr } = runHook(
      `refs/heads/feature ${head} refs/heads/feature ${originTip}\n`,
      ["origin", "file:///ignored"],
    );
    expect(stderr).not.toContain("BLOCKED");
    expect(code).toBe(0);
  });

  test("no argv (stdin/CLI invocation) falls back to the historical all-remotes exclusion", () => {
    // Documented contract, not a gap being celebrated: without the remote
    // name there is nothing to scope to, and the fallback scans exactly what
    // the hook always scanned. The installed hook wrapper forwards "$@", so
    // real pushes always carry the name.
    const { originTip } = buildSecretOnSecondRemote();
    const head = run(["rev-parse", "HEAD"]).trim();
    const { code, stderr } = runHook(
      `refs/heads/feature ${head} refs/heads/feature ${originTip}\n`,
      [],
    );
    expect(stderr).not.toContain("BLOCKED");
    expect(code).toBe(0);
  });

  test("an unconfigured name (URL push) also falls back rather than erroring", () => {
    const { originTip } = buildSecretOnSecondRemote();
    const head = run(["rev-parse", "HEAD"]).trim();
    const url = "file:///not-a-configured-remote";
    const { code, stderr } = runHook(
      `refs/heads/feature ${head} refs/heads/feature ${originTip}\n`,
      [url, url],
    );
    expect(stderr).not.toContain("could not");
    expect(code).toBe(0);
  });
});
