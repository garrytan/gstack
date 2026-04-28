/**
 * Tests for build/orchestrator/worktree.ts
 * Requires real git operations — uses a temp git repo created in beforeAll.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createWorktrees, teardownWorktrees, applyWinner } from "../worktree";
import type { DualImplState } from "../types";

let tmpDir: string;
let repoPath: string;

function git(args: string[], cwd: string) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-worktree-test-"));
  repoPath = path.join(tmpDir, "repo");
  fs.mkdirSync(repoPath, { recursive: true });

  git(["init", "--initial-branch=main"], repoPath);
  git(["config", "user.email", "test@test.com"], repoPath);
  git(["config", "user.name", "Test User"], repoPath);
  fs.writeFileSync(path.join(repoPath, "README.md"), "# Test repo");
  git(["add", "."], repoPath);
  git(["commit", "-m", "initial"], repoPath);
});

afterAll(() => {
  try {
    spawnSync("git", ["worktree", "prune"], { cwd: repoPath });
  } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("createWorktrees creates two directories with distinct branches", () => {
  const pair = createWorktrees({ cwd: repoPath, slug: "test", phaseNumber: "1" });

  expect(fs.existsSync(pair.geminiWorktreePath)).toBe(true);
  expect(fs.existsSync(pair.codexWorktreePath)).toBe(true);
  expect(pair.geminiBranch).not.toBe(pair.codexBranch);
  expect(pair.geminiBranch).toContain("gstack-dual");
  expect(pair.codexBranch).toContain("gstack-dual");
  expect(pair.baseCommit).toMatch(/^[0-9a-f]{7,40}$/);

  const state: DualImplState = { ...pair };
  teardownWorktrees({ cwd: repoPath, dualImpl: state });
});

test("teardownWorktrees removes both worktrees and is idempotent (safe to call twice)", () => {
  const pair = createWorktrees({ cwd: repoPath, slug: "test-td", phaseNumber: "2" });

  const state: DualImplState = { ...pair };

  teardownWorktrees({ cwd: repoPath, dualImpl: state });

  expect(fs.existsSync(pair.geminiWorktreePath)).toBe(false);
  expect(fs.existsSync(pair.codexWorktreePath)).toBe(false);

  // Second call must not throw
  expect(() => teardownWorktrees({ cwd: repoPath, dualImpl: state })).not.toThrow();
});

test("applyWinner cherry-picks commits from winning worktree branch onto main cwd", () => {
  const pair = createWorktrees({ cwd: repoPath, slug: "test-aw", phaseNumber: "3" });

  // Make a new commit in the gemini worktree
  fs.writeFileSync(path.join(pair.geminiWorktreePath, "winner.ts"), "export const x = 1;\n");
  git(["add", "."], pair.geminiWorktreePath);
  git(["commit", "-m", "gemini impl"], pair.geminiWorktreePath);

  const state: DualImplState = { ...pair };

  const result = applyWinner({ cwd: repoPath, winner: "gemini", dualImpl: state });

  expect(result.ok).toBe(true);
  // Winner's file should now exist in main cwd
  expect(fs.existsSync(path.join(repoPath, "winner.ts"))).toBe(true);
  expect(fs.readFileSync(path.join(repoPath, "winner.ts"), "utf8")).toContain("export const x = 1;");

  teardownWorktrees({ cwd: repoPath, dualImpl: state });

  // Clean up the cherry-picked file from main so future tests stay clean
  fs.rmSync(path.join(repoPath, "winner.ts"), { force: true });
  git(["add", "."], repoPath);
  git(["commit", "-m", "cleanup winner.ts"], repoPath);
});
