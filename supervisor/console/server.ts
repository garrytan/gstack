// supervisor/console/server.ts — agent console HTTP server
// Resolves the control repo (cloning if needed) then starts the server.
// The HTTP port is never bound until the clone succeeds (CONS-002 AC3).
// Uses node:http so req.url is the raw (un-normalised) request path — Bun.serve()
// normalises dot segments before the fetch handler, defeating taskId validation (AC4).

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { watch, mkdirSync, readFileSync } from "fs";
import { spawnSync, spawn } from "child_process";
import { appendFile, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  TASK_ID_RE,
  parseFleetConf,
  rawPath,
  sendJson,
  parseTaskLedger,
  serveStatic,
  readFleetStatus,
  resolveControlDir,
  makeWatchHandler,
  makeLedgerWatchHandler,
  gitCommitAndPush,
  resolvePort,
  readApprovals,
  readLogTail,
  makeRateLimiter,
  purgeStaleDecisionFiles,
  readPidFile,
  defaultIsProcessAlive,
  defaultKillFn,
  stopProcess,
  computeStuckSignals,
  readAndValidatePostBody,
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
const supervisorDir = dirname(__dirname); // directory containing console/


async function handleMailbox(req: IncomingMessage, res: ServerResponse, agentName: string): Promise<void> {
  const parsed = await readAndValidatePostBody(req);
  if (!parsed.ok) {
    sendJson(res, { error: parsed.error }, parsed.statusCode);
    return;
  }

  const mailboxFile = join(controlDir, "mailboxes", `${agentName}.md`);
  await appendFile(mailboxFile, parsed.raw ? `\n${parsed.raw}\n` : "\n");

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
  const parsed = await readAndValidatePostBody(req);
  if (!parsed.ok) {
    sendJson(res, { error: parsed.error }, parsed.statusCode);
    return;
  }
  let body: { agentName?: string; requestId?: string; approved?: boolean } = {};
  try {
    body = parsed.json as typeof body;
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

// Supervisor fleet.conf drives control-dir discovery only — not agent validation (T11-amended).
let supervisorAgentList: string[] = [];
try {
  supervisorAgentList = parseFleetConf(readFileSync(join(__dirname, "..", "fleet.conf"), "utf8"));
} catch {
  // Non-fatal: CONTROL_DIR env var may still resolve controlDir below.
}

// Scan each agent's control checkout to find the control repo (T2 AC1/AC4).
const agentDirs = supervisorAgentList.map((name) => join(homedir(), "agents", name, "control"));
const controlDir = resolveControlDir(agentDirs) ?? "";

// T11-amended AC1/AC2: validAgents built solely from controlDir/fleet.conf.
let validAgents = new Set<string>();
function rebuildValidAgents(dir: string): void {
  if (!dir) { validAgents = new Set(); return; }
  const confPath = join(dir, "fleet.conf");
  try {
    validAgents = new Set(parseFleetConf(readFileSync(confPath, "utf8")));
  } catch {
    process.stderr.write(`WARNING: fleet.conf not found at ${confPath} — no agents valid\n`);
    validAgents = new Set();
  }
}
rebuildValidAgents(controlDir);
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

// T14: stuck detection state — cleared on restart.
const prevStuckSignals = new Map<string, string>(); // agent → last signal type
const lastStuckBroadcast = new Map<string, number>(); // agent → last broadcast ms

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

// T5: POST /api/draft-decision — append human note to agent mailbox + git commit.
async function handleDraftDecision(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = await readAndValidatePostBody(req);
  if (!parsed.ok) {
    sendJson(res, { error: parsed.error }, parsed.statusCode);
    return;
  }

  if (!controlDir) {
    sendJson(res, { error: "control dir not configured" }, 503);
    return;
  }

  const body = parsed.json as { agentName?: string; taskId?: string; text?: string };
  const { agentName, taskId, text } = body;

  if (!agentName || !validAgents.has(agentName)) {
    sendJson(res, { error: "unknown agent" }, 400);
    return;
  }
  if (!taskId || !TASK_ID_RE.test(taskId)) {
    sendJson(res, { error: "invalid taskId" }, 400);
    return;
  }
  if (!text || text.trim() === "") {
    sendJson(res, { error: "text required" }, 400);
    return;
  }

  const ts = new Date().toISOString();
  const block = `\n## from: human | ${ts} | re: ${taskId}\n${text}\n`;
  const mailboxFile = join(controlDir, "mailboxes", `${agentName}.md`);
  await appendFile(mailboxFile, block);

  try {
    await gitCommitAndPush(controlDir, `console: note for ${agentName} re ${taskId}`);
    sendJson(res, { ok: true });
  } catch {
    sendJson(res, { error: "git push failed" }, 500);
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

  // POST /api/draft-decision — append human note to agent mailbox (T5).
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
  // T11-amended AC4: only agents in validAgents (from controlDir/fleet.conf) are included.
  if (path === "/api/fleet" && method === "GET") {
    sendJson(res, readFleetStatus([...validAgents], join(homedir(), "agents")));
    return;
  }

  // T11: POST /api/fleet/{stop,restart,pause,resume}?agent=... — fleet process control.
  if (path.startsWith("/api/fleet/") && method === "POST") {
    const action = path.slice("/api/fleet/".length).split("/")[0] as string;
    if (action !== "stop" && action !== "restart" && action !== "pause" && action !== "resume") {
      sendJson(res, { error: "unknown action" }, 404);
      return;
    }
    const qIdx = (req.url ?? "").indexOf("?");
    const agentName = qIdx !== -1
      ? (new URLSearchParams((req.url ?? "").slice(qIdx + 1)).get("agent") ?? "")
      : "";
    if (!validAgents.has(agentName)) {
      sendJson(res, { error: "unknown agent" }, 400);
      return;
    }
    const pidFile = join(supervisorDir, "pids", `${agentName}.pid`);
    const pid = readPidFile(pidFile);
    if (pid === null) {
      sendJson(res, { error: "pid file not found" }, 404);
      return;
    }
    if (action === "pause" || action === "resume") {
      if (!defaultIsProcessAlive(pid)) {
        sendJson(res, { error: "process not running" }, 409);
        return;
      }
      defaultKillFn(pid, action === "pause" ? "SIGSTOP" : "SIGCONT");
      sendJson(res, { ok: true });
      return;
    }
    // T15-amended: for restart, mark the agent's current task as human-failed first.
    if (action === "restart") {
      const tasks = parseTaskLedger(join(controlDir, "ledger"));
      const claimed = tasks.find((t) => t.claimed_by === agentName);
      if (claimed?.id) {
        const result = spawnSync(join(controlDir, "kernel", "task"), [
          "fail", claimed.id, "--agent", agentName, "--role", "human",
        ]);
        const code = result.status ?? 1;
        if (code !== 0) {
          sendJson(res, { error: `kernel/task fail exited with code ${code}` }, 500);
          return;
        }
      }
    }
    // stop and restart — async; response sent after stop completes
    void (async () => {
      await stopProcess(pid);
      if (action === "restart") {
        const proc = spawn(join(supervisorDir, "run-agent.sh"), [agentName], {
          detached: true,
          stdio: "ignore",
        });
        proc.unref();
      }
      const fleetPayload = JSON.stringify({
        type: "fleet-update",
        agent: agentName,
        action,
        ts: Date.now(),
      });
      broadcast(`event: fleet-update\ndata: ${fleetPayload}\n\n`);
      sendJson(res, { ok: true });
    })();
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

  // GET /api/pipeline — all ledger tasks sorted within each status group by updated_at (T13 AC1/AC2).
  if (path === "/api/pipeline" && method === "GET") {
    const tasks = parseTaskLedger(join(controlDir, "ledger"));
    tasks.sort((a, b) => {
      const ta = new Date(a.updated_at || "").getTime() || 0;
      const tb = new Date(b.updated_at || "").getTime() || 0;
      return tb - ta;
    });
    sendJson(res, { tasks, updatedAt: new Date().toISOString() });
    return;
  }

  // GET /api/spec/:taskId — return raw markdown for a task spec (T13 AC7).
  if (path.startsWith("/api/spec/") && method === "GET") {
    const taskId = path.slice("/api/spec/".length).split("/")[0];
    if (!TASK_ID_RE.test(taskId)) {
      sendJson(res, { error: "invalid task ID" }, 400);
      return;
    }
    if (!controlDir) {
      sendJson(res, { error: "CONTROL_DIR not configured" }, 503);
      return;
    }
    const specFile = join(controlDir, "tasks", `${taskId}.md`);
    try {
      const markdown = readFileSync(specFile, "utf8");
      sendJson(res, { markdown });
    } catch {
      sendJson(res, { error: "spec not found" }, 404);
    }
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

  // T14: GET /api/stuck — compute stuck signals + edge-triggered SSE broadcast.
  if (path === "/api/stuck" && method === "GET") {
    const stuckAgents = computeStuckSignals(
      [...validAgents],
      join(homedir(), "agents"),
      controlDir ? join(controlDir, "ledger") : "",
    );

    const now = Date.now();
    const currentSignals = new Map<string, string>(stuckAgents.map((s) => [s.agent, s.signal]));

    for (const entry of stuckAgents) {
      const prev = prevStuckSignals.get(entry.agent);
      const last = lastStuckBroadcast.get(entry.agent) ?? 0;
      if (prev !== entry.signal && now - last >= 60_000) {
        broadcast(`event: stuck\ndata: ${JSON.stringify({ agent: entry.agent, signal: entry.signal, detail: entry.detail })}\n\n`);
        lastStuckBroadcast.set(entry.agent, now);
      }
    }

    for (const agent of [...prevStuckSignals.keys()]) {
      if (!currentSignals.has(agent)) prevStuckSignals.delete(agent);
    }
    for (const [agent, signal] of currentSignals) {
      prevStuckSignals.set(agent, signal);
    }

    sendJson(res, { stuck: stuckAgents });
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
for (const agent of supervisorAgentList) {
  const logDir = join(homedir(), "agents", agent, "logs");
  mkdirSync(logDir, { recursive: true });
  watch(logDir, makeWatchHandler(agent, logDir, broadcast, lastEventCache));
  console.log(`Watching ${logDir}`);
}

// T13 AC3: single ledger watcher — broadcasts pipeline-update SSE on any .task file change.
if (controlDir) {
  const ledgerDir = join(controlDir, "ledger");
  watch(ledgerDir, makeLedgerWatchHandler(ledgerDir, broadcast));
  console.log(`Watching ledger: ${ledgerDir}`);
}
