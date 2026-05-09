import * as fs from "node:fs";
import * as path from "node:path";
import {
  defaultActiveRunRegistryDir,
  isPidAlive,
  readActiveRunRecords,
  type ActiveRunRecord,
} from "./active-runs";
import { loadMonitorManifest } from "./monitor";
import {
  canonicalSourcePlanClaimId,
  canonicalSourcePlanClaimPath,
  legacySourcePlanClaimPath,
} from "./plan-claims";
import { statePath } from "./state";
import type { BuildRunManifest, BuildRunManifestRun, BuildState } from "./types";

export type PlanSelectionKind = "selected" | "ambiguous" | "blocked" | "none";
export type PlanCandidateKind = "source-plan" | "living-plan";
export type PlanCandidateStatus =
  | "available"
  | "claimed"
  | "running"
  | "stale"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface PlanClaimRecord {
  runGroupId?: string;
  sourcePlanPath?: string;
  hostname?: string;
  pid?: number;
  status?: PlanCandidateStatus;
  runIds?: string[];
  repoPaths?: string[];
  pidFiles?: string[];
  stdoutLogs?: string[];
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface PlanCandidate {
  id: string;
  kind: PlanCandidateKind;
  path: string;
  status: PlanCandidateStatus;
  repoPath?: string;
  runId?: string;
  manifestPath?: string;
  livingPlanPath?: string;
  sourcePlanPath?: string;
  claimPath?: string;
  legacyClaimPath?: string;
  live: boolean;
  reason?: string;
  command: string;
  monitorCommand?: string;
}

export interface PlanSelectionResult {
  result: PlanSelectionKind;
  reason: string;
  selected?: PlanCandidate;
  candidates: PlanCandidate[];
  errors: string[];
  truncated: boolean;
  commands: string[];
}

export interface ResolvePlanSelectionOptions {
  gstackRepo: string;
  projectRoot?: string;
  explicitPaths?: string[];
  allInbox?: boolean;
  resumeRunId?: string;
  resumeOnly?: boolean;
  includeAll?: boolean;
  maxCandidates?: number;
  activeRunRegistry?: string;
  workspaceRoot?: string;
}

export interface CreateSourcePlanClaimOptions {
  gstackRepo: string;
  sourcePlanPath: string;
  runGroupId: string;
  hostname?: string;
  pid?: number;
  now?: Date;
}

export interface CreateSourcePlanClaimResult {
  ok: boolean;
  claimPath: string;
  reason?: string;
  existingClaimPath?: string;
}

const DEFAULT_MAX_CANDIDATES = 50;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const LIVE_CLAIM_STATUSES = new Set(["claimed", "manifested", "running"]);

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function readClaim(filePath: string): PlanClaimRecord | null {
  if (!fs.existsSync(filePath)) return null;
  const parsed = readJsonFile<PlanClaimRecord>(filePath);
  return parsed && typeof parsed === "object" ? parsed : null;
}

function readPidFile(filePath: string): number | null {
  try {
    const pid = Number(fs.readFileSync(filePath, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function claimHasLiveOwner(claim: PlanClaimRecord): boolean {
  if (Number.isInteger(claim.pid) && claim.pid! > 0 && isPidAlive(claim.pid!)) {
    return true;
  }
  for (const pidFile of claim.pidFiles ?? []) {
    const pid = readPidFile(pidFile);
    if (pid && isPidAlive(pid)) return true;
  }
  return false;
}

export function createSourcePlanClaim(
  opts: CreateSourcePlanClaimOptions,
): CreateSourcePlanClaimResult {
  const claimInfo = readClaimForSource(opts.gstackRepo, opts.sourcePlanPath);
  if (claimInfo.claim) {
    return {
      ok: false,
      claimPath: canonicalSourcePlanClaimPath(opts.gstackRepo, opts.sourcePlanPath),
      existingClaimPath: claimInfo.claimPath,
      reason: claimHasLiveOwner(claimInfo.claim)
        ? "source plan already has a live claim"
        : `source plan already has a ${claimStatus(claimInfo.claim)} claim`,
    };
  }
  const claimPath = canonicalSourcePlanClaimPath(opts.gstackRepo, opts.sourcePlanPath);
  fs.mkdirSync(path.dirname(claimPath), { recursive: true });
  const claim: PlanClaimRecord = {
    runGroupId: opts.runGroupId,
    sourcePlanPath: path.resolve(opts.sourcePlanPath),
    hostname: opts.hostname ?? "",
    pid: opts.pid ?? process.pid,
    status: "claimed",
    createdAt: (opts.now ?? new Date()).toISOString(),
  };
  try {
    const fd = fs.openSync(claimPath, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(claim, null, 2) + "\n");
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true, claimPath };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return {
        ok: false,
        claimPath,
        existingClaimPath: claimPath,
        reason: "source plan claim was created by another run",
      };
    }
    throw err;
  }
}

function claimStatus(claim: PlanClaimRecord | null): PlanCandidateStatus {
  if (!claim) return "available";
  const raw = String(claim.status ?? "unknown") as PlanCandidateStatus;
  if (
    raw === "claimed" ||
    raw === "running" ||
    raw === "completed" ||
    raw === "failed" ||
    raw === "cancelled"
  ) {
    return raw;
  }
  if (raw === "manifested") return "claimed";
  return "unknown";
}

function sourcePlanCommand(sourcePath: string): string {
  return `/build ${sourcePath}`;
}

function resumeCommand(candidate: {
  runId?: string;
  path: string;
  manifestPath?: string;
}): string {
  if (candidate.runId) return `/build --resume ${candidate.runId}`;
  return `/build ${candidate.path} --resume`;
}

function monitorCommand(manifestPath: string | undefined): string | undefined {
  return manifestPath
    ? `gstack-build monitor --manifest ${manifestPath} --watch`
    : undefined;
}

function candidateId(kind: PlanCandidateKind, filePath: string, runId?: string): string {
  return `${kind}:${runId ?? path.resolve(filePath)}`;
}

function sourceCandidate(
  gstackRepo: string,
  sourcePath: string,
  claim: PlanClaimRecord | null,
  claimPath?: string,
  legacyClaimPath?: string,
): PlanCandidate {
  const status = claimStatus(claim);
  const live = claim ? claimHasLiveOwner(claim) : false;
  const effectiveStatus =
    live && LIVE_CLAIM_STATUSES.has(status) ? "running" : status;
  return {
    id: canonicalSourcePlanClaimId(gstackRepo, sourcePath),
    kind: "source-plan",
    path: path.resolve(sourcePath),
    sourcePlanPath: path.resolve(sourcePath),
    status: effectiveStatus,
    repoPath: claim?.repoPaths?.[0],
    runId: claim?.runIds?.[0],
    claimPath,
    legacyClaimPath,
    live,
    reason: claim
      ? live
        ? "source plan has a live claim"
        : TERMINAL_STATUSES.has(status)
        ? `source plan has terminal claim: ${status}`
        : `source plan has claim: ${status}`
      : "unclaimed source plan",
    command: sourcePlanCommand(path.resolve(sourcePath)),
  };
}

function statMtimeDesc(a: string, b: string): number {
  const am = fs.statSync(a).mtimeMs;
  const bm = fs.statSync(b).mtimeMs;
  return bm - am || a.localeCompare(b);
}

function listFiles(dir: string, predicate: (name: string) => boolean): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && predicate(entry.name))
      .map((entry) => path.join(dir, entry.name))
      .sort(statMtimeDesc);
  } catch {
    return [];
  }
}

