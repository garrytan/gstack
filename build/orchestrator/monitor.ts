import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  activeRunRecordPath,
  defaultActiveRunRegistryDir,
  isPidAlive,
  readActiveRunRecords,
} from "./active-runs";
import { sourcePlanClaimPaths } from "./plan-claims";
import { lockPath, statePath } from "./state";
import type {
  BuildRunManifest,
  BuildRunManifestRun,
  BuildState,
  PhaseStatus,
} from "./types";

export type MonitorEventName =
  | "RUN_RUNNING"
  | "RUN_STALE"
  | "RUN_RESUMED"
  | "HOST_CONTEXT_SAVE_REQUIRED"
  | "USER_ACTION_REQUIRED"
  | "RUN_FAILED"
  | "ALL_RUNS_COMPLETE"
  | "MONITOR_ERROR"
  | "MONITOR_REENTER"
  | "MONITOR_AGENT_ESCALATION";

export const MONITOR_EXIT_CODES: Record<MonitorEventName, number> = {
  RUN_RUNNING: 12,
  RUN_STALE: 12,
  RUN_RESUMED: 12,
  HOST_CONTEXT_SAVE_REQUIRED: 10,
  USER_ACTION_REQUIRED: 11,
  RUN_FAILED: 20,
  ALL_RUNS_COMPLETE: 0,
  MONITOR_ERROR: 30,
  MONITOR_REENTER: 12,
  MONITOR_AGENT_ESCALATION: 11,
};

export interface MonitorEvent {
  event: MonitorEventName;
  timestamp: string;
  runId?: string;
  repoSlug?: string;
  stateSlug?: string;
  status?: string;
  message: string;
  committed?: number;
  countFile?: string;
  pidFile?: string;
  stateFile?: string;
  stdoutLog?: string;
  resumeAttempted?: boolean;
  exitCode?: number;
  sourceEvent?: MonitorEventName;
  verdict?: "host_action_required" | "user_action_required" | "no_action";
  summary?: string;
  attempted?: string[];
  recommendedHostAction?: string;
  suggestedCommands?: string[];
  userChoices?: string[];
  originalExitCode?: number;
  monitorAgent?: {
    provider?: string;
    model?: string;
    timedOut?: boolean;
    exitCode?: number;
    logPath?: string;
    outputPath?: string;
  };
}

interface MonitorRunSnapshot {
  run: BuildRunManifestRun;
  stateFile: string;
  state: BuildState | null;
  stateError?: string;
  pid: number | null;
  pidAlive: boolean;
  registryPidAlive: boolean;
  registryOk: boolean;
  identityOk: boolean;
  completed: boolean;
  failed: boolean;
  committedCount: number;
  contextSaveCountFile: string;
  priorContextSaveCount: number;
  lastUpdatedAtMs: number | null;
  recentProcessActivity: boolean;
  stale: boolean;
}

export interface MonitorOnceOptions {
  manifestPath: string;
  pollMs?: number;
  now?: Date;
  spawnResume?: boolean;
}

export interface MonitorEvaluation {
  manifest?: BuildRunManifest;
  events: MonitorEvent[];
  terminalEvent: MonitorEvent;
}

function nowIso(now: Date | undefined): string {
  return (now ?? new Date()).toISOString();
}

function event(args: Omit<MonitorEvent, "timestamp">, now?: Date): MonitorEvent {
  return { timestamp: nowIso(now), ...args };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requireString(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`manifest run missing ${field}`);
  }
  return value;
}

function requireStringArray(
  obj: Record<string, unknown>,
  field: string,
): string[] {
  const value = obj[field];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    throw new Error(`manifest run missing ${field}`);
  }
  return [...value] as string[];
}

function optionalString(obj: Record<string, unknown>, field: string): string | undefined {
  const value = obj[field];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalStringRecord(
  obj: Record<string, unknown>,
  field: string,
): Record<string, string> | undefined {
  const value = obj[field];
  if (value == null) return undefined;
  const record = asObject(value);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string") {
      throw new Error(`manifest run ${field}.${key} must be a string`);
    }
    out[key] = item;
  }
  return out;
}

