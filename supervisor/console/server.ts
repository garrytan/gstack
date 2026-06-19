// supervisor/console/server.ts — agent console HTTP server
// Resolves the control repo (cloning if needed) then starts the server.
// The HTTP port is never bound until the clone succeeds (CONS-002 AC3).
// Uses node:http so req.url is the raw (un-normalised) request path — Bun.serve()
// normalises dot segments before the fetch handler, defeating taskId validation (AC4).

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { spawnSync } from "child_process";
import { existsSync, watch, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";

const PORT = 7842;
const HOSTNAME = "127.0.0.1";
// Uppercase letters, hyphen, digits only — no path segments, no traversal.
const TASK_ID_RE = /^[A-Z]+-[0-9]+$/;
const __dirname = dirname(fileURLToPath(import.meta.url));

// Parse fleet.conf: skip blank lines and # comments, return all agent names.
function parseFleetConf(content: string): string[] {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(/\s+/)[0])
    .filter(Boolean);
}

// Extract path from node:http's raw un-normalised req.url (strips query string).
function rawPath(url: string | undefined): string {
  if (!url) return "/";
  const end = url.indexOf("?");
  return end === -1 ? url : url.slice(0, end);
}

function resolveControlDir(agents: string[]): string {
  // CONS-002 AC5: explicit override via env var.
  if (process.env.CONTROL_DIR) {
    return process.env.CONTROL_DIR;
  }

  if (!agents.length) {
    throw new Error("fleet.conf has no agent entries");
  }
  const firstAgent = agents[0];

  // CONS-002 AC4: derive URL via git, not a separate config file.
  const agentControlPath = join(homedir(), "agents", firstAgent, "control");
  const gitResult = spawnSync(
    "git",
    ["-C", agentControlPath, "remote", "get-url", "origin"],
    { encoding: "utf8" }
  );
  const gitExit = gitResult.status ?? 1;
  const remoteUrl = (gitResult.stdout ?? "").trim();

  if (gitExit !== 0 || !remoteUrl) {
    throw new Error(
      `Could not read control repo remote URL from ${agentControlPath}`
    );
  }

  const clonePath = join(homedir(), "agents", "console", "control");

  // CONS-002 AC2: already cloned — start immediately.
  if (existsSync(clonePath)) {
    return clonePath;
  }

  // CONS-002 AC1: clone is blocking; server.listen() is not called until done.
  console.log(`Cloning control repo from ${remoteUrl}...`);
  const cloneResult = spawnSync("git", ["clone", remoteUrl, clonePath], {
    stdio: "inherit",
  });
  const cloneExit = cloneResult.status ?? 1;

  // CONS-002 AC6: non-zero exit on failure; no server is started.
  if (cloneExit !== 0) {
    console.error(`ERROR: failed to clone control repo from ${remoteUrl}`);
    process.exit(1);
  }

  return clonePath;
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

// Read fleet.conf once — shared by control-dir resolution and agent validation.
const fleetConfPath = join(__dirname, "..", "fleet.conf");
let fleetContent: string;
try {
  fleetContent = readFileSync(fleetConfPath, "utf8");
} catch {
  console.error(`ERROR: cannot read fleet.conf at ${fleetConfPath}`);
  process.exit(1);
  throw new Error("unreachable"); // satisfies TS definite-assignment
}

const agentList = parseFleetConf(fleetContent);
const validAgents = new Set(agentList); // AC3, AC6: Set built at startup

// Resolve control dir (blocking — server.listen() is called only after this).
const controlDir = resolveControlDir(agentList);
console.log(`Control dir: ${controlDir}`);

// SSE client registry — one ServerResponse per connected browser tab.
const sseClients = new Set<ServerResponse>();

function broadcast(event: string): void {
  for (const res of sseClients) {
    try {
      res.write(`data: ${event}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
}

// CONS-005: POST /api/draft-decision — stream a Claude draft suggestion via SSE.
// Client disconnects abort the Anthropic SDK stream (no wasted tokens).
async function handleDraftDecision(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // AC3: missing key — return 503 before reading body.
  if (!process.env.ANTHROPIC_API_KEY) {
    sendJson(
      res,
      { error: "AI drafts unavailable — set ANTHROPIC_API_KEY in your environment" },
      503,
    );
    return;
  }

  // Read request body (small JSON — read before switching to SSE mode).
  let body: { taskId?: string; agentName?: string; context?: string } = {};
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    body = JSON.parse(Buffer.concat(chunks).toString()) as typeof body;
  } catch {
    // Malformed body — proceed with empty context.
  }

  // Switch to SSE mode.
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  // AC2: abort the SDK stream when the browser disconnects.
  const controller = new AbortController();
  req.on("close", () => controller.abort());

  const client = new Anthropic();
  try {
    const parts = [
      body.taskId ? `Task: ${body.taskId}` : "",
      body.agentName ? `Agent: ${body.agentName}` : "",
      body.context ?? "",
    ].filter(Boolean);
    const prompt = parts.join("\n") || "No context provided.";

    const stream = client.messages.stream(
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      },
      { signal: controller.signal },
    );

    // AC1: forward each text token as an SSE data event.
    stream.on("text", (text) => {
      res.write(`data: ${JSON.stringify(text)}\n\n`);
    });

    await stream.finalMessage();
    res.write("data: [DONE]\n\n"); // AC4: completion sentinel.
    res.end();
  } catch (err: unknown) {
    if (controller.signal.aborted) {
      // AC2: client disconnected — nothing more to write.
      res.end();
      return;
    }
    // AC5: API error — send error event and close gracefully.
    const msg = err instanceof Error ? err.message : "unknown error";
    try {
      res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    } catch {
      // Response already closed by the time we reach here.
    }
    res.end();
  }
}

// AC1: hostname '127.0.0.1' — not reachable from any network interface.
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const path = rawPath(req.url);
  const method = req.method ?? "GET";

  if (path === "/health") {
    sendJson(res, { status: "ok", controlDir });
    return;
  }

  // AC3: POST /api/mailbox/:agentName — reject names not in fleet.conf Set.
  if (path.startsWith("/api/mailbox/") && method === "POST") {
    const agentName = path.slice("/api/mailbox/".length).split("/")[0];
    if (!validAgents.has(agentName)) {
      sendJson(res, { error: "unknown agent" }, 400);
      return;
    }
    sendJson(res, { queued: true });
    return;
  }

  // AC4/AC5: POST /api/unblock/:taskId — reject IDs that fail the regex.
  if (path.startsWith("/api/unblock/") && method === "POST") {
    const taskId = path.slice("/api/unblock/".length).split("/")[0];
    if (!TASK_ID_RE.test(taskId)) {
      sendJson(res, { error: "invalid task ID" }, 400);
      return;
    }
    sendJson(res, { unblocked: taskId });
    return;
  }

  // GET /api/events — SSE stream; each tab gets its own ServerResponse.
  if (path === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": ping\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return; // keep connection open — do NOT call res.end()
  }

  // POST /api/draft-decision — stream AI-drafted decision suggestion (CONS-005).
  if (path === "/api/draft-decision" && method === "POST") {
    void handleDraftDecision(req, res);
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

server.listen(PORT, HOSTNAME, () => {
  console.log(`Console server listening on http://${HOSTNAME}:${PORT}`);
});

// One fs.watch per agent log directory; mkdir -p so missing dirs don't crash.
for (const agent of agentList) {
  const logDir = join(homedir(), "agents", agent, "logs");
  mkdirSync(logDir, { recursive: true });
  watch(logDir, (_evt, filename) => {
    if (filename === "live-events.jsonl") {
      broadcast(JSON.stringify({ agent, file: filename, ts: Date.now() }));
    }
  });
  console.log(`Watching ${logDir}`);
}