function listSourcePlans(gstackRepo: string): string[] {
  return listFiles(
    path.join(gstackRepo, "inbox"),
    (name) =>
      name.endsWith(".md") &&
      name.includes("-plan-") &&
      !name.includes("-impl-plan-"),
  );
}

function listLivingPlans(gstackRepo: string, includeAll: boolean): string[] {
  const current = listFiles(
    path.join(gstackRepo, "inbox", "living-plan"),
    (name) => name.endsWith(".md") && name.includes("-impl-plan-"),
  );
  const legacy = includeAll
    ? listFiles(
        path.join(gstackRepo, "living-plans"),
        (name) => name.endsWith(".md") && name.includes("-impl-plan-"),
      )
    : [];
  return [...current, ...legacy];
}

function readClaimForSource(gstackRepo: string, sourcePath: string): {
  claim: PlanClaimRecord | null;
  claimPath?: string;
  legacyClaimPath?: string;
} {
  const canonical = canonicalSourcePlanClaimPath(gstackRepo, sourcePath);
  const legacy = legacySourcePlanClaimPath(gstackRepo, sourcePath);
  const canonicalClaim = readClaim(canonical);
  if (canonicalClaim) {
    return {
      claim: canonicalClaim,
      claimPath: canonical,
      legacyClaimPath: legacy !== canonical && fs.existsSync(legacy) ? legacy : undefined,
    };
  }
  const legacyClaim = legacy !== canonical ? readClaim(legacy) : null;
  return {
    claim: legacyClaim,
    claimPath: legacyClaim ? legacy : canonical,
    legacyClaimPath: legacyClaim ? legacy : undefined,
  };
}

