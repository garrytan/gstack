// supervisor/console/server-utils.ts — pure utility functions, no side effects
import type { ServerResponse } from "node:http";
import { readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

// Scan each agent checkout directory for a git remote URL that contains the
// control-repo slug. Returns the first matching dir, or null if none match.
// CONTROL_DIR env var short-circuits all git calls (AC3).
// Non-existent dirs and git errors are silently skipped (AC5).
export function resolveControlDir(agentDirs: string[]): string | null {
  if (process.env.CONTROL_DIR) return process.env.CONTROL_DIR;
  for (const dir of agentDirs) {
    try {
      const r = spawnSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf8" });
      if ((r.status ?? 1) !== 0) continue;
      const url = (r.stdout ?? "").trim();
      if (url.includes("seab-group/tshepostack")) return dir;
    } catch {
      // silently skip unreadable dirs (AC5)
    }
  }
  console.warn("[resolveControlDir] no agent directory matched control-repo remote");
  return null;
}

export type AgentStatus = {
  name: string;
  state: string;
  task: string | null;
  sessionStart: string | null;
  lastTool: string | null;
  lastSummary: string | null;
  ended: boolean;
};

// Read live.json and presence.json for each agent and return fleet status array.
// agentsHome is the parent of per-agent dirs (e.g. ~/agents).
export function readFleetStatus(agents: string[], agentsHome: string): AgentStatus[] {
  return agents.map((name) => {
    const presencePath = join(
      agentsHome, name, "control", "mailboxes", "presence", `${name}.json`,
    );
    let state = "stopped";
    try {
      const p = JSON.parse(readFileSync(presencePath, "utf8")) as Record<string, unknown>;
      if (typeof p.state === "string") state = p.state;
    } catch {
      // AC5: missing or unreadable → "stopped"
    }

    const livePath = join(agentsHome, name, "logs", "live.json");
    let task: string | null = null;
    let sessionStart: string | null = null;
    let lastTool: string | null = null;
    let lastSummary: string | null = null;
    let ended = true;
    try {
      const l = JSON.parse(readFileSync(livePath, "utf8")) as Record<string, unknown>;
      ended = l.ended === true;
      // AC3: ended sessions leave a stale task — do not forward it.
      task = ended ? null : (typeof l.task === "string" ? l.task : null);
      sessionStart = typeof l.session_start === "string" ? l.session_start : null;
      lastTool = typeof l.last_tool === "string" ? l.last_tool : null;
      lastSummary = typeof l.last_summary === "string" ? l.last_summary : null;
    } catch {
      // AC2: no live.json → all null, ended: true
    }

    return { name, state, task, sessionStart, lastTool, lastSummary, ended };
  });
}

// Returns an fs.watch callback for a single agent's log directory.
// Exported so tests can verify broadcast payloads without real filesystem events.
// broadcastFn receives a complete SSE frame (event + data lines, terminated with \n\n).
// cache is updated with the last fleet-update payload per agent for Last-Event-ID replay.
export function makeWatchHandler(
  agent: string,
  logDir: string,
  broadcastFn: (frame: string) => void,
  cache: Map<string, string>,
): (_event: string, filename: string | null) => void {
  return (_event, filename) => {
    if (filename === "live-events.jsonl") {
      // AC2: read last JSON line and broadcast fleet-update.
      // AC3: silently skip on ENOENT or permission error — watcher stays active.
      try {
        const content = readFileSync(join(logDir, "live-events.jsonl"), "utf8");
        const lines = content.trimEnd().split("\n").filter(Boolean);
        if (!lines.length) return;
        const parsed = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
        const payload = JSON.stringify({
          type: "fleet-update",
          agent,
          task: parsed.task ?? null,
          tool: parsed.tool ?? null,
          summary: parsed.summary ?? null,
          ts: Date.now(),
        });
        cache.set(agent, payload);
        broadcastFn(`event: fleet-update\ndata: ${payload}\n\n`);
      } catch {
        // AC3: unreadable — skip silently
      }
    } else if (filename === "live.json") {
      const payload = JSON.stringify({ type: "fleet-update", agent, ts: Date.now() });
      broadcastFn(`event: fleet-update\ndata: ${payload}\n\n`);
    }
  };
}

const MIME_TYPES: Record<string, string> = {
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  json: "application/json",
  svg: "image/svg+xml",
  ico: "image/x-icon",
};

// Serve a static file from rootDir. Handles 200/400/404 itself — always writes a response.
// Static handler must be placed LAST, after all API routes.
export function serveStatic(rootDir: string, urlPath: string, res: ServerResponse): void {
  const filePath = urlPath === "/" ? "index.html" : urlPath.replace(/^\//, "");
  const safeRoot = resolve(rootDir);
  const resolved = resolve(join(rootDir, filePath));

  // Path-traversal guard: resolved path must be inside safeRoot (AC4).
  if (!resolved.startsWith(safeRoot + sep)) {
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }

  const ext = resolved.slice(resolved.lastIndexOf(".") + 1).toLowerCase();
  const mime = MIME_TYPES[ext] ?? "application/octet-stream";

  try {
    const content = readFileSync(resolved);
    res.writeHead(200, { "content-type": mime, "content-length": content.length });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not Found");
  }
}

// Resolve the server port from the PORT env var (default 7842).
// Throws on non-numeric or out-of-range values so callers can exit 1.
export function resolvePort(portEnv: string | undefined): number {
  if (!portEnv) return 7842;
  const n = parseInt(portEnv, 10);
  if (isNaN(n) || n < 1024 || n > 65535) {
    throw new Error(`Invalid PORT value: "${portEnv}" — expected a number between 1024 and 65535`);
  }
  return n;
}

// Uppercase letters then either hyphen+digits (CONS-003) or digits only (T13) — no traversal.
export const TASK_ID_RE = /^[A-Z]+(-[0-9]+|[0-9]+)$/;

export type TaskEntry = Record<string, string>;
export type PipelineTask = TaskEntry & { updated_at: string };
export type MailboxNote = { from: string; ts: string; taskId: string; body: string };

// Parse fleet.conf: skip blank lines and # comments, return all agent names.
export function parseFleetConf(content: string): string[] {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(/\s+/)[0])
    .filter(Boolean);
}

// Extract path from node:http's raw un-normalised req.url (strips query string).
export function rawPath(url: string | undefined): string {
  if (!url) return "/";
  const end = url.indexOf("?");
  return end === -1 ? url : url.slice(0, end);
}

export function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

// Read all *.task files from ledgerDir and return parsed key:value objects.
// Returns [] if the directory is absent, empty, or unreadable.
// updated_at is derived from each file's mtime (most recently kernel/task-updated time).
export function parseTaskLedger(ledgerDir: string): PipelineTask[] {
  let files: string[];
  try {
    files = readdirSync(ledgerDir).filter((f) => f.endsWith(".task"));
  } catch {
    return [];
  }
  return files.map((f) => {
    const filePath = join(ledgerDir, f);
    const content = readFileSync(filePath, "utf8");
    const entry: TaskEntry = {};
    for (const line of content.split("\n")) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const key = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (key) entry[key] = value;
    }
    let updated_at: string;
    try {
      updated_at = statSync(filePath).mtime.toISOString();
    } catch {
      updated_at = new Date(0).toISOString();
    }
    return { ...entry, updated_at } as PipelineTask;
  });
}

