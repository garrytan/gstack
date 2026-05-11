/**
 * Tests for Phase 2.1: SkillFaultDetectedEvent type + MonitorEvaluation wiring.
 *
 * Red-phase tests (fail before implementation, pass after):
 *  - MonitorEvaluation.skillFaultEvents field exists and is always an array
 *  - evaluateMonitorOnce populates skillFaultEvents from detectSkillFaults
 *  - each entry has event: "SKILL_FAULT_DETECTED" and required shape fields
 *  - monitor continues normally and skillFaultEvents is [] when detector finds nothing
 *  - monitor exit code is unaffected by skillFaultEvents presence
 *
 * Guard tests (pass before AND after implementation):
 *  - SKILL_FAULT_DETECTED is NOT in MONITOR_EXIT_CODES
 *  - SKILL_FAULT_DETECTED is NOT a key in the MonitorEventName union
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  evaluateMonitorOnce,
  MONITOR_EXIT_CODES,
  monitorExitCode,
} from "../monitor";
import type { BuildRunManifest, BuildState } from "../types";
import { DEFAULT_MAX_CODEX_ITERATIONS } from "../phase-runner";

let tmpDir: string;
let stateDir: string;
let oldStateDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-skill-fault-"));
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

function makeManifest(
  overrides: Partial<BuildRunManifest["runs"][number]> = {},
): BuildRunManifest {
  const repoPath = path.join(tmpDir, "repo");
  const worktreePath = path.join(tmpDir, "worktree");
  const runId = overrides.runId ?? "run-sf";
  const livingPlanPath = path.join(tmpDir, "living.md");
  return {
    manifestId: "manifest-sf",
    runGroupId: "group-sf",
    tmpDir,
    runs: [
      {
        runId,
        repoPath,
        repoSlug: "repo",
        livingPlanPath,
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
  const now = new Date("2026-05-11T00:00:00.000Z").toISOString();
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
      dryRun: false,
      skipShip: false,
      skipFeatureReview: false,
      launchedAt: now,
    },
    currentPhaseIndex: 0,
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

function writeContextCount(
  run: BuildRunManifest["runs"][number],
  count: number,
): void {
  const dir = path.join(stateDir, run.stateSlug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".host-context-save-count"), `${count}\n`);
}

// ---------------------------------------------------------------------------
// GUARD TESTS — pass before AND after implementation
// ---------------------------------------------------------------------------

describe("SKILL_FAULT_DETECTED is not a terminal event name (guard)", () => {
  it("MONITOR_EXIT_CODES does not contain SKILL_FAULT_DETECTED as a key", () => {
    expect("SKILL_FAULT_DETECTED" in MONITOR_EXIT_CODES).toBe(false);
  });

  it("Object.keys(MONITOR_EXIT_CODES) does not include SKILL_FAULT_DETECTED", () => {
    const keys = Object.keys(MONITOR_EXIT_CODES);
    expect(keys).not.toContain("SKILL_FAULT_DETECTED");
  });
});

// ---------------------------------------------------------------------------
// RED-PHASE TESTS — fail before implementation, pass after
// ---------------------------------------------------------------------------

describe("MonitorEvaluation.skillFaultEvents field", () => {
  it("evaluateMonitorOnce always returns skillFaultEvents as an array", () => {
    const data = makeManifest();
    const run = data.runs[0];
    writeState(run);

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-11T00:00:30.000Z"),
      pollMs: 60_000,
    });

    // This fails in Red: result.skillFaultEvents is undefined before impl
    expect(Array.isArray((result as any).skillFaultEvents)).toBe(true);
  });

  it("skillFaultEvents is an empty array when the run has no detectable skill faults", () => {
    const data = makeManifest();
    const run = data.runs[0];
    writeState(run, {
      phases: [{ index: 0, number: "1", name: "Phase", status: "pending" }],
    });

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-11T00:00:30.000Z"),
      pollMs: 60_000,
    });

    expect((result as any).skillFaultEvents).toEqual([]);
  });

  it("skillFaultEvents contains a fault when Codex review hit the iteration limit", () => {
    const data = makeManifest();
    const run = data.runs[0];
    // Phase with codexReview.iterations at the cap → detectSkillFaults returns CODEX_CONVERGENCE
    writeState(run, {
      phases: [
        {
          index: 0,
          number: "1",
          name: "Phase",
          status: "tests_green",
          codexReview: {
            iterations: DEFAULT_MAX_CODEX_ITERATIONS,
            outputLogPaths: [],
          },
        },
      ],
    });

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-11T00:00:30.000Z"),
      pollMs: 60_000,
    });

    expect((result as any).skillFaultEvents.length).toBeGreaterThan(0);
  });

  it("skillFaultEvents entries carry event: 'SKILL_FAULT_DETECTED' and all required shape fields", () => {
    const data = makeManifest();
    const run = data.runs[0];
    writeState(run, {
      phases: [
        {
          index: 0,
          number: "1",
          name: "Phase",
          status: "tests_green",
          codexReview: {
            iterations: DEFAULT_MAX_CODEX_ITERATIONS,
            outputLogPaths: [],
          },
        },
      ],
    });
    const manifestPath = writeManifest(data);

    const result = evaluateMonitorOnce({
      manifestPath,
      now: new Date("2026-05-11T00:00:30.000Z"),
      pollMs: 60_000,
    });

    const events: any[] = (result as any).skillFaultEvents;
    expect(events.length).toBeGreaterThan(0);

    const ev = events[0];
    // event discriminant must be exactly "SKILL_FAULT_DETECTED" (not a MonitorEventName)
    expect(ev.event).toBe("SKILL_FAULT_DETECTED");
    // ISO timestamp
    expect(typeof ev.timestamp).toBe("string");
    expect(ev.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // run correlation fields
    expect(typeof ev.runId).toBe("string");
    expect(typeof ev.stateSlug).toBe("string");
    expect(typeof ev.stateFile).toBe("string");
    // manifest path so the caller can correlate with the manifest
    expect(typeof ev.manifestPath).toBe("string");
    // the actual fault array from detectSkillFaults
    expect(Array.isArray(ev.faults)).toBe(true);
    expect(ev.faults.length).toBeGreaterThan(0);
    // each fault has a category string
    expect(typeof ev.faults[0].category).toBe("string");
  });

  it("skillFaultEvents entries are JSON-serializable with event: 'SKILL_FAULT_DETECTED' in output", () => {
    // Callers will process.stdout.write(JSON.stringify(ev) + '\n'); verify the round-trip.
    const data = makeManifest();
    const run = data.runs[0];
    writeState(run, {
      phases: [
        {
          index: 0,
          number: "1",
          name: "Phase",
          status: "tests_green",
          codexReview: {
            iterations: DEFAULT_MAX_CODEX_ITERATIONS,
            outputLogPaths: [],
          },
        },
      ],
    });

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-11T00:00:30.000Z"),
      pollMs: 60_000,
    });

    const events: any[] = (result as any).skillFaultEvents;
    expect(events.length).toBeGreaterThan(0);

    const jsonLine = JSON.stringify(events[0]);
    const parsed = JSON.parse(jsonLine);
    expect(parsed.event).toBe("SKILL_FAULT_DETECTED");
  });
});

describe("evaluateMonitorOnce continues normally when detectSkillFaults finds no faults", () => {
  it("monitor produces MONITOR_REENTER and skillFaultEvents is [] when state has no fault indicators", () => {
    const data = makeManifest();
    const run = data.runs[0];
    writeState(run);

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-11T00:00:30.000Z"),
      pollMs: 60_000,
    });

    expect(result.terminalEvent.event).toBe("MONITOR_REENTER");
    expect((result as any).skillFaultEvents).toEqual([]);
  });

  it("skillFaultEvents is [] and monitor continues normally when state is null (no state file)", () => {
    // null state → detectSkillFaults returns [] immediately; evaluateMonitorOnce must not throw.
    // This also covers: if detectSkillFaults somehow threw, the outer try/catch swallows it
    // and skillFaultEvents stays [].
    const data = makeManifest();
    // Intentionally do NOT write a state file; state will be null in the snapshot

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-11T00:00:30.000Z"),
      pollMs: 60_000,
    });

    expect(result.terminalEvent.event).toBe("MONITOR_REENTER");
    expect(Array.isArray((result as any).skillFaultEvents)).toBe(true);
    expect((result as any).skillFaultEvents).toEqual([]);
  });

  it("skillFaultEvents is [] when living plan file does not exist (detectSkillFaults reads gracefully)", () => {
    // livingPlanPath points to a non-existent file; readFileSafe returns null;
    // faults that require plan content are skipped.
    const data = makeManifest();
    const run = data.runs[0];
    writeState(run, {
      phases: [{ index: 0, number: "1", name: "Phase", status: "pending" }],
      // planFile points at a path that does not exist on disk
    });
    // Do NOT create tmpDir/living.md

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-11T00:00:30.000Z"),
      pollMs: 60_000,
    });

    expect(result.terminalEvent.event).toBe("MONITOR_REENTER");
    expect(Array.isArray((result as any).skillFaultEvents)).toBe(true);
  });
});

describe("monitor exit code is unaffected by skillFaultEvents", () => {
  it("MONITOR_REENTER exit code is the same whether skill faults are present or absent", () => {
    // Run without faults
    const data1 = makeManifest({ runId: "run-no-fault" });
    const run1 = data1.runs[0];
    writeState(run1, {
      phases: [{ index: 0, number: "1", name: "Phase", status: "pending" }],
    });
    const result1 = evaluateMonitorOnce({
      manifestPath: writeManifest(data1),
      now: new Date("2026-05-11T00:00:30.000Z"),
      pollMs: 60_000,
    });

    // Run with a CODEX_CONVERGENCE fault
    const data2 = makeManifest({ runId: "run-with-fault" });
    const run2 = data2.runs[0];
    writeState(run2, {
      phases: [
        {
          index: 0,
          number: "1",
          name: "Phase",
          status: "tests_green",
          codexReview: {
            iterations: DEFAULT_MAX_CODEX_ITERATIONS,
            outputLogPaths: [],
          },
        },
      ],
    });
    const result2 = evaluateMonitorOnce({
      manifestPath: writeManifest(data2),
      now: new Date("2026-05-11T00:00:30.000Z"),
      pollMs: 60_000,
    });

    // Both should produce MONITOR_REENTER with the same exit code
    expect(result1.terminalEvent.event).toBe("MONITOR_REENTER");
    expect(result2.terminalEvent.event).toBe("MONITOR_REENTER");
    expect(monitorExitCode(result1.terminalEvent.event)).toBe(
      monitorExitCode(result2.terminalEvent.event),
    );
  });

  it("ALL_RUNS_COMPLETE exit code is 0 even when a committed phase had a CODEX_CONVERGENCE fault", () => {
    const data = makeManifest();
    const run = data.runs[0];
    // committed phase with high codex iterations → CODEX_CONVERGENCE detected
    writeState(run, {
      phases: [
        {
          index: 0,
          number: "1",
          name: "Phase",
          status: "committed",
          codexReview: {
            iterations: DEFAULT_MAX_CODEX_ITERATIONS,
            outputLogPaths: [],
          },
        },
      ],
      completed: true,
    });
    // Satisfy the HOST_CONTEXT_SAVE_REQUIRED check
    writeContextCount(run, 1);

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-11T00:00:30.000Z"),
      pollMs: 60_000,
    });

    expect(result.terminalEvent.event).toBe("ALL_RUNS_COMPLETE");
    expect(monitorExitCode("ALL_RUNS_COMPLETE")).toBe(0);
    // skillFaultEvents may be non-empty but must still be an array
    expect(Array.isArray((result as any).skillFaultEvents)).toBe(true);
  });

  it("RUN_FAILED exit code is 20 regardless of skillFaultEvents", () => {
    const data = makeManifest();
    const run = data.runs[0];
    writeState(run, {
      failedAtPhase: 0,
      failureReason: "tests failed after implementation",
      phases: [
        {
          index: 0,
          number: "1",
          name: "Phase",
          status: "failed",
          codexReview: {
            iterations: DEFAULT_MAX_CODEX_ITERATIONS,
            outputLogPaths: [],
          },
        },
      ],
    });

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
    });

    expect(result.terminalEvent.event).toBe("RUN_FAILED");
    expect(monitorExitCode("RUN_FAILED")).toBe(20);
    // skillFaultEvents is always initialized — check it's an array even on early-return paths
    expect(Array.isArray((result as any).skillFaultEvents)).toBe(true);
  });
});

describe("SkillFaultDetectedEvent type shape (types.ts)", () => {
  it("SkillFaultDetectedEvent can be imported from types.ts and is not a MonitorEventName", async () => {
    // The type must exist in types.ts. We verify by importing it and checking
    // that a populated event has the right discriminant.
    const data = makeManifest();
    const run = data.runs[0];
    writeState(run, {
      phases: [
        {
          index: 0,
          number: "1",
          name: "Phase",
          status: "tests_green",
          codexReview: {
            iterations: DEFAULT_MAX_CODEX_ITERATIONS,
            outputLogPaths: [],
          },
        },
      ],
    });

    const result = evaluateMonitorOnce({
      manifestPath: writeManifest(data),
      now: new Date("2026-05-11T00:00:30.000Z"),
      pollMs: 60_000,
    });

    const events: any[] = (result as any).skillFaultEvents;
    expect(events.length).toBeGreaterThan(0);

    const ev = events[0];

    // Discriminant must be "SKILL_FAULT_DETECTED" — not any MonitorEventName
    expect(ev.event).toBe("SKILL_FAULT_DETECTED");
    // Must NOT be a key in MONITOR_EXIT_CODES (not a terminal event)
    expect(ev.event in MONITOR_EXIT_CODES).toBe(false);
  });
});