function normalizeRepo(repoPath: string | undefined): string | undefined {
  return repoPath ? path.resolve(repoPath) : undefined;
}

function repoMatches(candidateRepo: string | undefined, targetRepo: string | undefined): boolean {
  if (!targetRepo) return true;
  if (!candidateRepo) return false;
  return normalizeRepo(candidateRepo) === normalizeRepo(targetRepo);
}

function stateForRun(run: BuildRunManifestRun): BuildState | null {
  return readJsonFile<BuildState>(statePath(run.stateSlug));
}

function runCompleted(state: BuildState | null): boolean {
  return state?.completed === true;
}

function runFailed(state: BuildState | null): boolean {
  return Boolean(state?.failedAtPhase != null || state?.failureReason);
}

function manifestRunCandidate(
  manifestPath: string,
  run: BuildRunManifestRun,
  activeRecords: ActiveRunRecord[],
): PlanCandidate {
  const state = stateForRun(run);
  const active = activeRecords.find((record) => record.runId === run.runId);
  const live =
    (readPidFile(run.pidFile) ?? 0) > 0 &&
    isPidAlive(readPidFile(run.pidFile) ?? 0);
  const activeLive = active
    ? active.status !== "completed" &&
      active.status !== "failed" &&
      isPidAlive(active.pid)
    : false;
  const status: PlanCandidateStatus = runCompleted(state)
    ? "completed"
    : runFailed(state)
    ? "failed"
    : live || activeLive
    ? "running"
    : "stale";
  const command = resumeCommand({
    runId: run.runId,
    path: run.livingPlanPath,
    manifestPath,
  });
  return {
    id: candidateId("living-plan", run.livingPlanPath, run.runId),
    kind: "living-plan",
    path: run.livingPlanPath,
    livingPlanPath: run.livingPlanPath,
    sourcePlanPath: run.sourcePlanPath ?? run.originPlanPath,
    status,
    repoPath: run.repoPath,
    runId: run.runId,
    manifestPath,
    live: live || activeLive,
    command,
    monitorCommand: monitorCommand(manifestPath),
    reason:
      status === "running"
        ? "active run already owns this living plan"
        : status === "stale"
        ? "incomplete living plan can be resumed"
        : `living plan is ${status}`,
  };
}

