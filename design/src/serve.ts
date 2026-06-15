/**
 * HTTP server for the design comparison board feedback loop.
 *
 * Legacy single-process path: spawned by `$D compare --serve --no-daemon`.
 * The daemon (`design/src/daemon.ts`) handles default invocations and hosts
 * multiple boards under `/boards/<id>/`; this file stays as the escape hatch
 * for tests and debugging. Board JS uses relative URLs and a
 * location.protocol feature-detect, so the same generated HTML works at
 * both `/` (here) and `/boards/<id>/` (daemon).
 *
 * The server:
 * 1. Serves the comparison board HTML over HTTP at `/`
 * 2. Prints feedback JSON to stdout (agent reads it)
 * 3. Stays alive across regeneration rounds (stateful)
 * 4. Auto-opens in the user's default browser
 *
 * State machine:
 *
 *   SERVING ──(POST submit)──► DONE ──► exit 0
 *      │
 *      ├──(POST regenerate/remix)──► REGENERATING
 *      │                                  │
 *      │                          (POST /api/reload)
 *      │                                  │
 *      │                                  ▼
 *      │                             RELOADING ──► SERVING
 *      │
 *      └──(timeout)──► exit 1
 *
 * Feedback delivery (two channels, both always active):
 *   Stdout: feedback JSON (one line per event) — for foreground mode
 *   Disk:   feedback-pending.json (regenerate/remix) or feedback.json (submit)
 *           written next to the HTML file — for background mode polling
 *
 * The agent typically backgrounds $D serve and polls for feedback-pending.json.
 * When found: read it, delete it, generate new variants, POST /api/reload.
 *
 * Stderr: structured telemetry (SERVE_STARTED, SERVE_FEEDBACK_RECEIVED, etc.)
 */

import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";

export interface ServeOptions {
  html: string;
  port?: number;
  hostname?: string; // default '127.0.0.1' — localhost only
  timeout?: number; // seconds, default 600 (10 min)
}

type ServerState = "serving" | "regenerating" | "done";