export function loadMonitorManifest(manifestPath: string): BuildRunManifest {
  const raw = fs.readFileSync(manifestPath, "utf8");
  const parsed = asObject(JSON.parse(raw));
  const manifestId = requireString(parsed, "manifestId");
  const runGroupId = requireString(parsed, "runGroupId");
  const tmpDir = path.resolve(requireString(parsed, "tmpDir"));
  const runsRaw = parsed.runs;
  if (!Array.isArray(runsRaw) || runsRaw.length === 0) {
    throw new Error("manifest missing non-empty runs array");
  }
  const runs: BuildRunManifestRun[] = runsRaw.map((rawRun) => {
    const run = asObject(rawRun);
    return {
      runId: requireString(run, "runId"),
      repoPath: path.resolve(requireString(run, "repoPath")),
      repoSlug: requireString(run, "repoSlug"),
      sourcePlanPath: optionalString(run, "sourcePlanPath"),
      livingPlanPath: path.resolve(requireString(run, "livingPlanPath")),
      originPlanPath: optionalString(run, "originPlanPath"),
      worktreePath: path.resolve(requireString(run, "worktreePath")),
      stateSlug: requireString(run, "stateSlug"),
      branchPrefix: requireString(run, "branchPrefix"),
      pidFile: path.resolve(requireString(run, "pidFile")),
      stdoutLog: path.resolve(requireString(run, "stdoutLog")),
      launchCommand: requireStringArray(run, "launchCommand"),
      launchEnv: optionalStringRecord(run, "launchEnv"),
    };
  });
  return {
    manifestId,
    runGroupId,
    tmpDir,
    workspaceRoot:
      typeof parsed.workspaceRoot === "string"
        ? path.resolve(parsed.workspaceRoot)
        : undefined,
    gstackRepo:
      typeof parsed.gstackRepo === "string"
        ? path.resolve(parsed.gstackRepo)
        : undefined,
    runs,
  };
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function readPid(pidFile: string): number | null {
  try {
    const raw = fs.readFileSync(pidFile, "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function fileMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function registryDirFromLaunchCommand(run: BuildRunManifestRun): string {
  const idx = run.launchCommand.indexOf("--active-run-registry");
  if (idx >= 0 && run.launchCommand[idx + 1]) {
    return path.resolve(run.launchCommand[idx + 1]);
  }
  return defaultActiveRunRegistryDir();
}

function normalizeRepoIdentity(repoPath: string | undefined): string | undefined {
  return repoPath ? path.resolve(repoPath) : undefined;
}

function registryRunInfo(run: BuildRunManifestRun): {
  ok: boolean;
  liveOwner: boolean;
} {
  const registryDir = registryDirFromLaunchCommand(run);
  const records = readActiveRunRecords(registryDir).filter(
    (record) => record.runId === run.runId,
  );
  if (records.length === 0) return { ok: true, liveOwner: false };
  const expected = normalizeRepoIdentity(run.repoPath);
  const ok = records.every((record) => {
    const actual = normalizeRepoIdentity(record.baseProjectRoot ?? record.repoPath);
    return actual === expected;
  });
  const liveOwner = records.some(
    (record) =>
      record.status !== "completed" &&
      record.status !== "failed" &&
      isPidAlive(record.pid),
  );
  return { ok, liveOwner };
}

function stateMatchesRun(state: BuildState, run: BuildRunManifestRun): boolean {
  return (
    state.slug === run.stateSlug &&
    state.planFile === run.livingPlanPath &&
    state.launch?.runId === run.runId &&
    path.resolve(state.launch?.projectRoot ?? "") === run.worktreePath &&
    path.resolve(state.launch?.baseProjectRoot ?? "") === run.repoPath
  );
}

function committedPhaseCount(state: BuildState | null): number {
  return (state?.phases ?? []).filter((phase) => phase.status === "committed")
    .length;
}

function phaseStatus(state: BuildState | null): PhaseStatus | "missing" {
  if (!state) return "missing";
  return state.phases[state.currentPhaseIndex]?.status ?? "pending";
}

function readContextSaveCount(filePath: string): number {
  try {
    const value = Number(fs.readFileSync(filePath, "utf8").trim());
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function lockPid(slug: string): number | null {
  try {
    const firstLine = fs.readFileSync(lockPath(slug), "utf8").split(/\r?\n/)[0];
    const pid = Number(firstLine.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function removeDeadLock(slug: string): void {
  const pid = lockPid(slug);
  if (pid && isPidAlive(pid)) return;
  try {
    fs.unlinkSync(lockPath(slug));
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }
}

function readRunSnapshot(
  run: BuildRunManifestRun,
  pollMs: number,
  now: Date,
): MonitorRunSnapshot {
  const stateFile = statePath(run.stateSlug);
  let state: BuildState | null = null;
  let stateError: string | undefined;
  try {
    state = readJsonFile<BuildState>(stateFile);
  } catch (err) {
    stateError = (err as Error).message;
  }
  const pid = readPid(run.pidFile);
  const pidAlive = pid != null && isPidAlive(pid);
  const registry = registryRunInfo(run);
  const registryOk = registry.ok;
  const identityOk = state ? stateMatchesRun(state, run) && registryOk : registryOk;
  const committedCount = committedPhaseCount(state);
  const staleWindowMs = Math.max(3 * pollMs, 1_000);
  const contextSaveCountFile = path.join(
    path.dirname(stateFile),
    run.stateSlug,
    ".host-context-save-count",
  );
  const lastUpdatedAtMs = state?.lastUpdatedAt
    ? Date.parse(state.lastUpdatedAt)
    : null;
  const recentProcessActivity = [fileMtimeMs(run.pidFile), fileMtimeMs(run.stdoutLog)].some(
    (mtime) => mtime != null && now.getTime() - mtime < staleWindowMs,
  );
  return {
    run,
    stateFile,
    state,
    stateError,
    pid,
    pidAlive,
    registryPidAlive: registry.liveOwner,
    registryOk,
    identityOk,
    completed: state?.completed === true,
    failed: state?.failedAtPhase != null || Boolean(state?.failureReason),
    committedCount,
    contextSaveCountFile,
    priorContextSaveCount: readContextSaveCount(contextSaveCountFile),
    lastUpdatedAtMs: Number.isFinite(lastUpdatedAtMs) ? lastUpdatedAtMs : null,
    recentProcessActivity,
    stale:
      lastUpdatedAtMs != null &&
      now.getTime() - lastUpdatedAtMs >= staleWindowMs,
  };
}

function writeClaimStatus(
  manifest: BuildRunManifest,
  run: BuildRunManifestRun,
  status: "completed" | "failed",
  now: Date,
): void {
  if (!manifest.gstackRepo) return;
  const sourcePlanPath = run.sourcePlanPath ?? run.originPlanPath;
  if (!sourcePlanPath) return;
  if (path.dirname(path.resolve(sourcePlanPath)) !== path.join(manifest.gstackRepo, "inbox")) {
    return;
  }
  const claimPath = sourcePlanClaimPaths(manifest.gstackRepo, sourcePlanPath).find(
    (candidatePath) => fs.existsSync(candidatePath),
  );
  if (!claimPath) return;
  const claim = readJsonFile<Record<string, any>>(claimPath);
  if (!claim) return;
  const updatedAt = now.toISOString();
  const timeField = status === "completed" ? "completedAt" : "failedAt";
  claim.runStatuses = claim.runStatuses ?? {};
  claim.runStatuses[run.runId] = {
    status,
    updatedAt,
    [timeField]: updatedAt,
  };
  const runIds = Array.isArray(claim.runIds) ? claim.runIds : [run.runId];
  const allTerminal = runIds.every((id: string) =>
    ["completed", "failed"].includes(claim.runStatuses?.[id]?.status ?? ""),
  );
  const allCompleted =
    runIds.length > 0 &&
    runIds.every(
      (id: string) => claim.runStatuses?.[id]?.status === "completed",
    );
  const anyFailed = runIds.some(
    (id: string) => claim.runStatuses?.[id]?.status === "failed",
  );
  claim.status = allCompleted ? "completed" : allTerminal && anyFailed ? "failed" : "running";
  claim.updatedAt = updatedAt;
  if (claim.status === "completed") {
    claim.completedAt = updatedAt;
    delete claim.failedAt;
  } else if (claim.status === "failed") {
    claim.failedAt = updatedAt;
    delete claim.completedAt;
  } else {
    delete claim.completedAt;
    delete claim.failedAt;
  }
  const tmpPath = `${claimPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(claim, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.renameSync(tmpPath, claimPath);
}

function cleanupCompletedWorktree(run: BuildRunManifestRun): void {
  const ok = spawnSync("git", ["-C", run.worktreePath, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
  });
  if (ok.status !== 0) return;
  const removed = spawnSync("git", ["-C", run.repoPath, "worktree", "remove", run.worktreePath], {
    encoding: "utf8",
  });
  if (removed.status !== 0) {
    console.warn(
      `[monitor] worktree cleanup failed for completed run ${run.runId}: ${removed.stderr || removed.stdout}`,
    );
  }
}

function spawnResume(run: BuildRunManifestRun): number {
  fs.mkdirSync(path.dirname(run.pidFile), { recursive: true });
  fs.mkdirSync(path.dirname(run.stdoutLog), { recursive: true });
  if (path.isAbsolute(run.launchCommand[0]) && !fs.existsSync(run.launchCommand[0])) {
    throw new Error(`resume executable not found: ${run.launchCommand[0]}`);
  }
  const outFd = fs.openSync(run.stdoutLog, "a");
  try {
    const child = spawn(run.launchCommand[0], run.launchCommand.slice(1), {
      cwd: run.worktreePath,
      detached: true,
      stdio: ["ignore", outFd, outFd],
      env: { ...process.env, ...(run.launchEnv ?? {}) },
    });
    fs.writeFileSync(run.pidFile, `${child.pid}\n`);
    child.unref();
    return child.pid ?? 0;
  } finally {
    fs.closeSync(outFd);
  }
}

function runEvent(
  name: MonitorEventName,
  snapshot: MonitorRunSnapshot,
  message: string,
  now: Date,
  extra: Partial<MonitorEvent> = {},
): MonitorEvent {
  return event(
    {
      event: name,
      runId: snapshot.run.runId,
      repoSlug: snapshot.run.repoSlug,
      stateSlug: snapshot.run.stateSlug,
      status: phaseStatus(snapshot.state),
      message,
      pidFile: snapshot.run.pidFile,
      stateFile: snapshot.stateFile,
      stdoutLog: snapshot.run.stdoutLog,
      ...extra,
    },
    now,
  );
}

export function evaluateMonitorOnce(
  opts: MonitorOnceOptions,
): MonitorEvaluation {
  const now = opts.now ?? new Date();
  const pollMs = opts.pollMs ?? 60_000;
  try {
    const manifest = loadMonitorManifest(opts.manifestPath);
    const events: MonitorEvent[] = [];
    const snapshots = manifest.runs.map((run) =>
      readRunSnapshot(run, pollMs, now),
    );

    for (const snapshot of snapshots) {
      if (snapshot.stateError) {
        const terminalEvent = runEvent(
          "MONITOR_ERROR",
          snapshot,
          `state file is unreadable: ${snapshot.stateError}`,
          now,
        );
        return { manifest, events: [...events, terminalEvent], terminalEvent };
      }
      if (!snapshot.registryOk || (snapshot.state && !snapshot.identityOk)) {
        const terminalEvent = runEvent(
          "USER_ACTION_REQUIRED",
          snapshot,
          "run identity is ambiguous; refusing automatic recovery",
          now,
        );
        return { manifest, events: [...events, terminalEvent], terminalEvent };
      }
      if (
        snapshot.committedCount > snapshot.priorContextSaveCount &&
        snapshot.committedCount > 0
      ) {
        const terminalEvent = runEvent(
          "HOST_CONTEXT_SAVE_REQUIRED",
          snapshot,
          "host session must run /context-save before monitoring continues",
          now,
          {
            committed: snapshot.committedCount,
            countFile: snapshot.contextSaveCountFile,
          },
        );
        return { manifest, events: [...events, terminalEvent], terminalEvent };
      }
      if (snapshot.failed) {
        writeClaimStatus(manifest, snapshot.run, "failed", now);
        const terminalEvent = runEvent(
          "RUN_FAILED",
          snapshot,
          snapshot.state?.failureReason ?? "build run failed",
          now,
        );
        return { manifest, events: [...events, terminalEvent], terminalEvent };
      }
      if (snapshot.completed) {
        writeClaimStatus(manifest, snapshot.run, "completed", now);
        cleanupCompletedWorktree(snapshot.run);
        events.push(
          runEvent("RUN_RUNNING", snapshot, "run is complete", now, {
            status: "completed",
          }),
        );
        continue;
      }
      if (snapshot.stale) {
        if (snapshot.pidAlive || snapshot.registryPidAlive) {
          if (snapshot.recentProcessActivity) {
            events.push(
              runEvent(
                "RUN_RUNNING",
                snapshot,
                "run process is alive; waiting for state update",
                now,
              ),
            );
            continue;
          }
          const terminalEvent = runEvent(
            "USER_ACTION_REQUIRED",
            snapshot,
            "run process or active-run registry owner is alive but state is stale",
            now,
          );
          return { manifest, events: [...events, terminalEvent], terminalEvent };
        }
        const lock = lockPid(snapshot.run.stateSlug);
        if (lock && isPidAlive(lock)) {
          const terminalEvent = runEvent(
            "USER_ACTION_REQUIRED",
            snapshot,
            "run state is stale but its lock is still held by a live process",
            now,
          );
          return { manifest, events: [...events, terminalEvent], terminalEvent };
        }
        if (!snapshot.state || !snapshot.identityOk) {
          const terminalEvent = runEvent(
            "USER_ACTION_REQUIRED",
            snapshot,
            "run is stale but identity could not be proven",
            now,
          );
          return { manifest, events: [...events, terminalEvent], terminalEvent };
        }
        removeDeadLock(snapshot.run.stateSlug);
        let resumedPid = 0;
        if (opts.spawnResume !== false) {
          resumedPid = spawnResume(snapshot.run);
        }
        const terminalEvent = runEvent(
          "RUN_RESUMED",
          snapshot,
          resumedPid > 0
            ? `stale run auto-resumed as pid ${resumedPid}`
            : "stale run would be auto-resumed",
          now,
          { resumeAttempted: true },
        );
        return { manifest, events: [...events, terminalEvent], terminalEvent };
      }
      events.push(
        runEvent(
          snapshot.pidAlive || snapshot.registryPidAlive ? "RUN_RUNNING" : "RUN_STALE",
          snapshot,
          snapshot.pidAlive || snapshot.registryPidAlive
            ? "run process is alive"
            : "run process not found; waiting for state or stale threshold",
          now,
        ),
      );
    }

    const allComplete = snapshots.every((snapshot) => snapshot.completed);
    const terminalEvent = event(
      {
        event: allComplete ? "ALL_RUNS_COMPLETE" : "MONITOR_REENTER",
        message: allComplete
          ? "all manifest runs are complete"
          : "monitor pass complete; no terminal action required",
      },
      now,
    );
    return { manifest, events: [...events, terminalEvent], terminalEvent };
  } catch (err) {
    const terminalEvent = event(
      {
        event: "MONITOR_ERROR",
        message: (err as Error).message,
      },
      now,
    );
    return { events: [terminalEvent], terminalEvent };
  }
}

export function monitorExitCode(name: MonitorEventName): number {
  return MONITOR_EXIT_CODES[name] ?? 30;
}

export function activeRunRegistryPathForRun(run: BuildRunManifestRun): string {
  return activeRunRecordPath(registryDirFromLaunchCommand(run), run.runId);
}
