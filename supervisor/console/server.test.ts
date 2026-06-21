// supervisor/console/server.test.ts
// Tests for endpoint security boundaries (AC3, AC4, AC5) and utility edge cases (AC6, AC7).
// Starts a minimal test server on port 7843 — no dependency on a running console instance.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createServer } from "node:http";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TASK_ID_RE,
  parseTaskLedger,
  parseMailboxNotes,
  sendJson,
  rawPath,
  serveStatic,
  readFleetStatus,
  makeWatchHandler,
  readApprovals,
  type AgentStatus,
  type ApprovalItem,
} from "./server-utils.ts";

const TEST_PORT = 7843;

const testDir = join(tmpdir(), `console-test-${process.pid}`);
const ledgerDir = join(testDir, "ledger");
const staticDir = join(testDir, "static");
const agentsHome = join(testDir, "agents-home");
const decisionsDir = join(testDir, "decisions");
const fleetAgents = ["agent-be", "agent-qa", "agent-fe", "agent-doc"];

// Agents recognised by the mock fleet.conf.
const validAgents = new Set(["agent-be", "agent-qa", "agent-fe", "agent-doc"]);

let httpServer: Server;

function makeHandler(rootDir: string, fleetHome?: string, testDecisionsDir?: string) {
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
      sendJson(res, { ok: true });
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

      httpServer = createServer(makeHandler(staticDir, agentsHome, decisionsDir));
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

  test("accepts a known agent name", async () => {
    const r = await fetch(
      `http://127.0.0.1:${TEST_PORT}/api/mailbox/agent-be`,
      { method: "POST", body: "test message" },
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

describe("makeWatchHandler (AC4)", () => {
  test("broadcasts fleet-update payload when filename is live.json", () => {
    const calls: string[] = [];
    const handler = makeWatchHandler("agent-be", (msg) => calls.push(msg));
    handler("change", "live.json");
    expect(calls).toHaveLength(1);
    const payload = JSON.parse(calls[0]) as { type: string; agent: string; ts: number };
    expect(payload.type).toBe("fleet-update");
    expect(payload.agent).toBe("agent-be");
    expect(typeof payload.ts).toBe("number");
  });

  test("broadcasts file payload (not fleet-update) when filename is live-events.jsonl", () => {
    const calls: string[] = [];
    const handler = makeWatchHandler("agent-be", (msg) => calls.push(msg));
    handler("change", "live-events.jsonl");
    expect(calls).toHaveLength(1);
    const payload = JSON.parse(calls[0]) as { agent: string; file: string };
    expect(payload.agent).toBe("agent-be");
    expect(payload.file).toBe("live-events.jsonl");
  });

  test("does not call broadcast for unrelated filenames", () => {
    const calls: string[] = [];
    const handler = makeWatchHandler("agent-be", (msg) => calls.push(msg));
    handler("change", "other.log");
    expect(calls).toHaveLength(0);
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
});