// Delete stale decision request files (and their paired .decision.json) older than 1 hour.
// Also deletes orphaned .decision.json files older than 1 hour.
// Runs synchronously at startup; silently skips unreadable files.
export function purgeStaleDecisionFiles(decisionsDir: string): void {
  if (!decisionsDir) return;
  let files: string[];
  try {
    files = readdirSync(decisionsDir);
  } catch {
    return;
  }
  const ONE_HOUR = 60 * 60 * 1000;
  const now = Date.now();
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const fp = join(decisionsDir, f);
    try {
      const mtime = statSync(fp).mtime.getTime();
      if (now - mtime <= ONE_HOUR) continue;
      try { unlinkSync(fp); } catch { /* already removed */ }
      if (!f.endsWith(".decision.json")) {
        const decFp = join(decisionsDir, f.slice(0, -".json".length) + ".decision.json");
        try { unlinkSync(decFp); } catch { /* no paired file */ }
      }
    } catch {
      // unreadable or missing — skip
    }
  }
}

// Returns an fs.watch callback for the ledger directory.
// Broadcasts a pipeline-update SSE event whenever a .task file changes.
// Exported for unit tests; in server.ts this is registered at most once (no duplicate watchers).
export function makeLedgerWatchHandler(
  ledgerDir: string,
  broadcastFn: (frame: string) => void,
): (_event: string, filename: string | null) => void {
  return (_event, filename) => {
    if (!filename || !filename.endsWith(".task")) return;
    const taskId = filename.slice(0, -".task".length);
    if (!TASK_ID_RE.test(taskId)) return;
    let status: string | null = null;
    let agent: string | null = null;
    try {
      const content = readFileSync(join(ledgerDir, filename), "utf8");
      for (const line of content.split("\n")) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const key = line.slice(0, colon).trim();
        const val = line.slice(colon + 1).trim();
        if (key === "status") status = val || null;
        if (key === "claimed_by") agent = val && val !== "-" ? val : null;
      }
    } catch {
      // task file deleted — broadcast with null status/agent
    }
    const payload = JSON.stringify({ type: "pipeline-update", task_id: taskId, status, agent });
    broadcastFn(`event: pipeline-update\ndata: ${payload}\n\n`);
  };
}

