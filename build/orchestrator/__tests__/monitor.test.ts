import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  evaluateMonitorOnce,
  loadMonitorManifest,
  monitorExitCode,
} from "../monitor";
import type { BuildRunManifest, BuildState } from "../types";

let tmpDir: string;
let stateDir: string;
let oldStateDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-monitor-"));
  stateDir = path.join(tmpDir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  oldStateDir = process.env.GSTACK_BUILD_STATE_DIR;
  process.env.GSTACK_BUILD_STATE_DIR = stateDir;
});

afterEach(() => {
  if (oldStateDir) process.env.GSTACK_BUILD_STATE_DIR = oldStateDir;
  else delete process.env.GSTACK_BUILD_STATE_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function manifest(overrides: Partial<BuildRunManifest["runs"][number]> = {}): BuildRunManifest {
  const repoPath = path.join(tmpDir, "repo");
  const worktreePath = path.join(tmpDir, "worktree");
  const runId = overrides.runId ?? "run-a";
  return {
    manifestId: "manifest-a",
    runGroupId: "group-a",
    tmpDir,
    workspaceRoot: tmpDir,
    gstackRepo: path.join(tmpDir, "demo-gstack"),
    runs: [
      {
        runId,
        repoPath,
        repoSlug: "repo",
        sourcePlanPath: path.join(tmpDir, "demo-gstack", "inbox", "plan.md"),
        livingPlanPath: path.join(tmpDir, "living.md"),
        originPlanPath: path.join(tmpDir, "demo-gstack", "inbox", "plan.md"),
        worktreePath,
        stateSlug: `build-${runId}`,
        branchPrefix: `repo-${runId}`,
        pidFile: path.join(tmpDir, runId, "gstack-build.pid"),
        stdoutLog: path.join(tmpDir, runId, "agent-stdout.log"),
        launchCommand: [
          "/bin/echo",
          "resume",
          "--active-run-registry",
          path.join(tmpDir, "active-runs"),
        ],
        launchEnv: {},
        ...overrides,
      },
    ],
  };
}

function writeManifest(data: BuildRunManifest): string {
  const filePath = path.join(tmpDir, "manifest.json");
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

function writeState(
  run: BuildRunManifest["runs"][number],
  overrides: Partial<BuildState> = {},
): BuildState {
  const now = new Date("2026-05-08T00:00:00.000Z").toISOString();
  const state: BuildState = {
    planFile: run.livingPlanPath,
    planBasename: "living",
    slug: run.stateSlug,
    branch: "feat/test",
    startedAt: now,
    lastUpdatedAt: now,
    launch: {
      argv: run.launchCommand,
      projectRoot: run.worktreePath,
      baseProjectRoot: run.repoPath,
      runId: run.runId,
      branchPrefix: run.branchPrefix,
      activeRunRegistry: path.join(tmpDir, "active-runs"),
      stateSlug: run.stateSlug,
      originPlan: run.originPlanPath,
      dryRun: false,
      skipShip: false,
      skipFeatureReview: false,
      launchedAt: now,
    },
    currentPhaseIndex: 0,
    currentFeatureIndex: 0,
    features: [
      {
        index: 0,
        number: "1",
        name: "Feature",
        phaseIndexes: [0],
        status: "running",
      },
    ],
    phases: [{ index: 0, number: "1", name: "Phase", status: "pending" }],
    completed: false,
    ...overrides,
  };
  fs.writeFileSync(
    path.join(stateDir, `${run.stateSlug}.json`),
    JSON.stringify(state, null, 2),
  );
  return state;
}

function writeContextCount(run: BuildRunManifest["runs"][number], count: number): void {
  const dir = path.join(stateDir, run.stateSlug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".host-context-save-count"), `${count}\n`);
}

describe("loadMonitorManifest", () => {
  it("accepts manifest v2 runs with launchCommand", () => {
    const filePath = writeManifest(manifest());
    const loaded = loadMonitorManifest(filePath);
    expect(loaded.runs[0].launchCommand[0]).toBe("/bin/echo");
  });

  it("fails closed when launchCommand is missing", () => {
    const data = manifest();
    delete (data.runs[0] as any).launchCommand;
    const result = evaluateMonitorOnce({ manifestPath: writeManifest(data) });
    expect(result.terminalEvent.event).toBe("MONITOR_ERROR");
    expect(result.terminalEvent.message).toContain("launchCommand");
  });

  it("fails closed when required top-level manifest fields are missing", () => {
    const data = manifest();
    delete (data as any).manifestId;
    const result = evaluateMonitorOnce({ manifestPath: writeManifest(data) });
    expect(result.terminalEvent.event).toBe("MONITOR_ERROR");
    expect(result.terminalEvent.message).toContain("manifestId");
  });
});

describe("evaluateMonitorOnce", () => {
  it("emits HOST_CONTEXT_SAVE_REQUIRED when committed count advances", () => {
    const data = manifest();
    const run = data.runs[0];
    writeState(run, {
      phases: [{ index: 0, number: "1", name: "Phase", status: "committed" }],
    });
    const result = evaluateMonitorOnce({ manifestPath: writeManifest(data) });
    expect(result.terminalEvent.event).toBe("HOST_CONTEXT_SAVE_REQUIRED");
    expect(result.terminalEvent.committed).toBe(1);
    expect(monitorExitCode(result.terminalEvent.event)).toBe(10);
  });

  it("returns ALL_RUNS_COMPLETE only after host context-save count is current", () => {
    const data = manifest();
    const run = data.runs[0];
    writeState(run, {
      phases: [{ index: 0, number: "1", name: "Phase", status: "committed" }],
      completed: true,
    });
    writeContextCount(run, 1);
    const result = evaluateMonitorOnce({ manifestPath: writeManifest(data) });
    expect(result.terminalEvent.event).toBe("ALL_RUNS_COMPLETE");
    expect(monitorExitCode(result.terminalEvent.event)).toBe(0);
  });

  it("emits RUN_FAILED for failed state and preserves worktree ownership", () => {
    const data = manifest();
    const run = data.runs[0];
    writeState(run, {
      failedAtPhase: 0,
      failureReason: "tests failed",
      phases: [{ index: 0, number: "1", name: "Phase", status: "failed" }],
    });
    const result = evaluateMonitorOnce({ manifestPath: writeManifest(data) });
    expect(result.terminalEvent.event).toBe("RUN_FAILED");
    expect(result.terminalEvent.stdoutLog).toBe(run.stdoutLog);
    expect(monitorExitCode(result.terminalEvent.event)).toBe(20);
  });

  it("auto-resumes stale dead runs only when identity matches", () => {
    const data = manifest();
    const run = data.runs[0];
    writeState(run, {
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
    });
    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:04:00.000Z"),
      pollMs: 60_000,
      spawnResume: false,
    });
    expect(result.terminalEvent.event).toBe("RUN_RESUMED");
    expect(result.terminalEvent.resumeAttempted).toBe(true);
  });

  it("requires user action when stale run identity is ambiguous", () => {
    const data = manifest();
    const run = data.runs[0];
    writeState(run, {
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
      launch: {
        argv: run.launchCommand,
        projectRoot: path.join(tmpDir, "wrong-worktree"),
        baseProjectRoot: run.repoPath,
        runId: run.runId,
        branchPrefix: run.branchPrefix,
        activeRunRegistry: path.join(tmpDir, "active-runs"),
        stateSlug: run.stateSlug,
        dryRun: false,
        skipShip: false,
        skipFeatureReview: false,
        launchedAt: "2026-05-08T00:00:00.000Z",
      },
    });
    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:04:00.000Z"),
      pollMs: 60_000,
      spawnResume: false,
    });
    expect(result.terminalEvent.event).toBe("USER_ACTION_REQUIRED");
    expect(result.terminalEvent.message).toContain("ambiguous");
  });

  it("requires user action when the active-run registry points at another repo", () => {
    const data = manifest();
    const run = data.runs[0];
    const registryDir = path.join(tmpDir, "active-runs");
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, `${run.runId}.json`),
      JSON.stringify({
        runId: run.runId,
        stateSlug: run.stateSlug,
        repoPath: path.join(tmpDir, "another-repo"),
        planFile: run.livingPlanPath,
        pid: process.pid,
        status: "running",
        startedAt: "2026-05-08T00:00:00.000Z",
        lastUpdatedAt: "2026-05-08T00:00:00.000Z",
        branches: [],
      }),
    );
    writeState(run, {
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
    });

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:04:00.000Z"),
      pollMs: 60_000,
      spawnResume: false,
    });

    expect(result.terminalEvent.event).toBe("USER_ACTION_REQUIRED");
    expect(result.terminalEvent.message).toContain("ambiguous");
  });

  it("requires user action when a stale run still has a live active-run owner", () => {
    const data = manifest();
    const run = data.runs[0];
    const registryDir = path.join(tmpDir, "active-runs");
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, `${run.runId}.json`),
      JSON.stringify({
        runId: run.runId,
        stateSlug: run.stateSlug,
        repoPath: run.worktreePath,
        baseProjectRoot: run.repoPath,
        planFile: run.livingPlanPath,
        pid: process.pid,
        status: "running",
        startedAt: "2026-05-08T00:00:00.000Z",
        lastUpdatedAt: "2026-05-08T00:00:00.000Z",
        branches: [],
      }),
    );
    writeState(run, {
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
    });

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:04:00.000Z"),
      pollMs: 60_000,
      spawnResume: false,
    });

    expect(result.terminalEvent.event).toBe("USER_ACTION_REQUIRED");
    expect(result.terminalEvent.message).toContain("active-run registry owner");
  });

  it("emits MONITOR_ERROR instead of crashing when the resume executable is missing", () => {
    const data = manifest({
      launchCommand: [path.join(tmpDir, "missing-gstack-build")],
    });
    const run = data.runs[0];
    fs.mkdirSync(run.worktreePath, { recursive: true });
    writeState(run, {
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
    });

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:04:00.000Z"),
      pollMs: 60_000,
    });

    expect(result.terminalEvent.event).toBe("MONITOR_ERROR");
    expect(result.terminalEvent.message).toContain("resume executable not found");
  });
});
