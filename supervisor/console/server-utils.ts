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

// Uppercase letters, hyphen, digits only — no path segments, no traversal.
export const TASK_ID_RE = /^[A-Z]+-[0-9]+$/;

export type TaskEntry = Record<string, string>;
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
export function parseTaskLedger(ledgerDir: string): TaskEntry[] {
  let files: string[];
  try {
    files = readdirSync(ledgerDir).filter((f) => f.endsWith(".task"));
  } catch {
    return [];
  }
  return files.map((f) => {
    const content = readFileSync(join(ledgerDir, f), "utf8");
    const entry: TaskEntry = {};
    for (const line of content.split("\n")) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const key = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (key) entry[key] = value;
    }
    return entry;
  });
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

const STALE_THRESHOLD_MS = 60 * 60 * 1000;

export function purgeStaleDecisionFiles(dir: string): void {
  if (!dir) return;
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of files) {
    if (name.endsWith(".decision.json")) continue;
    if (!name.endsWith(".json")) continue;
    const fp = join(dir, name);
    try {
      if (Date.now() - statSync(fp).mtime.getTime() > STALE_THRESHOLD_MS) {
        try { unlinkSync(fp); } catch {}
        try { unlinkSync(join(dir, name.replace(/\.json$/, ".decision.json"))); } catch {}
      }
    } catch {}
  }
  for (const name of files) {
    if (!name.endsWith(".decision.json")) continue;
    const fp = join(dir, name);
    try {
      if (Date.now() - statSync(fp).mtime.getTime() > STALE_THRESHOLD_MS) {
        try { unlinkSync(fp); } catch {}
      }
    } catch {}
  }
}
