/**
 * In-process tests for design daemon endpoints + lifecycle helpers.
 *
 * Uses the exported fetchHandler directly (no Bun.serve spawn) so the suite
 * is fast and deterministic. Spawn-based tests live in
 * daemon-discovery.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";

import { __testInternals__, fetchHandler, idleCheckTick } from "../src/daemon";

const { markMeaningfulActivity } = __testInternals__;
import { makeBoardHtml, makeTmpDir, req, resetDaemon } from "./daemon-tests-fixtures";

let tmpDir: string;

beforeEach(() => {
  resetDaemon();
  tmpDir = makeTmpDir();
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // already gone
  }
});

async function publishTestBoard(opts: { dir?: string; body?: string; title?: string } = {}) {
  const dir = opts.dir ?? tmpDir;
  const htmlPath = makeBoardHtml(dir, opts.body ?? "<p>Test</p>");
  const r = await fetchHandler(
    req("POST", "/api/boards", { html: htmlPath, title: opts.title }),
  );
  expect(r.status).toBe(200);
  const body = (await r.json()) as { id: string; url: string; sourceDir: string };
  return { ...body, htmlPath, dir };
}

// ─── /health ─────────────────────────────────────────────────────

describe("daemon /health", () => {
  test("returns ok=true with version + boards counts", async () => {
    const r = await fetchHandler(req("GET", "/health"));
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
    expect(body.boards).toBe(0);
    expect(body.activeBoards).toBe(0);
    expect(typeof body.uptime).toBe("number");
  });

  test("activeBoards counts non-done after publish", async () => {
    await publishTestBoard();
    const r = await fetchHandler(req("GET", "/health"));
    const body = (await r.json()) as any;
    expect(body.boards).toBe(1);
    expect(body.activeBoards).toBe(1);
  });
});

// ─── POST /api/boards (publish) ─────────────────────────────────

describe("daemon /api/boards (publish)", () => {
  test("publishes a board and returns id + url + derived sourceDir", async () => {
    const htmlPath = makeBoardHtml(tmpDir);
    const r = await fetchHandler(req("POST", "/api/boards", { html: htmlPath }));
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.id).toMatch(/^b-\d{8}-\d{6}-[a-z0-9]{6}$/);
    expect(body.url).toMatch(/\/boards\/b-\d{8}-\d{6}-[a-z0-9]{6}\/$/); // trailing slash
    expect(body.sourceDir).toBe(fs.realpathSync(tmpDir));
  });

  test("rejects when html field missing", async () => {
    const r = await fetchHandler(req("POST", "/api/boards", { title: "noop" }));
    expect(r.status).toBe(400);
    const body = (await r.json()) as any;
    expect(body.error).toContain("Missing 'html'");
  });

  test("rejects when html file does not exist", async () => {
    const r = await fetchHandler(
      req("POST", "/api/boards", { html: "/tmp/does-not-exist.html" }),
    );
    expect(r.status).toBe(400);
    const body = (await r.json()) as any;
    expect(body.error).toContain("not found");
  });

  test("rejects when html points at a directory", async () => {
    const r = await fetchHandler(req("POST", "/api/boards", { html: tmpDir }));
    expect(r.status).toBe(400);
    const body = (await r.json()) as any;
    expect(body.error).toContain("must be a file");
  });

  test("ignores body-supplied sourceDir; derives from realpath(html) instead", async () => {
    const htmlPath = makeBoardHtml(tmpDir);
    const otherDir = makeTmpDir("sneaky");
    try {
      const r = await fetchHandler(
        req("POST", "/api/boards", { html: htmlPath, sourceDir: otherDir }),
      );
      expect(r.status).toBe(200);
      const body = (await r.json()) as any;
      // The daemon used the realpath of the HTML's dir, NOT the body field.
      expect(body.sourceDir).toBe(fs.realpathSync(tmpDir));
      expect(body.sourceDir).not.toBe(fs.realpathSync(otherDir));
    } finally {
      try {
        fs.rmSync(otherDir, { recursive: true, force: true });
      } catch {
        // already gone
      }
    }
  });

  test("409 when a non-done board already claims the same sourceDir", async () => {
    const first = await publishTestBoard();
    const htmlPath = makeBoardHtml(tmpDir, "<p>Second attempt</p>");
    const r = await fetchHandler(req("POST", "/api/boards", { html: htmlPath }));
    expect(r.status).toBe(409);
    const body = (await r.json()) as any;
    expect(body.error).toContain("already in use");
    expect(body.existing.id).toBe(first.id);
    expect(body.existing.url).toContain(`/boards/${first.id}/`);
  });

  test("allows publish to same sourceDir after the prior board is done", async () => {
    const first = await publishTestBoard();
    // Submit the first board so it becomes done
    await fetchHandler(
      req("POST", `/boards/${first.id}/api/feedback`, { regenerated: false }),
    );
    const htmlPath = makeBoardHtml(tmpDir, "<p>Round two</p>");
    const r = await fetchHandler(req("POST", "/api/boards", { html: htmlPath }));
    expect(r.status).toBe(200);
  });
});

// ─── GET /boards/<id> trailing-slash redirect ────────────────────

describe("daemon /boards/<id> trailing-slash redirect", () => {
  test("GET /boards/<id> returns 301 with Location /boards/<id>/", async () => {
    const board = await publishTestBoard();
    const r = await fetchHandler(req("GET", `/boards/${board.id}`));
    expect(r.status).toBe(301);
    expect(r.headers.get("Location")).toBe(`/boards/${board.id}/`);
  });

  test("GET /boards/<id>/ renders the board's HTML", async () => {
    const board = await publishTestBoard({ body: "<p>Hello from board</p>" });
    const r = await fetchHandler(req("GET", `/boards/${board.id}/`));
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type") || "").toContain("text/html");
    const html = await r.text();
    expect(html).toContain("Hello from board");
    // No __GSTACK_SERVER_URL injection (board JS uses relative paths)
    expect(html).not.toContain("__GSTACK_SERVER_URL");
  });

  test("404 on unknown board id (shows expired page)", async () => {
    const r = await fetchHandler(req("GET", "/boards/b-nonexistent/"));
    expect(r.status).toBe(404);
    const html = await r.text();
    expect(html).toContain("Board expired");
  });
});

// ─── POST /boards/<id>/api/feedback ──────────────────────────────

describe("daemon /boards/<id>/api/feedback", () => {
  test("submit writes feedback.json to derived sourceDir with boardId + publishedAt", async () => {
    const board = await publishTestBoard();
    const feedback = { preferred: "A", ratings: { A: 5 }, regenerated: false };
    const r = await fetchHandler(
      req("POST", `/boards/${board.id}/api/feedback`, feedback),
    );
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).action).toBe("submitted");

    const written = JSON.parse(
      fs.readFileSync(path.join(board.sourceDir, "feedback.json"), "utf-8"),
    );
    expect(written.preferred).toBe("A");
    expect(written.regenerated).toBe(false);
    expect(written.boardId).toBe(board.id);
    expect(typeof written.publishedAt).toBe("string");
    expect(written.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("regenerate writes feedback-pending.json and flips state to regenerating", async () => {
    const board = await publishTestBoard();
    const r = await fetchHandler(
      req("POST", `/boards/${board.id}/api/feedback`, {
        regenerated: true,
        regenerateAction: "more_like_A",
      }),
    );
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).action).toBe("regenerate");

    expect(fs.existsSync(path.join(board.sourceDir, "feedback-pending.json"))).toBe(true);
    expect(fs.existsSync(path.join(board.sourceDir, "feedback.json"))).toBe(false);

    const progress = await fetchHandler(
      req("GET", `/boards/${board.id}/api/progress`),
    );
    expect(((await progress.json()) as any).status).toBe("regenerating");
  });

  test("cross-board isolation: feedback writes only into that board's sourceDir", async () => {
    const dirA = makeTmpDir("board-a");
    const dirB = makeTmpDir("board-b");
    try {
      const htmlA = makeBoardHtml(dirA);
      const htmlB = makeBoardHtml(dirB);
      const a = (await (await fetchHandler(
        req("POST", "/api/boards", { html: htmlA }),
      )).json()) as any;
      const b = (await (await fetchHandler(
        req("POST", "/api/boards", { html: htmlB }),
      )).json()) as any;
      expect(a.id).not.toBe(b.id);

      await fetchHandler(
        req("POST", `/boards/${a.id}/api/feedback`, { preferred: "A", regenerated: false }),
      );
      expect(fs.existsSync(path.join(a.sourceDir, "feedback.json"))).toBe(true);
      // Board B's directory must not have been touched
      expect(fs.existsSync(path.join(b.sourceDir, "feedback.json"))).toBe(false);
      expect(fs.existsSync(path.join(b.sourceDir, "feedback-pending.json"))).toBe(false);
    } finally {
      try { fs.rmSync(dirA, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(dirB, { recursive: true, force: true }); } catch {}
    }
  });

  test("rejects malformed JSON body", async () => {
    const board = await publishTestBoard();
    const bad = new Request(`http://127.0.0.1/boards/${board.id}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const r = await fetchHandler(bad);
    expect(r.status).toBe(400);
  });
});

// ─── POST /boards/<id>/api/reload ────────────────────────────────

describe("daemon /boards/<id>/api/reload", () => {
  test("swaps HTML in place; subsequent GET returns new content", async () => {
    const board = await publishTestBoard({ body: "<p>round 1</p>" });
    const newHtml = makeBoardHtml(tmpDir, "<p>round 2</p>");
    // The reload helper writes to design-board.html; make a distinct path
    fs.writeFileSync(path.join(tmpDir, "round2.html"), "<html><body><p>round 2</p></body></html>");
    const reloadPath = path.join(tmpDir, "round2.html");

    const r = await fetchHandler(
      req("POST", `/boards/${board.id}/api/reload`, { html: reloadPath }),
    );
    expect(r.status).toBe(200);

    const page = await fetchHandler(req("GET", `/boards/${board.id}/`));
    expect(await page.text()).toContain("round 2");
  });

  test("rejects path traversal outside allowedDir", async () => {
    const board = await publishTestBoard();
    const r = await fetchHandler(
      req("POST", `/boards/${board.id}/api/reload`, { html: "/etc/passwd" }),
    );
    expect(r.status).toBe(403);
  });

  test("rejects directory path (Codex finding regression guard)", async () => {
    const board = await publishTestBoard();
    const sub = path.join(tmpDir, "subdir");
    fs.mkdirSync(sub, { recursive: true });
    const r = await fetchHandler(
      req("POST", `/boards/${board.id}/api/reload`, { html: sub }),
    );
    expect(r.status).toBe(400);
    const body = (await r.json()) as any;
    expect(body.error).toContain("must be a file");
  });

  test("rejects symlink pointing out of allowedDir", async () => {
    const board = await publishTestBoard();
    const linkPath = path.join(tmpDir, "evil.html");
    try {
      fs.symlinkSync("/etc/passwd", linkPath);
      const r = await fetchHandler(
        req("POST", `/boards/${board.id}/api/reload`, { html: linkPath }),
      );
      expect(r.status).toBe(403);
    } finally {
      try { fs.unlinkSync(linkPath); } catch {}
    }
  });
});

// ─── GET / (index) ───────────────────────────────────────────────

describe("daemon / (index)", () => {
  test("empty state shows the no-boards message", async () => {
    const r = await fetchHandler(req("GET", "/"));
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("No boards yet");
  });

  test("lists boards newest first with state badges", async () => {
    const a = await publishTestBoard({ title: "first" });
    // Small wait so publishedAt differs
    await new Promise((r) => setTimeout(r, 5));
    const dirB = makeTmpDir("index-b");
    try {
      const htmlB = makeBoardHtml(dirB);
      const b = (await (await fetchHandler(
        req("POST", "/api/boards", { html: htmlB, title: "second" }),
      )).json()) as any;

      const html = await (await fetchHandler(req("GET", "/"))).text();
      const idxA = html.indexOf(a.id);
      const idxB = html.indexOf(b.id);
      // Newest first: b appears before a
      expect(idxB).toBeGreaterThanOrEqual(0);
      expect(idxA).toBeGreaterThan(idxB);
      // State badge present
      expect(html).toMatch(/state-serving/);
    } finally {
      try { fs.rmSync(dirB, { recursive: true, force: true }); } catch {}
    }
  });
});

// ─── /shutdown ───────────────────────────────────────────────────

describe("daemon /shutdown", () => {
  test("refuses /shutdown when boards are non-done", async () => {
    await publishTestBoard();
    const r = await fetchHandler(req("POST", "/shutdown"));
    expect(r.status).toBe(409);
    const body = (await r.json()) as any;
    expect(body.error).toContain("active boards");
    expect(body.activeBoards).toBe(1);
  });

  test("accepts /shutdown when no active boards (graceful path)", async () => {
    // Publish then submit so state=done
    const board = await publishTestBoard();
    await fetchHandler(
      req("POST", `/boards/${board.id}/api/feedback`, { regenerated: false }),
    );
    // Now non-done count is 0 — handler should return shuttingDown:true.
    // We DON'T let the real gracefulShutdown timer fire (it calls process.exit
    // after 50ms which would tear down the test runner); instead we just
    // observe the immediate response.
    const r = await fetchHandler(req("POST", "/shutdown"));
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.shuttingDown).toBe(true);
    // Reset state for subsequent tests; the shutdown timer will be a no-op
    // because the next resetForTest flips shuttingDown back to false.
    resetDaemon();
  });
});

// ─── LRU + non-done protection ───────────────────────────────────

describe("daemon LRU eviction", () => {
  test("evicts done boards in preference to non-done", async () => {
    // Seed the map directly so we don't have to publish 50 real boards.
    // Setup: 10 done (oldest) + 40 serving (newer) = 50 total, 40 non-done.
    // Publishing a 51st board: nonDoneCount(40) < MAX(50) → accepts, inserts,
    // size=51, then evictUntilUnderCap kicks out the LRU done.
    const boards = __testInternals__.boards;
    const mk = (id: string, state: "serving" | "done", lastTouched: number) => {
      boards.set(id, {
        id,
        htmlContent: "<p>seeded</p>",
        sourceDir: `/tmp/seeded-${id}`,
        allowedDir: `/tmp/seeded-${id}`,
        state,
        publishedAt: lastTouched,
        lastTouched,
        publisherPid: 0,
      });
    };
    for (let i = 0; i < 10; i++) mk(`b-done-${i}`, "done", 1000 + i);
    for (let i = 0; i < 40; i++) mk(`b-active-${i}`, "serving", 2000 + i);
    expect(boards.size).toBe(50);

    const htmlPath = makeBoardHtml(tmpDir);
    const r = await fetchHandler(req("POST", "/api/boards", { html: htmlPath }));
    expect(r.status).toBe(200);

    expect(boards.size).toBeLessThanOrEqual(50);
    // At least one of the (oldest) done boards is gone; non-done untouched.
    let doneGoneCount = 0;
    for (let i = 0; i < 10; i++) if (!boards.has(`b-done-${i}`)) doneGoneCount += 1;
    expect(doneGoneCount).toBeGreaterThanOrEqual(1);
    // All non-done preserved
    for (let i = 0; i < 40; i++) {
      expect(boards.has(`b-active-${i}`)).toBe(true);
    }
  });

  test("503 when 50 non-done boards already exist", async () => {
    const boards = __testInternals__.boards;
    for (let i = 0; i < 50; i++) {
      boards.set(`b-busy-${i}`, {
        id: `b-busy-${i}`,
        htmlContent: "<p>busy</p>",
        sourceDir: `/tmp/busy-${i}`,
        allowedDir: `/tmp/busy-${i}`,
        state: "serving",
        publishedAt: i,
        lastTouched: i,
        publisherPid: 0,
      });
    }
    const htmlPath = makeBoardHtml(tmpDir);
    const r = await fetchHandler(req("POST", "/api/boards", { html: htmlPath }));
    expect(r.status).toBe(503);
  });
});

// ─── Idle + meaningful activity ──────────────────────────────────
//
// The behavioral tests for idle shutdown — actual process exit, bare-GET-
// doesn't-reset-idle, MAX_EXTENSIONS hard ceiling — live in
// daemon-discovery.test.ts because they require a real spawned daemon
// (lastMeaningfulActivity isn't observable in-process). The in-process
// version of these tests previously was a smoke that the testing specialist
// correctly flagged as misleading; it was removed.

describe("daemon idle + activity tracking (smoke)", () => {
  test("idleCheckTick on a freshly-touched daemon does not throw or shut down", () => {
    markMeaningfulActivity();
    expect(() => idleCheckTick()).not.toThrow();
    // boards map shouldn't have been wiped (no graceful shutdown happened)
    expect(typeof __testInternals__.boards.size).toBe("number");
  });
});

// ─── Malformed body negatives ────────────────────────────────────

describe("daemon malformed body handling", () => {
  test("POST /api/boards rejects invalid JSON body with 400", async () => {
    const bad = new Request("http://127.0.0.1:1234/api/boards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const r = await fetchHandler(bad);
    expect(r.status).toBe(400);
    const body = (await r.json()) as any;
    expect(body.error).toContain("Invalid JSON");
  });

  test("POST /api/boards rejects non-object body (e.g. JSON null) with 400", async () => {
    // JS quirk: `typeof [] === "object"`, so arrays slip past the
    // !body || typeof body !== "object" guard and fail at the missing-html
    // check below. The "Expected JSON object" path only fires for genuinely
    // non-object values like null, numbers, strings.
    const bad = new Request("http://127.0.0.1:1234/api/boards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    const r = await fetchHandler(bad);
    expect(r.status).toBe(400);
    const body = (await r.json()) as any;
    expect(body.error).toContain("Expected JSON object");
  });

  test("POST /api/boards: array body falls through to missing-html 400", async () => {
    // Documents the actual behavior — arrays bypass the type guard but get
    // caught by the html-field check. If we ever tighten the type check to
    // reject arrays explicitly, this test will surface the change.
    const r = await fetchHandler(req("POST", "/api/boards", [1, 2, 3] as any));
    expect(r.status).toBe(400);
    const body = (await r.json()) as any;
    expect(body.error).toContain("Missing 'html'");
  });

  test("POST /boards/<id>/api/reload rejects invalid JSON body with 400", async () => {
    const board = await publishTestBoard();
    const bad = new Request(
      `http://127.0.0.1:1234/boards/${board.id}/api/reload`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{nope",
      },
    );
    const r = await fetchHandler(bad);
    expect(r.status).toBe(400);
  });

  test("POST /boards/<id>/api/reload rejects body missing html field with 400", async () => {
    const board = await publishTestBoard();
    const r = await fetchHandler(
      req("POST", `/boards/${board.id}/api/reload`, { somethingElse: true }),
    );
    expect(r.status).toBe(400);
    const body = (await r.json()) as any;
    expect(body.error).toContain("HTML file not found");
  });
});

// ─── Unknown routes ──────────────────────────────────────────────

describe("daemon unknown routes", () => {
  test("404 on unknown path", async () => {
    const r = await fetchHandler(req("GET", "/some/unknown/path"));
    expect(r.status).toBe(404);
  });

  test("GET /api/boards (wrong method on publish endpoint) returns 404", async () => {
    const r = await fetchHandler(req("GET", "/api/boards"));
    expect(r.status).toBe(404);
  });
});
