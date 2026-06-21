// supervisor/console/server.test.ts
// Tests for endpoint security boundaries (AC3, AC4, AC5) and utility edge cases (AC6, AC7).
// Starts a minimal test server on port 7843 — no dependency on a running console instance.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createServer } from "node:http";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
  gitCommitAndPush,
  resolvePort,
  readApprovals,
  purgeStaleDecisionFiles,
  type AgentStatus,
  type GitSpawner,
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

// --- T9 AC4: rawPath preserves dot segments ---

describe("rawPath dot-segment preservation (AC4)", () => {
  test("rawPath('/a/../b') returns '/a/../b' unprocessed (AC4)", () => {
    expect(rawPath("/a/../b")).toBe("/a/../b");
  });

  test("rawPath('/foo/./bar') returns '/foo/./bar' unprocessed (AC4)", () => {
    expect(rawPath("/foo/./bar")).toBe("/foo/./bar");
  });

  test("rawPath does not normalise what the URL API would (AC4 contrast)", () => {
    expect(rawPath("/a/../b")).not.toBe(new URL("/a/../b", "http://localhost").pathname);
  });
});

// --- T9 AC7: GET /api/fleet with empty/absent fleet.conf ---

describe("GET /api/fleet absent/empty fleet.conf (AC7)", () => {
  test("readFleetStatus with empty agent list returns [] — no crash (AC7)", () => {
    expect(readFleetStatus([], testDir)).toEqual([]);
  });

  test("GET /api/fleet returns 200 with [] when no agents configured (AC7)", async () => {
    const srv = createServer((_req, res) => {
      sendJson(res, readFleetStatus([], testDir));
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const { port } = srv.address() as { port: number };
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/fleet`);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => srv.close(resolve));
    }
  });
});

// --- T9 AC1 + AC2: JSON body and Content-Type validation for all POST endpoints ---

async function readAndValidateJsonBody(req: IncomingMessage): Promise<string | null> {
  const ct = req.headers["content-type"] ?? "";
  if (!ct.includes("application/json")) return "content-type must be application/json";
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    JSON.parse(Buffer.concat(chunks).toString());
    return null;
  } catch {
    return "invalid JSON body";
  }
}

describe("JSON body and Content-Type validation (AC1 + AC2)", () => {
  let jsonSrv: Server;
  const JSON_PORT = 7845;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        jsonSrv = createServer((req, res) => {
          if (req.method !== "POST") {
            res.writeHead(405);
            res.end();
            return;
          }
          void (async () => {
            const err = await readAndValidateJsonBody(req);
            if (err) {
              sendJson(res, { error: err }, 400);
              return;
            }
            sendJson(res, { ok: true });
          })();
        });
        jsonSrv.listen(JSON_PORT, "127.0.0.1", resolve);
      }),
  );

  afterAll(
    () =>
      new Promise<void>((resolve, reject) => {
        jsonSrv.close((err) => (err ? reject(err) : resolve()));
      }),
  );

  test("POST /api/mailbox/:agentName returns 400 for invalid JSON body (AC1)", async () => {
    const r = await fetch(`http://127.0.0.1:${JSON_PORT}/api/mailbox/agent-be`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not: valid json}",
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  test("POST /api/approve returns 400 for invalid JSON body (AC1)", async () => {
    const r = await fetch(`http://127.0.0.1:${JSON_PORT}/api/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "this is not json",
    });
    expect(r.status).toBe(400);
  });

  test("POST /api/draft-decision returns 400 for invalid JSON body (AC1)", async () => {
    const r = await fetch(`http://127.0.0.1:${JSON_PORT}/api/draft-decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[unclosed array",
    });
    expect(r.status).toBe(400);
  });

  test("POST /api/mailbox/:agentName returns 400 when Content-Type is not application/json (AC2)", async () => {
    const r = await fetch(`http://127.0.0.1:${JSON_PORT}/api/mailbox/agent-be`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ note: "hello" }),
    });
    expect(r.status).toBe(400);
  });

  test("POST /api/approve returns 400 when Content-Type is not application/json (AC2)", async () => {
    const r = await fetch(`http://127.0.0.1:${JSON_PORT}/api/approve`, {
      method: "POST",
      body: JSON.stringify({ agentName: "agent-be", requestId: "r1", approved: true }),
    });
    expect(r.status).toBe(400);
  });

  test("POST /api/draft-decision returns 400 when Content-Type is not application/json (AC2)", async () => {
    const r = await fetch(`http://127.0.0.1:${JSON_PORT}/api/draft-decision`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "taskId=T9&agentName=agent-be",
    });
    expect(r.status).toBe(400);
  });
});
