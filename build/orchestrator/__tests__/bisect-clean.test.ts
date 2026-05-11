/**
 * Feature 5 — Bisect-clean commit split verification (T1–T7).
 *
 * RED PHASE: All tests fail before the commit split is executed.
 * GREEN PHASE: All tests pass after the 5-commit bisect split is done.
 *
 * The tests verify that the bisect-clean split of the active-run registry
 * fix produces exactly 5 commits in the specified order, each of which
 * independently passes the integration test suite.
 *
 * T7: Commit messages match source plan order exactly (5 commits, right subjects)
 * T1: Commit 1 is self-contained (constant introduced, tests pass)
 * T2: Commit 2 fixes the ternary (tests pass)
 * T3: Commit 3 adds stale-paused cleanup (tests pass)
 * T4: Commit 4 regression test lands and passes (including status === "paused" assert)
 * T5: Commit 5 only touches buildKindInstructions and coverage regex (not the ternary fix)
 * T6: No net diff lost in the split (pre-split tree equals post-split tree)
 */
import { afterEach, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

/** Exact commit subjects in order, from source plan §"Commit Order (bisect-clean)". */
const EXPECTED_SUBJECTS = [
  "fix(build): add FINALIZATION_REQUIRED constant, replace magic 13 in cli.ts",
  'fix(build): active-run registry shows "paused" for exit-13 (FINALIZATION_REQUIRED)',
  "fix(build): auto-clean stale paused active-run records when process is dead",
  'test(build): regression test — exit-13 active-run registry status is "paused"',
  "fix(build): add buildKindInstructions export and fix decimal coverage regex",
];

/** Worktrees created during tests — cleaned up in afterEach. */
const activeWorktrees: string[] = [];

afterEach(() => {
  for (const wt of activeWorktrees.splice(0)) {
    // Remove the node_modules symlink explicitly so rmSync does not follow it
    const wtModules = path.join(wt, "node_modules");
    try {
      if (
        fs.existsSync(wtModules) &&
        fs.lstatSync(wtModules).isSymbolicLink()
      ) {
        fs.unlinkSync(wtModules);
      }
    } catch {}
    try {
      spawnSync("git", ["worktree", "remove", "--force", wt], {
        cwd: REPO_ROOT,
      });
    } catch {}
    try {
      fs.rmSync(wt, { recursive: true, force: true });
    } catch {}
  }
});

function git(...args: string[]): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function baseBranch(): string {
  return git("rev-parse", "--verify", "main").status === 0 ? "main" : "master";
}

/**
 * Returns ordered list of commit hashes corresponding to EXPECTED_SUBJECTS.
 * A position is `undefined` if the commit was not found on the current branch.
 */
function matchedCommits(): (string | undefined)[] {
  const r = git("log", "--format=%H\t%s", "--reverse", `${baseBranch()}..HEAD`);
  if (r.status !== 0) return EXPECTED_SUBJECTS.map(() => undefined);

  const subjectToHash = new Map<string, string>();
  for (const line of r.stdout.trim().split("\n").filter(Boolean)) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    subjectToHash.set(line.slice(tab + 1), line.slice(0, tab));
  }
  return EXPECTED_SUBJECTS.map((s) => subjectToHash.get(s));
}

/**
 * Creates a detached git worktree at `commitHash`, symlinks node_modules
 * from the main worktree, runs `bun test integration.test.ts`, then
 * registers the worktree path for afterEach cleanup.
 */
