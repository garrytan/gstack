/**
 * Persistent design board daemon.
 *
 * One process hosts many boards under /boards/<id>/. Spawned by
 * daemon-client.ts when no live daemon is found on the project's discovery
 * file (.gstack/design.json). Replaces the per-invocation server in
 * serve.ts as the default for `$D compare --serve`; serve.ts is kept as
 * the --no-daemon legacy/test path.
 *
 * Endpoints (see plan docs/designs path for full table):
 *   GET  /                              index of boards
 *   GET  /health                        liveness + version (unauth)
 *   POST /api/boards                    publish a new board
 *   POST /shutdown                      graceful exit (refused if active)
 *   GET  /boards/<id>                   301 → /boards/<id>/
 *   GET  /boards/<id>/                  render board HTML
 *   GET  /boards/<id>/api/progress      state machine status
 *   POST /boards/<id>/api/feedback      submit/regenerate
 *   POST /boards/<id>/api/reload        swap board HTML
 *
 * Lifecycle:
 *   start → bind 127.0.0.1:N → write state file → serve until 24h idle or
 *   explicit /shutdown → remove state file → exit 0
 *
 * The daemon refuses /shutdown when boards are non-done; the idle timer
 * extends rather than killing in that case (up to a 28h hard ceiling).
 * Both are Codex-flagged guards against silent loss of in-memory history.
 */

import fs from "fs";
import path from "path";

import {
  CMDLINE_MARKER,
  DaemonState,
  readVersionString,
  removeStateFile,
  resolveDaemonLogPath,
  writeStateFile,
} from "./daemon-state";

// ─── Tunables (env overrides for tests) ──────────────────────────

const DEFAULT_IDLE_MS = 24 * 60 * 60 * 1000; // 24h
const IDLE_MS = parseInt(
  process.env.DESIGN_DAEMON_IDLE_MS || String(DEFAULT_IDLE_MS),
  10,
);
const IDLE_EXTENSION_MS = parseInt(
  process.env.DESIGN_DAEMON_EXTENSION_MS || String(60 * 60 * 1000), // 1h
  10,
);
const MAX_EXTENSIONS = parseInt(process.env.DESIGN_DAEMON_MAX_EXTENSIONS || "4", 10);
const IDLE_CHECK_INTERVAL_MS = parseInt(
  process.env.DESIGN_DAEMON_CHECK_MS || "60000",
  10,
);
const MAX_BOARDS = parseInt(process.env.DESIGN_DAEMON_MAX_BOARDS || "50", 10);

const VERSION = readVersionString();

// ─── Per-board state ─────────────────────────────────────────────

export type BoardState = "serving" | "regenerating" | "done";

export interface Board {
  id: string;
  htmlContent: string;
  sourceDir: string; // realpath of the dir feedback files write to
  allowedDir: string; // realpath anchor for path-traversal guard
  state: BoardState;
  publishedAt: number;
  lastTouched: number;
  publisherPid: number;
  title?: string;
}

// In-memory: keyed by board id.
const boards = new Map<string, Board>();
// Per-board mutex chain — serializes feedback POST vs reload POST on the
// same board so the daemon doesn't race a state mutation against an HTML swap.
const boardMutex = new Map<string, Promise<void>>();

let lastMeaningfulActivity = Date.now();
let idleExtensions = 0;
let shuttingDown = false;
let serverRef: ReturnType<typeof Bun.serve> | null = null;
let idleInterval: ReturnType<typeof setInterval> | null = null;
const startTime = Date.now();
const daemonLog = openDaemonLog();

function openDaemonLog(): fs.WriteStream | null {
  try {
    const p = resolveDaemonLogPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    return fs.createWriteStream(p, { flags: "a" });
  } catch {
    return null;
  }
}

