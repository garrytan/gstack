/**
 * browse-mobile HTTP server
 *
 * Same protocol as browse/src/server.ts but backed by MobileDriver (Appium)
 * instead of BrowserManager (Playwright).
 */

import { MobileDriver, type MobileDriverOptions } from "./mobile-driver";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// ─── Configuration ───

const TOKEN = crypto.randomUUID();
const STATE_FILE = process.env.BROWSE_MOBILE_STATE_FILE || ".gstack/browse-mobile.json";
const IDLE_TIMEOUT_MS = parseInt(process.env.BROWSE_MOBILE_IDLE_TIMEOUT || "1800000", 10); // 30 min

// ─── State ───

let mobileDriver: MobileDriver | null = null;
let lastActivity = Date.now();
let idleTimer: ReturnType<typeof setInterval> | null = null;
let commandQueue: Promise<unknown> = Promise.resolve();

// ─── Supported Commands ───

const READ_COMMANDS = new Set([
  "text", "links", "forms", "snapshot",
]);

const WRITE_COMMANDS = new Set([
  "goto", "click", "tap", "fill", "scroll", "back", "viewport",
  "dialog-accept", "dialog-dismiss",
]);

const META_COMMANDS = new Set([
  "screenshot", "status", "stop",
]);

const UNSUPPORTED_COMMANDS = new Set([
  "html", "css", "attrs", "js", "eval", "accessibility",
  "console", "network", "cookies", "storage", "perf", "dialog", "is",
  "forward", "reload", "select", "hover", "type", "press", "wait",
  "cookie", "cookie-import", "cookie-import-browser",
  "header", "useragent", "upload",
  "tabs", "tab", "newtab", "closetab",
  "pdf", "responsive", "chain", "diff", "url",
  "handoff", "resume",
]);

// ─── Command Handler ───

async function handleCommand(
  command: string,
  args: string[]
): Promise<string> {
  if (!mobileDriver) {
    throw new Error("MobileDriver not initialized");
  }

  // Auto-reconnect if initial connection failed or session died
  if (!mobileDriver.isConnected) {
    console.error("[browse-mobile] Not connected — attempting to connect to Appium...");
    await mobileDriver.connect();
    console.error("[browse-mobile] Connected to Appium (reconnect)");
  }

  if (UNSUPPORTED_COMMANDS.has(command)) {
    return JSON.stringify({
      error: "not_supported",
      message: `Command '${command}' is not supported in mobile mode.`,
      supported: false,
    });
  }

  switch (command) {
    // ─── Read Commands ───
    case "text":
      return mobileDriver.text();

    case "links":
      return mobileDriver.links();

    case "forms":
      return mobileDriver.forms();

    case "snapshot":
      return mobileDriver.snapshot(args);

    // ─── Write Commands ───
    case "goto":
      if (args.length === 0) throw new Error("goto requires a target (e.g., app://com.example.app)");
      return mobileDriver.goto(args[0]);

    case "click":
      if (args.length === 0) throw new Error("click requires a ref (e.g., @e1) or label:Text");
      return mobileDriver.click(args[0]);

    case "tap": {
      if (args.length < 2) throw new Error("tap requires x y coordinates (e.g., tap 195 750)");
      const tapX = parseInt(args[0], 10);
      const tapY = parseInt(args[1], 10);
      if (isNaN(tapX) || isNaN(tapY)) throw new Error(`Invalid coordinates: "${args[0]}" "${args[1]}" — must be numbers`);
      return mobileDriver.tapCoordinates(tapX, tapY);
    }

    case "fill":
      if (args.length < 2) throw new Error("fill requires a ref and text (e.g., @e1 \"hello\")");
      return mobileDriver.fill(args[0], args.slice(1).join(" "));

    case "scroll":
      return mobileDriver.scroll(args[0] || "down");

    case "back":
      return mobileDriver.back();

    case "viewport":
      if (args.length === 0) throw new Error("viewport requires a size (e.g., landscape, portrait)");
      return mobileDriver.viewport(args[0]);

    case "dialog-accept":
      return mobileDriver.dialogAccept();

    case "dialog-dismiss":
      return mobileDriver.dialogDismiss();

    // ─── Meta Commands ───
    case "screenshot": {
      const outputPath = args[0] || "/tmp/browse-mobile-screenshot.png";
      return mobileDriver.screenshot(outputPath);
    }

    case "status":
      return JSON.stringify({
        connected: mobileDriver.isConnected,
        refs: mobileDriver.getRefCount(),
        uptime: Math.floor((Date.now() - startTime) / 1000),
      });

    case "stop":
      await shutdown();
      return "Server stopped";

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

// ─── HTTP Server ───

const startTime = Date.now();

async function findAvailablePort(): Promise<number> {
  const explicit = process.env.BROWSE_MOBILE_PORT;
  if (explicit) return parseInt(explicit, 10);

  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 10000 + Math.floor(Math.random() * 50000);
    try {
      const test = Bun.serve({ port, fetch: () => new Response("ok") });
      test.stop(true);
      return port;
    } catch {
      continue;
    }
  }
  throw new Error("Could not find available port after 5 attempts");
}

async function shutdown(): Promise<void> {
  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }

  if (mobileDriver) {
    try {
      await mobileDriver.disconnect();
    } catch {
      // Best effort
    }
    mobileDriver = null;
  }

  // Remove state file
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    // May not exist
  }

  process.exit(0);
}

