import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteJson, readJsonRegistry, safeRegistryKey } from "./registry";
import { canonicalRepoIdentity } from "./release-identity";

export const RELEASE_QUEUE_LABEL = "gstack-release-queued";
export const RELEASE_QUEUE_MARKER_START = "<!-- gstack-release-queued";
export const RELEASE_QUEUE_MARKER_END = "gstack-release-queued -->";

export type ReleaseQueueStatus =
  | "queued"
  | "claiming"
  | "landing"
  | "drift_repairing"
  | "landed"
  | "blocked"
  | "abandoned";

export interface ReleaseQueueRecord {
  runId: string;
  repoPath: string;
  repoIdentity?: string;
  baseBranch: string;
  featureBranch: string;
  prNumber: number;
  prUrl?: string;
  version: string;
  livingPlanPath: string;
  sourcePlanPath?: string;
  worktreePath: string;
  queuedAt: string;
  status: ReleaseQueueStatus;
  lastError?: string;
  lastUpdatedAt?: string;
  retries?: number;
}

const ALLOWED_TRANSITIONS: Record<ReleaseQueueStatus, ReleaseQueueStatus[]> = {
  queued: ["claiming", "blocked", "abandoned"],
  claiming: ["landing", "queued", "blocked", "abandoned"],
  landing: ["drift_repairing", "landed", "blocked"],
  drift_repairing: ["landing", "blocked"],
  landed: [],
  blocked: ["queued", "abandoned"],
  abandoned: [],
};

export function defaultReleaseQueueDir(): string {
  return path.join(os.homedir(), ".gstack", "build-state", "release-queue");
}

export function releaseQueueRecordId(
  record: Pick<ReleaseQueueRecord, "repoPath" | "repoIdentity" | "baseBranch" | "prNumber">,
): string {
  const repoKey = record.repoIdentity
    ? safeRegistryKey(record.repoIdentity)
    : canonicalRepoIdentity({
        cwd: record.repoPath,
        repoPath: record.repoPath,
      }).key;
  return safeRegistryKey(
    `${repoKey}-${record.baseBranch}-pr-${record.prNumber}`,
  );
}

export function releaseQueueRecordPath(
  queueDir: string,
  record: Pick<ReleaseQueueRecord, "repoPath" | "repoIdentity" | "baseBranch" | "prNumber">,
): string {
  return path.join(path.resolve(queueDir), `${releaseQueueRecordId(record)}.json`);
}

function isReleaseQueueRecord(value: unknown): value is ReleaseQueueRecord {
  const r = value as ReleaseQueueRecord;
  return (
    !!r &&
    typeof r === "object" &&
    typeof r.runId === "string" &&
    typeof r.repoPath === "string" &&
    typeof r.baseBranch === "string" &&
    typeof r.featureBranch === "string" &&
    Number.isInteger(r.prNumber) &&
    typeof r.version === "string" &&
    typeof r.livingPlanPath === "string" &&
    typeof r.worktreePath === "string" &&
    typeof r.queuedAt === "string" &&
    isReleaseQueueStatus(r.status)
  );
}

export function isReleaseQueueStatus(value: unknown): value is ReleaseQueueStatus {
  return (
    value === "queued" ||
    value === "claiming" ||
    value === "landing" ||
    value === "drift_repairing" ||
    value === "landed" ||
    value === "blocked" ||
    value === "abandoned"
  );
}

export function assertReleaseQueueTransition(
  from: ReleaseQueueStatus,
  to: ReleaseQueueStatus,
): void {
  if (from === to) return;
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new Error(`invalid release queue transition: ${from} -> ${to}`);
  }
}

export function writeReleaseQueueRecord(
  queueDir: string,
  record: ReleaseQueueRecord,
): ReleaseQueueRecord {
  const next = { ...record, lastUpdatedAt: new Date().toISOString() };
  atomicWriteJson(releaseQueueRecordPath(queueDir, next), next);
  return next;
}

export function readReleaseQueueRecords(queueDir: string): ReleaseQueueRecord[] {
  return readJsonRegistry(queueDir, isReleaseQueueRecord, {
    debugName: "release-queue",
  }).sort((a, b) => {
    const byQueued = a.queuedAt.localeCompare(b.queuedAt);
    return byQueued !== 0 ? byQueued : a.prNumber - b.prNumber;
  });
}

export function updateReleaseQueueRecord(
  queueDir: string,
  record: ReleaseQueueRecord,
  patch: Partial<ReleaseQueueRecord>,
): ReleaseQueueRecord {
  if (patch.status) assertReleaseQueueTransition(record.status, patch.status);
  return writeReleaseQueueRecord(queueDir, { ...record, ...patch });
}

