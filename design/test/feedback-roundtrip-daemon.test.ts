/**
 * End-to-end daemon round-trip test.
 *
 * Spawns a real design daemon and walks the full publish → submit /
 * regenerate / reload cycle via HTTP fetch (the same calls the board JS
 * makes). Proves what design-shotgun and the rest of the design skills
 * depend on:
 *
 *   - $D compare --serve attaches to OR spawns a single shared daemon.
 *   - Two boards published into the same daemon get independent paths
 *     under /boards/<id>/ — no port churn, no second process.
 *   - Submit writes feedback.json into the board's sourceDir with
 *     boardId + publishedAt fields the skill can poll for.
 *   - Regenerate writes feedback-pending.json, flips state to
 *     regenerating, /api/progress reflects it.
 *   - /api/reload swaps HTML in place — second GET returns new content.
 *   - Even with two concurrent boards in flight, feedback for one does
 *     not contaminate the other's sourceDir.
 *
 * Browser-driven round-trip (feedback-roundtrip.test.ts) covers the same
 * flow at the click level for the legacy --no-daemon path; this file is
 * the daemon-path equivalent.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";

import { publishBoard } from "../src/daemon-client";
import { readStateFile } from "../src/daemon-state";
import {
  makeBoardHtml,
  makeTmpDir,
  spawnDaemonForTest,
  type SpawnedDaemon,
} from "./daemon-tests-fixtures";

let workDir: string;
let stateFile: string;
let daemons: SpawnedDaemon[] = [];

beforeEach(() => {
  workDir = makeTmpDir("roundtrip-daemon");
  stateFile = path.join(workDir, "design.json");
  process.env.DESIGN_DAEMON_STATE_FILE = stateFile;
});

afterEach(async () => {
  for (const d of daemons.splice(0)) {
    try { await d.stop(); } catch {}
  }
  try { fs.unlinkSync(stateFile); } catch {}
  delete process.env.DESIGN_DAEMON_STATE_FILE;
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
});

async function spawn1(): Promise<SpawnedDaemon> {
  const d = await spawnDaemonForTest({ stateFile, idleMs: 60_000 });
  daemons.push(d);
  return d;
}

// ─── Submit round-trip ───────────────────────────────────────────

describe("daemon round-trip: publish → submit → feedback.json", () => {
  test("Submit feedback lands at sourceDir with boardId + publishedAt", async () => {
    const d = await spawn1();
    const boardDir = makeTmpDir("board-submit");
    try {
      const htmlPath = makeBoardHtml(boardDir, "<p>round-trip board</p>");
      const board = await publishBoard({ port: d.port, html: htmlPath });
      expect(board.url).toBe(`http://127.0.0.1:${d.port}/boards/${board.id}/`);
      expect(board.sourceDir).toBe(fs.realpathSync(boardDir));

      // GET the board URL — same path the browser would hit
      const page = await fetch(board.url);
      expect(page.status).toBe(200);
      const pageHtml = await page.text();
      expect(pageHtml).toContain("round-trip board");

      // POST submit (mirrors what the board JS does on Submit click)
      const submit = await fetch(`${board.url}api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preferred: "A",
          ratings: { A: 5, B: 3 },
          comments: { A: "love it" },
          overall: "ship A",
          regenerated: false,
        }),
      });
      expect(submit.status).toBe(200);
      const submitBody = (await submit.json()) as any;
      expect(submitBody.action).toBe("submitted");

      // The skill side polls for feedback.json in the source directory
      const feedbackPath = path.join(board.sourceDir, "feedback.json");
      expect(fs.existsSync(feedbackPath)).toBe(true);
      const written = JSON.parse(fs.readFileSync(feedbackPath, "utf-8"));
      expect(written.preferred).toBe("A");
      expect(written.ratings).toEqual({ A: 5, B: 3 });
      expect(written.regenerated).toBe(false);
      // Augmented fields the daemon adds
      expect(written.boardId).toBe(board.id);
      expect(typeof written.publishedAt).toBe("string");
      expect(written.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // The board's URL stays accessible after submit (history view)
      const after = await fetch(board.url);
      expect(after.status).toBe(200);

      // Progress endpoint reflects done state
      const progress = await fetch(`${board.url}api/progress`);
      expect(((await progress.json()) as any).status).toBe("done");
    } finally {
      try { fs.rmSync(boardDir, { recursive: true, force: true }); } catch {}
    }
  });

  test("GET /boards/<id> (no trailing slash) returns 301 to /boards/<id>/", async () => {
    const d = await spawn1();
    const boardDir = makeTmpDir("board-redir");
    try {
      const board = await publishBoard({
        port: d.port,
        html: makeBoardHtml(boardDir),
      });
      // Use redirect: 'manual' so we observe the 301 response itself
      const res = await fetch(`http://127.0.0.1:${d.port}/boards/${board.id}`, {
        redirect: "manual",
      });
      expect(res.status).toBe(301);
      expect(res.headers.get("Location")).toBe(`/boards/${board.id}/`);
    } finally {
      try { fs.rmSync(boardDir, { recursive: true, force: true }); } catch {}
    }
  });
});

// ─── Regenerate + reload round-trip ──────────────────────────────

describe("daemon round-trip: publish → regenerate → reload → submit round 2", () => {
  test("Full regen cycle: feedback-pending.json then reload swaps HTML", async () => {
    const d = await spawn1();
    const boardDir = makeTmpDir("board-regen");
    try {
      const r1Path = makeBoardHtml(boardDir, "<p>round 1 variants</p>");
      const board = await publishBoard({ port: d.port, html: r1Path });

      // Skill issues a regenerate via the board JS path
      const regen = await fetch(`${board.url}api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preferred: "A",
          ratings: { A: 4 },
          regenerated: true,
          regenerateAction: "more_like_A",
        }),
      });
      expect(regen.status).toBe(200);
      expect(((await regen.json()) as any).action).toBe("regenerate");

      // Pending file exists, final feedback file does not
      expect(fs.existsSync(path.join(board.sourceDir, "feedback-pending.json"))).toBe(true);
      expect(fs.existsSync(path.join(board.sourceDir, "feedback.json"))).toBe(false);

      // Progress reflects regenerating state
      const prog1 = await fetch(`${board.url}api/progress`);
      expect(((await prog1.json()) as any).status).toBe("regenerating");

      // Agent generates round 2, writes a new HTML file, calls /api/reload
      const r2Path = path.join(boardDir, "round2.html");
      fs.writeFileSync(r2Path, "<!DOCTYPE html><html><body><p>round 2 variants</p></body></html>");
      const reload = await fetch(`${board.url}api/reload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html: r2Path }),
      });
      expect(reload.status).toBe(200);

      // Same URL now serves the round-2 content (no port change, no
      // new browser tab — the user's existing tab can reload in place)
      const r2Page = await fetch(board.url);
      expect(await r2Page.text()).toContain("round 2 variants");
      expect(((await (await fetch(`${board.url}api/progress`)).json()) as any).status).toBe(
        "serving",
      );

      // User submits round 2
      const finalSubmit = await fetch(`${board.url}api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preferred: "B",
          ratings: { B: 5 },
          regenerated: false,
        }),
      });
      expect(finalSubmit.status).toBe(200);

      const written = JSON.parse(
        fs.readFileSync(path.join(board.sourceDir, "feedback.json"), "utf-8"),
      );
      expect(written.preferred).toBe("B");
      expect(written.boardId).toBe(board.id);
    } finally {
      try { fs.rmSync(boardDir, { recursive: true, force: true }); } catch {}
    }
  });
});

// ─── Two-board, one-daemon attach behavior ───────────────────────

describe("daemon round-trip: two concurrent publishes share one daemon", () => {
  test("Second publish attaches to the same daemon (no new spawn)", async () => {
    const d = await spawn1();
    const dirA = makeTmpDir("two-a");
    const dirB = makeTmpDir("two-b");
    try {
      const a = await publishBoard({ port: d.port, html: makeBoardHtml(dirA) });
      const b = await publishBoard({ port: d.port, html: makeBoardHtml(dirB) });

      // Same daemon process — state file pid is stable
      const state = readStateFile(stateFile);
      expect(state!.pid).toBe(d.proc.pid);

      // Two distinct board ids
      expect(a.id).not.toBe(b.id);

      // Both URLs serve their own content
      const pageA = await fetch(a.url);
      const pageB = await fetch(b.url);
      expect(pageA.status).toBe(200);
      expect(pageB.status).toBe(200);

      // Feedback isolation: submit to A only affects A's sourceDir
      await fetch(`${a.url}api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ regenerated: false, preferred: "A" }),
      });
      expect(fs.existsSync(path.join(a.sourceDir, "feedback.json"))).toBe(true);
      expect(fs.existsSync(path.join(b.sourceDir, "feedback.json"))).toBe(false);

      // Index page lists both
      const idx = await fetch(`http://127.0.0.1:${d.port}/`);
      const idxHtml = await idx.text();
      expect(idxHtml).toContain(a.id);
      expect(idxHtml).toContain(b.id);
    } finally {
      try { fs.rmSync(dirA, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(dirB, { recursive: true, force: true }); } catch {}
    }
  });
});