async function startServer(): Promise<void> {
  const port = await findAvailablePort();

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      // Health check — no auth required
      if (url.pathname === "/health") {
        const healthy = mobileDriver ? await mobileDriver.isHealthy() : false;
        return Response.json({
          status: healthy ? "healthy" : "unhealthy",
          uptime: Math.floor((Date.now() - startTime) / 1000),
          refs: mobileDriver?.getRefCount() || 0,
        });
      }

      // All other routes require auth
      const auth = req.headers.get("Authorization");
      if (auth !== `Bearer ${TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      if (url.pathname === "/command" && req.method === "POST") {
        lastActivity = Date.now();

        try {
          const body = (await req.json()) as {
            command: string;
            args: string[];
          };
          const { command, args = [] } = body;

          // Sequential command execution via queue
          const result = await new Promise<string>((resolve, reject) => {
            commandQueue = commandQueue
              .then(() => handleCommand(command, args))
              .then(resolve)
              .catch(reject);
          });

          return new Response(result, {
            headers: { "Content-Type": "text/plain" },
          });
        } catch (err) {
          const message =
            err instanceof Error ? err.message : String(err);
          return Response.json(
            { error: message, hint: getErrorHint(message) },
            { status: 500 }
          );
        }
      }

      return new Response("Not found", { status: 404 });
    },
  });

  // Write state file atomically
  const stateDir = path.dirname(STATE_FILE);
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  const state = {
    pid: process.pid,
    port,
    token: TOKEN,
    startedAt: new Date().toISOString(),
    serverPath: import.meta.path,
  };

  const tmpFile = STATE_FILE + ".tmp";
  fs.writeFileSync(tmpFile, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmpFile, STATE_FILE);

  // Idle timeout check
  idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
      console.error("[browse-mobile] Idle timeout — shutting down");
      shutdown();
    }
  }, 60000);

  // Graceful shutdown
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.error(
    `[browse-mobile] Server running on port ${port} (pid ${process.pid})`
  );
}

function getErrorHint(message: string): string | undefined {
  if (message.includes("not connected") || message.includes("session")) {
    return "Appium session may have died. Try: $BM goto app://your.bundle.id";
  }
  if (message.includes("no longer exists")) {
    return "Element was on a previous screen. Run: $BM snapshot -i to see current elements.";
  }
  if (message.includes("Disk may be full")) {
    return "Check available disk space with: df -h";
  }
  return undefined;
}

// ─── Initialize ───

async function init(): Promise<void> {
  // Parse bundle ID from environment (set by CLI) or command line args (skip --server flag)
  const cliArgs = process.argv.slice(2).filter(a => a !== "--server");
  const bundleId =
    process.env.BROWSE_MOBILE_BUNDLE_ID || cliArgs[0] || "";

  if (!bundleId) {
    console.error(
      "[browse-mobile] Warning: No bundle ID provided. Set BROWSE_MOBILE_BUNDLE_ID or pass as argument."
    );
  }

  const options: MobileDriverOptions = {
    bundleId,
    appPath: process.env.BROWSE_MOBILE_APP_PATH,
    deviceName: process.env.BROWSE_MOBILE_DEVICE_NAME,
    platformVersion: process.env.BROWSE_MOBILE_PLATFORM_VERSION,
  };

  mobileDriver = new MobileDriver(options);

  // Start HTTP server first (so CLI knows we're alive)
  await startServer();

  // Then connect to Appium (this may take 10-30s)
  try {
    await mobileDriver.connect();
    console.error("[browse-mobile] Connected to Appium");
  } catch (err) {
    console.error(
      `[browse-mobile] Failed to connect to Appium: ${err instanceof Error ? err.message : String(err)}`
    );
    console.error(
      "[browse-mobile] Server is running — Appium connection will be retried on first command"
    );
  }
}

init().catch((err) => {
  console.error(`[browse-mobile] Fatal error: ${err}`);
  process.exit(1);
});
