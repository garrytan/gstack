import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type ActiveRunStatus = "running" | "paused" | "completed" | "failed";

export interface ActiveRunRecord {
  runId: string;
  stateSlug: string;
  repoPath: string;
  baseProjectRoot?: string;
  planFile: string;
  branchPrefix?: string;
  pid: number;
  status: ActiveRunStatus;
  startedAt: string;
  lastUpdatedAt: string;
  branches: string[];
}

export function defaultActiveRunRegistryDir(): string {
  return path.join(os.homedir(), ".gstack", "build-state", "active-runs");
}

function safeRunId(runId: string): string {
  return (
    runId
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "run"
  );
}

export function activeRunRecordPath(registryDir: string, runId: string): string {
  return path.join(path.resolve(registryDir), `${safeRunId(runId)}.json`);
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function writeActiveRunRecord(
  registryDir: string,
  record: ActiveRunRecord,
): void {
  fs.mkdirSync(registryDir, { recursive: true });
  const finalPath = activeRunRecordPath(registryDir, record.runId);
  const tmpPath = `${finalPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.renameSync(tmpPath, finalPath);
}

export function removeActiveRunRecord(registryDir: string, runId: string): void {
  try {
    fs.unlinkSync(activeRunRecordPath(registryDir, runId));
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }
}

export function readActiveRunRecords(registryDir: string): ActiveRunRecord[] {
  if (!fs.existsSync(registryDir)) return [];
  const entries = fs.readdirSync(registryDir, { withFileTypes: true });
  const records: ActiveRunRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(registryDir, entry.name);
    try {
      const parsed = JSON.parse(
        fs.readFileSync(filePath, "utf8"),
      ) as ActiveRunRecord;
      if (
        typeof parsed.runId === "string" &&
        typeof parsed.stateSlug === "string" &&
        Array.isArray(parsed.branches)
      ) {
        records.push(parsed);
      }
    } catch {
      // Ignore corrupt registry records. They should not block unrelated builds.
    }
  }
  return records;
}

function normalizeRepoPath(repoPath: string | undefined): string | undefined {
  return repoPath ? path.resolve(repoPath) : undefined;
}

function activeRunRepoIdentity(record: ActiveRunRecord): string | undefined {
  return normalizeRepoPath(record.baseProjectRoot ?? record.repoPath);
}

export function activeOwnedBranches(
  registryDir: string,
  opts: { projectRoot?: string; baseProjectRoot?: string } = {},
): Set<string> {
  const targetRepo = normalizeRepoPath(opts.baseProjectRoot ?? opts.projectRoot);
  const branches = new Set<string>();
  for (const record of readActiveRunRecords(registryDir)) {
    if (targetRepo && activeRunRepoIdentity(record) !== targetRepo) continue;
    const terminal = record.status === "completed" || record.status === "failed";
    if (terminal && !isPidAlive(record.pid)) continue;
    for (const branch of record.branches) {
      if (branch.startsWith("feat/")) branches.add(branch);
    }
  }
  return branches;
}
