import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  activeOwnedBranches,
  readActiveRunRecords,
  removeActiveRunRecord,
  writeActiveRunRecord,
  type ActiveRunRecord,
} from "../active-runs";

describe("active-run registry", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "active-runs-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function record(overrides: Partial<ActiveRunRecord> = {}): ActiveRunRecord {
    return {
      runId: "run-1",
      stateSlug: "build-run-1",
      repoPath: "/repo",
      planFile: "/plans/plan.md",
      pid: process.pid,
      status: "running",
      startedAt: "2026-05-08T00:00:00.000Z",
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
      branches: ["feat/run-1-auth"],
      ...overrides,
    };
  }

  it("writes, updates, and removes records", () => {
    writeActiveRunRecord(dir, record());
    expect(readActiveRunRecords(dir).map((r) => r.runId)).toEqual(["run-1"]);

    writeActiveRunRecord(dir, record({ branches: ["feat/run-1-auth", "feat/run-1-api"] }));
    expect(readActiveRunRecords(dir)[0].branches).toEqual([
      "feat/run-1-auth",
      "feat/run-1-api",
    ]);

    removeActiveRunRecord(dir, "run-1");
    expect(readActiveRunRecords(dir)).toEqual([]);
  });

  it("returns active owned branches and ignores stale terminal records", () => {
    writeActiveRunRecord(dir, record({ runId: "live", branches: ["feat/live"] }));
    writeActiveRunRecord(
      dir,
      record({
        runId: "stale-completed",
        pid: 99999999,
        status: "completed",
        branches: ["feat/stale"],
      }),
    );

    expect(activeOwnedBranches(dir)).toEqual(new Set(["feat/live"]));
  });

  it("scopes active owned branches to the requested repo identity", () => {
    writeActiveRunRecord(
      dir,
      record({
        runId: "repo-a",
        repoPath: "/repos/a",
        branches: ["feat/shared", "feat/a-only"],
      }),
    );
    writeActiveRunRecord(
      dir,
      record({
        runId: "repo-b",
        repoPath: "/repos/b",
        branches: ["feat/shared", "feat/b-only"],
      }),
    );

    expect(activeOwnedBranches(dir, { projectRoot: "/repos/a" })).toEqual(
      new Set(["feat/shared", "feat/a-only"]),
    );
    expect(activeOwnedBranches(dir, { projectRoot: "/repos/b" })).toEqual(
      new Set(["feat/shared", "feat/b-only"]),
    );
  });

  it("matches same-repo worktree records through baseProjectRoot", () => {
    writeActiveRunRecord(
      dir,
      record({
        runId: "worktree",
        repoPath: "/worktrees/a/run-1",
        baseProjectRoot: "/repos/a",
        branches: ["feat/worktree"],
      }),
    );

    expect(activeOwnedBranches(dir, { projectRoot: "/repos/a" })).toEqual(
      new Set(["feat/worktree"]),
    );
    expect(
      activeOwnedBranches(dir, {
        projectRoot: "/worktrees/a/run-1",
        baseProjectRoot: "/repos/a",
      }),
    ).toEqual(new Set(["feat/worktree"]));
    expect(activeOwnedBranches(dir, { projectRoot: "/repos/b" })).toEqual(
      new Set(),
    );
  });
});
