// supervisor/console/server.ts — agent console HTTP server
// Resolves the control repo (cloning if needed) then starts the server.
// The HTTP port is never bound until the clone succeeds (CONS-002 AC3).
// Uses node:http so req.url is the raw (un-normalised) request path — Bun.serve()
// normalises dot segments before the fetch handler, defeating taskId validation (AC4).

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { watch, mkdirSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
import { appendFile, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";
import {
  TASK_ID_RE,
  parseFleetConf,
  rawPath,
  sendJson,
  parseTaskLedger,
  serveStatic,
  readFleetStatus,
  makeWatchHandler,
  gitCommitAndPush,
  resolvePort,
  readApprovals,
  readLogTail,
  makeRateLimiter,
  purgeStaleDecisionFiles,
} from "./server-utils.ts";

// Validate PORT early — before any filesystem reads (AC5: exit 1 before bind).
const PORT = (() => {
  try {
    return resolvePort(process.env.PORT);
  } catch (e) {
    process.stderr.write(`ERROR: ${(e as Error).message}\n`);
    process.exit(1);
  }
})();
const HOSTNAME = "127.0.0.1";
const __dirname = dirname(fileURLToPath(import.meta.url));


async function handleMailbox(req: IncomingMessage, res: ServerResponse, agentName: string): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString();

  const mailboxFile = join(controlDir, "mailboxes", `${agentName}.md`);
  await appendFile(mailboxFile, body ? `\n${body}\n` : "\n");

  try {
    await gitCommitAndPush(controlDir, `mailbox(${agentName}): console message`);
    sendJson(res, { ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "git push failed after 3 retries";
    sendJson(res, { error: msg }, 500);
  }
}

// AC3/AC4: write decision file + schedule 60s unlink (gives bash wrapper time to read).
async function handleApprove(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let body: { agentName?: string; requestId?: string; approved?: boolean } = {};
  try {
    body = JSON.parse(Buffer.concat(chunks).toString()) as typeof body;
  } catch {
    sendJson(res, { error: "invalid JSON" }, 400);
    return;
  }

  const { agentName, requestId } = body;
  if (!agentName || !requestId || body.approved === undefined) {
    sendJson(res, { error: "missing agentName, requestId, or approved" }, 400);
    return;
  }

  const dir = process.env.SUPERVISOR_DECISIONS_DIR;
  if (!dir) {
    sendJson(res, { error: "SUPERVISOR_DECISIONS_DIR not set" }, 503);
    return;
  }

  const decisionFile = join(dir, `${agentName}-${requestId}.decision.json`);
  await writeFile(decisionFile, JSON.stringify({ approved: body.approved }));

  // AC3: schedule cleanup — bash wrapper has 60s to poll and read before we unlink.
  setTimeout(() => {
    unlink(decisionFile).catch(() => {}); // AC4: swallow — wrapper may have already removed it
  }, 60_000);

  sendJson(res, { ok: true });
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

// Scan each agent's control checkout to find the control repo (T2 AC1/AC4).
const agentDirs = agentList.map((name) => join(homedir(), "agents", name, "control"));
const controlDir = resolveControlDir(agentDirs) ?? "";
if (controlDir) {
  console.log(`Control dir: ${controlDir}`);
} else {
  console.warn("WARNING: control dir not found — mailbox and ledger routes unavailable");
}

// SSE client registry — one ServerResponse per connected browser tab.
const sseClients = new Set<ServerResponse>();

// AC4: last known fleet-update payload per agent — replayed on reconnect.
const lastEventCache = new Map<string, string>();

// AC7 (T12): module-level rate limiter for GET /api/log/:agent — resets on server restart.
const logRateLimiter = makeRateLimiter(10);

// broadcastFn: frame is a complete SSE frame (event + data lines, terminated with \n\n).
function broadcast(frame: string): void {
  for (const res of sseClients) {
    try {
      res.write(frame);
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
    void handleMailbox(req, res, agentName);
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
    // AC1: flush initial comment to prevent proxy buffering.
    res.write(": ok\n\n");

    // AC4: replay last known fleet-update for each agent on reconnect.
    const lastId = req.headers["last-event-id"];
    if (lastId) {
      for (const payload of lastEventCache.values()) {
        res.write(`event: fleet-update\ndata: ${payload}\n\n`);
      }
    }

    sseClients.add(res);

    // AC6: keep-alive ping every 30 s to prevent proxy/load-balancer timeout.
    const pingInterval = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        sseClients.delete(res);
        clearInterval(pingInterval);
      }
    }, 30_000);

    // AC5: remove client on disconnect; clear ping interval to avoid memory leak.
    req.on("close", () => {
      sseClients.delete(res);
      clearInterval(pingInterval);
    });
    return; // keep connection open — do NOT call res.end()
  }

  // POST /api/approve — write decision file for bash wrapper approval (CONS-008).
  if (path === "/api/approve" && method === "POST") {
    void handleApprove(req, res);
    return;
  }

  // POST /api/draft-decision — stream AI-drafted decision suggestion (CONS-005).
  if (path === "/api/draft-decision" && method === "POST") {
    void handleDraftDecision(req, res);
    return;
  }

  // GET /api/attention — return tasks with status: needs_human from the ledger.
  if (path === "/api/attention" && method === "GET") {
    const tasks = parseTaskLedger(join(controlDir, "ledger"));
    const needsHuman = tasks.filter((t) => t.status === "needs_human");
    sendJson(res, { tasks: needsHuman });
    return;
  }

  // GET /api/fleet — per-agent status from live.json + presence.json (CONS-012).
  if (path === "/api/fleet" && method === "GET") {
    sendJson(res, readFleetStatus(agentList, join(homedir(), "agents")));
    return;
  }

  // GET /api/queue — pending approvals + needs_human attention items (CONS-016).
  if (path === "/api/queue" && method === "GET") {
    const allTasks = parseTaskLedger(join(controlDir, "ledger"));
    const attention = allTasks.filter((t) => t.status === "needs_human");
    const approvals = readApprovals(process.env.SUPERVISOR_DECISIONS_DIR);
    sendJson(res, { approvals, attention });
    return;
  }

  // GET /api/log/:agent — return last N events from live-events.jsonl (T12).
  if (path.startsWith("/api/log/") && method === "GET") {
    const agentName = path.slice("/api/log/".length).split("/")[0];
    if (!validAgents.has(agentName)) {
      sendJson(res, { error: "not found" }, 404);
      return;
    }
    const ip = (req.socket as { remoteAddress?: string }).remoteAddress ?? "unknown";
    if (!logRateLimiter.check(ip)) {
      sendJson(res, { error: "rate limit exceeded" }, 429);
      return;
    }
    const qIdx = (req.url ?? "").indexOf("?");
    const nStr = qIdx !== -1
      ? new URLSearchParams((req.url ?? "").slice(qIdx + 1)).get("n")
      : null;
    let n = 50;
    if (nStr !== null) {
      const parsed = parseInt(nStr, 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 200) {
        sendJson(res, { error: "n must be 1-200" }, 400);
        return;
      }
      n = parsed;
    }
    const logFile = join(homedir(), "agents", agentName, "logs", "live-events.jsonl");
    const { events, totalLines } = readLogTail(logFile, n);
    const data = JSON.stringify({ events });
    res.writeHead(200, {
      "content-type": "application/json",
      "x-log-lines": String(totalLines),
      "content-length": Buffer.byteLength(data),
    });
    res.end(data);
    return;
  }

  // Static file handler (CONS-011) — LAST, after all API routes.
  serveStatic(__dirname, path, res);
});

// T8: purge stale decision files (older than 1 hour) synchronously before binding (AC5).
purgeStaleDecisionFiles(process.env.SUPERVISOR_DECISIONS_DIR ?? "");

// AC3: crash on EADDRINUSE rather than silently binding to a random port.
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    process.stderr.write(`ERROR: port ${PORT} already in use — is another console running?\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOSTNAME, () => {
  process.stdout.write(`Console ready → http://localhost:${PORT}\n`);
});

// One fs.watch per agent log directory; mkdir -p so missing dirs don't crash.
for (const agent of agentList) {
  const logDir = join(homedir(), "agents", agent, "logs");
  mkdirSync(logDir, { recursive: true });
  watch(logDir, makeWatchHandler(agent, logDir, broadcast, lastEventCache));
  console.log(`Watching ${logDir}`);
}