export function queuedMarker(record: ReleaseQueueRecord): string {
  const payload = {
    runId: record.runId,
    repoPath: path.resolve(record.repoPath),
    repoIdentity: record.repoIdentity,
    baseBranch: record.baseBranch,
    featureBranch: record.featureBranch,
    prNumber: record.prNumber,
    prUrl: record.prUrl,
    version: record.version,
    livingPlanPath: record.livingPlanPath,
    sourcePlanPath: record.sourcePlanPath,
    worktreePath: record.worktreePath,
    queuedAt: record.queuedAt,
  };
  return `${RELEASE_QUEUE_MARKER_START}\n${JSON.stringify(payload, null, 2)}\n${RELEASE_QUEUE_MARKER_END}`;
}

export function parseQueuedMarker(body: string): Partial<ReleaseQueueRecord> | null {
  const escapedStart = RELEASE_QUEUE_MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = RELEASE_QUEUE_MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(new RegExp(`${escapedStart}\\s*([\\s\\S]*?)\\s*${escapedEnd}`));
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as Partial<ReleaseQueueRecord>;
    if (
      typeof parsed.runId !== "string" ||
      typeof parsed.featureBranch !== "string" ||
      typeof parsed.version !== "string" ||
      typeof parsed.queuedAt !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

interface GhQueuedPr {
  number?: number;
  url?: string;
  baseRefName?: string;
  headRefName?: string;
  body?: string;
  isCrossRepository?: boolean;
}

export function discoverBuildQueuedPullRequests(
  repoPath: string,
  run: typeof spawnSync = spawnSync,
): { records: ReleaseQueueRecord[]; error?: string } {
  const r = run("gh", [
    "pr",
    "list",
    "--state",
    "open",
    "--label",
    RELEASE_QUEUE_LABEL,
    "--json",
    "number,url,baseRefName,headRefName,body,isCrossRepository",
  ], { cwd: repoPath, encoding: "utf8" }) as SpawnSyncReturns<string>;
  if (r.status !== 0) {
    return { records: [], error: r.stderr || r.stdout || "gh pr list failed" };
  }
  let prs: GhQueuedPr[];
  try {
    prs = JSON.parse(r.stdout) as GhQueuedPr[];
  } catch {
    return { records: [], error: "gh pr list returned invalid JSON" };
  }
  const records: ReleaseQueueRecord[] = [];
  for (const pr of prs) {
    if (!Number.isInteger(pr.number) || pr.isCrossRepository) continue;
    const marker = parseQueuedMarker(pr.body ?? "");
    if (!marker) continue;
    records.push({
      runId: marker.runId ?? `pr-${pr.number}`,
      repoPath: path.resolve(repoPath),
      repoIdentity: canonicalRepoIdentity({ cwd: repoPath, repoPath }).identity,
      baseBranch: pr.baseRefName || marker.baseBranch || "main",
      featureBranch: pr.headRefName || marker.featureBranch || "",
      prNumber: pr.number!,
      prUrl: pr.url || marker.prUrl,
      version: marker.version ?? "0.0.0.0",
      livingPlanPath: marker.livingPlanPath ?? "",
      sourcePlanPath: marker.sourcePlanPath,
      worktreePath: marker.worktreePath ?? "",
      queuedAt: marker.queuedAt ?? new Date(0).toISOString(),
      status: "queued",
    });
  }
  records.sort((a, b) => {
    const byQueued = a.queuedAt.localeCompare(b.queuedAt);
    return byQueued !== 0 ? byQueued : a.prNumber - b.prNumber;
  });
  return { records };
}

export function parseShipOutput(text: string): {
  prNumber?: number;
  prUrl?: string;
  version?: string;
} {
  const prMatch =
    text.match(/\bPR\s+#(\d+)\b/i) ??
    text.match(/pull\/(\d+)\b/i) ??
    text.match(/\bMR\s+!(\d+)\b/i);
  const urlMatch = text.match(/https?:\/\/\S+\/(?:pull|merge_requests)\/\d+\S*/i);
  const versionMatch =
    text.match(/\bv(\d+\.\d+\.\d+\.\d+)\b/) ??
    text.match(/\bVERSION[:=\s]+(\d+\.\d+\.\d+\.\d+)\b/i);
  return {
    prNumber: prMatch ? Number(prMatch[1]) : undefined,
    prUrl: urlMatch?.[0],
    version: versionMatch?.[1],
  };
}

export function readVersion(cwd: string): string {
  try {
    return fs.readFileSync(path.join(cwd, "VERSION"), "utf8").trim();
  } catch {
    return "0.0.0.0";
  }
}

export function currentBranch(cwd: string): string {
  const r = spawnSync("git", ["branch", "--show-current"], {
    cwd,
    encoding: "utf8",
  });
  return r.status === 0 ? r.stdout.trim() : "";
}

export function prBaseAndHead(
  cwd: string,
  prNumber: number,
  run: typeof spawnSync = spawnSync,
): { baseBranch: string; featureBranch: string } {
  const r = run("gh", [
    "pr",
    "view",
    String(prNumber),
    "--json",
    "baseRefName,headRefName",
  ], { cwd, encoding: "utf8" }) as SpawnSyncReturns<string>;
  if (r.status !== 0) {
    return { baseBranch: "main", featureBranch: currentBranch(cwd) };
  }
  try {
    const parsed = JSON.parse(r.stdout) as {
      baseRefName?: string;
      headRefName?: string;
    };
    return {
      baseBranch: parsed.baseRefName || "main",
      featureBranch: parsed.headRefName || currentBranch(cwd),
    };
  } catch {
    return { baseBranch: "main", featureBranch: currentBranch(cwd) };
  }
}

export function markPrQueued(
  cwd: string,
  record: ReleaseQueueRecord,
  run: typeof spawnSync = spawnSync,
): { ok: boolean; error?: string } {
  const label = run("gh", ["label", "create", RELEASE_QUEUE_LABEL, "--force"], {
    cwd,
    encoding: "utf8",
  });
  if (label.status !== 0 && process.env.GSTACK_DEBUG) {
    console.warn(`[release-queue] could not ensure label: ${label.stderr}`);
  }
  const addLabel = run(
    "gh",
    ["pr", "edit", String(record.prNumber), "--add-label", RELEASE_QUEUE_LABEL],
    { cwd, encoding: "utf8" },
  );
  if (addLabel.status !== 0) {
    return { ok: false, error: addLabel.stderr || addLabel.stdout };
  }
  const bodyResult = run(
    "gh",
    ["pr", "view", String(record.prNumber), "--json", "body", "-q", ".body"],
    { cwd, encoding: "utf8" },
  );
  if (bodyResult.status !== 0) {
    return { ok: false, error: bodyResult.stderr || bodyResult.stdout || "gh pr view body failed" };
  }
  const body = bodyResult.stdout.trimEnd();
  const marker = queuedMarker(record);
  const nextBody = body.includes(RELEASE_QUEUE_MARKER_START)
    ? body.replace(
        new RegExp(`${RELEASE_QUEUE_MARKER_START}[\\s\\S]*?${RELEASE_QUEUE_MARKER_END}`),
        marker,
      )
    : `${body}${body ? "\n\n" : ""}${marker}`;
  const editBody = run(
    "gh",
    ["pr", "edit", String(record.prNumber), "--body", nextBody],
    { cwd, encoding: "utf8" },
  );
  if (editBody.status !== 0) {
    return { ok: false, error: editBody.stderr || editBody.stdout };
  }
  return { ok: true };
}

export function verifyPrQueued(
  cwd: string,
  record: Pick<ReleaseQueueRecord, "prNumber">,
  run: typeof spawnSync = spawnSync,
): { ok: boolean; error?: string } {
  const viewed = run(
    "gh",
    ["pr", "view", String(record.prNumber), "--json", "body,labels"],
    { cwd, encoding: "utf8" },
  ) as SpawnSyncReturns<string>;
  if (viewed.status !== 0) {
    return { ok: false, error: viewed.stderr || viewed.stdout || "gh pr view failed" };
  }
  try {
    const parsed = JSON.parse(viewed.stdout) as {
      body?: string;
      labels?: Array<{ name?: string } | string>;
    };
    const labels = parsed.labels ?? [];
    const hasLabel = labels.some((label) =>
      typeof label === "string"
        ? label === RELEASE_QUEUE_LABEL
        : label.name === RELEASE_QUEUE_LABEL,
    );
    if (!hasLabel) return { ok: false, error: `missing ${RELEASE_QUEUE_LABEL} label` };
    const marker = parseQueuedMarker(parsed.body ?? "");
    if (!marker) return { ok: false, error: "missing queued PR marker" };
    if (marker.prNumber && marker.prNumber !== record.prNumber) {
      return { ok: false, error: "queued PR marker points at a different PR" };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "gh pr view returned invalid JSON" };
  }
}
