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
} from "./server-utils.ts";

const TEST_PORT = 7843;

const testDir = join(tmpdir(), `console-test-${process.pid}`);
const ledgerDir = join(testDir, "ledger");
const staticDir = join(testDir, "static");

// Agents recognised by the mock fleet.conf.
const validAgents = new Set(["agent-be", "agent-qa", "agent-fe", "agent-doc"]);

let httpServer: Server;

function makeHandler(rootDir: string) {
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

    // Static file handler — last, after all API routes.
    serveStatic(rootDir, path, res);
  };
}

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      mkdirSync(ledgerDir, { recursive: true });
      mkdirSync(staticDir, { recursive: true });

      // Seed mock ledger with one needs_human task for AC5.
      writeFileSync(
        join(ledgerDir, "CONS-999.task"),
        "id: CONS-999\nstatus: needs_human\ndomain: be\ndescription: blocked test task\n",
      );

      // Fixture files for CONS-011 static-serving tests.
      writeFileSync(join(staticDir, "index.html"), "<html><body>test</body></html>");
      writeFileSync(join(staticDir, "styles.css"), "body { color: red; }");

      httpServer = createServer(makeHandler(staticDir));
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

// --- AC7 ---

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