function runIntegrationTestAtCommit(commitHash: string): {
  status: number;
  output: string;
  wtDir: string | undefined;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-bisect-wt-"));

  const addResult = spawnSync(
    "git",
    ["worktree", "add", "--detach", tmpDir, commitHash],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  // Register for cleanup regardless of whether add succeeded
  activeWorktrees.push(tmpDir);

  if ((addResult.status ?? -1) !== 0) {
    return {
      status: -1,
      output: `git worktree add failed: ${addResult.stderr}`,
      wtDir: undefined,
    };
  }

  // Symlink node_modules so bun can resolve deps without reinstalling
  const mainModules = path.join(REPO_ROOT, "node_modules");
  const wtModules = path.join(tmpDir, "node_modules");
  if (fs.existsSync(mainModules) && !fs.existsSync(wtModules)) {
    try {
      fs.symlinkSync(mainModules, wtModules, "dir");
    } catch {}
  }

  const integrationTest = path.join(
    tmpDir,
    "build",
    "orchestrator",
    "__tests__",
    "integration.test.ts",
  );
  const testResult = spawnSync("bun", ["test", integrationTest], {
    cwd: tmpDir,
    encoding: "utf8",
    timeout: 60_000,
  });

  return {
    status: testResult.status ?? -1,
    output: (testResult.stdout ?? "") + (testResult.stderr ?? ""),
    wtDir: tmpDir,
  };
}

// ---------------------------------------------------------------------------
// T7: Commit messages match source plan order — run first; T1-T6 depend on it
// ---------------------------------------------------------------------------

test("T7: commit messages match source plan order exactly", () => {
  const r = git("log", "--format=%s", "--reverse", `${baseBranch()}..HEAD`);
  expect(r.status).toBe(0);

  const subjects = r.stdout.trim().split("\n").filter(Boolean);

  // Must have exactly 5 commits on the branch
  expect(subjects).toHaveLength(5);

  // Must match expected subjects in exact order
  for (let i = 0; i < EXPECTED_SUBJECTS.length; i++) {
    expect(subjects[i]).toBe(EXPECTED_SUBJECTS[i]);
  }
});

// ---------------------------------------------------------------------------
// T1: Commit 1 is self-contained (constant introduced, no behavior change)
// ---------------------------------------------------------------------------

test("T1: commit 1 is self-contained and integration tests pass", () => {
  const commits = matchedCommits();
  const c1 = commits[0];
  expect(c1).toBeDefined();

  const { status, output } = runIntegrationTestAtCommit(c1!);
  if (status !== 0) console.error("T1 integration tests failed:\n", output);
  expect(status).toBe(0);
}, 120_000);

// ---------------------------------------------------------------------------
// T2: Commit 2 fixes the ternary (exit-13 → "paused")
// ---------------------------------------------------------------------------

test("T2: commit 2 fixes the ternary and integration tests pass", () => {
  const commits = matchedCommits();
  const c2 = commits[1];
  expect(c2).toBeDefined();

  const { status, output } = runIntegrationTestAtCommit(c2!);
  if (status !== 0) console.error("T2 integration tests failed:\n", output);
  expect(status).toBe(0);
}, 120_000);

// ---------------------------------------------------------------------------
// T3: Commit 3 adds stale-paused cleanup (plan-selection.ts)
// ---------------------------------------------------------------------------

test("T3: commit 3 adds stale-paused cleanup and integration tests pass", () => {
  const commits = matchedCommits();
  const c3 = commits[2];
  expect(c3).toBeDefined();

  const { status, output } = runIntegrationTestAtCommit(c3!);
  if (status !== 0) console.error("T3 integration tests failed:\n", output);
  expect(status).toBe(0);
}, 120_000);

// ---------------------------------------------------------------------------
// T4: Commit 4 regression test lands and passes
// ---------------------------------------------------------------------------

test('T4: commit 4 regression test lands and passes (status === "paused" assertion)', () => {
  const commits = matchedCommits();
  const c4 = commits[3];
  expect(c4).toBeDefined();

  const { status, output, wtDir } = runIntegrationTestAtCommit(c4!);
  if (status !== 0) console.error("T4 integration tests failed:\n", output);
  expect(status).toBe(0);

  // Verify the regression test asserting status === "paused" is present at this commit
  expect(wtDir).toBeDefined();
  const integrationContent = fs.readFileSync(
    path.join(
      wtDir!,
      "build",
      "orchestrator",
      "__tests__",
      "integration.test.ts",
    ),
    "utf8",
  );
  expect(integrationContent).toContain('status === "paused"');
}, 120_000);

// ---------------------------------------------------------------------------
// T5: Commit 5 is unrelated and isolated (buildKindInstructions + coverage regex)
// ---------------------------------------------------------------------------

test("T5: commit 5 only touches buildKindInstructions and coverage regex — not the ternary fix", () => {
  const commits = matchedCommits();
  const c5 = commits[4];
  expect(c5).toBeDefined();

  // Get changed file list via diff-tree (no header noise)
  const nameResult = spawnSync(
    "git",
    ["diff-tree", "--no-commit-id", "-r", "--name-only", c5!],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  expect(nameResult.status ?? -1).toBe(0);

  const changedFiles = nameResult.stdout.trim().split("\n").filter(Boolean);

  // Must NOT touch plan-selection.ts (that belongs to commit 3)
  expect(changedFiles.some((f) => f.includes("plan-selection.ts"))).toBe(false);

  // Diff content must not contain ternary-fix or constant-fix symbols
  const diffResult = spawnSync("git", ["show", c5!], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  expect(diffResult.status ?? -1).toBe(0);
  expect(diffResult.stdout).not.toContain("FINALIZATION_REQUIRED");
  expect(diffResult.stdout).not.toContain("updateActiveRunFromState");
  expect(diffResult.stdout).not.toContain("plan-selection.ts");
});

// ---------------------------------------------------------------------------
// T6: No net diff lost in the split
// ---------------------------------------------------------------------------

test("T6: no net diff lost in the split (pre-split tree equals post-split tree)", () => {
  const commits = matchedCommits();

  // All 5 commits must exist before we can compare
  for (let i = 0; i < EXPECTED_SUBJECTS.length; i++) {
    expect(commits[i]).toBeDefined();
  }

  // The implementation phase records the pre-split HEAD SHA in this file before
  // rebasing, so the post-rebase run can verify the diff is empty.
  // Path is outside the repo to avoid polluting the index.
  const preSplitFile = path.join(
    os.homedir(),
    ".gstack",
    "build-state",
    "pre-split-tip",
  );

  if (!fs.existsSync(preSplitFile)) {
    // Red phase: implementation has not yet recorded the pre-split SHA.
    throw new Error(
      `Pre-split tip SHA not found at ${preSplitFile}. ` +
        "The implementation phase must write this file before rebasing.",
    );
  }

  const preSplitTip = fs.readFileSync(preSplitFile, "utf8").trim();
  // Must be a 40-character hex SHA
  expect(preSplitTip).toMatch(/^[0-9a-f]{40}$/);

  // git diff between the old tree and the new tree should be empty —
  // the split only rewrites commit graph, not file content.
  const diffResult = git("diff", `${preSplitTip}..HEAD`);
  expect(diffResult.status).toBe(0);
  expect(diffResult.stdout.trim()).toBe("");
});
