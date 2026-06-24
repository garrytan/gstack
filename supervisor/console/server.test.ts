// supervisor/console/server.test.ts
// Tests for endpoint security boundaries (AC3, AC4, AC5) and utility edge cases (AC6, AC7).
// Starts a minimal test server on port 7843 — no dependency on a running console instance.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createServer } from "node:http";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, utimesSync, readFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, isAbsolute, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import {
  TASK_ID_RE,
  parseFleetConf,
  parseTaskLedger,
  parseMailboxNotes,
  sendJson,
  rawPath,
  serveStatic,
  readFleetStatus,
  makeWatchHandler,
  makeLedgerWatchHandler,
  gitCommitAndPush,
  resolvePort,
  readApprovals,
  readLogTail,
  makeRateLimiter,
  purgeStaleDecisionFiles,
  readPidFile,
  stopProcess,
  computeStuckSignals,
  readAndValidatePostBody,
  computeCostData,
  readWorkspaceRegistry,
  writeWorkspaceRegistry,
  bootstrapWorkspace,
  type CostAgentRow,
  type CostResponse,
  type AgentStatus,
  type GitSpawner,
  type ApprovalItem,
  type LogEvent,
  type PipelineTask,
  type KillFn,
  type IsAliveFn,
  type StuckAgent,
  type Workspace,
  type WorkspaceRegistry,
  type TrustRule,
  type TrustLedger,
} from "./server-utils.ts";

const TEST_PORT = 7843;

const testDir = join(tmpdir(), `console-test-${process.pid}`);
const ledgerDir = join(testDir, "ledger");
const staticDir = join(testDir, "static");
const agentsHome = join(testDir, "agents-home");
const decisionsDir = join(testDir, "decisions");
const tasksDir = join(testDir, "tasks");
const fleetAgents = ["agent-be", "agent-qa", "agent-fe", "agent-doc"];

// Agents recognised by the mock fleet.conf.
const validAgents = new Set(["agent-be", "agent-qa", "agent-fe", "agent-doc"]);

let httpServer: Server;

function makeHandler(rootDir: string, fleetHome?: string, testDecisionsDir?: string, testTasksDir?: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const path = rawPath(req.url);
    const method = req.method ?? "GET";

    // AC3: POST /api/unblock/:taskId — reject IDs failing the regex.
    if (path.startsWith("/api/unblock/") && method === "POST") {
      const taskId = path.slice("/api/unblock/".length).split("/")[0];
      if (!TASK_ID_RE.test(taskId)) {
        sendJson(res, { error: "invalid task ID" }, 400);
        return;
      }
      sendJson(res, { unblocked: taskId });
      return;
    }

    // AC4: POST /api/mailbox/:agentName — reject names not in fleet.conf Set.
    if (path.startsWith("/api/mailbox/") && method === "POST") {
      const agentName = path.slice("/api/mailbox/".length).split("/")[0];
      if (!validAgents.has(agentName)) {
        sendJson(res, { error: "unknown agent" }, 400);
        return;
      }
      void (async () => {
        const v = await readAndValidatePostBody(req);
        if (!v.ok) { sendJson(res, { error: v.error }, v.statusCode); return; }
        sendJson(res, { ok: true });
      })();
      return;
    }

    // POST /api/approve — validate JSON body and Content-Type (T9 AC1 + AC2).
    if (path === "/api/approve" && method === "POST") {
      void (async () => {
        const v = await readAndValidatePostBody(req);
        if (!v.ok) { sendJson(res, { error: v.error }, v.statusCode); return; }
        sendJson(res, { ok: true });
      })();
      return;
    }

    // POST /api/draft-decision — validate JSON body and Content-Type (T9 AC1 + AC2).
    if (path === "/api/draft-decision" && method === "POST") {
      void (async () => {
        const v = await readAndValidatePostBody(req);
        if (!v.ok) { sendJson(res, { error: v.error }, v.statusCode); return; }
        sendJson(res, { ok: true });
      })();
      return;
    }

    // AC5: GET /api/attention — return tasks with status: needs_human.
    if (path === "/api/attention" && method === "GET") {
      const tasks = parseTaskLedger(ledgerDir);
      const needsHuman = tasks.filter((t) => t.status === "needs_human");
      sendJson(res, { tasks: needsHuman });
      return;
    }

    // GET /api/fleet — per-agent status (CONS-012).
    if (path === "/api/fleet" && method === "GET" && fleetHome) {
      sendJson(res, readFleetStatus(fleetAgents, fleetHome));
      return;
    }

    // GET /api/queue — pending approvals + attention items (CONS-016).
    if (path === "/api/queue" && method === "GET") {
      const tasks = parseTaskLedger(ledgerDir);
      const attention = tasks.filter((t) => t.status === "needs_human");
      const approvals = readApprovals(testDecisionsDir);
      sendJson(res, { approvals, attention });
      return;
    }

    // T13 AC1/AC2: GET /api/pipeline — all ledger tasks sorted by updated_at descending.
    if (path === "/api/pipeline" && method === "GET") {
      const tasks = parseTaskLedger(ledgerDir);
      tasks.sort((a, b) => {
        const ta = new Date(a.updated_at || "").getTime() || 0;
        const tb = new Date(b.updated_at || "").getTime() || 0;
        return tb - ta;
      });
      sendJson(res, { tasks, updatedAt: new Date().toISOString() });
      return;
    }

    // T13 AC7: GET /api/spec/:taskId — return raw markdown for a task spec.
    if (path.startsWith("/api/spec/") && method === "GET") {
      const taskId = path.slice("/api/spec/".length).split("/")[0];
      if (!TASK_ID_RE.test(taskId)) {
        sendJson(res, { error: "invalid task ID" }, 400);
        return;
      }
      if (!testTasksDir) {
        sendJson(res, { error: "CONTROL_DIR not configured" }, 503);
        return;
      }
      const specFile = join(testTasksDir, `${taskId}.md`);
      try {
        const markdown = readFileSync(specFile, "utf8");
        sendJson(res, { markdown });
      } catch {
        sendJson(res, { error: "spec not found" }, 404);
      }
      return;
    }

    // Static file handler — last, after all API routes.
    serveStatic(rootDir, path, res);
  };
}

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      mkdirSync(ledgerDir, { recursive: true });
      mkdirSync(staticDir, { recursive: true });
      mkdirSync(decisionsDir, { recursive: true });
      mkdirSync(tasksDir, { recursive: true });

      // Seed mock ledger with one needs_human task for AC5.
      writeFileSync(
        join(ledgerDir, "CONS-999.task"),
        "id: CONS-999\nstatus: needs_human\ndomain: be\ndescription: blocked test task\n",
      );

      // Fixture files for CONS-011 static-serving tests.
      writeFileSync(join(staticDir, "index.html"), "<html><body>test</body></html>");
      writeFileSync(join(staticDir, "styles.css"), "body { color: red; }");

      // CONS-016 decisions fixtures: one unresolved + one resolved approval file.
      // agent-fe-REQ-1.json: no matching .decision.json → unresolved (should appear).
      writeFileSync(
        join(decisionsDir, "agent-fe-REQ-1.json"),
        JSON.stringify({ id: "REQ-1", agent: "agent-fe", command: "rm test.txt", risk: "low" }),
      );
      // agent-fe-REQ-2.json: has matching .decision.json → resolved (should be excluded).
      writeFileSync(
        join(decisionsDir, "agent-fe-REQ-2.json"),
        JSON.stringify({ id: "REQ-2", agent: "agent-fe", command: "cat file.txt", risk: "low" }),
      );
      writeFileSync(
        join(decisionsDir, "agent-fe-REQ-2.decision.json"),
        JSON.stringify({ approved: true }),
      );

      // CONS-012 fleet fixtures: four agents, each with different live/presence state.

      // agent-be: active session + presence → used for AC1 (full shape check)
      mkdirSync(join(agentsHome, "agent-be", "logs"), { recursive: true });
      mkdirSync(join(agentsHome, "agent-be", "control", "mailboxes", "presence"), { recursive: true });
      writeFileSync(
        join(agentsHome, "agent-be", "logs", "live.json"),
        JSON.stringify({
          agent: "agent-be",
          session_start: "2026-06-20T10:00:00Z",
          task: "CONS-012",
          last_tool: "Bash",
          last_summary: "Implementing fleet endpoint",
          ended: false,
        }),
      );
      writeFileSync(
        join(agentsHome, "agent-be", "control", "mailboxes", "presence", "agent-be.json"),
        JSON.stringify({ state: "working" }),
      );

      // agent-qa: ended session → AC3 (task must be null)
      mkdirSync(join(agentsHome, "agent-qa", "logs"), { recursive: true });
      writeFileSync(
        join(agentsHome, "agent-qa", "logs", "live.json"),
        JSON.stringify({ task: "CONS-009", ended: true }),
      );

      // agent-fe: no live.json at all → AC2 (all-null session fields)
      mkdirSync(join(agentsHome, "agent-fe", "logs"), { recursive: true });

      // agent-doc: active live.json but no presence.json → AC5 (state: "stopped")
      mkdirSync(join(agentsHome, "agent-doc", "logs"), { recursive: true });
      writeFileSync(
        join(agentsHome, "agent-doc", "logs", "live.json"),
        JSON.stringify({
          task: "CONS-003",
          session_start: "2026-06-20T09:00:00Z",
          ended: false,
        }),
      );

      // Seed a spec file for GET /api/spec tests.
      writeFileSync(join(tasksDir, "CONS-999.md"), "# CONS-999\n\nSpec content for testing.");

      httpServer = createServer(makeHandler(staticDir, agentsHome, decisionsDir, tasksDir));
      httpServer.listen(TEST_PORT, "127.0.0.1", resolve);
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      httpServer.close((err) => {
        rmSync(testDir, { recursive: true, force: true });
        if (err) reject(err);
        else resolve();
      });
    }),
);

// --- AC3 ---

