// supervisor/console/server.ts — agent console HTTP server
// Resolves the control repo (cloning if needed) then starts the server.
// The HTTP port is never bound until the clone succeeds (CONS-002 AC3).
// Uses node:http so req.url is the raw (un-normalised) request path — Bun.serve()
// normalises dot segments before the fetch handler, defeating taskId validation (AC4).

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, watch, mkdirSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
import { appendFile, readdir, stat, unlink, writeFile } from "fs/promises";
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
} from "./server-utils.ts";

const PORT = 7842;
const HOSTNAME = "127.0.0.1";
const __dirname = dirname(fileURLToPath(import.meta.url));

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

// Run a git subcommand in repoPath, return exit code.
function runGit(args: string[], repoPath: string): number {
  const result = spawnSync("git", args, { cwd: repoPath, stdio: "inherit" });
  return result.status ?? 1;
}

// Commit `file` (absolute path inside `repoPath`) then push.
// If push is rejected (exit 1 or 128): pull --rebase once, then retry push.
// Maximum one rebase attempt — does not loop.
function gitCommitAndPush(repoPath: string, file: string, message: string): void {
  runGit(["add", file], repoPath);
  runGit(["commit", "-m", message], repoPath);

  console.log(`[gitCommitAndPush] pushing`);
  const pushExit = runGit(["push"], repoPath);
  if (pushExit === 0) return; // AC4: no rebase on success

  // Only rebase on push-rejection exit codes (AC4 constraint).
  if (pushExit === 1 || pushExit === 128) {
    console.log(`[gitCommitAndPush] push rejected (exit ${pushExit}), retrying with pull --rebase`);
    const pullExit = runGit(["pull", "--rebase"], repoPath);
    if (pullExit !== 0) throw new Error("push failed after retry"); // AC3

    const retryExit = runGit(["push"], repoPath);
    if (retryExit === 0) return; // AC2: success after rebase
  }

  throw new Error("push failed after retry"); // AC3
}

async function handleMailbox(req: IncomingMessage, res: ServerResponse, agentName: string): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString();

  const mailboxFile = join(controlDir, "mailboxes", `${agentName}.md`);
  await appendFile(mailboxFile, body ? `\n${body}\n` : "\n");

  try {
    gitCommitAndPush(controlDir, mailboxFile, `mailbox(${agentName}): console message`);
    sendJson(res, { ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "push failed after retry";
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
    res.write(": ping\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
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

  res.writeHead(404);
  res.end("Not Found");
});

// AC1/AC2: prune decision files older than 24h before binding — not fire-and-forget.
const _decisionsDir = process.env.SUPERVISOR_DECISIONS_DIR ?? "";
if (_decisionsDir) {
  try {
    const _now = Date.now();
    const _cutoff = 24 * 60 * 60 * 1000;
    for (const _file of await readdir(_decisionsDir)) {
      if (!_file.endsWith(".json")) continue;
      const _fp = join(_decisionsDir, _file);
      try {
        const _st = await stat(_fp);
        if (_now - _st.mtimeMs > _cutoff) await unlink(_fp);
      } catch { /* file removed between readdir and stat */ }
    }
  } catch { /* dir absent or unreadable */ }
}

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