export type GitSpawnResult = { code: number; out: string; err: string };
export type GitSpawner = (args: string[]) => Promise<GitSpawnResult>;

// Commit all staged + unstaged changes then push, retrying up to 3 times on rejection.
// Pass spawner to inject a mock in tests; defaults to Bun.spawn with 30s timeout.
export async function gitCommitAndPush(
  controlDir: string,
  commitMessage: string,
  spawner?: GitSpawner,
): Promise<void> {
  const git: GitSpawner = spawner ?? (async (args) => {
    const proc = Bun.spawn(["git", ...args], {
      cwd: controlDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), 30_000);
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    clearTimeout(timer);
    return { code: code ?? 1, out, err };
  });

  // Get current branch name for the reset target on retry (AC2).
  const branchResult = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchResult.out.trim() || "main";

  // Stage all working-tree changes (AC1: git add -A).
  await git(["add", "-A"]);

  // Commit — exit non-zero means nothing to commit; resolve void without push (AC5).
  const commitResult = await git(["commit", "-m", commitMessage]);
  if (commitResult.code !== 0) return;

  // Attempt push up to 3 times; sync with remote between each failure (AC2, AC3, AC4).
  for (let attempt = 1; attempt <= 3; attempt++) {
    const pushResult = await git(["push", "origin", "HEAD"]);
    if (pushResult.code === 0) return; // AC4: success

    if (attempt < 3) {
      await git(["fetch", "origin"]);
      await git(["reset", "--hard", `origin/${branch}`]);
      await git(["add", "-A"]);
      await git(["commit", "-m", commitMessage]);
    }
  }

  throw new Error("git push failed after 3 retries"); // AC3
}

export type ApprovalItem = Record<string, unknown>;

// Read unresolved decision-request files from decisionsDir.
// A request file (<base>.json) is "unresolved" when no matching <base>.decision.json exists.
// Returns [] for undefined/empty dir or when the dir is absent/unreadable.
export function readApprovals(decisionsDir: string | undefined): ApprovalItem[] {
  if (!decisionsDir) return [];
  let files: string[];
  try {
    files = readdirSync(decisionsDir);
  } catch {
    return [];
  }
  const resolved = new Set(
    files
      .filter((f) => f.endsWith(".decision.json"))
      .map((f) => f.slice(0, -(".decision.json".length)) + ".json"),
  );
  return files
    .filter((f) => f.endsWith(".json") && !f.endsWith(".decision.json") && !resolved.has(f))
    .flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(join(decisionsDir, f), "utf8")) as ApprovalItem];
      } catch {
        return [];
      }
    });
}

