import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertReleaseQueueTransition,
  discoverBuildQueuedPullRequests,
  markPrQueued,
  parseShipOutput,
  parseQueuedMarker,
  queuedMarker,
  readReleaseQueueRecords,
  releaseQueueRecordId,
  updateReleaseQueueRecord,
  verifyPrQueued,
  writeReleaseQueueRecord,
  type ReleaseQueueRecord,
} from "../release-queue";

describe("release queue registry", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-release-queue-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function record(overrides: Partial<ReleaseQueueRecord> = {}): ReleaseQueueRecord {
    return {
      runId: "run-1",
      repoPath: "/repo",
      baseBranch: "main",
      featureBranch: "feat/a",
      prNumber: 10,
      version: "1.2.3.4",
      livingPlanPath: "/plans/living.md",
      worktreePath: "/worktrees/a",
      queuedAt: "2026-05-09T00:00:00.000Z",
      status: "queued",
      ...overrides,
    };
  }

  it("writes, sorts, updates, and ignores corrupt records", () => {
    writeReleaseQueueRecord(dir, record({ prNumber: 12, queuedAt: "2026-05-09T00:02:00.000Z" }));
    writeReleaseQueueRecord(dir, record({ prNumber: 11, queuedAt: "2026-05-09T00:01:00.000Z" }));
    fs.writeFileSync(path.join(dir, "bad.json"), "{not json");

    const records = readReleaseQueueRecords(dir);
    expect(records.map((item) => item.prNumber)).toEqual([11, 12]);

    const updated = updateReleaseQueueRecord(dir, records[0], { status: "claiming" });
    expect(updated.status).toBe("claiming");
    expect(readReleaseQueueRecords(dir)[0].status).toBe("claiming");
  });

  it("enforces the typed state machine", () => {
    expect(() => assertReleaseQueueTransition("queued", "claiming")).not.toThrow();
    expect(() => assertReleaseQueueTransition("landed", "queued")).toThrow(
      "invalid release queue transition",
    );
  });

  it("parses PR number, URL, and version from /ship output", () => {
    const parsed = parseShipOutput(
      "Created PR #42: https://github.com/acme/repo/pull/42\nTitle: v1.2.3.4 feat: queue",
    );
    expect(parsed).toEqual({
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
      version: "1.2.3.4",
    });
  });

  it("round-trips the hidden queued PR marker", () => {
    const parsed = parseQueuedMarker(`body\n\n${queuedMarker(record({
      repoIdentity: "github.com/acme/repo",
    }))}`);
    expect(parsed?.runId).toBe("run-1");
    expect(parsed?.repoIdentity).toBe("github.com/acme/repo");
    expect(parsed?.livingPlanPath).toBe("/plans/living.md");
    expect(parsed?.worktreePath).toBe("/worktrees/a");
  });

  it("uses canonical repo identity for queue record ids across different local paths", () => {
    const left = releaseQueueRecordId(record({
      repoPath: "/Users/alice/repo",
      repoIdentity: "github.com/acme/repo",
      prNumber: 42,
    }));
    const right = releaseQueueRecordId(record({
      repoPath: "/home/bob/repo",
      repoIdentity: "github.com/acme/repo",
      prNumber: 42,
    }));
    expect(left).toBe(right);
    expect(left).toContain("github.com-acme-repo-main-pr-42");
  });

  it("discovers only build-queued same-repo PRs from GitHub labels and markers", () => {
    const queued = queuedMarker(record({
      prNumber: 5,
      queuedAt: "2026-05-09T00:05:00.000Z",
    }));
    const older = queuedMarker(record({
      runId: "run-older",
      prNumber: 4,
      queuedAt: "2026-05-09T00:04:00.000Z",
    }));
    const run = (() => ({
      status: 0,
      stdout: JSON.stringify([
        {
          number: 5,
          url: "https://github.com/acme/repo/pull/5",
          baseRefName: "main",
          headRefName: "feat/a",
          body: queued,
          isCrossRepository: false,
        },
        {
          number: 4,
          url: "https://github.com/acme/repo/pull/4",
          baseRefName: "main",
          headRefName: "feat/b",
          body: older,
          isCrossRepository: false,
        },
        {
          number: 3,
          url: "https://github.com/acme/repo/pull/3",
          baseRefName: "main",
          headRefName: "fork/branch",
          body: queued,
          isCrossRepository: true,
        },
        {
          number: 2,
          url: "https://github.com/acme/repo/pull/2",
          baseRefName: "main",
          headRefName: "manual",
          body: "no gstack marker",
          isCrossRepository: false,
        },
      ]),
      stderr: "",
    })) as never;

    const result = discoverBuildQueuedPullRequests("/local/repo", run);
    expect(result.error).toBeUndefined();
    expect(result.records.map((item) => item.prNumber)).toEqual([4, 5]);
    expect(result.records[0].repoPath).toBe("/local/repo");
    expect(result.records[0].featureBranch).toBe("feat/b");
  });

  it("verifies the queued PR label and hidden marker before daemon landing", () => {
    const body = queuedMarker(record({ prNumber: 42 }));
    const okRun = (() => ({
      status: 0,
      stdout: JSON.stringify({
        body,
        labels: [{ name: "gstack-release-queued" }],
      }),
      stderr: "",
      signal: null,
      output: [],
    })) as never;
    expect(verifyPrQueued("/repo", { prNumber: 42 }, okRun).ok).toBe(true);

    const missingMarker = (() => ({
      status: 0,
      stdout: JSON.stringify({
        body: "plain body",
        labels: [{ name: "gstack-release-queued" }],
      }),
      stderr: "",
      signal: null,
      output: [],
    })) as never;
    expect(verifyPrQueued("/repo", { prNumber: 42 }, missingMarker).ok).toBe(false);

    const missingLabel = (() => ({
      status: 0,
      stdout: JSON.stringify({ body, labels: [] }),
      stderr: "",
      signal: null,
      output: [],
    })) as never;
    expect(verifyPrQueued("/repo", { prNumber: 42 }, missingLabel).ok).toBe(false);
  });

  it("does not overwrite a PR body when reading the current body fails", () => {
    const calls: string[][] = [];
    const run = ((_cmd, args) => {
      calls.push(args);
      if (args[0] === "label") {
        return { status: 0, stdout: "", stderr: "", signal: null, output: [] };
      }
      if (args[0] === "pr" && args[1] === "edit" && args.includes("--add-label")) {
        return { status: 0, stdout: "", stderr: "", signal: null, output: [] };
      }
      if (args[0] === "pr" && args[1] === "view") {
        return { status: 1, stdout: "", stderr: "body unavailable", signal: null, output: [] };
      }
      return { status: 0, stdout: "", stderr: "", signal: null, output: [] };
    }) as never;

    const marked = markPrQueued("/repo", record({ prNumber: 77 }), run);
    expect(marked.ok).toBe(false);
    expect(marked.error).toContain("body unavailable");
    expect(calls.some((args) => args[0] === "pr" && args[1] === "edit" && args.includes("--body"))).toBe(false);
  });
});