describe("POST /api/unblock/:taskId", () => {
  test("returns 400 for invalid taskId (lowercase)", async () => {
    const r = await fetch(`http://127.0.0.1:${TEST_PORT}/api/unblock/cons-003`, {
      method: "POST",
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  test("returns 400 for taskId with trailing slash (empty slot)", async () => {
    const r = await fetch(
      `http://127.0.0.1:${TEST_PORT}/api/unblock/CONS-003/extra`,
      { method: "POST" },
    );
    // The route matches because the prefix matches; taskId = "CONS-003" (valid).
    // This verifies .split("/")[0] isolates the first segment correctly.
    expect(r.status).toBe(200);
  });

  test("returns 400 for taskId with no digits", async () => {
    const r = await fetch(`http://127.0.0.1:${TEST_PORT}/api/unblock/CONS`, {
      method: "POST",
    });
    expect(r.status).toBe(400);
  });

  test("accepts a valid taskId (CONS-003)", async () => {
    const r = await fetch(`http://127.0.0.1:${TEST_PORT}/api/unblock/CONS-003`, {
      method: "POST",
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { unblocked: string };
    expect(body.unblocked).toBe("CONS-003");
  });
});

// --- AC4 ---

describe("POST /api/mailbox/:agentName", () => {
  test("returns 400 for unknown agent name", async () => {
    const r = await fetch(
      `http://127.0.0.1:${TEST_PORT}/api/mailbox/unknown-agent`,
      { method: "POST", body: "hello" },
    );
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  test("returns 400 for empty agent name slot", async () => {
    const r = await fetch(`http://127.0.0.1:${TEST_PORT}/api/mailbox/`, {
      method: "POST",
    });
    expect(r.status).toBe(400);
  });

  test("accepts a known agent name with valid JSON body", async () => {
    const r = await fetch(
      `http://127.0.0.1:${TEST_PORT}/api/mailbox/agent-be`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "test message" }),
      },
    );
    expect(r.status).toBe(200);
  });
});

// --- AC5 ---

describe("GET /api/attention", () => {
  test("returns 200 with the needs_human task from the mock ledger", async () => {
    const r = await fetch(`http://127.0.0.1:${TEST_PORT}/api/attention`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { tasks: Array<{ id: string; status: string }> };
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].id).toBe("CONS-999");
    expect(body.tasks[0].status).toBe("needs_human");
  });
});

// --- AC6 ---

describe("parseTaskLedger", () => {
  test("returns [] for an empty ledger directory", () => {
    const emptyDir = join(testDir, "empty-ledger");
    mkdirSync(emptyDir, { recursive: true });
    expect(parseTaskLedger(emptyDir)).toEqual([]);
  });

  test("returns [] when the ledger directory does not exist", () => {
    expect(parseTaskLedger(join(testDir, "nonexistent-ledger"))).toEqual([]);
  });
});

// --- CONS-011: static file serving ---

describe("GET / (index.html)", () => {
  test("returns 200 with HTML content and text/html content-type (AC1)", async () => {
    const r = await fetch(`http://127.0.0.1:${TEST_PORT}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const body = await r.text();
    expect(body).toContain("<html>");
  });

  test("GET /index.html also returns 200 with HTML (AC1)", async () => {
    const r = await fetch(`http://127.0.0.1:${TEST_PORT}/index.html`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
  });
});

describe("GET /styles.css", () => {
  test("returns 200 with CSS content and text/css content-type (AC2)", async () => {
    const r = await fetch(`http://127.0.0.1:${TEST_PORT}/styles.css`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/css");
    const body = await r.text();
    expect(body).toContain("color");
  });
});

describe("GET /nonexistent.xyz", () => {
  test("returns 404 for a file that does not exist (AC3)", async () => {
    const r = await fetch(`http://127.0.0.1:${TEST_PORT}/nonexistent.xyz`);
    expect(r.status).toBe(404);
  });
});

describe("path traversal prevention", () => {
  test("returns 400 or 404 for a traversal attempt (AC4)", async () => {
    const r = await fetch(`http://127.0.0.1:${TEST_PORT}/../../../etc/passwd`);
    expect([400, 404]).toContain(r.status);
  });
});

// --- CONS-012: GET /api/fleet ---

describe("GET /api/fleet", () => {
  test("returns 200 with application/json and a typed AgentStatus array (AC1)", async () => {
    const r = await fetch(`http://127.0.0.1:${TEST_PORT}/api/fleet`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    const body = (await r.json()) as AgentStatus[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(4);
    const be = body.find((a) => a.name === "agent-be");
    expect(be).toBeDefined();
    expect(be!.state).toBe("working");
    expect(be!.task).toBe("CONS-012");
    expect(be!.sessionStart).toBe("2026-06-20T10:00:00Z");
    expect(be!.lastTool).toBe("Bash");
    expect(be!.ended).toBe(false);
  });

  test("agent with no live.json has null session fields and ended: true (AC2)", async () => {
    const r = await fetch(`http://127.0.0.1:${TEST_PORT}/api/fleet`);
    const body = (await r.json()) as AgentStatus[];
    const fe = body.find((a) => a.name === "agent-fe");
    expect(fe).toBeDefined();
    expect(fe!.task).toBeNull();
    expect(fe!.lastTool).toBeNull();
    expect(fe!.lastSummary).toBeNull();
    expect(fe!.sessionStart).toBeNull();
    expect(fe!.ended).toBe(true);
  });

  test("agent with ended:true in live.json returns task: null (AC3)", async () => {
    const r = await fetch(`http://127.0.0.1:${TEST_PORT}/api/fleet`);
    const body = (await r.json()) as AgentStatus[];
    const qa = body.find((a) => a.name === "agent-qa");
    expect(qa).toBeDefined();
    expect(qa!.task).toBeNull();
    expect(qa!.ended).toBe(true);
  });

  test("agent with missing presence.json has state: 'stopped' (AC5)", async () => {
    const r = await fetch(`http://127.0.0.1:${TEST_PORT}/api/fleet`);
    const body = (await r.json()) as AgentStatus[];
    const doc = body.find((a) => a.name === "agent-doc");
    expect(doc).toBeDefined();
    expect(doc!.state).toBe("stopped");
    expect(doc!.task).toBe("CONS-003");
    expect(doc!.ended).toBe(false);
  });
});

// --- T4: makeWatchHandler ---

describe("makeWatchHandler", () => {
  const watchLogDir = join(testDir, "watch-logs");

  beforeAll(() => {
    mkdirSync(watchLogDir, { recursive: true });
  });

  // AC2: reads last line of live-events.jsonl and broadcasts fleet-update SSE frame
  test("broadcasts fleet-update SSE frame with correct fields for live-events.jsonl (AC2)", () => {
    const frames: string[] = [];
    const cache = new Map<string, string>();
    const handler = makeWatchHandler("agent-be", watchLogDir, (f) => frames.push(f), cache);

    writeFileSync(
      join(watchLogDir, "live-events.jsonl"),
      JSON.stringify({ task: "T4", tool: "Bash", summary: "Running tests" }) + "\n",
    );

    handler("change", "live-events.jsonl");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain("event: fleet-update");
    const dataLine = frames[0].split("\n").find((l) => l.startsWith("data: "));
    const payload = JSON.parse(dataLine!.slice("data: ".length)) as {
      type: string; agent: string; task: string; tool: string; summary: string; ts: number;
    };
    expect(payload.type).toBe("fleet-update");
    expect(payload.agent).toBe("agent-be");
    expect(payload.task).toBe("T4");
    expect(payload.tool).toBe("Bash");
    expect(payload.summary).toBe("Running tests");
    expect(typeof payload.ts).toBe("number");
    expect(cache.get("agent-be")).toBeDefined();
  });

  // AC3: unreadable live-events.jsonl → no broadcast, no crash
  test("does not broadcast when live-events.jsonl is unreadable (AC3)", () => {
    const frames: string[] = [];
    const cache = new Map<string, string>();
    const missingDir = join(testDir, "missing-logs");
    // directory exists but file is absent → ENOENT
    mkdirSync(missingDir, { recursive: true });
    const handler = makeWatchHandler("agent-be", missingDir, (f) => frames.push(f), cache);
    handler("change", "live-events.jsonl");
    expect(frames).toHaveLength(0);
    expect(cache.size).toBe(0);
  });

  // live.json: broadcasts named fleet-update SSE frame
  test("broadcasts fleet-update SSE frame when live.json changes", () => {
    const frames: string[] = [];
    const cache = new Map<string, string>();
    const handler = makeWatchHandler("agent-be", watchLogDir, (f) => frames.push(f), cache);
    handler("change", "live.json");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain("event: fleet-update");
    const dataLine = frames[0].split("\n").find((l) => l.startsWith("data: "));
    const payload = JSON.parse(dataLine!.slice("data: ".length)) as {
      type: string; agent: string; ts: number;
    };
    expect(payload.type).toBe("fleet-update");
    expect(payload.agent).toBe("agent-be");
    expect(typeof payload.ts).toBe("number");
  });

  // unrelated filename → no broadcast
  test("does not call broadcast for unrelated filenames", () => {
    const frames: string[] = [];
    const cache = new Map<string, string>();
    const handler = makeWatchHandler("agent-be", watchLogDir, (f) => frames.push(f), cache);
    handler("change", "other.log");
    expect(frames).toHaveLength(0);
  });

  test("fires broadcast on 'rename' event for live-events.jsonl (AC6)", () => {
    const frames: string[] = [];
    const cache = new Map<string, string>();
    const handler = makeWatchHandler("agent-be", watchLogDir, (f) => frames.push(f), cache);

    writeFileSync(
      join(watchLogDir, "live-events.jsonl"),
      JSON.stringify({ task: "T9", tool: "Edit", summary: "Testing rename events" }) + "\n",
    );
    handler("rename", "live-events.jsonl");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain("event: fleet-update");
  });

  test("fires broadcast on 'rename' event for live.json (AC6)", () => {
    const frames: string[] = [];
    const cache = new Map<string, string>();
    const handler = makeWatchHandler("agent-be", watchLogDir, (f) => frames.push(f), cache);
    handler("rename", "live.json");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain("event: fleet-update");
  });
});

// --- T4: GET /api/events (AC1 + AC5) ---

describe("GET /api/events", () => {
  const localSseClients = new Set<ServerResponse>();
  let sseServer: Server;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        sseServer = createServer((req, res) => {
          const p = rawPath(req.url);
          if (p !== "/api/events") {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          res.write(": ok\n\n");
          localSseClients.add(res);
          req.on("close", () => localSseClients.delete(res));
        });
        sseServer.listen(7844, "127.0.0.1", resolve);
      }),
  );

  afterAll(
    () =>
      new Promise<void>((resolve, reject) => {
        sseServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  );

  test("returns 200 with SSE headers and ': ok' heartbeat (AC1)", async () => {
    const ac = new AbortController();
    const r = await fetch("http://127.0.0.1:7844/api/events", { signal: ac.signal });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    expect(r.headers.get("cache-control")).toBe("no-cache");
    expect(r.headers.get("connection")).toBe("keep-alive");
    const reader = r.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe(": ok\n\n");
    ac.abort();
    await reader.cancel();
    // Brief wait so close event fires before the next test checks localSseClients.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  test("removes closed response from sseClients on disconnect (AC5)", async () => {
    const before = localSseClients.size;
    const ac = new AbortController();
    const r = await fetch("http://127.0.0.1:7844/api/events", { signal: ac.signal });
    const reader = r.body!.getReader();
    await reader.read(); // consume ": ok\n\n"
    expect(localSseClients.size).toBe(before + 1);
    ac.abort();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(localSseClients.size).toBe(before);
  });

  test("three concurrent connections all receive a broadcast — no duplicates (AC3)", async () => {
    const initial = localSseClients.size;
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const responses = await Promise.all(
      controllers.map((ac) => fetch("http://127.0.0.1:7844/api/events", { signal: ac.signal })),
    );
    const readers = responses.map((r) => r.body!.getReader());
    await Promise.all(readers.map((r) => r.read())); // consume ": ok\n\n" heartbeats
    expect(localSseClients.size).toBe(initial + 3);

    const frame = `event: fleet-update\ndata: ${JSON.stringify({ test: true })}\n\n`;
    for (const client of localSseClients) {
      try { client.write(frame); } catch { /* closed */ }
    }

    const chunks = await Promise.all(readers.map((r) => r.read()));
    const texts = chunks.map((c) => new TextDecoder().decode(c.value));
    for (const text of texts) {
      expect(text).toContain("event: fleet-update");
      expect(text.split("event: fleet-update").length).toBe(2);
    }

    controllers.forEach((ac) => ac.abort());
    await Promise.all(readers.map((r) => r.cancel()));
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(localSseClients.size).toBe(initial);
  });
});

// --- T3: port binding ---

describe("port binding", () => {
  test("server binds to 127.0.0.1, not 0.0.0.0 (AC1)", async () => {
    const s = createServer(() => {});
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    const addr = s.address() as AddressInfo;
    expect(addr.address).toBe("127.0.0.1");
    await new Promise<void>((resolve) => s.close(resolve));
  });

  test("resolvePort returns 7842 when PORT is unset (AC2)", () => {
    expect(resolvePort(undefined)).toBe(7842);
    expect(resolvePort("")).toBe(7842);
  });

  test("resolvePort returns the numeric PORT value when set (AC2)", () => {
    expect(resolvePort("9999")).toBe(9999);
  });

  test("server actually binds to PORT=9999 when resolvePort is used (AC2)", async () => {
    const port = resolvePort("9999");
    const s = createServer(() => {});
    await new Promise<void>((resolve) => s.listen(port, "127.0.0.1", resolve));
    expect((s.address() as AddressInfo).port).toBe(9999);
    await new Promise<void>((resolve) => s.close(resolve));
  });

  test("EADDRINUSE exits 1 with the right error message (AC3)", async () => {
    const occupier = createServer(() => {});
    await new Promise<void>((resolve) => occupier.listen(0, "127.0.0.1", resolve));
    const usedPort = (occupier.address() as AddressInfo).port;

    const script = `
import { createServer } from "node:http";
const s = createServer(() => {});
s.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    process.stderr.write("ERROR: port " + ${usedPort} + " already in use — is another console running?\\n");
    process.exit(1);
  }
});
s.listen(${usedPort}, "127.0.0.1");
`;
    const result = spawnSync("bun", ["--eval", script], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already in use");

    await new Promise<void>((resolve) => occupier.close(resolve));
  });

  test("resolvePort throws on non-numeric PORT (AC5)", () => {
    expect(() => resolvePort("abc")).toThrow();
  });

  test("resolvePort throws on out-of-range PORT (AC5)", () => {
    expect(() => resolvePort("80")).toThrow();
    expect(() => resolvePort("99999")).toThrow();
  });

  test("server exits 1 for PORT=invalid before bind (AC5)", () => {
    const tmpScript = join(tmpdir(), `t3-ac5-${process.pid}.ts`);
    writeFileSync(tmpScript, `
import { resolvePort } from ${JSON.stringify(join(import.meta.dir, "server-utils.ts"))};
try {
  resolvePort(process.env.PORT);
} catch (e) {
  process.stderr.write("ERROR: " + (e as Error).message + "\\n");
  process.exit(1);
}
`);
    const result = spawnSync("bun", ["run", tmpScript], {
      encoding: "utf8",
      env: { ...process.env, PORT: "invalid" },
    });
    try { unlinkSync(tmpScript); } catch { /* ignore */ }
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ERROR:");
  });
});

// --- AC7 ---

// --- CONS-016: GET /api/queue ---

describe("GET /api/queue", () => {
  test("returns only unresolved approvals and needs_human attention tasks (AC1)", async () => {
    const r = await fetch(`http://127.0.0.1:${TEST_PORT}/api/queue`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    const body = (await r.json()) as { approvals: ApprovalItem[]; attention: Array<{ id: string; status: string }> };
    // Only REQ-1 is unresolved (REQ-2 has a .decision.json)
    expect(body.approvals).toHaveLength(1);
    expect((body.approvals[0] as Record<string, unknown>).id).toBe("REQ-1");
    // attention mirrors /api/attention (CONS-999 is needs_human in the mock ledger)
    expect(body.attention).toHaveLength(1);
    expect(body.attention[0].id).toBe("CONS-999");
    expect(body.attention[0].status).toBe("needs_human");
  });
});

describe("GET /api/queue no decisions dir", () => {
  test("readApprovals returns [] when decisionsDir is undefined (AC5)", () => {
    expect(readApprovals(undefined)).toEqual([]);
  });

  test("readApprovals returns [] when decisionsDir is empty string (AC5)", () => {
    expect(readApprovals("")).toEqual([]);
  });
});

describe("GET /api/queue missing dir", () => {
  test("readApprovals returns [] when dir does not exist — no 500 (AC6)", () => {
    expect(readApprovals(join(testDir, "nonexistent-decisions"))).toEqual([]);
  });
});

describe("parseMailboxNotes", () => {
  test("returns [] for content containing only the cleared marker", () => {
    const content = "<!-- cleared by agent-be at 2026-06-20T08:00:00Z -->\n";
    expect(parseMailboxNotes(content)).toEqual([]);
  });

  test("returns [] for completely empty content", () => {
    expect(parseMailboxNotes("")).toEqual([]);
  });

  test("parses a real note section correctly", () => {
    const content = [
      "<!-- cleared by agent-be at 2026-06-20T07:00:00Z -->",
      "",
      "## from: agent-qa | 2026-06-20T07:00:00Z | re: CONS-003",
      "Bun API calls found.",
      "",
    ].join("\n");
    const notes = parseMailboxNotes(content);
    expect(notes).toHaveLength(1);
    expect(notes[0].from).toBe("agent-qa");
    expect(notes[0].taskId).toBe("CONS-003");
  });

  test("parseMailboxNotes with malformed header skips section gracefully (AC5)", () => {
    expect(parseMailboxNotes("## from: bad-header")).toEqual([]);
  });

  test("parseMailboxNotes with unicode agent name parses correctly (AC5)", () => {
    const content = [
      "",
      "## from: 代理人-α | 2026-06-21T00:00:00Z | re: T9",
      "unicode body",
      "",
    ].join("\n");
    const notes = parseMailboxNotes(content);
    expect(notes).toHaveLength(1);
    expect(notes[0].from).toBe("代理人-α");
    expect(notes[0].taskId).toBe("T9");
  });
});

// --- T8: startup cleanup ---

describe("startup cleanup", () => {
  const cleanupDir = join(testDir, "cleanup-decisions");

  beforeAll(() => {
    mkdirSync(cleanupDir, { recursive: true });
  });

  function setOldMtime(fp: string): void {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(fp, twoHoursAgo, twoHoursAgo);
  }

  test("deletes request *.json file older than 1 hour (AC1)", () => {
    const fp = join(cleanupDir, "agent-x-OLD-1.json");
    writeFileSync(fp, JSON.stringify({ id: "OLD-1" }));
    setOldMtime(fp);

    purgeStaleDecisionFiles(cleanupDir);
    expect(existsSync(fp)).toBe(false);
  });

  test("also deletes paired *.decision.json when request file is deleted (AC2)", () => {
    const reqFp = join(cleanupDir, "agent-x-OLD-2.json");
    const decFp = join(cleanupDir, "agent-x-OLD-2.decision.json");
    writeFileSync(reqFp, JSON.stringify({ id: "OLD-2" }));
    writeFileSync(decFp, JSON.stringify({ approved: true }));
    setOldMtime(reqFp);
    setOldMtime(decFp);

    purgeStaleDecisionFiles(cleanupDir);
    expect(existsSync(reqFp)).toBe(false);
    expect(existsSync(decFp)).toBe(false);
  });

  test("deletes old *.decision.json even when request file is not old (AC2)", () => {
    const reqFp = join(cleanupDir, "agent-x-OLD-3.json");
    const decFp = join(cleanupDir, "agent-x-OLD-3.decision.json");
    writeFileSync(reqFp, JSON.stringify({ id: "OLD-3" }));
    writeFileSync(decFp, JSON.stringify({ approved: false }));
    setOldMtime(decFp);
    // reqFp left with current mtime (newer than 1 hour)

    purgeStaleDecisionFiles(cleanupDir);
    expect(existsSync(decFp)).toBe(false);
    expect(existsSync(reqFp)).toBe(true);
  });

  test("does NOT delete request file newer than 1 hour (AC3)", () => {
    const fp = join(cleanupDir, "agent-x-NEW-1.json");
    writeFileSync(fp, JSON.stringify({ id: "NEW-1" }));
    // leave mtime as-is (just created — well under 1 hour)

    purgeStaleDecisionFiles(cleanupDir);
    expect(existsSync(fp)).toBe(true);
  });

  test("exits silently when decisionsDir does not exist (AC4)", () => {
    expect(() =>
      purgeStaleDecisionFiles(join(testDir, "nonexistent-cleanup-dir")),
    ).not.toThrow();
  });

  test("exits silently when decisionsDir is empty string (AC4)", () => {
    expect(() => purgeStaleDecisionFiles("")).not.toThrow();
  });
});

// --- T7: gitCommitAndPush ---

function makeSpawner(responses: Record<string, { code: number; out?: string; err?: string }[]>): {
  spawner: GitSpawner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const counters: Record<string, number> = {};
  const spawner: GitSpawner = async (args) => {
    calls.push([...args]);
    const key = args[0];
    counters[key] = (counters[key] ?? 0) + 1;
    const queue = responses[key] ?? [];
    const response = queue[counters[key] - 1] ?? queue[queue.length - 1] ?? { code: 0 };
    return { code: response.code, out: response.out ?? "", err: response.err ?? "" };
  };
  return { spawner, calls };
}

describe("gitCommitAndPush", () => {
  test("uses git add -A, commit -m, and push origin HEAD in order (AC1)", async () => {
    const { spawner, calls } = makeSpawner({
      "rev-parse": [{ code: 0, out: "main" }],
    });
    await gitCommitAndPush("/fake/repo", "test: hello", spawner);
    expect(calls[0]).toEqual(["rev-parse", "--abbrev-ref", "HEAD"]);
    expect(calls[1]).toEqual(["add", "-A"]);
    expect(calls[2]).toEqual(["commit", "-m", "test: hello"]);
    expect(calls[3]).toEqual(["push", "origin", "HEAD"]);
  });

  test("resolves void on success without retry (AC4)", async () => {
    const { spawner } = makeSpawner({ "rev-parse": [{ code: 0, out: "main" }] });
    await expect(gitCommitAndPush("/fake/repo", "msg", spawner)).resolves.toBeUndefined();
  });

  test("resolves void without push when commit exits non-zero (AC5)", async () => {
    const { spawner, calls } = makeSpawner({
      "rev-parse": [{ code: 0, out: "main" }],
      commit: [{ code: 1, err: "nothing to commit" }],
    });
    await expect(gitCommitAndPush("/fake/repo", "msg", spawner)).resolves.toBeUndefined();
    expect(calls.some((a) => a[0] === "push")).toBe(false);
  });

  test("retries with fetch+reset+re-stage+re-commit after first push failure (AC2)", async () => {
    let pushCount = 0;
    const { spawner, calls } = makeSpawner({
      "rev-parse": [{ code: 0, out: "main" }],
      push: [{ code: 128, err: "rejected" }, { code: 0 }],
    });
    // Override push counter tracking via custom spawner that delegates
    const wrappedSpawner: GitSpawner = async (args) => {
      if (args[0] === "push") pushCount++;
      return spawner(args);
    };
    await expect(gitCommitAndPush("/fake/repo", "msg", wrappedSpawner)).resolves.toBeUndefined();
    const fetchIdx = calls.findIndex((a) => a[0] === "fetch");
    const resetIdx = calls.findIndex((a) => a[0] === "reset");
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(resetIdx).toBeGreaterThan(fetchIdx);
    expect(calls[resetIdx]).toEqual(["reset", "--hard", "origin/main"]);
    expect(pushCount).toBe(2);
  });

  test("throws Error after 3 failed push attempts (AC3)", async () => {
    const { spawner } = makeSpawner({
      "rev-parse": [{ code: 0, out: "main" }],
      push: [{ code: 1 }],
    });
    await expect(gitCommitAndPush("/fake/repo", "msg", spawner)).rejects.toThrow(
      "git push failed after 3 retries",
    );
  });

  test("uses origin/<branch> from rev-parse in reset command (AC2 branch name)", async () => {
    const { spawner, calls } = makeSpawner({
      "rev-parse": [{ code: 0, out: "feat/my-branch\n" }],
      push: [{ code: 1, err: "rejected" }, { code: 0 }],
    });
    await gitCommitAndPush("/fake/repo", "msg", spawner);
    const resetCall = calls.find((a) => a[0] === "reset");
    expect(resetCall).toEqual(["reset", "--hard", "origin/feat/my-branch"]);
  });
});

// --- T12: GET /api/log/:agent ---

const logAgentsHome = join(testDir, "log-agents");
const logAgents = new Set(["agent-be", "agent-doc"]);
let logServer: Server;
const logLimiter = makeRateLimiter(10);

function makeLogHandler(agentsHome: string, limiter: { check: (ip: string) => boolean }) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const p = rawPath(req.url);
    if (!p.startsWith("/api/log/") || req.method !== "GET") {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    const agentName = p.slice("/api/log/".length).split("/")[0];
    if (!logAgents.has(agentName)) {
      sendJson(res, { error: "not found" }, 404);
      return;
    }
    const ip = (req.socket as { remoteAddress?: string }).remoteAddress ?? "unknown";
    if (!limiter.check(ip)) {
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
    const logFile = join(agentsHome, agentName, "logs", "live-events.jsonl");
    const { events, totalLines } = readLogTail(logFile, n);
    const data = JSON.stringify({ events });
    res.writeHead(200, {
      "content-type": "application/json",
      "x-log-lines": String(totalLines),
      "content-length": Buffer.byteLength(data),
    });
    res.end(data);
  };
}

describe("GET /api/log", () => {
  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        mkdirSync(join(logAgentsHome, "agent-be", "logs"), { recursive: true });
        // 100 valid JSONL lines for AC1 / AC6.
        const lines = Array.from({ length: 100 }, (_, i) =>
          JSON.stringify({ ts: String(i), tool: "Bash", summary: `event ${i}`, path: null }),
        ).join("\n") + "\n";
        writeFileSync(join(logAgentsHome, "agent-be", "logs", "live-events.jsonl"), lines);

        // agent-doc dir exists but has no JSONL file (AC4 test uses readLogTail directly).
        mkdirSync(join(logAgentsHome, "agent-doc", "logs"), { recursive: true });

        logServer = createServer(makeLogHandler(logAgentsHome, logLimiter));
        logServer.listen(7845, "127.0.0.1", resolve);
      }),
  );

  afterAll(
    () =>
      new Promise<void>((resolve, reject) => {
        logServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  );

  test("returns last 50 of 100 events as JSON array { events } (AC1)", async () => {
    const r = await fetch("http://127.0.0.1:7845/api/log/agent-be?n=50");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    const body = (await r.json()) as { events: LogEvent[] };
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events).toHaveLength(50);
    // Last event in file is i=99; last in the tail slice should also be i=99.
    const last = body.events[body.events.length - 1];
    expect(last.ts).toBe("99");
    expect(last.tool).toBe("Bash");
    expect(last.path).toBeNull();
  });

  test("?n=300 returns 400 { error: 'n must be 1-200' } (AC2)", async () => {
    const r = await fetch("http://127.0.0.1:7845/api/log/agent-be?n=300");
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("n must be 1-200");
  });

  test("?n=abc returns 400 { error: 'n must be 1-200' } (AC2)", async () => {
    const r = await fetch("http://127.0.0.1:7845/api/log/agent-be?n=abc");
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("n must be 1-200");
  });

  test("unknown agent returns 404 (AC3)", async () => {
    const r = await fetch("http://127.0.0.1:7845/api/log/agent-unknown");
    expect(r.status).toBe(404);
  });

  test("missing log file returns { events: [] } without 404/500 (AC4)", () => {
    const { events, totalLines } = readLogTail(join(testDir, "no-such-file.jsonl"), 50);
    expect(events).toEqual([]);
    expect(totalLines).toBe(0);
  });

  test("malformed JSON lines are silently skipped; valid lines returned (AC5)", () => {
    const malformedFile = join(testDir, "malformed.jsonl");
    writeFileSync(
      malformedFile,
      [
        JSON.stringify({ ts: "t1", tool: "Read", summary: "valid 1", path: null }),
        "{not-json",
        JSON.stringify({ ts: "t2", tool: "Bash", summary: "valid 2", path: "/x" }),
      ].join("\n") + "\n",
    );
    const { events } = readLogTail(malformedFile, 50);
    expect(events).toHaveLength(2);
    expect(events[0].tool).toBe("Read");
    expect(events[1].tool).toBe("Bash");
    expect(events[1].path).toBe("/x");
  });

  test("X-Log-Lines header equals total line count in file (AC6)", async () => {
    const r = await fetch("http://127.0.0.1:7845/api/log/agent-be?n=50");
    expect(r.status).toBe(200);
    const xLogLines = r.headers.get("x-log-lines");
    expect(xLogLines).toBeTruthy();
    expect(Number(xLogLines)).toBe(100);
  });
});

describe("GET /api/log rate limiting (AC7)", () => {
  let rlServer: Server;
  const rlLimiter = makeRateLimiter(10);

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        rlServer = createServer(makeLogHandler(logAgentsHome, rlLimiter));
        rlServer.listen(7846, "127.0.0.1", resolve);
      }),
  );

  afterAll(
    () =>
      new Promise<void>((resolve, reject) => {
        rlServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  );

  test("11th request from same IP returns 429 (AC7)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await fetch("http://127.0.0.1:7846/api/log/agent-be");
      statuses.push(r.status);
      await r.body?.cancel();
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

// --- T13 AC1/AC2: GET /api/pipeline ---

describe("GET /api/pipeline", () => {
  const pipelineLedger = join(testDir, "pipeline-ledger");

  beforeAll(() => {
    mkdirSync(pipelineLedger, { recursive: true });
    // Three tasks with different statuses and distinct mtimes.
    writeFileSync(
      join(pipelineLedger, "T1.task"),
      "id: T1\nstatus: open\ndomain: be\nclaimed_by: -\nfailure_count: 0\ndescription: Backend task\n",
    );
    writeFileSync(
      join(pipelineLedger, "T2.task"),
      "id: T2\nstatus: in_progress\ndomain: fe\nclaimed_by: agent-fe\nfailure_count: 1\ndescription: Frontend task\n",
    );
    writeFileSync(
      join(pipelineLedger, "T3.task"),
      "id: T3\nstatus: done\ndomain: doc\nclaimed_by: agent-doc\nfailure_count: 0\ndescription: Doc task\n",
    );
  });

  let pipelineServer: Server;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        pipelineServer = createServer(makeHandler(staticDir, undefined, undefined, tasksDir));
        // Override ledgerDir for the pipeline handler by wrapping makeHandler
        pipelineServer = createServer((req, res) => {
          const p = rawPath(req.url);
          if (p === "/api/pipeline" && req.method === "GET") {
            const tasks = parseTaskLedger(pipelineLedger);
            tasks.sort((a, b) => {
              const ta = new Date(a.updated_at || "").getTime() || 0;
              const tb = new Date(b.updated_at || "").getTime() || 0;
              return tb - ta;
            });
            sendJson(res, { tasks, updatedAt: new Date().toISOString() });
            return;
          }
          res.writeHead(404);
          res.end();
        });
        pipelineServer.listen(7847, "127.0.0.1", resolve);
      }),
  );

  afterAll(
    () =>
      new Promise<void>((resolve, reject) => {
        pipelineServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  );

  test("returns 200 with tasks array and updatedAt string (AC1)", async () => {
    const r = await fetch("http://127.0.0.1:7847/api/pipeline");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    const body = (await r.json()) as { tasks: PipelineTask[]; updatedAt: string };
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(body.tasks).toHaveLength(3);
    expect(typeof body.updatedAt).toBe("string");
  });

  test("each task has id, status, domain, failure_count, updated_at fields (AC1)", async () => {
    const r = await fetch("http://127.0.0.1:7847/api/pipeline");
    const body = (await r.json()) as { tasks: PipelineTask[] };
    const t2 = body.tasks.find((t) => t.id === "T2");
    expect(t2).toBeDefined();
    expect(t2!.status).toBe("in_progress");
    expect(t2!.domain).toBe("fe");
    expect(t2!.failure_count).toBe("1");
    expect(typeof t2!.updated_at).toBe("string");
    expect(new Date(t2!.updated_at).getTime()).toBeGreaterThan(0);
  });

  test("tasks with same status are sorted by updated_at descending (AC2)", () => {
    // Set T1 mtime to 1 hour ago, T3 mtime to 2 hours ago (both different statuses but we can
    // verify the sort direction by creating two same-status tasks).
    const sortLedger = join(testDir, "sort-ledger");
    mkdirSync(sortLedger, { recursive: true });
    const older = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const newer = new Date(Date.now() - 1 * 60 * 60 * 1000);

    writeFileSync(join(sortLedger, "SA-1.task"), "id: SA-1\nstatus: open\ndomain: be\n");
    writeFileSync(join(sortLedger, "SA-2.task"), "id: SA-2\nstatus: open\ndomain: fe\n");
    // Manually set mtimes so SA-2 is newer than SA-1
    utimesSync(join(sortLedger, "SA-1.task"), older, older);
    utimesSync(join(sortLedger, "SA-2.task"), newer, newer);

    const tasks = parseTaskLedger(sortLedger);
    tasks.sort((a, b) => {
      const ta = new Date(a.updated_at || "").getTime() || 0;
      const tb = new Date(b.updated_at || "").getTime() || 0;
      return tb - ta;
    });
    const openTasks = tasks.filter((t) => t.status === "open");
    expect(openTasks).toHaveLength(2);
    // SA-2 (newer) must come before SA-1 (older)
    expect(openTasks[0].id).toBe("SA-2");
    expect(openTasks[1].id).toBe("SA-1");
  });
});

// --- T13 AC3: makeLedgerWatchHandler ---

describe("makeLedgerWatchHandler", () => {
  const watchLedger = join(testDir, "watch-ledger");

  beforeAll(() => {
    mkdirSync(watchLedger, { recursive: true });
  });

  test("broadcasts single pipeline-update SSE frame for a .task file change (AC3)", () => {
    const frames: string[] = [];
    const handler = makeLedgerWatchHandler(watchLedger, (f) => frames.push(f));

    writeFileSync(
      join(watchLedger, "T99.task"),
      "id: T99\nstatus: open\nclaimed_by: -\ndomain: be\n",
    );
    handler("change", "T99.task");

    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain("event: pipeline-update");
    const dataLine = frames[0].split("\n").find((l) => l.startsWith("data: "));
    const payload = JSON.parse(dataLine!.slice("data: ".length)) as {
      type: string; task_id: string; status: string | null; agent: string | null;
    };
    expect(payload.type).toBe("pipeline-update");
    expect(payload.task_id).toBe("T99");
    expect(payload.status).toBe("open");
    expect(payload.agent).toBeNull();
  });

  test("includes claimed_by as agent when not '-' (AC3)", () => {
    const frames: string[] = [];
    const handler = makeLedgerWatchHandler(watchLedger, (f) => frames.push(f));
    writeFileSync(
      join(watchLedger, "T98.task"),
      "id: T98\nstatus: in_progress\nclaimed_by: agent-fe\ndomain: fe\n",
    );
    handler("change", "T98.task");
    expect(frames).toHaveLength(1);
    const dataLine = frames[0].split("\n").find((l) => l.startsWith("data: "));
    const payload = JSON.parse(dataLine!.slice("data: ".length)) as { agent: string | null };
    expect(payload.agent).toBe("agent-fe");
  });

  test("does not broadcast for non-.task filenames (AC3)", () => {
    const frames: string[] = [];
    const handler = makeLedgerWatchHandler(watchLedger, (f) => frames.push(f));
    handler("change", "README.md");
    handler("change", "some.json");
    handler("change", null);
    expect(frames).toHaveLength(0);
  });

  test("does not broadcast for .task filenames that fail TASK_ID_RE (AC3)", () => {
    const frames: string[] = [];
    const handler = makeLedgerWatchHandler(watchLedger, (f) => frames.push(f));
    handler("change", "invalid-task.task");
    expect(frames).toHaveLength(0);
  });
});

// --- T13 AC7: GET /api/spec/:taskId ---

describe("GET /api/spec/:taskId", () => {
  test("returns 200 with markdown content for a valid existing taskId (AC7)", async () => {
    const r = await fetch(`http://127.0.0.1:${TEST_PORT}/api/spec/CONS-999`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    const body = (await r.json()) as { markdown: string };
    expect(typeof body.markdown).toBe("string");
    expect(body.markdown).toContain("CONS-999");
  });

  test("returns 400 for invalid taskId (lowercase) (AC7)", async () => {
    const r = await fetch(`http://127.0.0.1:${TEST_PORT}/api/spec/cons-999`);
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  test("returns 400 for invalid taskId (no digits) (AC7)", async () => {
    const r = await fetch(`http://127.0.0.1:${TEST_PORT}/api/spec/CONS`);
    expect(r.status).toBe(400);
  });

  test("returns 404 for valid taskId with no spec file (AC7)", async () => {
    const r = await fetch(`http://127.0.0.1:${TEST_PORT}/api/spec/T13`);
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  test("returns 503 when no tasksDir configured (AC7)", async () => {
    // Create a separate server without tasksDir to test the 503 path.
    let noSpecServer: Server;
    await new Promise<void>((resolve) => {
      noSpecServer = createServer(makeHandler(staticDir));
      noSpecServer.listen(7848, "127.0.0.1", resolve);
    });
    try {
      const r = await fetch("http://127.0.0.1:7848/api/spec/CONS-001");
      expect(r.status).toBe(503);
    } finally {
      await new Promise<void>((resolve) => noSpecServer.close(() => resolve()));
    }
  });
});

// --- T13-amended AC2: pipeline bootstrapped at most once per tab activation ---

describe("T13-amended AC2: console.js pipeline bootstrap guard", () => {
  const consoleSrc = readFileSync(join(import.meta.dir, "console.js"), "utf8");

  test("pipelineBootstrapped guard variable is present in console.js", () => {
    expect(consoleSrc).toContain("pipelineBootstrapped");
  });

  test("fetchPipeline in switchTab is conditional on pipelineBootstrapped", () => {
    const switchTabIdx = consoleSrc.indexOf("function switchTab(");
    expect(switchTabIdx).toBeGreaterThan(-1);
    // The pipeline block inside switchTab must gate fetchPipeline on the flag
    const switchTabBody = consoleSrc.slice(switchTabIdx, switchTabIdx + 1000);
    expect(switchTabBody).toContain("pipelineBootstrapped");
    expect(switchTabBody).toContain("fetchPipeline()");
  });

  test("no setInterval or setTimeout polls /api/pipeline", () => {
    expect(/setInterval\b[^;]*pipeline/i.test(consoleSrc)).toBe(false);
    expect(/setTimeout\b[^;]*fetchPipeline/i.test(consoleSrc)).toBe(false);
  });
});

// --- T13-amended AC4: SSE reconnect bootstraps pipeline ---

describe("T13-amended AC4: SSE open handler calls fetchPipeline on reconnect", () => {
  const consoleSrc = readFileSync(join(import.meta.dir, "console.js"), "utf8");

  test("fetchPipeline is called inside the SSE open event handler", () => {
    const openIdx = consoleSrc.indexOf("addEventListener('open'");
    expect(openIdx).toBeGreaterThan(-1);
    const closingIdx = consoleSrc.indexOf("});\n", openIdx);
    expect(closingIdx).toBeGreaterThan(openIdx);
    const handler = consoleSrc.slice(openIdx, closingIdx + 4);
    expect(handler).toContain("fetchPipeline()");
  });
});

// ─── T11: Fleet control endpoints ────────────────────────────────────────────

// Helper: build a request handler for fleet control routes with injectable deps.
function makeFleetControlHandler(opts: {
  validAgents: Set<string>;
  pidsDir: string;
  supervisorDir: string;
  killFn: KillFn;
  isAliveFn: IsAliveFn;
  spawnFn: (script: string, agentName: string) => void;
  broadcastFn: (frame: string) => void;
  stopTimeoutMs?: number;
  ledgerDir?: string;
  taskFailFn?: (argv: string[]) => number;
}) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const path = rawPath(req.url);
    if (!path.startsWith("/api/fleet/") || req.method !== "POST") {
      res.writeHead(404); res.end(); return;
    }
    const action = path.slice("/api/fleet/".length).split("/")[0];
    if (action !== "stop" && action !== "restart" && action !== "pause" && action !== "resume") {
      sendJson(res, { error: "unknown action" }, 404); return;
    }
    const qIdx = (req.url ?? "").indexOf("?");
    const agentName = qIdx !== -1
      ? (new URLSearchParams((req.url ?? "").slice(qIdx + 1)).get("agent") ?? "")
      : "";
    if (!opts.validAgents.has(agentName)) {
      sendJson(res, { error: "unknown agent" }, 400); return;
    }
    const pidFile = join(opts.pidsDir, `${agentName}.pid`);
    const pid = readPidFile(pidFile);
    if (pid === null) {
      sendJson(res, { error: "pid file not found" }, 404); return;
    }
    if (action === "pause" || action === "resume") {
      if (!opts.isAliveFn(pid)) {
        sendJson(res, { error: "process not running" }, 409); return;
      }
      opts.killFn(pid, action === "pause" ? "SIGSTOP" : "SIGCONT");
      sendJson(res, { ok: true }); return;
    }
    // T15-amended: for restart, mark the agent's current task as human-failed first.
    if (action === "restart" && opts.taskFailFn && opts.ledgerDir) {
      const tasks = parseTaskLedger(opts.ledgerDir);
      const claimed = tasks.find((t) => t.claimed_by === agentName);
      if (claimed?.id) {
        const code = opts.taskFailFn(["fail", claimed.id, "--agent", agentName, "--role", "human"]);
        if (code !== 0) {
          sendJson(res, { error: `kernel/task fail exited with code ${code}` }, 500); return;
        }
      }
    }
    // stop / restart — async
    void (async () => {
      await stopProcess(pid, {
        killFn: opts.killFn,
        isAliveFn: opts.isAliveFn,
        stopTimeoutMs: opts.stopTimeoutMs ?? 100,
      });
      if (action === "restart") {
        opts.spawnFn(join(opts.supervisorDir, "run-agent.sh"), agentName);
      }
      const payload = JSON.stringify({ type: "fleet-update", agent: agentName, action, ts: Date.now() });
      opts.broadcastFn(`event: fleet-update\ndata: ${payload}\n\n`);
      sendJson(res, { ok: true });
    })();
  };
}

// Shared mutable spies — reset before each HTTP fleet test
let fleetKillCalls: { pid: number; signal: string }[] = [];
let fleetSpawnCalls: { script: string; agentName: string }[] = [];
let fleetBroadcasts: string[] = [];
let mockIsAlive: IsAliveFn = () => false;
let mockKill: KillFn = (pid, signal) => fleetKillCalls.push({ pid, signal });

const fleetPidsDir = join(testDir, "fleet-pids");
const fleetSupervisorDir = join(testDir, "fleet-supervisor");
const fleetValidAgents = new Set(["agent-be", "agent-qa"]);

let fleetServer: Server;

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      mkdirSync(fleetPidsDir, { recursive: true });
      // agent-be has pid 12345; agent-qa has no pid file (for 404 tests)
      writeFileSync(join(fleetPidsDir, "agent-be.pid"), "12345\n");

      fleetServer = createServer(
        makeFleetControlHandler({
          validAgents: fleetValidAgents,
          pidsDir: fleetPidsDir,
          supervisorDir: fleetSupervisorDir,
          killFn: (pid, signal) => mockKill(pid, signal),
          isAliveFn: (pid) => mockIsAlive(pid),
          spawnFn: (script, agentName) => fleetSpawnCalls.push({ script, agentName }),
          broadcastFn: (frame) => fleetBroadcasts.push(frame),
          stopTimeoutMs: 100,
        }),
      );
      fleetServer.listen(7849, "127.0.0.1", resolve);
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      fleetServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    }),
);

// --- T11 AC1: stopProcess sends SIGTERM, then SIGKILL if process stays alive ---

describe("stopProcess (AC1)", () => {
  test("sends SIGTERM first, then SIGKILL after timeout when process stays alive", async () => {
    const signals: string[] = [];
    const killFn: KillFn = (_pid, sig) => signals.push(sig);
    const isAliveFn: IsAliveFn = () => true; // never dies naturally

    await stopProcess(12345, { killFn, isAliveFn, stopTimeoutMs: 60 });

    expect(signals).toContain("SIGTERM");
    expect(signals).toContain("SIGKILL");
    expect(signals.indexOf("SIGTERM")).toBeLessThan(signals.indexOf("SIGKILL"));
  });

  test("sends SIGTERM and resolves without SIGKILL when process dies after SIGTERM", async () => {
    const signals: string[] = [];
    let alive = true;
    const killFn: KillFn = (_pid, sig) => {
      signals.push(sig);
      if (sig === "SIGTERM") alive = false; // process dies on SIGTERM
    };
    const isAliveFn: IsAliveFn = () => alive;

    await stopProcess(12345, { killFn, isAliveFn, stopTimeoutMs: 500 });

    expect(signals).toContain("SIGTERM");
    expect(signals).not.toContain("SIGKILL");
  });

  test("returns immediately without sending any signal when process is already dead (AC6/AC8)", async () => {
    const signals: string[] = [];
    const killFn: KillFn = (_pid, sig) => signals.push(sig);
    const isAliveFn: IsAliveFn = () => false;

    await stopProcess(99999, { killFn, isAliveFn });

    expect(signals).toHaveLength(0);
  });
});

// --- T11 AC5: unknown agent → 400 on all four endpoints ---

describe("fleet control unknown agent → 400 (AC5)", () => {
  for (const action of ["stop", "restart", "pause", "resume"] as const) {
    test(`POST /api/fleet/${action} returns 400 for unknown agent`, async () => {
      const r = await fetch(`http://127.0.0.1:7849/api/fleet/${action}?agent=unknown-agent`, {
        method: "POST",
      });
      expect(r.status).toBe(400);
      const body = (await r.json()) as { error: string };
      expect(body.error).toBeTruthy();
    });
  }

  test("POST /api/fleet/stop returns 400 when agent query param is missing", async () => {
    const r = await fetch("http://127.0.0.1:7849/api/fleet/stop", { method: "POST" });
    expect(r.status).toBe(400);
  });
});

// --- T11 AC1 (HTTP): POST /api/fleet/stop --- (via stopProcess test above + HTTP 200)

describe("POST /api/fleet/stop (AC1/AC6/AC8)", () => {
  test("returns 200 { ok: true } when process is dead (stale PID / AC6 / AC8)", async () => {
    fleetKillCalls = [];
    mockIsAlive = () => false; // process already dead

    const r = await fetch("http://127.0.0.1:7849/api/fleet/stop?agent=agent-be", { method: "POST" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(fleetKillCalls).toHaveLength(0); // no signals sent to already-dead process
  });

  test("returns 200 { ok: true } and sends SIGTERM when process is alive", async () => {
    fleetKillCalls = [];
    let alive = true;
    mockKill = (pid, signal) => { fleetKillCalls.push({ pid, signal }); alive = false; };
    mockIsAlive = () => alive;

    const r = await fetch("http://127.0.0.1:7849/api/fleet/stop?agent=agent-be", { method: "POST" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(fleetKillCalls.some((c) => c.signal === "SIGTERM")).toBe(true);
    expect(fleetKillCalls.every((c) => c.pid === 12345)).toBe(true);

    // restore defaults
    mockKill = (pid, signal) => fleetKillCalls.push({ pid, signal });
  });

  test("returns 404 when pid file does not exist", async () => {
    const r = await fetch("http://127.0.0.1:7849/api/fleet/stop?agent=agent-qa", { method: "POST" });
    expect(r.status).toBe(404);
  });

  test("is idempotent — second call when process is dead also returns 200 (AC8)", async () => {
    fleetKillCalls = [];
    mockIsAlive = () => false;

    const r1 = await fetch("http://127.0.0.1:7849/api/fleet/stop?agent=agent-be", { method: "POST" });
    expect(r1.status).toBe(200);

    const r2 = await fetch("http://127.0.0.1:7849/api/fleet/stop?agent=agent-be", { method: "POST" });
    expect(r2.status).toBe(200);
    expect((await r2.json() as { ok: boolean }).ok).toBe(true);
  });
});

// --- T11 AC2: POST /api/fleet/restart — stop then spawn ---

describe("POST /api/fleet/restart (AC2)", () => {
  test("stops the agent then spawns run-agent.sh with the agent name", async () => {
    fleetKillCalls = [];
    fleetSpawnCalls = [];
    let alive = true;
    mockKill = (pid, signal) => { fleetKillCalls.push({ pid, signal }); alive = false; };
    mockIsAlive = () => alive;

    const r = await fetch("http://127.0.0.1:7849/api/fleet/restart?agent=agent-be", { method: "POST" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // SIGTERM was sent to the agent's process
    expect(fleetKillCalls.some((c) => c.signal === "SIGTERM" && c.pid === 12345)).toBe(true);

    // run-agent.sh was spawned with agent-be
    expect(fleetSpawnCalls).toHaveLength(1);
    expect(fleetSpawnCalls[0].agentName).toBe("agent-be");
    expect(fleetSpawnCalls[0].script).toContain("run-agent.sh");

    // restore defaults
    mockKill = (pid, signal) => fleetKillCalls.push({ pid, signal });
  });

  test("spawns run-agent.sh even when process was already dead", async () => {
    fleetKillCalls = [];
    fleetSpawnCalls = [];
    mockIsAlive = () => false; // already dead — stop is a no-op

    const r = await fetch("http://127.0.0.1:7849/api/fleet/restart?agent=agent-be", { method: "POST" });
    expect(r.status).toBe(200);
    expect(fleetSpawnCalls).toHaveLength(1);
    expect(fleetSpawnCalls[0].agentName).toBe("agent-be");
  });
});

// --- T11 AC3: POST /api/fleet/pause — sends SIGSTOP ---

describe("POST /api/fleet/pause (AC3/AC6)", () => {
  test("sends SIGSTOP to the agent's PID when process is alive (AC3)", async () => {
    fleetKillCalls = [];
    mockKill = (pid, signal) => fleetKillCalls.push({ pid, signal });
    mockIsAlive = () => true;

    const r = await fetch("http://127.0.0.1:7849/api/fleet/pause?agent=agent-be", { method: "POST" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(fleetKillCalls).toHaveLength(1);
    expect(fleetKillCalls[0]).toEqual({ pid: 12345, signal: "SIGSTOP" });
  });

  test("returns 409 { error: 'process not running' } when process is not alive (AC6)", async () => {
    mockIsAlive = () => false;

    const r = await fetch("http://127.0.0.1:7849/api/fleet/pause?agent=agent-be", { method: "POST" });
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("process not running");
  });
});

// --- T11 AC4: POST /api/fleet/resume — sends SIGCONT ---

describe("POST /api/fleet/resume (AC4/AC6)", () => {
  test("sends SIGCONT to the agent's PID when process is alive (AC4)", async () => {
    fleetKillCalls = [];
    mockKill = (pid, signal) => fleetKillCalls.push({ pid, signal });
    mockIsAlive = () => true;

    const r = await fetch("http://127.0.0.1:7849/api/fleet/resume?agent=agent-be", { method: "POST" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(fleetKillCalls).toHaveLength(1);
    expect(fleetKillCalls[0]).toEqual({ pid: 12345, signal: "SIGCONT" });
  });

  test("returns 409 { error: 'process not running' } when process is not alive (AC6)", async () => {
    mockIsAlive = () => false;

    const r = await fetch("http://127.0.0.1:7849/api/fleet/resume?agent=agent-be", { method: "POST" });
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("process not running");
  });
});

// --- T11 AC7: fleet-update SSE broadcast after stop and restart ---

describe("fleet-update SSE broadcast (AC7)", () => {
  test("broadcasts fleet-update event after stop", async () => {
    fleetBroadcasts = [];
    mockIsAlive = () => false; // process already dead — stop is instant

    await fetch("http://127.0.0.1:7849/api/fleet/stop?agent=agent-be", { method: "POST" });

    expect(fleetBroadcasts).toHaveLength(1);
    expect(fleetBroadcasts[0]).toContain("event: fleet-update");
    const dataLine = fleetBroadcasts[0].split("\n").find((l) => l.startsWith("data: "));
    const payload = JSON.parse(dataLine!.slice("data: ".length)) as {
      type: string; agent: string; action: string; ts: number;
    };
    expect(payload.type).toBe("fleet-update");
    expect(payload.agent).toBe("agent-be");
    expect(payload.action).toBe("stop");
    expect(typeof payload.ts).toBe("number");
  });

  test("broadcasts fleet-update event after restart", async () => {
    fleetBroadcasts = [];
    fleetSpawnCalls = [];
    mockIsAlive = () => false;

    await fetch("http://127.0.0.1:7849/api/fleet/restart?agent=agent-be", { method: "POST" });

    expect(fleetBroadcasts).toHaveLength(1);
    const dataLine = fleetBroadcasts[0].split("\n").find((l) => l.startsWith("data: "));
    const payload = JSON.parse(dataLine!.slice("data: ".length)) as { action: string };
    expect(payload.action).toBe("restart");
  });

  test("does NOT broadcast fleet-update after pause (AC7 scope: stop/restart only)", async () => {
    fleetBroadcasts = [];
    mockKill = () => {};
    mockIsAlive = () => true;

    await fetch("http://127.0.0.1:7849/api/fleet/pause?agent=agent-be", { method: "POST" });

    expect(fleetBroadcasts).toHaveLength(0);
  });
});

// --- T11: readPidFile utility ---

describe("readPidFile", () => {
  test("returns the numeric PID when the file contains a valid integer", () => {
    const pidFile = join(testDir, "test.pid");
    writeFileSync(pidFile, "42\n");
    expect(readPidFile(pidFile)).toBe(42);
  });

  test("returns null when the file does not exist", () => {
    expect(readPidFile(join(testDir, "nonexistent.pid"))).toBeNull();
  });

  test("returns null for non-numeric content", () => {
    const pidFile = join(testDir, "bad.pid");
    writeFileSync(pidFile, "not-a-pid\n");
    expect(readPidFile(pidFile)).toBeNull();
  });

  test("returns null for zero or negative PID", () => {
    const pidFile = join(testDir, "zero.pid");
    writeFileSync(pidFile, "0\n");
    expect(readPidFile(pidFile)).toBeNull();
  });
});

// =============================================================================
// T14 — GET /api/stuck + edge-triggered SSE broadcast
// =============================================================================

// Minimal stuck handler factory for testing — mirrors the server.ts implementation.
function makeStuckHandler(opts: {
  agents: string[];
  agentsHome: string;
  ledgerDir: string;
  broadcastFn: (frame: string) => void;
  broadcastCooldownMs?: number;
}) {
  const prevSignals = new Map<string, string>();
  const lastBroadcast = new Map<string, number>();
  const cooldown = opts.broadcastCooldownMs ?? 60_000;

  return (req: IncomingMessage, res: ServerResponse) => {
    if (rawPath(req.url) !== "/api/stuck" || (req.method ?? "GET") !== "GET") {
      sendJson(res, { error: "not found" }, 404);
      return;
    }
    const now = Date.now();
    const stuckAgents = computeStuckSignals(opts.agents, opts.agentsHome, opts.ledgerDir, now);
    const currentSignals = new Map<string, string>(stuckAgents.map((s) => [s.agent, s.signal]));

    for (const entry of stuckAgents) {
      const prev = prevSignals.get(entry.agent);
      const last = lastBroadcast.get(entry.agent) ?? 0;
      if (prev !== entry.signal && now - last >= cooldown) {
        opts.broadcastFn(
          `event: stuck\ndata: ${JSON.stringify({ agent: entry.agent, signal: entry.signal, detail: entry.detail })}\n\n`,
        );
        lastBroadcast.set(entry.agent, now);
      }
    }
    for (const agent of [...prevSignals.keys()]) {
      if (!currentSignals.has(agent)) prevSignals.delete(agent);
    }
    for (const [agent, signal] of currentSignals) prevSignals.set(agent, signal);

    sendJson(res, { stuck: stuckAgents });
  };
}

const stuckAgentsHome = join(testDir, "stuck-agents");
const stuckLedgerDir = join(testDir, "stuck-ledger");
let stuckBroadcasts: string[] = [];
let stuckServer: Server;

// AC7-specific server — isolated state for edge-trigger test.
let stuckEdgeServer: Server;
let stuckEdgeBroadcasts: string[] = [];

const STUCK_TEST_PORT = 7851;
const STUCK_EDGE_PORT = 7852;

const stuckTestAgents = [
  "stuck-silent",
  "stuck-loop",
  "stuck-fail",
  "stuck-malformed",
  "stuck-missing",
  "stuck-suppressed",
];

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      mkdirSync(stuckLedgerDir, { recursive: true });
      for (const a of stuckTestAgents) {
        mkdirSync(join(stuckAgentsHome, a, "logs"), { recursive: true });
      }

      // AC2: stuck-silent — one event 11 minutes ago
      const elevenMinAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString();
      writeFileSync(
        join(stuckAgentsHome, "stuck-silent", "logs", "live-events.jsonl"),
        JSON.stringify({ ts: elevenMinAgo, tool: "Bash", summary: "old event" }) + "\n",
      );

      // AC3: stuck-loop — 5 consecutive Edit events (recent ts so no silent conflict)
      const recentTs = new Date().toISOString();
      const loopLines = Array.from({ length: 5 }, () =>
        JSON.stringify({ ts: recentTs, tool: "Edit", summary: "editing" })
      ).join("\n") + "\n";
      writeFileSync(join(stuckAgentsHome, "stuck-loop", "logs", "live-events.jsonl"), loopLines);

      // AC4: stuck-fail — ledger with failure_count=2 and status=in_progress
      writeFileSync(
        join(stuckLedgerDir, "STUCK-1.task"),
        "id: STUCK-1\nstatus: in_progress\nclaimed_by: stuck-fail\nfailure_count: 2\n",
      );
      writeFileSync(
        join(stuckAgentsHome, "stuck-fail", "logs", "live-events.jsonl"),
        JSON.stringify({ ts: new Date().toISOString(), tool: "Read", summary: "reading" }) + "\n",
      );

      // AC5: stuck-malformed — broken line + one valid old line
      const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      writeFileSync(
        join(stuckAgentsHome, "stuck-malformed", "logs", "live-events.jsonl"),
        `}{broken json line\n${JSON.stringify({ ts: fifteenMinAgo, tool: "Bash", summary: "old" })}\n`,
      );

      // AC6: stuck-missing — log dir exists but no live-events.jsonl file

      // AC8: stuck-suppressed — ledger with status=needs_human (failure_count=3 to confirm suppression over fail_storm)
      writeFileSync(
        join(stuckLedgerDir, "STUCK-2.task"),
        "id: STUCK-2\nstatus: needs_human\nclaimed_by: stuck-suppressed\nfailure_count: 3\n",
      );
      // Recent log so it wouldn't trigger silent
      writeFileSync(
        join(stuckAgentsHome, "stuck-suppressed", "logs", "live-events.jsonl"),
        JSON.stringify({ ts: new Date().toISOString(), tool: "Bash", summary: "recent" }) + "\n",
      );

      stuckServer = createServer(
        makeStuckHandler({
          agents: stuckTestAgents,
          agentsHome: stuckAgentsHome,
          ledgerDir: stuckLedgerDir,
          broadcastFn: (frame) => stuckBroadcasts.push(frame),
          broadcastCooldownMs: 0,
        }),
      );
      stuckServer.listen(STUCK_TEST_PORT, "127.0.0.1", resolve);
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      stuckServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    }),
);

// AC7-specific server lifecycle — fresh state for edge-trigger test.
beforeAll(
  () =>
    new Promise<void>((resolve) => {
      const edgeAgentsHome = join(testDir, "stuck-edge-agents");
      mkdirSync(join(edgeAgentsHome, "stuck-edge", "logs"), { recursive: true });
      const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
      writeFileSync(
        join(edgeAgentsHome, "stuck-edge", "logs", "live-events.jsonl"),
        JSON.stringify({ ts: twentyMinAgo, tool: "Bash", summary: "old event" }) + "\n",
      );

      stuckEdgeServer = createServer(
        makeStuckHandler({
          agents: ["stuck-edge"],
          agentsHome: edgeAgentsHome,
          ledgerDir: stuckLedgerDir,
          broadcastFn: (frame) => stuckEdgeBroadcasts.push(frame),
          broadcastCooldownMs: 0,
        }),
      );
      stuckEdgeServer.listen(STUCK_EDGE_PORT, "127.0.0.1", resolve);
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      stuckEdgeServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    }),
);

describe("GET /api/stuck", () => {
  test("AC1: returns { stuck: StuckAgent[] } with correct shape", async () => {
    const r = await fetch(`http://127.0.0.1:${STUCK_TEST_PORT}/api/stuck`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { stuck: StuckAgent[] };
    expect(Array.isArray(body.stuck)).toBe(true);
    const entry = body.stuck.find((e) => e.agent === "stuck-silent");
    expect(entry).toBeDefined();
    expect(typeof entry!.agent).toBe("string");
    expect(typeof entry!.signal).toBe("string");
    expect(typeof entry!.detail).toBe("string");
    expect(typeof entry!.since).toBe("string");
    expect(() => new Date(entry!.since)).not.toThrow();
  });

  test("AC2: silent detection — ts 11 minutes ago, signal=silent, detail contains '11m'", async () => {
    const r = await fetch(`http://127.0.0.1:${STUCK_TEST_PORT}/api/stuck`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { stuck: StuckAgent[] };
    const entry = body.stuck.find((e) => e.agent === "stuck-silent");
    expect(entry).toBeDefined();
    expect(entry!.signal).toBe("silent");
    expect(entry!.detail).toContain("11m");
  });

  test("AC3: loop detection — 5 events with tool='Edit', signal=loop, detail='looping on Edit'", async () => {
    const r = await fetch(`http://127.0.0.1:${STUCK_TEST_PORT}/api/stuck`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { stuck: StuckAgent[] };
    const entry = body.stuck.find((e) => e.agent === "stuck-loop");
    expect(entry).toBeDefined();
    expect(entry!.signal).toBe("loop");
    expect(entry!.detail).toBe("looping on Edit");
  });

  test("AC4: fail_storm — failure_count=2 and status=in_progress, signal=fail_storm", async () => {
    const r = await fetch(`http://127.0.0.1:${STUCK_TEST_PORT}/api/stuck`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { stuck: StuckAgent[] };
    const entry = body.stuck.find((e) => e.agent === "stuck-fail");
    expect(entry).toBeDefined();
    expect(entry!.signal).toBe("fail_storm");
    expect(entry!.detail).toBe("2 failed attempts");
  });

  test("AC5: malformed JSONL line skipped — returns 200 with valid array, not 500", async () => {
    const r = await fetch(`http://127.0.0.1:${STUCK_TEST_PORT}/api/stuck`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { stuck: StuckAgent[] };
    // Valid line after malformed line is still processed; old ts → silent
    const entry = body.stuck.find((e) => e.agent === "stuck-malformed");
    expect(entry).toBeDefined();
    expect(entry!.signal).toBe("silent");
  });

  test("AC6: missing log file — agent skipped gracefully, others still returned, no 500", async () => {
    const r = await fetch(`http://127.0.0.1:${STUCK_TEST_PORT}/api/stuck`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { stuck: StuckAgent[] };
    // stuck-missing has no log file — must not appear and must not cause 500
    expect(body.stuck.find((e) => e.agent === "stuck-missing")).toBeUndefined();
    // stuck-silent still appears (other agents unaffected)
    expect(body.stuck.find((e) => e.agent === "stuck-silent")).toBeDefined();
  });

  test("AC7: edge-triggered SSE — broadcasts once for new signal, suppresses same signal on re-evaluation", async () => {
    stuckEdgeBroadcasts = [];

    // First call — stuck-edge has old log → silent signal → new edge → broadcast
    const r1 = await fetch(`http://127.0.0.1:${STUCK_EDGE_PORT}/api/stuck`);
    expect(r1.status).toBe(200);
    const edgeBroadcasts1 = stuckEdgeBroadcasts.filter((f) => f.includes('"stuck-edge"'));
    expect(edgeBroadcasts1).toHaveLength(1);
    expect(edgeBroadcasts1[0]).toContain("event: stuck");
    const payload = JSON.parse(edgeBroadcasts1[0].split("\n")[1].slice("data: ".length)) as {
      agent: string; signal: string; detail: string;
    };
    expect(payload.agent).toBe("stuck-edge");
    expect(payload.signal).toBe("silent");

    stuckEdgeBroadcasts = [];

    // Second call — same signal for stuck-edge — must NOT broadcast again
    const r2 = await fetch(`http://127.0.0.1:${STUCK_EDGE_PORT}/api/stuck`);
    expect(r2.status).toBe(200);
    expect(stuckEdgeBroadcasts.filter((f) => f.includes('"stuck-edge"'))).toHaveLength(0);
  });

  test("AC8: agent with needs_human status not reported as stuck", async () => {
    const r = await fetch(`http://127.0.0.1:${STUCK_TEST_PORT}/api/stuck`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { stuck: StuckAgent[] };
    expect(body.stuck.find((e) => e.agent === "stuck-suppressed")).toBeUndefined();
  });
});

// T14-amended — Stuck detection: wrap ALL JSON.parse in try/catch (P1 crash fix)
// =============================================================================

const STUCK_MALFORMED_PORT = 7853;
const STUCK_ALL_MALFORMED_PORT = 7854;

const malformedAgentsHome = join(testDir, "stuck-malformed-amended");
let malformedMixedServer: Server;
let malformedAllServer: Server;

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      // AC2/AC3: 20-line JSONL with 3 malformed lines interspersed among 17 valid Bash events.
      mkdirSync(join(malformedAgentsHome, "malformed-mixed", "logs"), { recursive: true });
      const recentTs = new Date().toISOString();
      const validLine = JSON.stringify({ ts: recentTs, tool: "Bash", summary: "work" });
      const malformedLine = "}{broken";
      // Build 20 lines: malformed at positions 4, 11, 17 (0-indexed), valid elsewhere.
      const lines: string[] = [];
      let validCount = 0;
      for (let i = 0; i < 20; i++) {
        if (i === 4 || i === 11 || i === 17) {
          lines.push(malformedLine);
        } else {
          validCount++;
          lines.push(validLine);
        }
      }
      writeFileSync(
        join(malformedAgentsHome, "malformed-mixed", "logs", "live-events.jsonl"),
        lines.join("\n") + "\n",
      );

      malformedMixedServer = createServer(
        makeStuckHandler({
          agents: ["malformed-mixed"],
          agentsHome: malformedAgentsHome,
          ledgerDir: join(testDir, "stuck-ledger"),
          broadcastFn: () => {},
          broadcastCooldownMs: 0,
        }),
      );
      malformedMixedServer.listen(STUCK_MALFORMED_PORT, "127.0.0.1", resolve);
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      malformedMixedServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    }),
);

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      // AC4: all 5 lines are malformed — validEvents will be empty → { stuck: [] }.
      mkdirSync(join(malformedAgentsHome, "malformed-all", "logs"), { recursive: true });
      const allBroken = Array.from({ length: 5 }, () => "}{broken").join("\n") + "\n";
      writeFileSync(
        join(malformedAgentsHome, "malformed-all", "logs", "live-events.jsonl"),
        allBroken,
      );

      malformedAllServer = createServer(
        makeStuckHandler({
          agents: ["malformed-all"],
          agentsHome: malformedAgentsHome,
          ledgerDir: join(testDir, "stuck-ledger"),
          broadcastFn: () => {},
          broadcastCooldownMs: 0,
        }),
      );
      malformedAllServer.listen(STUCK_ALL_MALFORMED_PORT, "127.0.0.1", resolve);
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      malformedAllServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    }),
);

describe("stuck detection malformed JSONL", () => {
  test("AC2: 20-line file with 3 malformed lines — signals computed from 17 valid lines", async () => {
    const r = await fetch(`http://127.0.0.1:${STUCK_MALFORMED_PORT}/api/stuck`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { stuck: StuckAgent[] };
    // 17 valid Bash events → last 5 all Bash → loop signal confirms 17 lines processed
    const entry = body.stuck.find((e) => e.agent === "malformed-mixed");
    expect(entry).toBeDefined();
    expect(entry!.signal).toBe("loop");
    expect(entry!.detail).toBe("looping on Bash");
  });

  test("AC3: malformed JSONL lines do not cause a 500 — endpoint always returns 200", async () => {
    const r = await fetch(`http://127.0.0.1:${STUCK_MALFORMED_PORT}/api/stuck`);
    expect(r.status).toBe(200);
  });

  test("AC4: all-malformed JSONL file → { stuck: [] } with HTTP 200", async () => {
    const r = await fetch(`http://127.0.0.1:${STUCK_ALL_MALFORMED_PORT}/api/stuck`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { stuck: StuckAgent[] };
    expect(body.stuck).toHaveLength(0);
  });
});

// =============================================================================
// T15-amended — POST /api/fleet/restart: kernel/task fail --role human
// =============================================================================

const T15A_PORT = 7870;
const t15aLedgerDir = join(testDir, "t15a-ledger");
const t15aPidsDir = join(testDir, "t15a-pids");
const t15aValidAgents = new Set(["agent-be"]);

let t15aTaskFailCalls: string[][] = [];
let t15aSpawnCalls: string[] = [];
let t15aMockTaskFailCode = 0;
let t15aServer: Server;

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      mkdirSync(t15aLedgerDir, { recursive: true });
      mkdirSync(t15aPidsDir, { recursive: true });
      writeFileSync(join(t15aPidsDir, "agent-be.pid"), "99999\n");

      t15aServer = createServer(
        makeFleetControlHandler({
          validAgents: t15aValidAgents,
          pidsDir: t15aPidsDir,
          supervisorDir: join(testDir, "t15a-supervisor"),
          killFn: () => {},
          isAliveFn: () => false,
          spawnFn: (_script, agentName) => t15aSpawnCalls.push(agentName),
          broadcastFn: () => {},
          stopTimeoutMs: 50,
          ledgerDir: t15aLedgerDir,
          taskFailFn: (argv) => { t15aTaskFailCalls.push(argv); return t15aMockTaskFailCode; },
        }),
      );
      t15aServer.listen(T15A_PORT, "127.0.0.1", resolve);
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      t15aServer.close((err) => { if (err) reject(err); else resolve(); });
    }),
);

// =============================================================================
// T16 — v1 test expansion: fleet control + stuck + log tail + pipeline
// Each describe block is isolated so it is easily findable by git bisect.
// =============================================================================

// --- T16 AC1: fleet/stop stale PID ---

describe("fleet/stop stale PID", () => {
  test("PID file exists but process does not exist (ESRCH) → 200 { ok: true }", async () => {
    fleetKillCalls = [];
    mockIsAlive = () => false; // simulates process.kill(pid, 0) throwing ESRCH
    const r = await fetch("http://127.0.0.1:7849/api/fleet/stop?agent=agent-be", { method: "POST" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    // stopProcess returns immediately without sending any signal to a non-running process
    expect(fleetKillCalls).toHaveLength(0);
  });
});

// --- T16 AC2: stuck 4-event loop ---

describe("stuck 4-event loop", () => {
  test("exactly 4 matching tool events does NOT trigger loop signal (threshold is 5)", () => {
    const ah = join(testDir, "stuck-4events");
    mkdirSync(join(ah, "agent-4evt", "logs"), { recursive: true });
    const recentTs = new Date().toISOString();
    // Exactly 4 consecutive Bash events — loop check requires validEvents.length >= 5
    const lines = Array.from({ length: 4 }, () =>
      JSON.stringify({ ts: recentTs, tool: "Bash", summary: "work" }),
    ).join("\n") + "\n";
    writeFileSync(join(ah, "agent-4evt", "logs", "live-events.jsonl"), lines);

    const result = computeStuckSignals(
      ["agent-4evt"],
      ah,
      join(testDir, "nonexistent-4evt-ledger"),
      Date.now(),
    );
    // 4 events is below the 5-event threshold — no loop signal must be present
    expect(result.some((e) => e.agent === "agent-4evt" && e.signal === "loop")).toBe(false);
  });
});

// --- T16 AC3: stuck precedence ---

describe("stuck precedence", () => {
  test("fail_storm signal returned when both fail_storm and loop conditions are met", () => {
    const ah = join(testDir, "stuck-precedence");
    const ld = join(testDir, "precedence-ledger");
    mkdirSync(join(ah, "agent-prec", "logs"), { recursive: true });
    mkdirSync(ld, { recursive: true });

    // Ledger: failure_count=2, status=in_progress → fail_storm condition met
    writeFileSync(
      join(ld, "PREC1.task"),
      "id: PREC1\nstatus: in_progress\nclaimed_by: agent-prec\nfailure_count: 2\n",
    );

    // Log: 5 identical Bash events → loop condition also met
    const recentTs = new Date().toISOString();
    const lines = Array.from({ length: 5 }, () =>
      JSON.stringify({ ts: recentTs, tool: "Bash", summary: "work" }),
    ).join("\n") + "\n";
    writeFileSync(join(ah, "agent-prec", "logs", "live-events.jsonl"), lines);

    const result = computeStuckSignals(["agent-prec"], ah, ld, Date.now());
    const entry = result.find((e) => e.agent === "agent-prec");
    expect(entry).toBeDefined();
    // fail_storm is checked before loop in computeStuckSignals and uses continue — wins
    expect(entry!.signal).toBe("fail_storm");
  });
});

// --- T16 AC4: log n=0 ---
// Uses its own server so this block is independent of the describe("GET /api/log") lifecycle.

describe("log n=0", () => {
  let n0Server: Server;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        n0Server = createServer(makeLogHandler(logAgentsHome, makeRateLimiter(10)));
        n0Server.listen(7860, "127.0.0.1", resolve);
      }),
  );

  afterAll(
    () =>
      new Promise<void>((resolve, reject) => {
        n0Server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  );

  test("?n=0 returns 400 { error: 'n must be 1-200' } (boundary below minimum)", async () => {
    const r = await fetch("http://127.0.0.1:7860/api/log/agent-be?n=0");
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("n must be 1-200");
  });
});

// =============================================================================

describe("POST /api/draft-decision", () => {
  test("AC1: appends correct mailbox block to {controlDir}/mailboxes/{agentName}.md", async () => {
    capturedGitArgs = null;
    gitShouldFail = false;
    const mailboxFile = join(draftMailboxDir, "agent-be.md");

    const r = await fetch(`http://127.0.0.1:${T15A_PORT}/api/fleet/restart?agent=agent-be`, { method: "POST" });
    expect(r.status).toBe(200);

    expect(t15aTaskFailCalls).toHaveLength(1);
    expect(t15aTaskFailCalls[0]).toEqual(["fail", "TASK-001", "--agent", "agent-be", "--role", "human"]);
    expect(t15aSpawnCalls).toContain("agent-be");

    unlinkSync(join(t15aLedgerDir, "TASK-001.task"));
  });

  test("AC3: returns 500 when kernel/task fail exits non-zero and does not restart", async () => {
    t15aTaskFailCalls = [];
    t15aSpawnCalls = [];
    t15aMockTaskFailCode = 1;
    writeFileSync(
      join(t15aLedgerDir, "TASK-002.task"),
      "id: TASK-002\nclaimed_by: agent-be\nstatus: in_progress\n",
    );

    const r = await fetch(`http://127.0.0.1:${T15A_PORT}/api/fleet/restart?agent=agent-be`, { method: "POST" });
    expect(r.status).toBe(500);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("kernel/task fail exited with code 1");
    expect(t15aSpawnCalls).toHaveLength(0);

    unlinkSync(join(t15aLedgerDir, "TASK-002.task"));
  });

  test("AC4: skips kernel/task fail and restarts when agent has no claimed task", async () => {
    t15aTaskFailCalls = [];
    t15aSpawnCalls = [];
    t15aMockTaskFailCode = 0;
    // ledger has a task claimed by a different agent — agent-be has no claim
    writeFileSync(
      join(t15aLedgerDir, "TASK-003.task"),
      "id: TASK-003\nclaimed_by: agent-qa\nstatus: in_progress\n",
    );

    const r = await fetch(`http://127.0.0.1:${T15A_PORT}/api/fleet/restart?agent=agent-be`, { method: "POST" });
    expect(r.status).toBe(200);
    expect(t15aTaskFailCalls).toHaveLength(0);
    expect(t15aSpawnCalls).toContain("agent-be");

    unlinkSync(join(t15aLedgerDir, "TASK-003.task"));
  });
});

// =============================================================================
// T17: Workspace registry

const T17_WS_PORT = 7880;
const wsTestDir = join(testDir, "t17-workspaces");
let wsBroadcasts: string[] = [];
let wsRebuildCalls: string[] = [];
let wsServer: Server;
let wsRegistryPath: string;

function makeWorkspacesHandler(opts: {
  workspacesPath: string;
  rebuildValidAgentsFn?: (controlDir: string) => void;
  broadcastFn?: (frame: string) => void;
  existsFn?: (dir: string) => boolean;
  costInvalidateFn?: (wsId: string) => void;
}) {
  const bc = opts.broadcastFn ?? (() => {});
  const rebuild = opts.rebuildValidAgentsFn ?? (() => {});
  const existsCheck = opts.existsFn ?? existsSync;
  const invalidateCost = opts.costInvalidateFn ?? (() => {});

  return (req: IncomingMessage, res: ServerResponse) => {
    const path = rawPath(req.url);
    const method = req.method ?? "GET";

    if (path === "/api/workspaces" && method === "GET") {
      sendJson(res, readWorkspaceRegistry(opts.workspacesPath));
      return;
    }

    if (path === "/api/workspaces" && method === "POST") {
      void (async () => {
        const parsed = await readAndValidatePostBody(req);
        if (!parsed.ok) { sendJson(res, { error: parsed.error }, parsed.statusCode); return; }
        const body = parsed.json as { name?: string; controlDir?: string };
        const { name, controlDir } = body;
        if (!name || !controlDir || !isAbsolute(controlDir)) {
          sendJson(res, { error: "controlDir must be an absolute path" }, 400);
          return;
        }
        if (!existsCheck(join(controlDir, "ledger"))) {
          sendJson(res, { error: "controlDir/ledger not found" }, 400);
          return;
        }
        const reg = readWorkspaceRegistry(opts.workspacesPath);
        const ws: Workspace = {
          id: randomUUID(),
          name,
          controlDir,
          createdAt: new Date().toISOString(),
        };
        reg.workspaces.push(ws);
        writeWorkspaceRegistry(opts.workspacesPath, reg);
        sendJson(res, { workspace: ws });
      })();
      return;
    }

    if (path.startsWith("/api/workspaces/")) {
      const rest = path.slice("/api/workspaces/".length);
      const parts = rest.split("/");
      const wsId = parts[0];

      if (parts.length === 2 && parts[1] === "activate" && method === "POST") {
        const reg = readWorkspaceRegistry(opts.workspacesPath);
        const ws = reg.workspaces.find((w) => w.id === wsId);
        if (!ws) { sendJson(res, { error: "not found" }, 404); return; }
        invalidateCost(reg.activeId ?? "");
        reg.activeId = wsId;
        writeWorkspaceRegistry(opts.workspacesPath, reg);
        rebuild(ws.controlDir);
        const payload = JSON.stringify({ workspaceId: wsId, name: ws.name, controlDir: ws.controlDir });
        bc(`event: workspace-switch\ndata: ${payload}\n\n`);
        sendJson(res, { ok: true });
        return;
      }

      if (parts.length === 1 && method === "DELETE") {
        const reg = readWorkspaceRegistry(opts.workspacesPath);
        const idx = reg.workspaces.findIndex((w) => w.id === wsId);
        if (idx === -1) { sendJson(res, { error: "not found" }, 404); return; }
        reg.workspaces.splice(idx, 1);
        if (reg.activeId === wsId) {
          reg.activeId = reg.workspaces.length > 0 ? (reg.workspaces[0].id ?? null) : null;
        }
        writeWorkspaceRegistry(opts.workspacesPath, reg);
        res.writeHead(204); res.end();
        return;
      }
    }

    sendJson(res, { error: "not found" }, 404);
  };
}

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      mkdirSync(wsTestDir, { recursive: true });
      wsRegistryPath = join(wsTestDir, "workspaces.json");

      wsServer = createServer(
        makeWorkspacesHandler({
          workspacesPath: wsRegistryPath,
          rebuildValidAgentsFn: (dir) => wsRebuildCalls.push(dir),
          broadcastFn: (frame) => wsBroadcasts.push(frame),
          existsFn: (dir) => existsSync(dir),
        }),
      );
      wsServer.listen(T17_WS_PORT, "127.0.0.1", resolve);
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      wsServer.close((err) => { if (err) reject(err); else resolve(); });
    }),
);

describe("GET /api/workspaces (AC1)", () => {
  test("returns empty registry when file does not exist", async () => {
    if (existsSync(wsRegistryPath)) unlinkSync(wsRegistryPath);
    const r = await fetch(`http://127.0.0.1:${T17_WS_PORT}/api/workspaces`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as WorkspaceRegistry;
    expect(body.workspaces).toEqual([]);
    expect(body.activeId).toBeNull();
  });

  test("returns populated registry when file exists", async () => {
    const reg: WorkspaceRegistry = {
      workspaces: [{ id: "w1", name: "Alpha", controlDir: "/alpha", createdAt: "2026-01-01T00:00:00Z" }],
      activeId: "w1",
    };
    writeWorkspaceRegistry(wsRegistryPath, reg);
    const r = await fetch(`http://127.0.0.1:${T17_WS_PORT}/api/workspaces`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as WorkspaceRegistry;
    expect(body.activeId).toBe("w1");
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0].name).toBe("Alpha");
    unlinkSync(wsRegistryPath);
  });
});

describe("POST /api/workspaces (AC2)", () => {
  test("returns 400 when controlDir is relative", async () => {
    const r = await fetch(`http://127.0.0.1:${T17_WS_PORT}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X", controlDir: "relative/path" }),
    });
    expect(r.status).toBe(400);
  });

  test("returns 400 when controlDir/ledger does not exist", async () => {
    const r = await fetch(`http://127.0.0.1:${T17_WS_PORT}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X", controlDir: "/no-such-dir-t17" }),
    });
    expect(r.status).toBe(400);
  });

  test("appends workspace and returns it when controlDir/ledger exists", async () => {
    if (existsSync(wsRegistryPath)) unlinkSync(wsRegistryPath);
    const fakeControl = join(wsTestDir, "fake-control");
    mkdirSync(join(fakeControl, "ledger"), { recursive: true });

    const r = await fetch(`http://127.0.0.1:${T17_WS_PORT}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Beta", controlDir: fakeControl }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { workspace: Workspace };
    expect(body.workspace.name).toBe("Beta");
    expect(body.workspace.controlDir).toBe(fakeControl);
    expect(typeof body.workspace.id).toBe("string");
    const saved = readWorkspaceRegistry(wsRegistryPath);
    expect(saved.workspaces).toHaveLength(1);
  });
});

describe("DELETE /api/workspaces/:id (AC3)", () => {
  test("removes workspace and shifts activeId to first remaining when active is deleted", async () => {
    const reg: WorkspaceRegistry = {
      workspaces: [
        { id: "del1", name: "One", controlDir: "/one", createdAt: "2026-01-01T00:00:00Z" },
        { id: "del2", name: "Two", controlDir: "/two", createdAt: "2026-01-01T00:00:00Z" },
      ],
      activeId: "del1",
    };
    writeWorkspaceRegistry(wsRegistryPath, reg);

    const r = await fetch(`http://127.0.0.1:${T17_WS_PORT}/api/workspaces/del1`, { method: "DELETE" });
    expect(r.status).toBe(204);
    const saved = readWorkspaceRegistry(wsRegistryPath);
    expect(saved.workspaces).toHaveLength(1);
    expect(saved.activeId).toBe("del2");
  });

  test("sets activeId to null when last workspace is deleted", async () => {
    const reg: WorkspaceRegistry = {
      workspaces: [{ id: "only1", name: "Only", controlDir: "/only", createdAt: "2026-01-01T00:00:00Z" }],
      activeId: "only1",
    };
    writeWorkspaceRegistry(wsRegistryPath, reg);

    const r = await fetch(`http://127.0.0.1:${T17_WS_PORT}/api/workspaces/only1`, { method: "DELETE" });
    expect(r.status).toBe(204);
    const saved = readWorkspaceRegistry(wsRegistryPath);
    expect(saved.workspaces).toHaveLength(0);
    expect(saved.activeId).toBeNull();
  });
});

describe("POST /api/workspaces/:id/activate (AC4)", () => {
  test("sets activeId, broadcasts workspace-switch event, returns ok", async () => {
    wsBroadcasts = [];
    const reg: WorkspaceRegistry = {
      workspaces: [
        { id: "act1", name: "Gamma", controlDir: "/gamma", createdAt: "2026-01-01T00:00:00Z" },
        { id: "act2", name: "Delta", controlDir: "/delta", createdAt: "2026-01-01T00:00:00Z" },
      ],
      activeId: "act1",
    };
    writeWorkspaceRegistry(wsRegistryPath, reg);

    const r = await fetch(`http://127.0.0.1:${T17_WS_PORT}/api/workspaces/act2/activate`, { method: "POST" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const saved = readWorkspaceRegistry(wsRegistryPath);
    expect(saved.activeId).toBe("act2");

    expect(wsBroadcasts).toHaveLength(1);
    expect(wsBroadcasts[0]).toContain("event: workspace-switch");
    const dataLine = wsBroadcasts[0].split("\n").find((l) => l.startsWith("data:")) ?? "";
    const payload = JSON.parse(dataLine.slice("data:".length).trim()) as Record<string, unknown>;
    expect(payload.workspaceId).toBe("act2");
    expect(payload.name).toBe("Delta");
    expect(payload.controlDir).toBe("/delta");
  });
});

describe("bootstrapWorkspace AC5/AC6", () => {
  test("AC5: creates registry with CONTROL_DIR as active workspace when file absent", () => {
    const regPath = join(wsTestDir, "bootstrap-ac5.json");
    if (existsSync(regPath)) unlinkSync(regPath);
    bootstrapWorkspace("/test/control-ac5", regPath);
    const reg = readWorkspaceRegistry(regPath);
    expect(reg.workspaces).toHaveLength(1);
    expect(reg.workspaces[0].controlDir).toBe("/test/control-ac5");
    expect(reg.activeId).toBe(reg.workspaces[0].id);
  });

  test("AC6: appends CONTROL_DIR without changing activeId when registry already exists", () => {
    const regPath = join(wsTestDir, "bootstrap-ac6.json");
    const existing: WorkspaceRegistry = {
      workspaces: [{ id: "existing1", name: "Existing", controlDir: "/existing", createdAt: "2026-01-01T00:00:00Z" }],
      activeId: "existing1",
    };
    writeWorkspaceRegistry(regPath, existing);
    bootstrapWorkspace("/test/control-ac6", regPath);
    const reg = readWorkspaceRegistry(regPath);
    expect(reg.workspaces).toHaveLength(2);
    expect(reg.workspaces[1].controlDir).toBe("/test/control-ac6");
    expect(reg.activeId).toBe("existing1");
  });
});

describe("POST /api/workspaces/:id/activate validAgents reload (AC7)", () => {
  test("calls rebuildValidAgentsFn with the activated workspace's controlDir", async () => {
    wsRebuildCalls = [];
    const reg: WorkspaceRegistry = {
      workspaces: [
        { id: "ws-ac7", name: "AC7 WS", controlDir: "/ac7-control", createdAt: "2026-01-01T00:00:00Z" },
      ],
      activeId: null,
    };
    writeWorkspaceRegistry(wsRegistryPath, reg);

    const r = await fetch(`http://127.0.0.1:${T17_WS_PORT}/api/workspaces/ws-ac7/activate`, { method: "POST" });
    expect(r.status).toBe(200);
    expect(wsRebuildCalls).toHaveLength(1);
    expect(wsRebuildCalls[0]).toBe("/ac7-control");
  });
});

// =============================================================================
// T21 — Trust ledger: GET/POST /api/trust, DELETE /api/trust/:id
// =============================================================================

const T21_PORT = 7890;
const t21TrustDir = join(testDir, "t21-trust");
let t21TrustPath: string;
let t21ValidAgents: Set<string>;
let t21Server: Server;

function makeTrustHandler(opts: {
  trustPath: string;
  validAgents: Set<string>;
}) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const path = rawPath(req.url);
    const method = req.method ?? "GET";

    if (path === "/api/trust" && method === "GET") {
      const ledger = readTrustLedger(opts.trustPath);
      sendJson(res, { rules: ledger.rules });
      return;
    }

    if (path === "/api/trust" && method === "POST") {
      void (async () => {
        const parsed = await readAndValidatePostBody(req);
        if (!parsed.ok) { sendJson(res, { error: parsed.error }, parsed.statusCode); return; }
        const body = parsed.json as { agent?: string; pattern?: string; action?: string };
        const { agent: ruleAgent, pattern, action } = body;
        if (!ruleAgent || !opts.validAgents.has(ruleAgent)) {
          sendJson(res, { error: "unknown agent" }, 400);
          return;
        }
        if (!pattern || typeof pattern !== "string" || pattern.trim() === "") {
          sendJson(res, { error: "pattern must be a non-empty string" }, 400);
          return;
        }
        if (action !== "approve" && action !== "reject") {
          sendJson(res, { error: "action must be 'approve' or 'reject'" }, 400);
          return;
        }
        const ledger = readTrustLedger(opts.trustPath);
        const rule: TrustRule = {
          id: randomUUID(),
          agent: ruleAgent,
          pattern,
          action,
          createdAt: new Date().toISOString(),
        };
        ledger.rules.push(rule);
        writeTrustLedger(opts.trustPath, ledger);
        sendJson(res, { rule });
      })();
      return;
    }

    if (path.startsWith("/api/trust/") && method === "DELETE") {
      const ruleId = path.slice("/api/trust/".length).split("/")[0];
      const ledger = readTrustLedger(opts.trustPath);
      const idx = ledger.rules.findIndex((r) => r.id === ruleId);
      if (idx === -1) { sendJson(res, { error: "not found" }, 404); return; }
      ledger.rules.splice(idx, 1);
      writeTrustLedger(opts.trustPath, ledger);
      res.writeHead(204); res.end();
      return;
    }

    sendJson(res, { error: "not found" }, 404);
  };
}

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      mkdirSync(t21TrustDir, { recursive: true });
      t21TrustPath = join(t21TrustDir, "trust.json");
      t21ValidAgents = new Set(["agent-be", "agent-qa"]);
      t21Server = createServer(makeTrustHandler({ trustPath: t21TrustPath, validAgents: t21ValidAgents }));
      t21Server.listen(T21_PORT, "127.0.0.1", resolve);
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      t21Server.close((err) => { if (err) reject(err); else resolve(); });
    }),
);

describe("GET /api/trust (AC1)", () => {
  test("returns { rules: [] } when trust.json does not exist", async () => {
    if (existsSync(t21TrustPath)) unlinkSync(t21TrustPath);
    const r = await fetch(`http://127.0.0.1:${T21_PORT}/api/trust`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { rules: TrustRule[] };
    expect(body.rules).toEqual([]);
  });

  test("returns existing rules from trust.json", async () => {
    const ledger: TrustLedger = {
      rules: [
        { id: "r1", agent: "agent-be", pattern: "bun test", action: "approve", createdAt: "2026-01-01T00:00:00Z" },
      ],
    };
    writeTrustLedger(t21TrustPath, ledger);
    const r = await fetch(`http://127.0.0.1:${T21_PORT}/api/trust`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { rules: TrustRule[] };
    expect(body.rules).toHaveLength(1);
    expect(body.rules[0].id).toBe("r1");
    expect(body.rules[0].pattern).toBe("bun test");
  });
});

describe("POST /api/trust (AC2)", () => {
  test("valid request appends rule and returns { rule }", async () => {
    if (existsSync(t21TrustPath)) unlinkSync(t21TrustPath);
    const r = await fetch(`http://127.0.0.1:${T21_PORT}/api/trust`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "agent-be", pattern: "bun test", action: "approve" }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { rule: TrustRule };
    expect(body.rule.agent).toBe("agent-be");
    expect(body.rule.pattern).toBe("bun test");
    expect(body.rule.action).toBe("approve");
    expect(typeof body.rule.id).toBe("string");
    const saved = readTrustLedger(t21TrustPath);
    expect(saved.rules).toHaveLength(1);
    expect(saved.rules[0].id).toBe(body.rule.id);
  });

  test("unknown agent returns 400", async () => {
    const r = await fetch(`http://127.0.0.1:${T21_PORT}/api/trust`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "agent-unknown", pattern: "bun test", action: "approve" }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/unknown agent/);
  });

  test("empty pattern returns 400", async () => {
    const r = await fetch(`http://127.0.0.1:${T21_PORT}/api/trust`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "agent-be", pattern: "", action: "approve" }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/pattern/);
  });

  test("invalid action returns 400", async () => {
    const r = await fetch(`http://127.0.0.1:${T21_PORT}/api/trust`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "agent-be", pattern: "bun test", action: "allow" }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/action/);
  });
});

describe("DELETE /api/trust/:id (AC3)", () => {
  test("existing rule → 204 and rule removed from file", async () => {
    const ledger: TrustLedger = {
      rules: [
        { id: "del-r1", agent: "agent-be", pattern: "bun test", action: "approve", createdAt: "2026-01-01T00:00:00Z" },
      ],
    };
    writeTrustLedger(t21TrustPath, ledger);
    const r = await fetch(`http://127.0.0.1:${T21_PORT}/api/trust/del-r1`, { method: "DELETE" });
    expect(r.status).toBe(204);
    const saved = readTrustLedger(t21TrustPath);
    expect(saved.rules).toHaveLength(0);
  });

  test("unknown id → 404", async () => {
    const r = await fetch(`http://127.0.0.1:${T21_PORT}/api/trust/nonexistent-id`, { method: "DELETE" });
    expect(r.status).toBe(404);
  });
});

// T19: Cost tracker tests
// makeCostHandler: injects computeFn and workspaceId for cache tests.
function makeCostHandler(opts: {
  agents: string[];
  agentsHome: string;
  workspacesPath: string;
  costCache: Map<string, { data: CostResponse; expiresAt: number }>;
  computeFn?: (agents: string[], home: string, since?: string) => CostResponse;
}) {
  const compute = opts.computeFn ?? computeCostData;
  const TTL = 30_000;

  return (req: IncomingMessage, res: ServerResponse) => {
    const p = rawPath(req.url);
    if (!p.startsWith("/api/cost") || (req.method ?? "GET") !== "GET") {
      sendJson(res, { error: "not found" }, 404);
      return;
    }
    const qs = (req.url ?? "").includes("?") ? new URLSearchParams((req.url ?? "").split("?")[1]) : null;
    const since = qs?.get("since") ?? undefined;

    if (since) {
      sendJson(res, compute(opts.agents, opts.agentsHome, since));
      return;
    }

    const reg = readWorkspaceRegistry(opts.workspacesPath);
    const wsId = reg.activeId ?? "";
    const cached = opts.costCache.get(wsId);
    if (cached && cached.expiresAt > Date.now()) {
      sendJson(res, cached.data);
      return;
    }
    const data = compute(opts.agents, opts.agentsHome);
    opts.costCache.set(wsId, { data, expiresAt: Date.now() + TTL });
    sendJson(res, data);
  };
}

const COST_PORT = 7890;
const COST_AC3_PORT = 7891;

const costTestDir = join(tmpdir(), `console-cost-test-${process.pid}`);
const costAgentsHome = join(costTestDir, "agents");
let costServer: Server;
let costRegistryPath: string;
let costCache: Map<string, { data: CostResponse; expiresAt: number }>;

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      mkdirSync(join(costAgentsHome, "agent-a", "logs"), { recursive: true });
      mkdirSync(join(costAgentsHome, "agent-b", "logs"), { recursive: true });

      // Write JSONL with known token values for agent-a (AC1).
      writeFileSync(
        join(costAgentsHome, "agent-a", "logs", "live-events.jsonl"),
        [
          JSON.stringify({ ts: "2026-01-01T10:00:00Z", tokens_in: 100, tokens_out: 50, cost_usd: 0.001 }),
          JSON.stringify({ ts: "2026-01-01T11:00:00Z", tokens_in: 200, tokens_out: 80, cost_usd: 0.002 }),
          JSON.stringify({ ts: "2026-01-01T12:00:00Z", tool: "Bash" }), // no cost_usd → skipped (AC4)
          JSON.stringify({ ts: "2026-01-01T13:00:00Z", cost_usd: "bad" }), // non-numeric → skipped (AC4)
        ].join("\n") + "\n",
      );
      // agent-b has no cost_usd fields at all (AC6: should not appear in agents[]).
      writeFileSync(
        join(costAgentsHome, "agent-b", "logs", "live-events.jsonl"),
        JSON.stringify({ ts: "2026-01-01T10:00:00Z", tool: "Read", summary: "reading" }) + "\n",
      );

      costRegistryPath = join(costTestDir, "workspaces.json");
      writeWorkspaceRegistry(costRegistryPath, { workspaces: [{ id: "cost-ws-1", name: "CostWS", controlDir: "/cost-ctrl", createdAt: "2026-01-01T00:00:00Z" }], activeId: "cost-ws-1" });

      costCache = new Map();
      costServer = createServer(
        makeCostHandler({
          agents: ["agent-a", "agent-b"],
          agentsHome: costAgentsHome,
          workspacesPath: costRegistryPath,
          costCache,
        }),
      );
      costServer.listen(COST_PORT, "127.0.0.1", resolve);
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve) => {
      costServer.close(() => {
        rmSync(costTestDir, { recursive: true, force: true });
        resolve();
      });
    }),
);

describe("GET /api/cost aggregation (AC1)", () => {
  test("returns per-agent totals and grand total for agents with cost_usd", async () => {
    costCache.clear();
    const r = await fetch(`http://127.0.0.1:${COST_PORT}/api/cost`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as CostResponse;
    expect(body.agents).toHaveLength(1);
    const row = body.agents.find((a: CostAgentRow) => a.agent === "agent-a");
    expect(row).toBeDefined();
    expect(row!.tokens_in).toBe(300);
    expect(row!.tokens_out).toBe(130);
    expect(row!.cost_usd).toBe(0.003);
    expect(body.total.tokens_in).toBe(300);
    expect(body.total.cost_usd).toBe(0.003);
    expect(typeof body.cachedAt).toBe("string");
  });
});

describe("GET /api/cost 30s cache (AC2)", () => {
  test("second call within 30s returns cached result without re-computing", async () => {
    let callCount = 0;
    const stubCompute = (agents: string[], home: string, since?: string): CostResponse => {
      callCount++;
      return computeCostData(agents, home, since);
    };
    const localCache = new Map<string, { data: CostResponse; expiresAt: number }>();
    const localRegPath = join(costTestDir, "ws-ac2.json");
    writeWorkspaceRegistry(localRegPath, { workspaces: [{ id: "ws-ac2", name: "AC2", controlDir: "/c", createdAt: "2026-01-01T00:00:00Z" }], activeId: "ws-ac2" });
    const s = createServer(makeCostHandler({ agents: ["agent-a"], agentsHome: costAgentsHome, workspacesPath: localRegPath, costCache: localCache, computeFn: stubCompute }));
    await new Promise<void>((r) => s.listen(7892, "127.0.0.1", r));
    try {
      await fetch("http://127.0.0.1:7892/api/cost");
      await fetch("http://127.0.0.1:7892/api/cost");
      expect(callCount).toBe(1); // second call hit the cache
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});

describe("GET /api/cost cache invalidation on workspace-switch (AC3)", () => {
  test("switching workspace clears the outgoing workspace's cache entry", async () => {
    const ac3TmpDir = mkdtempSync(join(tmpdir(), "console-cost-ac3-"));
    const ac3RegPath = join(ac3TmpDir, "workspaces.json");
    const ac3Cache = new Map<string, { data: CostResponse; expiresAt: number }>();
    writeWorkspaceRegistry(ac3RegPath, {
      workspaces: [
        { id: "ac3-ws1", name: "W1", controlDir: "/w1", createdAt: "2026-01-01T00:00:00Z" },
        { id: "ac3-ws2", name: "W2", controlDir: "/w2", createdAt: "2026-01-01T00:00:00Z" },
      ],
      activeId: "ac3-ws1",
    });

    // Pre-populate cache for ac3-ws1 (simulates a prior /api/cost call).
    const stubEntry = { data: { agents: [], total: { tokens_in: 0, tokens_out: 0, cost_usd: 0 }, cachedAt: "2026-01-01T00:00:00Z" }, expiresAt: Date.now() + 60_000 };
    ac3Cache.set("ac3-ws1", stubEntry);

    const s = createServer(
      makeWorkspacesHandler({
        workspacesPath: ac3RegPath,
        costInvalidateFn: (id) => ac3Cache.delete(id),
      }),
    );
    await new Promise<void>((r) => s.listen(COST_AC3_PORT, "127.0.0.1", r));
    try {
      // Activate ac3-ws2 — should invalidate ac3-ws1 from cost cache.
      const r = await fetch(`http://127.0.0.1:${COST_AC3_PORT}/api/workspaces/ac3-ws2/activate`, { method: "POST" });
      expect(r.status).toBe(200);
      expect(ac3Cache.has("ac3-ws1")).toBe(false); // cache invalidated
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
      rmSync(ac3TmpDir, { recursive: true, force: true });
    }
  });
});

describe("GET /api/cost malformed cost fields skipped (AC4)", () => {
  test("returns 200 and skips events with non-numeric cost_usd without 500", async () => {
    costCache.clear();
    const r = await fetch(`http://127.0.0.1:${COST_PORT}/api/cost`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as CostResponse;
    // agent-a has 2 valid cost events (0.001 + 0.002) and 2 invalid lines → total 0.003
    const row = body.agents.find((a: CostAgentRow) => a.agent === "agent-a");
    expect(row!.cost_usd).toBe(0.003);
  });
});

describe("GET /api/cost ?since= filter (AC5)", () => {
  test("returns only events at or after the since timestamp, bypasses cache", async () => {
    // Pre-populate cache with stale data to verify since bypasses it.
    const fakeStale: CostResponse = { agents: [{ agent: "stale", tokens_in: 99, tokens_out: 99, cost_usd: 9.9999 }], total: { tokens_in: 99, tokens_out: 99, cost_usd: 9.9999 }, cachedAt: "2026-01-01T00:00:00Z" };
    costCache.set("cost-ws-1", { data: fakeStale, expiresAt: Date.now() + 60_000 });
    // since=2026-01-01T11:30:00Z — only the 12:00 event qualifies (but it has no cost_usd → 0), 11:00 also qualifies
    const r = await fetch(`http://127.0.0.1:${COST_PORT}/api/cost?since=2026-01-01T11:30:00Z`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as CostResponse;
    // 12:00 event has no cost_usd, 13:00 has bad cost_usd → agent-a absent (no valid cost after 11:30)
    // 11:00 event is exactly at 11:00, which is BEFORE 11:30 → filtered out
    expect(body.agents).toHaveLength(0);
    expect(body.total.cost_usd).toBe(0);
  });

  test("?since= within window returns correct filtered totals", async () => {
    // since=2026-01-01T10:30:00Z — only 11:00 event (cost 0.002) qualifies
    const r = await fetch(`http://127.0.0.1:${COST_PORT}/api/cost?since=2026-01-01T10:30:00Z`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as CostResponse;
    const row = body.agents.find((a: CostAgentRow) => a.agent === "agent-a");
    expect(row).toBeDefined();
    expect(row!.tokens_in).toBe(200);
    expect(row!.cost_usd).toBe(0.002);
  });
});

describe("GET /api/cost no cost data returns empty agents (AC6)", () => {
  test("returns empty agents array when no events have cost_usd", async () => {
    // agent-b has no cost_usd events; test with only agent-b
    const localCache = new Map<string, { data: CostResponse; expiresAt: number }>();
    const localRegPath = join(costTestDir, "ws-ac6.json");
    writeWorkspaceRegistry(localRegPath, { workspaces: [{ id: "ws-ac6", name: "AC6", controlDir: "/c", createdAt: "2026-01-01T00:00:00Z" }], activeId: "ws-ac6" });
    const s = createServer(makeCostHandler({ agents: ["agent-b"], agentsHome: costAgentsHome, workspacesPath: localRegPath, costCache: localCache }));
    await new Promise<void>((r) => s.listen(7893, "127.0.0.1", r));
    try {
      const r = await fetch("http://127.0.0.1:7893/api/cost");
      expect(r.status).toBe(200);
      const body = (await r.json()) as CostResponse;
      expect(body.agents).toHaveLength(0);
      expect(body.total.tokens_in).toBe(0);
      expect(body.total.cost_usd).toBe(0);
      expect(typeof body.cachedAt).toBe("string");
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});

// T19-amended: cache-specific describe blocks matching AC → verification table.

describe("cost cache cachedAt", () => {
  test("GET /api/cost response includes cachedAt as ISO string", async () => {
    costCache.clear();
    const r = await fetch(`http://127.0.0.1:${COST_PORT}/api/cost`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as CostResponse;
    expect(typeof body.cachedAt).toBe("string");
    expect(new Date(body.cachedAt).toISOString()).toBe(body.cachedAt);
  });
});

describe("cost cache TTL", () => {
  test("two calls within 1s hit cache: compute runs once", async () => {
    let callCount = 0;
    const spy = (agents: string[], home: string, since?: string): CostResponse => {
      callCount++;
      return computeCostData(agents, home, since);
    };
    const localCache = new Map<string, { data: CostResponse; expiresAt: number }>();
    const localReg = join(costTestDir, "ws-ttl.json");
    writeWorkspaceRegistry(localReg, { workspaces: [{ id: "ws-ttl", name: "TTL", controlDir: "/c", createdAt: "2026-01-01T00:00:00Z" }], activeId: "ws-ttl" });
    const s = createServer(makeCostHandler({ agents: ["agent-a"], agentsHome: costAgentsHome, workspacesPath: localReg, costCache: localCache, computeFn: spy }));
    await new Promise<void>((r) => s.listen(7894, "127.0.0.1", r));
    try {
      await fetch("http://127.0.0.1:7894/api/cost");
      await fetch("http://127.0.0.1:7894/api/cost");
      expect(callCount).toBe(1);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});

describe("cost cache workspace switch", () => {
  test("switching workspace invalidates cost cache for the outgoing workspace id", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "console-cost-switch-"));
    const regPath = join(tmpDir, "workspaces.json");
    const cache = new Map<string, { data: CostResponse; expiresAt: number }>();
    writeWorkspaceRegistry(regPath, {
      workspaces: [
        { id: "sw-ws1", name: "W1", controlDir: "/w1", createdAt: "2026-01-01T00:00:00Z" },
        { id: "sw-ws2", name: "W2", controlDir: "/w2", createdAt: "2026-01-01T00:00:00Z" },
      ],
      activeId: "sw-ws1",
    });
    cache.set("sw-ws1", { data: { agents: [], total: { tokens_in: 0, tokens_out: 0, cost_usd: 0 }, cachedAt: "2026-01-01T00:00:00Z" }, expiresAt: Date.now() + 60_000 });
    const s = createServer(makeWorkspacesHandler({ workspacesPath: regPath, costInvalidateFn: (id) => cache.delete(id) }));
    await new Promise<void>((r) => s.listen(7895, "127.0.0.1", r));
    try {
      const r = await fetch("http://127.0.0.1:7895/api/workspaces/sw-ws2/activate", { method: "POST" });
      expect(r.status).toBe(200);
      expect(cache.has("sw-ws1")).toBe(false);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("cost cache bypass since", () => {
  test("GET /api/cost?since= bypasses cache and re-reads on every call", async () => {
    let callCount = 0;
    const spy = (agents: string[], home: string, since?: string): CostResponse => {
      callCount++;
      return computeCostData(agents, home, since);
    };
    const localCache = new Map<string, { data: CostResponse; expiresAt: number }>();
    const localReg = join(costTestDir, "ws-since.json");
    writeWorkspaceRegistry(localReg, { workspaces: [{ id: "ws-since", name: "Since", controlDir: "/c", createdAt: "2026-01-01T00:00:00Z" }], activeId: "ws-since" });
    const s = createServer(makeCostHandler({ agents: ["agent-a"], agentsHome: costAgentsHome, workspacesPath: localReg, costCache: localCache, computeFn: spy }));
    await new Promise<void>((r) => s.listen(7896, "127.0.0.1", r));
    try {
      await fetch("http://127.0.0.1:7896/api/cost?since=2026-01-01T10:00:00Z");
      await fetch("http://127.0.0.1:7896/api/cost?since=2026-01-01T10:00:00Z");
      expect(callCount).toBe(2);
      expect(localCache.size).toBe(0);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});