export interface LogEvent {
  ts: string;
  tool: string;
  summary: string;
  path: string | null;
}

// Read the last n lines of a JSONL log file. Silently skips malformed lines (AC5).
// Returns { events: [], totalLines: 0 } when the file is absent or empty (AC4).
export function readLogTail(logFile: string, n: number): { events: LogEvent[]; totalLines: number } {
  let content: string;
  try {
    content = readFileSync(logFile, "utf8");
  } catch {
    return { events: [], totalLines: 0 };
  }
  const lines = content.split("\n").filter((l) => l.trim() !== "");
  const totalLines = lines.length;
  const events: LogEvent[] = [];
  for (const line of lines.slice(-n)) {
    try {
      const ev = JSON.parse(line) as Record<string, unknown>;
      events.push({
        ts: typeof ev.ts === "string" ? ev.ts : "",
        tool: typeof ev.tool === "string" ? ev.tool : "",
        summary: typeof ev.summary === "string" ? ev.summary : "",
        path: typeof ev.path === "string" ? ev.path : null,
      });
    } catch {
      // AC5: silently skip malformed lines
    }
  }
  return { events, totalLines };
}

// Simple token bucket rate limiter — caller owns state, resets when the returned object is GC'd.
// check(ip) returns true (allowed) or false (over limit → respond 429).
export function makeRateLimiter(maxPerSecond: number): { check: (ip: string) => boolean } {
  const map = new Map<string, { count: number; resetAt: number }>();
  return {
    check(ip: string): boolean {
      const now = Date.now();
      const entry = map.get(ip);
      if (!entry || now >= entry.resetAt) {
        map.set(ip, { count: 1, resetAt: now + 1000 });
        return true;
      }
      if (entry.count >= maxPerSecond) return false;
      entry.count++;
      return true;
    },
  };
}

// Parse a mailbox file's content into an array of note objects.
// Returns [] when the file contains only the <!-- cleared --> marker.
export function parseMailboxNotes(content: string): MailboxNote[] {
  const notes: MailboxNote[] = [];
  const sections = content.split(/^## /m);
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed || trimmed.startsWith("<!--")) continue;
    const firstLine = trimmed.split("\n")[0];
    const match = firstLine.match(
      /^from:\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*re:\s*(.+)$/,
    );
    if (!match) continue;
    notes.push({
      from: match[1].trim(),
      ts: match[2].trim(),
      taskId: match[3].trim(),
      body: trimmed.slice(firstLine.length).trim(),
    });
  }
  return notes;
}

// T14: Stuck detection

export interface StuckAgent {
  agent: string;
  signal: "silent" | "loop" | "fail_storm";
  detail: string;
  since: string;
}

const STUCK_SILENT_SECONDS = 600;
const STUCK_IDLE_STATUSES = new Set(["needs_human", "awaiting_info", "complete", "open"]);

