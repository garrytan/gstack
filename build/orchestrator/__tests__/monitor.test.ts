import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  evaluateMonitorOnce,
  loadMonitorManifest,
  monitorExitCode,
} from "../monitor";
import {
  buildMonitorAgentEscalation,
  buildMonitorAgentPrompt,
  parseMonitorAgentJson,
  shouldInvokeMonitorAgent,
} from "../monitor-supervisor";
import { lockPath } from "../state";
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

  it("removes a dead state lock before auto-resuming a stale run", () => {
    const data = manifest();
    const run = data.runs[0];
    writeState(run, {
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
    });
    const staleLock = lockPath(run.stateSlug);
    fs.writeFileSync(staleLock, "99999999\n2026-05-08T00:01:00.000Z\n");

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:04:00.000Z"),
      pollMs: 60_000,
      spawnResume: false,
    });

    expect(result.terminalEvent.event).toBe("RUN_RESUMED");
    expect(fs.existsSync(staleLock)).toBe(false);
  });

  it("does not remove a live state lock for a stale run", () => {
    const data = manifest();
    const run = data.runs[0];
    writeState(run, {
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
    });
    const liveLock = lockPath(run.stateSlug);
    fs.writeFileSync(liveLock, `${process.pid}\n2026-05-08T00:01:00.000Z\n`);

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:04:00.000Z"),
      pollMs: 60_000,
      spawnResume: false,
    });

    expect(result.terminalEvent.event).toBe("USER_ACTION_REQUIRED");
    expect(result.terminalEvent.message).toContain("lock is still held by a live process");
    expect(fs.existsSync(liveLock)).toBe(true);
  });

  it("requires user action when a stale run has an invalid state lock", () => {
    const data = manifest();
    const run = data.runs[0];
    writeState(run, {
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
    });
    const invalidLock = lockPath(run.stateSlug);
    fs.writeFileSync(invalidLock, "not-a-pid\n2026-05-08T00:01:00.000Z\n");

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:04:00.000Z"),
      pollMs: 60_000,
      spawnResume: false,
    });

    expect(result.terminalEvent.event).toBe("USER_ACTION_REQUIRED");
    expect(result.terminalEvent.message).toContain("cannot be safely verified");
    expect(fs.existsSync(invalidLock)).toBe(true);
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

