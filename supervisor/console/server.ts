// supervisor/console/server.ts — agent console HTTP server
// Resolves the control repo (cloning if needed) then starts the server.
// The HTTP port is never bound until the clone succeeds (CONS-002 AC3).

import { existsSync, watch, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

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

// Extract the raw path without dot-segment resolution so traversal attempts
// reach the taskId validator rather than silently becoming a different path.
function rawPath(url: string): string {
  const afterScheme = url.indexOf("://");
  const pathStart = afterScheme === -1 ? 0 : url.indexOf("/", afterScheme + 3);
  if (pathStart === -1) return "/";
  const end = url.indexOf("?", pathStart);
  return end === -1 ? url.slice(pathStart) : url.slice(pathStart, end);
}

async function resolveControlDir(agents: string[]): Promise<string> {
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
  const gitProc = Bun.spawn(
    ["git", "-C", agentControlPath, "remote", "get-url", "origin"],
    { stdout: "pipe", stderr: "pipe" }
  );
  const gitExit = await gitProc.exited;
  const remoteUrl = (await new Response(gitProc.stdout).text()).trim();

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

  // CONS-002 AC1: clone is blocking; Bun.serve() is not called until done.
  console.log(`Cloning control repo from ${remoteUrl}...`);
  const cloneProc = Bun.spawn(["git", "clone", remoteUrl, clonePath], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const cloneExit = await cloneProc.exited;

  // CONS-002 AC6: non-zero exit on failure; no server is started.
  if (cloneExit !== 0) {
    console.error(`ERROR: failed to clone control repo from ${remoteUrl}`);
    process.exit(1);
  }

  return clonePath;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Read fleet.conf once — shared by control-dir resolution and agent validation.
const fleetConfPath = join(__dirname, "..", "fleet.conf");
let fleetContent: string;
try {
  fleetContent = await Bun.file(fleetConfPath).text();
} catch {
  console.error(`ERROR: cannot read fleet.conf at ${fleetConfPath}`);
  process.exit(1);
  throw new Error("unreachable"); // satisfies TS definite-assignment
}

const agentList = parseFleetConf(fleetContent);
const validAgents = new Set(agentList); // AC3, AC6: Set built at startup

// Resolve control dir (blocking — Bun.serve() is called only after this).
const controlDir = await resolveControlDir(agentList);
console.log(`Control dir: ${controlDir}`);

// SSE client registry — one controller per connected browser tab.
const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();

function broadcast(event: string): void {
  const chunk = encoder.encode(`data: ${event}\n\n`);
  for (const ctrl of sseClients) {
    try {
      ctrl.enqueue(chunk);
    } catch {
      sseClients.delete(ctrl);
    }
  }
}

// AC1: hostname:'127.0.0.1' — not reachable from any network interface.
Bun.serve({
  port: PORT,
  hostname: HOSTNAME,
  fetch(req: Request): Response {
    const path = rawPath(req.url);
    const { method } = req;

    if (path === "/health") {
      return json({ status: "ok", controlDir });
    }

    // AC3: POST /api/mailbox/:agentName — reject names not in fleet.conf Set.
    if (path.startsWith("/api/mailbox/") && method === "POST") {
      const agentName = path.slice("/api/mailbox/".length).split("/")[0];
      if (!validAgents.has(agentName)) {
        return json({ error: "unknown agent" }, 400);
      }
      return json({ queued: true });
    }

    // AC4/AC5: POST /api/unblock/:taskId — reject IDs that fail the regex.
    if (path.startsWith("/api/unblock/") && method === "POST") {
      const taskId = path.slice("/api/unblock/".length).split("/")[0];
      if (!TASK_ID_RE.test(taskId)) {
        return json({ error: "invalid task ID" }, 400);
      }
      return json({ unblocked: taskId });
    }

    // AC2/AC5: GET /api/events — SSE stream; each tab gets its own controller.
    if (path === "/api/events") {
      let thisCtrl: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          thisCtrl = ctrl;
          sseClients.add(ctrl);
          ctrl.enqueue(encoder.encode(": ping\n\n"));
        },
        cancel() {
          sseClients.delete(thisCtrl);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Console server listening on http://${HOSTNAME}:${PORT}`);

// AC1/AC4: one fs.watch per agent log directory; mkdir -p so missing dirs don't crash.
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