export async function serve(options: ServeOptions): Promise<void> {
  const { html, port = 0, hostname = "127.0.0.1", timeout = 600 } = options;

  // Validate HTML file exists
  if (!fs.existsSync(html)) {
    console.error(`SERVE_ERROR: HTML file not found: ${html}`);
    process.exit(1);
  }

  // Security: anchor all file reads to the initial HTML's directory.
  // Prevents /api/reload from reading arbitrary files via path traversal.
  const allowedDir = fs.realpathSync(path.dirname(path.resolve(html)));

  let htmlContent = fs.readFileSync(html, "utf-8");
  let state: ServerState = "serving";
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  const server = Bun.serve({
    port,
    hostname,
    fetch(req) {
      const url = new URL(req.url);

      // Serve the comparison board HTML. The board JS uses relative paths
      // (./api/feedback, ./api/progress) and a location.protocol
      // feature-detect, so no per-request injection is needed.
      if (
        req.method === "GET" &&
        (url.pathname === "/" || url.pathname === "/index.html")
      ) {
        return new Response(htmlContent, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // Progress polling endpoint (used by board during regeneration)
      if (req.method === "GET" && url.pathname === "/api/progress") {
        return Response.json({ status: state });
      }

      // Feedback submission from the board
      if (req.method === "POST" && url.pathname === "/api/feedback") {
        return handleFeedback(req);
      }

      // Reload endpoint (used by the agent to swap in new board HTML)
      if (req.method === "POST" && url.pathname === "/api/reload") {
        return handleReload(req);
      }

      return new Response("Not found", { status: 404 });
    },
  });

  const actualPort = server.port;
  const boardUrl = `http://127.0.0.1:${actualPort}`;

  console.error(`SERVE_STARTED: port=${actualPort} html=${html}`);

  // Auto-open in user's default browser
  openBrowser(boardUrl);

  // Set timeout
  timeoutTimer = setTimeout(() => {
    console.error(`SERVE_TIMEOUT: after=${timeout}s`);
    server.stop();
    process.exit(1);
  }, timeout * 1000);

  async function handleFeedback(req: Request): Promise<Response> {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Validate expected shape
    if (typeof body !== "object" || body === null) {
      return Response.json({ error: "Expected JSON object" }, { status: 400 });
    }

    const isSubmit = body.regenerated === false;
    const isRegenerate = body.regenerated === true;
    const action = isSubmit
      ? "submitted"
      : body.regenerateAction || "regenerate";

    console.error(`SERVE_FEEDBACK_RECEIVED: type=${action}`);

    // Print feedback JSON to stdout (for foreground mode)
    console.log(JSON.stringify(body));

    // ALWAYS write feedback to disk so the agent can poll for it
    // (agent typically backgrounds $D serve, can't read stdout)
    const feedbackDir = path.dirname(html);
    const feedbackFile = isSubmit ? "feedback.json" : "feedback-pending.json";
    const feedbackPath = path.join(feedbackDir, feedbackFile);
    fs.writeFileSync(feedbackPath, JSON.stringify(body, null, 2));

    if (isSubmit) {
      state = "done";
      if (timeoutTimer) clearTimeout(timeoutTimer);

      // Give the response time to send before exiting
      setTimeout(() => {
        server.stop();
        process.exit(0);
      }, 100);

      return Response.json({ received: true, action: "submitted" });
    }

    if (isRegenerate) {
      state = "regenerating";
      // Reset timeout for regeneration (agent needs time to generate new variants)
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timeoutTimer = setTimeout(() => {
        console.error(`SERVE_TIMEOUT: after=${timeout}s (during regeneration)`);
        server.stop();
        process.exit(1);
      }, timeout * 1000);

      return Response.json({ received: true, action: "regenerate" });
    }

    return Response.json({ received: true, action: "unknown" });
  }

  async function handleReload(req: Request): Promise<Response> {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const newHtmlPath = body.html;
    if (!newHtmlPath || !fs.existsSync(newHtmlPath)) {
      return Response.json(
        { error: `HTML file not found: ${newHtmlPath}` },
        { status: 400 },
      );
    }

    // Security: resolve symlinks and validate the reload path is a FILE
    // inside the allowed directory (anchored to the initial HTML file's
    // parent). Prevents path traversal via /api/reload reading arbitrary
    // files. A path resolving to the allowedDir itself (a directory) used
    // to pass the guard and then crash readFileSync with EISDIR — reject
    // it explicitly with a clear 400 instead.
    const resolvedReload = fs.realpathSync(path.resolve(newHtmlPath));
    if (!resolvedReload.startsWith(allowedDir + path.sep)) {
      return Response.json(
        { error: `Path must be within: ${allowedDir}` },
        { status: 403 },
      );
    }
    if (!fs.statSync(resolvedReload).isFile()) {
      return Response.json(
        { error: `Path must be a file, not a directory: ${newHtmlPath}` },
        { status: 400 },
      );
    }

    // Swap the HTML content
    htmlContent = fs.readFileSync(resolvedReload, "utf-8");
    state = "serving";

    console.error(`SERVE_RELOADED: html=${newHtmlPath}`);

    // Reset timeout
    if (timeoutTimer) clearTimeout(timeoutTimer);
    timeoutTimer = setTimeout(() => {
      console.error(`SERVE_TIMEOUT: after=${timeout}s`);
      server.stop();
      process.exit(1);
    }, timeout * 1000);

    return Response.json({ reloaded: true });
  }

  // Keep the process alive
  await new Promise(() => {});
}

/**
 * Open a URL in the user's default browser.
 * Handles macOS (open), Linux (xdg-open), and headless environments.
 */
function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;

  if (platform === "darwin") {
    cmd = "open";
  } else if (platform === "linux") {
    cmd = "xdg-open";
  } else {
    // Windows or unknown — just print the URL
    console.error(`SERVE_BROWSER_MANUAL: url=${url}`);
    console.error(`Open this URL in your browser: ${url}`);
    return;
  }

  try {
    const child = spawn(cmd, [url], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    console.error(`SERVE_BROWSER_OPENED: url=${url}`);
  } catch {
    // open/xdg-open not available (headless CI environment)
    console.error(`SERVE_BROWSER_MANUAL: url=${url}`);
    console.error(`Open this URL in your browser: ${url}`);
  }
}
