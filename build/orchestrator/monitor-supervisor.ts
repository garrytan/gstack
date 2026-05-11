import * as fs from "node:fs";
import * as path from "node:path";
import { envNumberOrDefault } from "./build-config";
import type { RoleConfig } from "./role-config";
import { roleLabel } from "./role-config";
import { logDir } from "./state";
import { runConfiguredRoleTask, type SubAgentResult } from "./sub-agents";
import type { BuildRunManifest, BuildRunManifestRun, BuildState } from "./types";
import type { MonitorEvaluation, MonitorEvent } from "./monitor";
import { monitorExitCode } from "./monitor";

const BLOCKING_SUPERVISOR_EVENTS = new Set([
  "RUN_FAILED",
  "USER_ACTION_REQUIRED",
  "MONITOR_ERROR",
]);

const DEFAULT_LOG_TAIL_CHARS = 16_000;
const MONITOR_AGENT_TIMEOUT_MS = envNumberOrDefault(
  "GSTACK_BUILD_MONITOR_AGENT_TIMEOUT_MS",
  600_000,
);

export type MonitorAgentVerdict =
  | "host_action_required"
  | "user_action_required"
  | "no_action";

export interface MonitorAgentJson {
  verdict: MonitorAgentVerdict;
  summary: string;
  attempted: string[];
  recommendedHostAction: string;
  suggestedCommands: string[];
  userChoices: string[];
}

export interface MonitorAgentRunnerOptions {
  inputFilePath: string;
  outputFilePath: string;
  cwd: string;
  slug: string;
  logPrefix: string;
  role: RoleConfig;
  timeoutMs: number;
}

export type MonitorAgentRunner = (
  opts: MonitorAgentRunnerOptions,
) => Promise<SubAgentResult>;

export function shouldInvokeMonitorAgent(event: MonitorEvent): boolean {
  return BLOCKING_SUPERVISOR_EVENTS.has(event.event);
}

function safeSlug(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "monitor"
  );
}

function readJsonSummary(filePath: string | undefined): unknown {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as BuildState;
    return {
      slug: parsed.slug,
      branch: parsed.branch,
      planFile: parsed.planFile,
      currentFeatureIndex: parsed.currentFeatureIndex,
      currentPhaseIndex: parsed.currentPhaseIndex,
      completed: parsed.completed,
      failedAtPhase: parsed.failedAtPhase,
      failureReason: parsed.failureReason,
      features: (parsed.features ?? []).map((feature) => ({
        number: feature.number,
        name: feature.name,
        status: feature.status,
      })),
      phases: parsed.phases.map((phase) => ({
        number: phase.number,
        name: phase.name,
        status: phase.status,
      })),
    };
  } catch (err) {
    return { error: (err as Error).message, path: filePath };
  }
}

function tailFile(filePath: string | undefined, maxChars: number): string {
  if (!filePath || !fs.existsSync(filePath)) return "";
  const raw = fs.readFileSync(filePath, "utf8");
  if (raw.length <= maxChars) return raw;
  const omitted = raw.length - maxChars;
  return `[...truncated ${omitted} chars from start...]\n${raw.slice(-maxChars)}`;
}

function findRun(
  manifest: BuildRunManifest | undefined,
  event: MonitorEvent,
): BuildRunManifestRun | undefined {
  if (!manifest) return undefined;
  if (event.runId) {
    return manifest.runs.find((run) => run.runId === event.runId);
  }
  return manifest.runs[0];
}

export function buildMonitorAgentPrompt(opts: {
  manifestPath: string;
  manifest?: BuildRunManifest;
  event: MonitorEvent;
  role: RoleConfig;
  logTailChars?: number;
}): string {
  const run = findRun(opts.manifest, opts.event);
  const logTail = tailFile(
    opts.event.stdoutLog ?? run?.stdoutLog,
    opts.logTailChars ?? DEFAULT_LOG_TAIL_CHARS,
  );
  const context = {
    monitorEvent: opts.event,
    role: roleLabel(opts.role),
    manifestPath: opts.manifestPath,
    manifest: opts.manifest
      ? {
          manifestId: opts.manifest.manifestId,
          runGroupId: opts.manifest.runGroupId,
          tmpDir: opts.manifest.tmpDir,
          workspaceRoot: opts.manifest.workspaceRoot,
          gstackRepo: opts.manifest.gstackRepo,
          runs: opts.manifest.runs.map((item) => ({
            runId: item.runId,
            repoPath: item.repoPath,
            repoSlug: item.repoSlug,
            sourcePlanPath: item.sourcePlanPath,
            livingPlanPath: item.livingPlanPath,
            originPlanPath: item.originPlanPath,
            worktreePath: item.worktreePath,
            stateSlug: item.stateSlug,
            branchPrefix: item.branchPrefix,
            pidFile: item.pidFile,
            stdoutLog: item.stdoutLog,
          })),
        }
      : null,
    selectedRun: run
      ? {
          runId: run.runId,
          repoPath: run.repoPath,
          livingPlanPath: run.livingPlanPath,
          worktreePath: run.worktreePath,
          stateSlug: run.stateSlug,
          pidFile: run.pidFile,
          stdoutLog: run.stdoutLog,
        }
      : null,
    stateSummary: readJsonSummary(opts.event.stateFile),
    stdoutLogTail: logTail,
  };

  return [
    "# gstack-build Monitor Agent",
    "",
    "You are an advisory supervisor for a blocking `/build` monitor event.",
    "Deterministic `gstack-build monitor` owns process identity, stale-run recovery, locks, and state mutation. Do not edit files, run shell commands, commit, kill processes, patch state JSON, or override monitor identity checks. Do not tell the host to do those things either.",
    "Diagnose the bounded context below and return exactly one JSON object. No Markdown, no prose outside JSON.",
    "",
    "Required JSON shape:",
    JSON.stringify(
      {
        verdict: "host_action_required | user_action_required | no_action",
        summary: "short diagnosis",
        attempted: ["what you inspected or inferred"],
        recommendedHostAction: "single safe next host action",
        suggestedCommands: ["read-only or deterministic gstack-build commands only"],
        userChoices: ["only if verdict is user_action_required"],
      },
      null,
      2,
    ),
    "",
    "Allowed verdicts: host_action_required, user_action_required, no_action.",
    "Suggested commands must preserve the run/worktree. Prefer inspection commands and exact `gstack-build monitor --manifest ... --watch --supervise` re-entry when appropriate.",
    "",
    "Context JSON:",
    JSON.stringify(context, null, 2),
  ].join("\n");
}

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function parseMonitorAgentJson(raw: string): MonitorAgentJson | null {
  try {
    const parsed = JSON.parse(stripJsonFence(raw)) as Record<string, unknown>;
    const verdict = parsed.verdict;
    if (
      verdict !== "host_action_required" &&
      verdict !== "user_action_required" &&
      verdict !== "no_action"
    ) {
      return null;
    }
    if (
      typeof parsed.summary !== "string" ||
      !isStringArray(parsed.attempted) ||
      typeof parsed.recommendedHostAction !== "string" ||
      !isStringArray(parsed.suggestedCommands) ||
      !isStringArray(parsed.userChoices)
    ) {
      return null;
    }
    return {
      verdict,
      summary: parsed.summary,
      attempted: stringArray(parsed.attempted),
      recommendedHostAction: parsed.recommendedHostAction,
      suggestedCommands: stringArray(parsed.suggestedCommands),
      userChoices: stringArray(parsed.userChoices),
    };
  } catch {
    return null;
  }
}