function findManifestFiles(gstackRepo: string, includeAll: boolean): string[] {
  const roots = [
    path.join(gstackRepo, ".llm-tmp", "build-runs"),
    path.join(path.dirname(gstackRepo), ".llm-tmp", "build-runs"),
  ];
  const out: string[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (includeAll || path.dirname(full) === root) stack.push(full);
        } else if (entry.isFile() && entry.name === "build-run-manifest.json") {
          out.push(full);
        }
      }
    }
  }
  return [...new Set(out)].sort(statMtimeDesc);
}

function manifestCandidates(opts: ResolvePlanSelectionOptions): {
  candidates: PlanCandidate[];
  errors: string[];
} {
  const activeRecords = readActiveRunRecords(
    opts.activeRunRegistry ?? defaultActiveRunRegistryDir(),
  );
  const errors: string[] = [];
  const candidates: PlanCandidate[] = [];
  for (const manifestPath of findManifestFiles(opts.gstackRepo, Boolean(opts.includeAll))) {
    let manifest: BuildRunManifest;
    try {
      manifest = loadMonitorManifest(manifestPath);
    } catch (err) {
      errors.push(`${manifestPath}: ${(err as Error).message}`);
      continue;
    }
    for (const run of manifest.runs) {
      if (!repoMatches(run.repoPath, opts.projectRoot)) continue;
      candidates.push(manifestRunCandidate(manifestPath, run, activeRecords));
    }
  }
  return { candidates, errors };
}

function activeRunRepoPath(record: ActiveRunRecord): string {
  return record.baseProjectRoot ?? record.repoPath;
}

function activeRunCandidate(record: ActiveRunRecord): PlanCandidate {
  const terminal = record.status === "completed" || record.status === "failed";
  const live = !terminal && isPidAlive(record.pid);
  const status: PlanCandidateStatus =
    record.status === "completed"
      ? "completed"
      : record.status === "failed"
      ? "failed"
      : live
      ? "running"
      : "stale";
  const planPath = path.resolve(record.planFile);
  return {
    id: candidateId("living-plan", planPath, record.runId),
    kind: "living-plan",
    path: planPath,
    livingPlanPath: planPath,
    status,
    repoPath: activeRunRepoPath(record),
    runId: record.runId,
    live,
    command: `/build --resume ${record.runId}`,
    reason:
      status === "running"
        ? "active run registry reports this run is live"
        : status === "stale"
        ? "active run registry has an incomplete run without a manifest"
        : `active run registry says run is ${status}`,
  };
}

function activeRunOnlyCandidates(
  opts: ResolvePlanSelectionOptions,
  manifestRunIds: Set<string>,
): PlanCandidate[] {
  return readActiveRunRecords(
    opts.activeRunRegistry ?? defaultActiveRunRegistryDir(),
  )
    .filter((record) => !manifestRunIds.has(record.runId))
    .filter((record) => repoMatches(activeRunRepoPath(record), opts.projectRoot))
    .map(activeRunCandidate);
}

function livingPlanFallbackCandidates(opts: ResolvePlanSelectionOptions): PlanCandidate[] {
  const explicitLivingPaths = new Set(
    (opts.explicitPaths ?? []).map((p) => path.resolve(p)),
  );
  if (opts.projectRoot && explicitLivingPaths.size === 0) return [];
  const livingPaths = listLivingPlans(opts.gstackRepo, Boolean(opts.includeAll)).filter(
    (livingPath) =>
      explicitLivingPaths.size === 0 || explicitLivingPaths.has(path.resolve(livingPath)),
  );
  return livingPaths.map((livingPath) => ({
    id: candidateId("living-plan", livingPath),
    kind: "living-plan" as const,
    path: path.resolve(livingPath),
    livingPlanPath: path.resolve(livingPath),
    status: "stale" as const,
    live: false,
    command: resumeCommand({ path: path.resolve(livingPath) }),
    reason: "living plan exists without a manifest; explicit resume required",
  }));
}