// Compute stuck signals for a list of agents.
// nowMs is injectable for deterministic tests.
export function computeStuckSignals(
  agents: string[],
  agentsHome: string,
  ledgerDir: string,
  nowMs: number = Date.now(),
): StuckAgent[] {
  const tasks = parseTaskLedger(ledgerDir);

  const agentTask = new Map<string, { failureCount: number; status: string }>();
  for (const task of tasks) {
    const cb = task.claimed_by;
    if (cb && cb !== "-" && cb !== "") {
      const fc = parseInt(task.failure_count ?? "0", 10);
      agentTask.set(cb, { failureCount: Number.isFinite(fc) ? fc : 0, status: task.status ?? "" });
    }
  }

  const stuck: StuckAgent[] = [];
  const sinceIso = new Date(nowMs).toISOString();

  for (const agent of agents) {
    const taskMeta = agentTask.get(agent);

    // AC8: skip agents in idle/terminal statuses
    if (taskMeta && STUCK_IDLE_STATUSES.has(taskMeta.status)) continue;

    // AC4: fail_storm takes highest precedence
    if (taskMeta && taskMeta.failureCount >= 2 && taskMeta.status !== "needs_human" && taskMeta.status !== "awaiting_info") {
      stuck.push({ agent, signal: "fail_storm", detail: `${taskMeta.failureCount} failed attempts`, since: sinceIso });
      continue;
    }

    // Read last 20 JSONL lines; skip malformed (AC5/AC6)
    let validEvents: Record<string, unknown>[] = [];
    try {
      const content = readFileSync(join(agentsHome, agent, "logs", "live-events.jsonl"), "utf8");
      const rawLines = content.split("\n").filter((l) => l.trim() !== "");
      validEvents = rawLines
        .slice(-20)
        .map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; } })
        .filter((e): e is Record<string, unknown> => e !== null);
    } catch {
      // AC6: missing/unreadable log — skip gracefully
      continue;
    }

    if (validEvents.length === 0) continue;

    // AC3: loop — last 5 valid events all have same non-null tool
    if (validEvents.length >= 5) {
      const last5 = validEvents.slice(-5);
      const tools = last5.map((e) => (typeof e.tool === "string" && e.tool !== "") ? e.tool : null);
      if (tools.every((t) => t !== null) && new Set(tools).size === 1) {
        stuck.push({ agent, signal: "loop", detail: `looping on ${tools[0]}`, since: sinceIso });
        continue;
      }
    }

    // AC2: silent — last valid event ts more than 600s ago
    const lastEvent = validEvents[validEvents.length - 1];
    const tsMs = typeof lastEvent.ts === "string" ? new Date(lastEvent.ts).getTime() : 0;
    if (tsMs > 0 && (nowMs - tsMs) / 1000 > STUCK_SILENT_SECONDS) {
      const minutes = Math.round((nowMs - tsMs) / 60_000);
      stuck.push({ agent, signal: "silent", detail: `silent for ${minutes}m`, since: sinceIso });
    }
  }

  return stuck;
}

// T11: Fleet process control types and utilities

export type KillFn = (pid: number, signal: string) => void;
export type IsAliveFn = (pid: number) => boolean;

// Read PID from a pid file; returns null if missing, unreadable, or not a positive integer.
export function readPidFile(pidPath: string): number | null {
  try {
    const pid = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Check process liveness via signal 0 (no signal sent; ESRCH if absent).
export function defaultIsProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Send a signal; swallows if the process has already exited.
export function defaultKillFn(pid: number, signal: string): void {
  try { process.kill(pid, signal as NodeJS.Signals); } catch { /* already gone */ }
}

// Send SIGTERM; fire SIGKILL after stopTimeoutMs (default 5000ms) if still alive.
// Resolves when the process is confirmed dead or SIGKILL has fired.
// Returns immediately without sending any signal if the process is already dead (AC6/AC8).
export async function stopProcess(
  pid: number,
  opts: { killFn?: KillFn; isAliveFn?: IsAliveFn; stopTimeoutMs?: number } = {},
): Promise<void> {
  const kill = opts.killFn ?? defaultKillFn;
  const isAlive = opts.isAliveFn ?? defaultIsProcessAlive;
  const ms = opts.stopTimeoutMs ?? 5_000;

  if (!isAlive(pid)) return;
  kill(pid, "SIGTERM");

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(sigkillTimer);
      resolve();
    };
    const sigkillTimer = setTimeout(() => { kill(pid, "SIGKILL"); finish(); }, ms);
    const poll = setInterval(() => { if (!isAlive(pid)) finish(); }, 50);
  });
}