describe("monitor agent supervisor", () => {
  const monitorAgent = {
    provider: "kimi" as const,
    model: "kimi-code/kimi-for-coding",
    reasoning: "high" as const,
  };

  it("does not invoke the agent for normal monitor re-entry", async () => {
    const data = manifest();
    const run = data.runs[0];
    writeState(run);
    const evaluation = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-08T00:00:30.000Z"),
      pollMs: 60_000,
    });
    expect(evaluation.terminalEvent.event).toBe("MONITOR_REENTER");
    expect(shouldInvokeMonitorAgent(evaluation.terminalEvent)).toBe(false);

    let invoked = false;
    const escalation = await buildMonitorAgentEscalation({
      manifestPath: writeManifest(data),
      evaluation,
      role: monitorAgent,
      runner: async () => {
        invoked = true;
        throw new Error("should not run");
      },
    });
    expect(escalation).toBeNull();
    expect(invoked).toBe(false);
  });

  it("skips monitorAgent for host-owned context-save events", async () => {
    const data = manifest();
    const run = data.runs[0];
    writeState(run, {
      phases: [{ index: 0, number: "1", name: "Phase", status: "committed" }],
    });
    const evaluation = evaluateMonitorOnce({ manifestPath: writeManifest(data) });
    expect(evaluation.terminalEvent.event).toBe("HOST_CONTEXT_SAVE_REQUIRED");
    expect(shouldInvokeMonitorAgent(evaluation.terminalEvent)).toBe(false);

    const escalation = await buildMonitorAgentEscalation({
      manifestPath: writeManifest(data),
      evaluation,
      role: monitorAgent,
      runner: async () => {
        throw new Error("should not run");
      },
    });
    expect(escalation).toBeNull();
  });

  it("invokes fake monitorAgent for RUN_FAILED and emits MONITOR_AGENT_ESCALATION", async () => {
    const data = manifest();
    const run = data.runs[0];
    writeState(run, {
      failedAtPhase: 0,
      failureReason: "tests failed",
      phases: [{ index: 0, number: "1", name: "Phase", status: "failed" }],
    });
    fs.mkdirSync(path.dirname(run.stdoutLog), { recursive: true });
    fs.writeFileSync(run.stdoutLog, "test output\nAssertionError\n");
    const manifestPath = writeManifest(data);
    const evaluation = evaluateMonitorOnce({ manifestPath });
    expect(shouldInvokeMonitorAgent(evaluation.terminalEvent)).toBe(true);
    let agentCwd = "";

    const escalation = await buildMonitorAgentEscalation({
      manifestPath,
      evaluation,
      role: monitorAgent,
      now: new Date("2026-05-08T01:00:00.000Z"),
      runner: async ({ outputFilePath, cwd }) => {
        agentCwd = cwd;
        const body = {
          verdict: "host_action_required",
          summary: "tests failed after implementation",
          attempted: ["read monitor event", "read log tail"],
          recommendedHostAction: "inspect failing test and relaunch monitor",
          suggestedCommands: [`gstack-build monitor --manifest ${manifestPath} --watch --supervise`],
          userChoices: [],
        };
        fs.writeFileSync(outputFilePath, JSON.stringify(body));
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          logPath: path.join(tmpDir, "agent.log"),
          durationMs: 1,
          retries: 0,
        };
      },
    });

    expect(escalation?.event).toBe("MONITOR_AGENT_ESCALATION");
    expect(escalation?.sourceEvent).toBe("RUN_FAILED");
    expect(escalation?.verdict).toBe("host_action_required");
    expect(escalation?.recommendedHostAction).toContain("inspect");
    expect(agentCwd).toContain("monitor-");
    expect(agentCwd).not.toBe(run.worktreePath);
    expect(monitorExitCode(escalation!.event)).toBe(11);
  });

  it("invokes fake monitorAgent for USER_ACTION_REQUIRED and MONITOR_ERROR", async () => {
    for (const eventName of ["USER_ACTION_REQUIRED", "MONITOR_ERROR"] as const) {
      const evaluation = {
        events: [
          {
            event: eventName,
            timestamp: "2026-05-08T00:00:00.000Z",
            message: "blocked",
          },
        ],
        terminalEvent: {
          event: eventName,
          timestamp: "2026-05-08T00:00:00.000Z",
          message: "blocked",
        },
      };
      const escalation = await buildMonitorAgentEscalation({
        manifestPath: path.join(tmpDir, "manifest.json"),
        evaluation,
        role: monitorAgent,
        runner: async ({ outputFilePath }) => {
          fs.writeFileSync(
            outputFilePath,
            JSON.stringify({
              verdict: "user_action_required",
              summary: `${eventName} diagnosis`,
              attempted: [],
              recommendedHostAction: "ask user",
              suggestedCommands: [],
              userChoices: ["continue", "stop"],
            }),
          );
          return {
            stdout: "",
            stderr: "",
            exitCode: 0,
            timedOut: false,
            logPath: path.join(tmpDir, "agent.log"),
            durationMs: 1,
            retries: 0,
          };
        },
      });
      expect(escalation?.event).toBe("MONITOR_AGENT_ESCALATION");
      expect(escalation?.sourceEvent).toBe(eventName);
      expect(escalation?.verdict).toBe("user_action_required");
    }
  });

  it("fails closed when monitorAgent returns malformed or empty JSON", async () => {
    const data = manifest();
    const run = data.runs[0];
    writeState(run, {
      failedAtPhase: 0,
      failureReason: "failed",
      phases: [{ index: 0, number: "1", name: "Phase", status: "failed" }],
    });
    const manifestPath = writeManifest(data);
    const evaluation = evaluateMonitorOnce({ manifestPath });
    const escalation = await buildMonitorAgentEscalation({
      manifestPath,
      evaluation,
      role: monitorAgent,
      runner: async () => ({
        stdout: "not json",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        logPath: path.join(tmpDir, "agent.log"),
        durationMs: 1,
        retries: 0,
      }),
    });
    expect(escalation?.event).toBe("MONITOR_AGENT_ESCALATION");
    expect(escalation?.verdict).toBe("host_action_required");
    expect(escalation?.summary).toContain("invalid JSON");
  });

  it("builds bounded prompts with truncated stdout log tails and safety rules", () => {
    const data = manifest();
    const run = data.runs[0];
    fs.mkdirSync(path.dirname(run.stdoutLog), { recursive: true });
    fs.writeFileSync(run.stdoutLog, `${"x".repeat(200)}TAIL`);
    const event = {
      event: "RUN_FAILED" as const,
      timestamp: "2026-05-08T00:00:00.000Z",
      runId: run.runId,
      message: "failed",
      stdoutLog: run.stdoutLog,
    };
    const prompt = buildMonitorAgentPrompt({
      manifestPath: writeManifest(data),
      manifest: data,
      event,
      role: monitorAgent,
      logTailChars: 12,
    });
    expect(prompt).toContain("Do not edit files, run shell commands");
    expect(prompt).toContain("Do not tell the host to do those things either");
    expect(prompt).toContain("exactly one JSON object");
    expect(prompt).toContain("[...truncated");
    expect(prompt).toContain("xxxxxxxxTAIL");
    expect(prompt).not.toContain("x".repeat(50));
  });

  it("parses fenced strict JSON output", () => {
    const parsed = parseMonitorAgentJson(`\`\`\`json
{"verdict":"no_action","summary":"ok","attempted":[],"recommendedHostAction":"none","suggestedCommands":[],"userChoices":[]}
\`\`\``);
    expect(parsed?.verdict).toBe("no_action");
    expect(parseMonitorAgentJson("{}")).toBeNull();
    expect(parseMonitorAgentJson('{"verdict":"no_action"}')).toBeNull();
  });
});