function sourceCandidates(opts: ResolvePlanSelectionOptions): PlanCandidate[] {
  const sourcePaths = opts.explicitPaths?.length
    ? opts.explicitPaths.map((p) => path.resolve(p))
    : listSourcePlans(opts.gstackRepo);
  return sourcePaths.map((sourcePath) => {
    const claimInfo = readClaimForSource(opts.gstackRepo, sourcePath);
    return sourceCandidate(
      opts.gstackRepo,
      sourcePath,
      claimInfo.claim,
      claimInfo.claimPath,
      claimInfo.legacyClaimPath,
    );
  });
}

function uniqueCandidates(candidates: PlanCandidate[]): PlanCandidate[] {
  const seen = new Set<string>();
  const out: PlanCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.kind}:${candidate.runId ?? ""}:${candidate.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function limitCandidates(
  candidates: PlanCandidate[],
  maxCandidates: number,
): { candidates: PlanCandidate[]; truncated: boolean } {
  if (candidates.length <= maxCandidates) {
    return { candidates, truncated: false };
  }
  return { candidates: candidates.slice(0, maxCandidates), truncated: true };
}

function resumeCandidates(
  manifestCandidates: PlanCandidate[],
  activeRunOnlyCandidates: PlanCandidate[],
  fallbackLivingCandidates: PlanCandidate[],
): PlanCandidate[] {
  return [
    ...manifestCandidates.filter((candidate) => runHasIncompleteCandidate(candidate)),
    ...activeRunOnlyCandidates.filter((candidate) => runHasIncompleteCandidate(candidate)),
    ...fallbackLivingCandidates,
  ];
}

function livingPlanIdentity(candidate: PlanCandidate): string {
  return path.resolve(candidate.livingPlanPath ?? candidate.path);
}

function selectionFromCandidates(
  candidates: PlanCandidate[],
  errors: string[],
  truncated: boolean,
): PlanSelectionResult {
  const active = candidates.filter(
    (candidate) =>
      candidate.status !== "completed" &&
      candidate.status !== "failed" &&
      candidate.status !== "cancelled",
  );
  const blockers = active.filter(
    (candidate) =>
      candidate.kind === "source-plan" &&
      (candidate.live || candidate.status === "claimed" || candidate.status === "running"),
  );
  if (blockers.length > 0) {
    return {
      result: "blocked",
      reason: "one or more source plans are already claimed",
      candidates,
      errors,
      truncated,
      commands: blockers.flatMap((candidate) =>
        candidate.monitorCommand ? [candidate.monitorCommand] : [candidate.command],
      ),
    };
  }
  if (active.length === 0) {
    return {
      result: "none",
      reason: "no selectable source or resumable living plans found",
      candidates,
      errors,
      truncated,
      commands: [],
    };
  }
  if (active.length === 1) {
    return {
      result: "selected",
      reason: "exactly one safe candidate found",
      selected: active[0],
      candidates,
      errors,
      truncated,
      commands: [active[0].command],
    };
  }
  return {
    result: "ambiguous",
    reason: "multiple plausible build candidates found",
    candidates,
    errors,
    truncated,
    commands: active.map((candidate) => candidate.command),
  };
}

export function resolvePlanSelection(
  opts: ResolvePlanSelectionOptions,
): PlanSelectionResult {
  const gstackRepo = path.resolve(opts.gstackRepo);
  const maxCandidates = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const errors: string[] = [];
  const explicitPaths = opts.explicitPaths?.map((p) => path.resolve(p)) ?? [];
  const explicitPathsToValidate = opts.resumeRunId ? [] : explicitPaths;
  for (const explicitPath of explicitPathsToValidate) {
    if (!fs.existsSync(explicitPath)) {
      errors.push(`explicit plan not found: ${explicitPath}`);
    }
  }
  if (errors.length > 0 && explicitPathsToValidate.length > 0) {
    return {
      result: "blocked",
      reason: "explicit plan validation failed",
      candidates: [],
      errors,
      truncated: false,
      commands: [],
    };
  }

  const normalizedOpts = { ...opts, gstackRepo, explicitPaths };
  const manifest = manifestCandidates(normalizedOpts);
  errors.push(...manifest.errors);
  const activeRunOnly = activeRunOnlyCandidates(
    normalizedOpts,
    new Set(manifest.candidates.map((candidate) => candidate.runId).filter(Boolean) as string[]),
  );
  const manifestLivingPaths = new Set(manifest.candidates.map((candidate) => candidate.path));
  const fallbackLiving = livingPlanFallbackCandidates(normalizedOpts).filter(
    (candidate) => !manifestLivingPaths.has(candidate.path),
  );
  const resumable = resumeCandidates(manifest.candidates, activeRunOnly, fallbackLiving);
  let candidates: PlanCandidate[] = [];

  if (opts.resumeRunId) {
    candidates = resumable.filter((candidate) => candidate.runId === opts.resumeRunId);
  } else if (opts.resumeOnly) {
    const explicitLivingPaths = new Set(explicitPaths.map((p) => path.resolve(p)));
    candidates =
      explicitLivingPaths.size > 0
        ? resumable.filter((candidate) =>
            explicitLivingPaths.has(livingPlanIdentity(candidate)),
          )
        : resumable;
  } else if (explicitPaths.length > 0) {
    candidates = [
      ...sourceCandidates(normalizedOpts),
      ...activeRunOnly.filter((candidate) => runHasIncompleteCandidate(candidate)),
    ];
  } else if (opts.allInbox) {
    candidates = sourceCandidates(normalizedOpts).filter(
      (candidate) => candidate.status === "available",
    );
    const limited = limitCandidates(uniqueCandidates(candidates), maxCandidates);
    if (limited.candidates.length === 0) {
      return {
        result: "none",
        reason: "no unclaimed inbox source plans found",
        candidates: limited.candidates,
        errors,
        truncated: limited.truncated,
        commands: [],
      };
    }
    return {
      result: "selected",
      reason: "selected all unclaimed inbox source plans",
      selected: limited.candidates[0],
      candidates: limited.candidates,
      errors,
      truncated: limited.truncated,
      commands: limited.candidates.map((candidate) => candidate.command),
    };
  } else {
    candidates = [
      ...sourceCandidates(normalizedOpts),
      ...manifest.candidates.filter((candidate) => runHasIncompleteCandidate(candidate)),
      ...activeRunOnly.filter((candidate) => runHasIncompleteCandidate(candidate)),
      ...fallbackLiving,
    ];
  }

  const limited = limitCandidates(uniqueCandidates(candidates), maxCandidates);
  return selectionFromCandidates(limited.candidates, errors, limited.truncated);
}

function runHasIncompleteCandidate(candidate: PlanCandidate): boolean {
  return candidate.status === "running" || candidate.status === "stale";
}

export function renderPlanStatusTable(result: PlanSelectionResult): string {
  const lines: string[] = [];
  lines.push(`Result: ${result.result}`);
  lines.push(`Reason: ${result.reason}`);
  if (result.errors.length > 0) {
    lines.push("Errors:");
    for (const err of result.errors) lines.push(`  - ${err}`);
  }
  if (result.candidates.length === 0) {
    lines.push("Candidates: none");
  } else {
    lines.push("Candidates:");
    lines.push("kind        status     live  runId          repo  path");
    for (const candidate of result.candidates) {
      lines.push(
        [
          candidate.kind.padEnd(11),
          candidate.status.padEnd(10),
          String(candidate.live).padEnd(5),
          (candidate.runId ?? "-").slice(0, 13).padEnd(13),
          path.basename(candidate.repoPath ?? "-").padEnd(5),
          candidate.path,
        ].join(" "),
      );
      if (candidate.monitorCommand) {
        lines.push(`  monitor: ${candidate.monitorCommand}`);
      }
      lines.push(`  command: ${candidate.command}`);
    }
  }
  if (result.truncated) lines.push("Note: candidate list truncated; rerun with --all.");
  return `${lines.join("\n")}\n`;
}