function dlog(...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(" ")}\n`;
  if (daemonLog) daemonLog.write(line);
  process.stderr.write(line);
}

// ─── Helpers ─────────────────────────────────────────────────────

function newBoardId(): string {
  const now = new Date();
  const y = now.getUTCFullYear().toString().padStart(4, "0");
  const mo = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = now.getUTCDate().toString().padStart(2, "0");
  const hh = now.getUTCHours().toString().padStart(2, "0");
  const mm = now.getUTCMinutes().toString().padStart(2, "0");
  const ss = now.getUTCSeconds().toString().padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `b-${y}${mo}${d}-${hh}${mm}${ss}-${rand}`;
}

async function withBoardMutex<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = boardMutex.get(id) || Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  boardMutex.set(id, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (boardMutex.get(id) === next) boardMutex.delete(id);
  }
}

function markMeaningfulActivity(): void {
  lastMeaningfulActivity = Date.now();
  idleExtensions = 0;
}

function nonDoneCount(): number {
  let n = 0;
  for (const b of boards.values()) if (b.state !== "done") n += 1;
  return n;
}

function hasActiveBoards(): boolean {
  return nonDoneCount() > 0;
}

// LRU eviction. Prefers `done` boards as victims so an active regen doesn't
// vanish mid-flight. Returns the evicted id, or null when the map fits.
function evictOne(): string | null {
  if (boards.size <= MAX_BOARDS) return null;
  let oldestDone: Board | null = null;
  let oldestAny: Board | null = null;
  for (const b of boards.values()) {
    if (b.state === "done") {
      if (!oldestDone || b.lastTouched < oldestDone.lastTouched) oldestDone = b;
    }
    if (!oldestAny || b.lastTouched < oldestAny.lastTouched) oldestAny = b;
  }
  const victim = oldestDone || oldestAny;
  if (!victim) return null;
  boards.delete(victim.id);
  boardMutex.delete(victim.id);
  dlog(`evicted board ${victim.id} state=${victim.state}`);
  return victim.id;
}

function evictUntilUnderCap(): void {
  while (boards.size > MAX_BOARDS) {
    if (!evictOne()) break;
  }
}

function findActiveBoardForSourceDir(sourceDir: string): Board | null {
  for (const b of boards.values()) {
    if (b.sourceDir === sourceDir && b.state !== "done") return b;
  }
  return null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}

// ─── Shutdown ─────────────────────────────────────────────────────

async function gracefulShutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  dlog(`shutting down boards=${boards.size} code=${exitCode}`);
  if (idleInterval) clearInterval(idleInterval);
  try {
    serverRef?.stop();
  } catch {
    // already stopped
  }
  removeStateFile();
  if (daemonLog) daemonLog.end();
  setTimeout(() => process.exit(exitCode), 50);
}

export function idleCheckTick(): void {
  if (shuttingDown) return;
  const idle = Date.now() - lastMeaningfulActivity;
  if (idle < IDLE_MS) return;
  if (hasActiveBoards()) {
    if (idleExtensions >= MAX_EXTENSIONS) {
      dlog(`idle past hard ceiling with ${nonDoneCount()} active boards — forcing shutdown`);
      gracefulShutdown(0);
      return;
    }
    idleExtensions += 1;
    // Push lastMeaningfulActivity forward by an extension window without
    // marking real activity (so the count stays correct).
    lastMeaningfulActivity = Date.now() - IDLE_MS + IDLE_EXTENSION_MS;
    dlog(
      `idle with ${nonDoneCount()} active boards — extending ${IDLE_EXTENSION_MS / 60000}min (${idleExtensions}/${MAX_EXTENSIONS})`,
    );
    return;
  }
  dlog(`idle for ${Math.floor(idle / 1000)}s — shutting down`);
  gracefulShutdown(0);
}

// ─── Handlers ─────────────────────────────────────────────────────

function handleHealth(): Response {
  return Response.json({
    ok: true,
    version: VERSION,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    boards: boards.size,
    activeBoards: nonDoneCount(),
  });
}

function handleIndex(): Response {
  const sorted = [...boards.values()].sort((a, b) => b.publishedAt - a.publishedAt);
  const rows = sorted
    .map((b) => {
      const ts = new Date(b.publishedAt).toISOString();
      const titleSuffix = b.title ? ` — ${escapeHtml(b.title)}` : "";
      return `<li><a href="/boards/${b.id}/">${b.id}</a> <span class="state state-${b.state}">${b.state}</span> <time>${ts}</time>${titleSuffix}</li>`;
    })
    .join("\n");
  const empty = `<p class="empty">No boards yet. Run <code>$D compare --serve</code> to publish one.</p>`;
  const list = sorted.length === 0 ? empty : `<ul>\n${rows}\n</ul>`;
  const html = `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><title>gstack design boards</title><style>
  body{font:14px/1.5 -apple-system,system-ui,sans-serif;max-width:720px;margin:32px auto;padding:0 16px;color:#1a1a1a}
  h1{font-size:20px;margin-bottom:4px}
  .meta{color:#666;margin-bottom:24px;font-size:13px}
  ul{padding:0;list-style:none}
  li{padding:10px 0;border-bottom:1px solid #eee;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  a{color:#0070f3;text-decoration:none;font-family:ui-monospace,monospace}
  a:hover{text-decoration:underline}
  .state{font-size:11px;padding:2px 8px;border-radius:10px;background:#eef;color:#335}
  .state-done{background:#efe;color:#353}
  .state-regenerating{background:#ffe;color:#553}
  time{color:#888;font-size:12px}
  .empty{color:#888;font-style:italic}
  code{font-family:ui-monospace,monospace;background:#f5f5f5;padding:2px 6px;border-radius:3px}
</style></head><body>
<h1>gstack design boards</h1>
<p class="meta">daemon up ${Math.floor((Date.now() - startTime) / 1000)}s · ${boards.size} board(s) · ${nonDoneCount()} active</p>
${list}
</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function handlePublish(req: Request, origin: string): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Expected JSON object" }, { status: 400 });
  }
  const htmlPath = typeof body.html === "string" ? body.html : "";
  if (!htmlPath) return Response.json({ error: "Missing 'html' field" }, { status: 400 });
  if (!fs.existsSync(htmlPath)) {
    return Response.json({ error: `HTML file not found: ${htmlPath}` }, { status: 400 });
  }
  let resolvedHtml: string;
  let sourceDir: string;
  try {
    resolvedHtml = fs.realpathSync(path.resolve(htmlPath));
    sourceDir = fs.realpathSync(path.dirname(resolvedHtml));
  } catch (e: any) {
    return Response.json({ error: `Cannot resolve path: ${e.message}` }, { status: 400 });
  }
  if (!fs.statSync(resolvedHtml).isFile()) {
    return Response.json(
      { error: `'html' must be a file, not a directory: ${htmlPath}` },
      { status: 400 },
    );
  }

  // sourceDir comes from realpath(html), not from the body — Codex finding:
  // body-supplied sourceDir is a local trust boundary the daemon shouldn't cross.
  const existing = findActiveBoardForSourceDir(sourceDir);
  if (existing) {
    return Response.json(
      {
        error: "Source directory already in use by an active board",
        existing: {
          id: existing.id,
          url: `${origin}/boards/${existing.id}/`,
          state: existing.state,
        },
      },
      { status: 409 },
    );
  }
  if (nonDoneCount() >= MAX_BOARDS) {
    return Response.json(
      {
        error: `Cannot publish: ${MAX_BOARDS} non-done boards already exist. Submit or close some first.`,
      },
      { status: 503 },
    );
  }

  const id = newBoardId();
  const htmlContent = fs.readFileSync(resolvedHtml, "utf-8");
  const now = Date.now();
  const board: Board = {
    id,
    htmlContent,
    sourceDir,
    allowedDir: sourceDir,
    state: "serving",
    publishedAt: now,
    lastTouched: now,
    publisherPid: typeof body.publisherPid === "number" ? body.publisherPid : 0,
    title: typeof body.title === "string" ? body.title : undefined,
  };
  boards.set(id, board);
  evictUntilUnderCap();
  markMeaningfulActivity();
  dlog(`published board ${id} sourceDir=${sourceDir} pid=${board.publisherPid}`);
  return Response.json({
    id,
    url: `${origin}/boards/${id}/`,
    sourceDir,
  });
}

function handleBoardGet(board: Board): Response {
  board.lastTouched = Date.now();
  // No __GSTACK_SERVER_URL injection — board JS uses relative URLs that
  // resolve against /boards/<id>/ (the trailing slash is load-bearing here;
  // the 301 from the bare /boards/<id> form ensures it).
  return new Response(board.htmlContent, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function handleBoardProgress(board: Board): Response {
  // NOT meaningful activity — bare progress polling shouldn't keep the
  // daemon alive forever (Codex finding on idle-immortality).
  board.lastTouched = Date.now();
  return Response.json({ status: board.state });
}

async function handleBoardFeedback(board: Board, req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Expected JSON object" }, { status: 400 });
  }
  const isSubmit = body.regenerated === false;
  const isRegen = body.regenerated === true;

  // Augment with boardId + publishedAt so multi-board agents can disambiguate
  // which board produced a given feedback.json.
  const augmented = {
    ...body,
    boardId: board.id,
    publishedAt: new Date(board.publishedAt).toISOString(),
  };

  const feedbackFile = isSubmit ? "feedback.json" : "feedback-pending.json";
  const feedbackPath = path.join(board.sourceDir, feedbackFile);
  try {
    fs.writeFileSync(feedbackPath, JSON.stringify(augmented, null, 2));
  } catch (e: any) {
    dlog(`feedback write failed for ${board.id}: ${e.message}`);
    return Response.json(
      { error: `Cannot write ${feedbackFile}: ${e.message}` },
      { status: 500 },
    );
  }

  board.lastTouched = Date.now();
  markMeaningfulActivity();

  if (isSubmit) {
    board.state = "done";
    dlog(`board ${board.id} submitted → ${feedbackPath}`);
    return Response.json({ received: true, action: "submitted" });
  }
  if (isRegen) {
    board.state = "regenerating";
    dlog(`board ${board.id} regenerate → ${feedbackPath}`);
    return Response.json({ received: true, action: "regenerate" });
  }
  return Response.json({ received: true, action: "unknown" });
}

async function handleBoardReload(board: Board, req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const newHtmlPath = typeof body?.html === "string" ? body.html : "";
  if (!newHtmlPath || !fs.existsSync(newHtmlPath)) {
    return Response.json({ error: `HTML file not found: ${newHtmlPath}` }, { status: 400 });
  }
  const resolvedReload = fs.realpathSync(path.resolve(newHtmlPath));
  if (!resolvedReload.startsWith(board.allowedDir + path.sep)) {
    return Response.json(
      { error: `Path must be within: ${board.allowedDir}` },
      { status: 403 },
    );
  }
  if (!fs.statSync(resolvedReload).isFile()) {
    return Response.json(
      { error: `Path must be a file, not a directory: ${newHtmlPath}` },
      { status: 400 },
    );
  }
  board.htmlContent = fs.readFileSync(resolvedReload, "utf-8");
  board.state = "serving";
  board.lastTouched = Date.now();
  markMeaningfulActivity();
  dlog(`board ${board.id} reloaded from ${resolvedReload}`);
  return Response.json({ reloaded: true });
}

function boardExpiredHtml(id: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Board expired — gstack</title>
<style>body{font:14px/1.5 -apple-system,system-ui,sans-serif;max-width:600px;margin:80px auto;padding:0 20px;color:#1a1a1a;text-align:center}
h1{font-size:20px}.id{font-family:ui-monospace,monospace;color:#888;font-size:13px}
a{color:#0070f3;text-decoration:none}a:hover{text-decoration:underline}</style></head><body>
<h1>Board expired</h1>
<p>Board <span class="id">${escapeHtml(id)}</span> is no longer hosted by this daemon (evicted or the daemon restarted).</p>
<p><a href="/">← see active boards</a></p>
</body></html>`;
}

// ─── Router ──────────────────────────────────────────────────────

const BOARD_RE = /^\/boards\/([A-Za-z0-9_-]+)(\/.*)?$/;

export async function fetchHandler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const origin = url.origin;

  if (req.method === "GET" && url.pathname === "/health") return handleHealth();
  if (req.method === "GET" && url.pathname === "/") return handleIndex();
  if (req.method === "POST" && url.pathname === "/api/boards") return handlePublish(req, origin);

  if (req.method === "POST" && url.pathname === "/shutdown") {
    if (hasActiveBoards()) {
      return Response.json(
        {
          error: "Refusing /shutdown: daemon has active boards. Submit or close them first.",
          activeBoards: nonDoneCount(),
        },
        { status: 409 },
      );
    }
    setTimeout(() => gracefulShutdown(0), 50);
    return Response.json({ shuttingDown: true });
  }

  const m = url.pathname.match(BOARD_RE);
  if (m) {
    const id = m[1]!;
    const subpath = m[2] || "";
    const board = boards.get(id);
    if (!board) {
      return new Response(boardExpiredHtml(id), {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    // Bare /boards/<id> → 301 to /boards/<id>/ so relative URLs in board JS
    // resolve against the right base (./api/feedback → /boards/<id>/api/feedback).
    if (req.method === "GET" && subpath === "") {
      return new Response(null, {
        status: 301,
        headers: { Location: `/boards/${id}/` },
      });
    }
    if (req.method === "GET" && subpath === "/") return handleBoardGet(board);
    if (req.method === "GET" && subpath === "/api/progress") return handleBoardProgress(board);
    if (req.method === "POST" && subpath === "/api/feedback") {
      return withBoardMutex(id, () => handleBoardFeedback(board, req));
    }
    if (req.method === "POST" && subpath === "/api/reload") {
      return withBoardMutex(id, () => handleBoardReload(board, req));
    }
  }

  return new Response("Not found", { status: 404 });
}

// ─── Startup ─────────────────────────────────────────────────────

export function start(): { port: number } {
  const portArg = process.env.DESIGN_DAEMON_PORT;
  const port = portArg ? parseInt(portArg, 10) : 0;
  serverRef = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: fetchHandler,
  });
  const actualPort = serverRef.port;
  const state: DaemonState = {
    pid: process.pid,
    port: actualPort,
    startedAt: new Date().toISOString(),
    version: VERSION,
    serverPath: process.argv[1] || "",
    cmdlineMarker: CMDLINE_MARKER,
  };
  writeStateFile(state);
  dlog(`DAEMON_STARTED port=${actualPort} pid=${process.pid} version=${VERSION}`);
  // Stdout line the spawning CLI parses to learn the port quickly.
  console.log(`DAEMON_STARTED port=${actualPort}`);

  idleInterval = setInterval(idleCheckTick, IDLE_CHECK_INTERVAL_MS);

  process.on("SIGTERM", () => {
    void gracefulShutdown(0);
  });
  process.on("SIGINT", () => {
    void gracefulShutdown(0);
  });
  process.on("uncaughtException", (e) => {
    dlog(`uncaughtException: ${(e as Error).stack || (e as Error).message}`);
    void gracefulShutdown(1);
  });

  return { port: actualPort };
}

if (import.meta.main) {
  start();
}

// Exported for tests. Keep this small and stable.
export const __testInternals__ = {
  boards,
  fetchHandler,
  idleCheckTick,
  markMeaningfulActivity,
  resetForTest: (): void => {
    boards.clear();
    boardMutex.clear();
    lastMeaningfulActivity = Date.now();
    idleExtensions = 0;
    shuttingDown = false;
  },
};