export async function buildMonitorAgentEscalation(opts: {
  manifestPath: string;
  evaluation: MonitorEvaluation;
  role: RoleConfig;
  runner?: MonitorAgentRunner;
  now?: Date;
  timeoutMs?: number;
}): Promise<MonitorEvent | null> {
  const sourceEvent = opts.evaluation.terminalEvent;
  if (!shouldInvokeMonitorAgent(sourceEvent)) return null;

  const slug = `monitor-${safeSlug(
    opts.evaluation.manifest?.runGroupId ?? sourceEvent.runId ?? "unknown",
  )}`;
  const dir = logDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const inputFilePath = path.join(dir, `monitor-agent-${stamp}.md`);
  const outputFilePath = path.join(dir, `monitor-agent-${stamp}.json`);
  fs.writeFileSync(
    inputFilePath,
    buildMonitorAgentPrompt({
      manifestPath: opts.manifestPath,
      manifest: opts.evaluation.manifest,
      event: sourceEvent,
      role: opts.role,
    }),
  );
  fs.writeFileSync(outputFilePath, "");

  const runner = opts.runner ?? runConfiguredRoleTask;
  let result: SubAgentResult;
  try {
    result = await runner({
      inputFilePath,
      outputFilePath,
      cwd: dir,
      slug,
      logPrefix: "monitor-agent",
      role: opts.role,
      timeoutMs: opts.timeoutMs ?? MONITOR_AGENT_TIMEOUT_MS,
    });
  } catch (err) {
    result = {
      exitCode: 1,
      stdout: "",
      stderr: (err as Error).message,
      timedOut: false,
      logPath: outputFilePath,
      durationMs: 0,
      retries: 0,
    };
  }

  const rawOutput = fs.existsSync(outputFilePath)
    ? fs.readFileSync(outputFilePath, "utf8")
    : "";
  const parsed = parseMonitorAgentJson(rawOutput.trim() || result.stdout);
  const fallbackSummary = result.timedOut
    ? "monitor agent timed out; host must inspect the monitor event and logs"
    : "monitor agent returned invalid JSON; host must inspect the monitor event and logs";
  const details: MonitorAgentJson = parsed ?? {
    verdict: "host_action_required",
    summary: fallbackSummary,
    attempted: [
      result.timedOut
        ? "monitor-agent process timed out"
        : "monitor-agent JSON parse failed",
    ],
    recommendedHostAction:
      "Inspect the source monitor event, state file, and stdout log before deciding whether to re-enter the monitor or ask the user.",
    suggestedCommands: [
      `gstack-build monitor --manifest ${opts.manifestPath} --watch --supervise`,
    ],
    userChoices: [],
  };

  return {
    event: "MONITOR_AGENT_ESCALATION",
    timestamp: (opts.now ?? new Date()).toISOString(),
    sourceEvent: sourceEvent.event,
    runId: sourceEvent.runId,
    repoSlug: sourceEvent.repoSlug,
    stateSlug: sourceEvent.stateSlug,
    status: sourceEvent.status,
    message: details.summary,
    pidFile: sourceEvent.pidFile,
    stateFile: sourceEvent.stateFile,
    stdoutLog: sourceEvent.stdoutLog,
    verdict: details.verdict,
    summary: details.summary,
    attempted: details.attempted,
    recommendedHostAction: details.recommendedHostAction,
    suggestedCommands: details.suggestedCommands,
    userChoices: details.userChoices,
    originalExitCode: monitorExitCode(sourceEvent.event),
    monitorAgent: {
      provider: opts.role.provider,
      model: opts.role.model,
      timedOut: result.timedOut,
      exitCode: result.exitCode,
      logPath: result.logPath,
      outputPath: outputFilePath,
    },
  };
}
