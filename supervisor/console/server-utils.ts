// supervisor/console/server-utils.ts — pure utility functions, no side effects
import type { ServerResponse } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

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
export function makeWatchHandler(
  agent: string,
  broadcastFn: (msg: string) => void,
): (_event: string, filename: string | null) => void {
  return (_event, filename) => {
    if (filename === "live-events.jsonl") {
      broadcastFn(JSON.stringify({ agent, file: filename, ts: Date.now() }));
    } else if (filename === "live.json") {
      // AC4: broadcast fleet-update so browsers know to re-fetch /api/fleet.
      broadcastFn(JSON.stringify({ type: "fleet-update", agent, ts: Date.now() }));
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

export type ApprovalItem = Record<string, unknown>;

// Return unresolved approval request files from decisionsDir.
// "Unresolved" = {agent}-{id}.json exists but {agent}-{id}.decision.json does NOT.
// Returns [] when decisionsDir is falsy, absent, or unreadable (AC5, AC6).
export function readApprovals(decisionsDir: string | undefined): ApprovalItem[] {
  if (!decisionsDir) return [];
  let files: string[];
  try {
    files = readdirSync(decisionsDir);
  } catch {
    return [];
  }
  const decisionSet = new Set(files.filter((f) => f.endsWith(".decision.json")));
  return files
    .filter((f) => f.endsWith(".json") && !f.endsWith(".decision.json"))
    .filter((f) => !decisionSet.has(f.replace(/\.json$/, ".decision.json")))
    .map((f): ApprovalItem | null => {
      try {
        return JSON.parse(readFileSync(join(decisionsDir, f), "utf8")) as ApprovalItem;
      } catch {
        return null;
      }
    })
    .filter((item): item is ApprovalItem => item !== null);
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
