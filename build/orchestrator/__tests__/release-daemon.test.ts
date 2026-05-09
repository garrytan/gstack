import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createReleaseLockHeartbeat,
  processReleaseQueueRecord,
  runReleaseDaemon,
} from "../release-daemon";
import {
  readReleaseQueueRecords,
  writeReleaseQueueRecord,
  type ReleaseQueueRecord,
} from "../release-queue";
import { DEFAULT_ROLE_CONFIGS } from "../role-config";
import type { ReleaseLockHandle } from "../release-lock";
import type { SubAgentResult } from "../sub-agents";

describe("release daemon queue loop", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-release-daemon-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function record(overrides: Partial<ReleaseQueueRecord>): ReleaseQueueRecord {
    return {
      runId: "run",
      repoPath: "/repo",
      baseBranch: "main",
      featureBranch: "feat/a",
      prNumber: 1,
      version: "1.0.0.1",
      livingPlanPath: "/plans/living.md",
      worktreePath: "/worktree",
      queuedAt: "2026-05-09T00:00:00.000Z",
      status: "queued",
      ...overrides,
    };
  }

  function handle(overrides: Partial<ReleaseLockHandle> = {}): ReleaseLockHandle {
    return {
      ref: "refs/gstack/release-locks/github.com-acme-repo/main",
      ownerId: "owner",
      commit: "mine",
      repoPath: "/repo",
      repoIdentity: "github.com/acme/repo",
      baseBranch: "main",
      ...overrides,
    };
  }

  function result(overrides: Partial<SubAgentResult> = {}): SubAgentResult {
    return {
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      logPath: "/tmp/log",
      durationMs: 1,
      retries: 0,
      ...overrides,
    };
  }

  it("processes the oldest queued record once and ignores blocked records", async () => {
    writeReleaseQueueRecord(dir, record({
      prNumber: 3,
      queuedAt: "2026-05-09T00:03:00.000Z",
    }));
    writeReleaseQueueRecord(dir, record({
      prNumber: 2,
      queuedAt: "2026-05-09T00:02:00.000Z",
      status: "blocked",
    }));
    writeReleaseQueueRecord(dir, record({
      prNumber: 1,
      queuedAt: "2026-05-09T00:01:00.000Z",
    }));

    const processed: number[] = [];
    const exit = await runReleaseDaemon({
      queueDir: dir,
      once: true,
      roles: DEFAULT_ROLE_CONFIGS,
      log: () => {},
      processor: async (item) => {
        processed.push(item.prNumber);
        return { ...item, status: "landed" };
      },
    });

    expect(exit).toBe(0);
    expect(processed).toEqual([1]);
  });

  it("exits cleanly when the queue is empty", async () => {
    const messages: string[] = [];
    const exit = await runReleaseDaemon({
      queueDir: dir,
      once: true,
      roles: DEFAULT_ROLE_CONFIGS,
      log: (msg) => messages.push(msg),
    });
    expect(exit).toBe(0);
    expect(messages).toContain("release queue empty");
  });

  it("can process a globally discovered queued PR when no local record exists", async () => {
    const processed: number[] = [];
    const exit = await runReleaseDaemon({
      queueDir: dir,
      repoPath: "/repo",
      once: true,
      roles: DEFAULT_ROLE_CONFIGS,
      log: () => {},
      discoverRemote: () => ({ records: [record({ prNumber: 9 })] }),
      processor: async (item) => {
        processed.push(item.prNumber);
        return { ...item, status: "landed" };
      },
    });

    expect(exit).toBe(0);
    expect(processed).toEqual([9]);
  });

  it("heartbeat updates the current handle and records ownership loss", () => {
    const hb = createReleaseLockHeartbeat({
      cwd: "/repo",
      handle: handle(),
      refresh: () => ({ ok: true, handle: handle({ commit: "next" }) }),
    });
    hb.beat();
    expect(hb.currentHandle().commit).toBe("next");

    const lost = createReleaseLockHeartbeat({
      cwd: "/repo",
      handle: handle(),
      refresh: () => ({
        ok: false,
        lostOwnership: true,
        error: "release lock is no longer owned by this daemon",
      }),
    });
    lost.beat();
    expect(lost.lostOwnership()).toContain("no longer owned");
  });

  it("blocks a local queue record without a valid PR marker before landing", async () => {
    const item = writeReleaseQueueRecord(dir, record({ prNumber: 20 }));
    const processed = await processReleaseQueueRecord(item, {
      queueDir: dir,
      roles: DEFAULT_ROLE_CONFIGS,
      verifyQueued: () => ({ ok: false, error: "missing queued PR marker" }),
      land: async () => {
        throw new Error("land should not run");
      },
    });

    expect(processed.status).toBe("blocked");
    expect(processed.lastError).toContain("missing queued PR marker");
    expect(readReleaseQueueRecords(dir)[0].status).toBe("blocked");
  });

  it("blocks after landing when heartbeat loses ownership and does not drift-repair", async () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-release-worktree-"));
    const item = writeReleaseQueueRecord(dir, record({
      prNumber: 21,
      repoPath: worktree,
      worktreePath: worktree,
    }));
    let shipCalls = 0;
    const processed = await processReleaseQueueRecord(item, {
      queueDir: dir,
      roles: DEFAULT_ROLE_CONFIGS,
      heartbeatIntervalMs: 1,
      verifyQueued: () => ({ ok: true }),
      acquireLock: () => ({ acquired: true, handle: handle({ repoPath: worktree }) }),
      refreshLock: () => ({
        ok: false,
        lostOwnership: true,
        error: "release lock is no longer owned by this daemon",
      }),
      releaseLock: () => ({ ok: true }),
      land: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return result({
          exitCode: 1,
          stderr: "VERSION drift detected",
        });
      },
      ship: async () => {
        shipCalls++;
        return result();
      },
    });

    fs.rmSync(worktree, { recursive: true, force: true });
    expect(processed.status).toBe("blocked");
    expect(processed.lastError).toContain("ownership lost");
    expect(shipCalls).toBe(0);
  });
});
