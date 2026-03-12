/**
 * gstack browse server — persistent Chromium daemon
 *
 * Architecture:
 *   HTTP server on localhost → routes commands to Playwright
 *   Console/network buffers: in-memory (all entries) + disk flush every 1s
 *   Chromium crash → server EXITS with clear error (CLI auto-restarts)
 *   Auto-shutdown after BROWSE_IDLE_TIMEOUT (default 30 min)
 *
 * Runtime: works under both Bun and Node (uses node:http/node:net)
 */

import { BrowserManager } from './browser-manager';
import { handleReadCommand } from './read-commands';
import { handleWriteCommand } from './write-commands';
import { handleMetaCommand } from './meta-commands';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';

// ─── Auth (inline) ─────────────────────────────────────────────
const AUTH_TOKEN = crypto.randomUUID();
const PORT_OFFSET = 45600;
const BROWSE_PORT = process.env.CONDUCTOR_PORT
  ? parseInt(process.env.CONDUCTOR_PORT, 10) - PORT_OFFSET
  : parseInt(process.env.BROWSE_PORT || '0', 10); // 0 = auto-scan
const INSTANCE_SUFFIX = BROWSE_PORT ? `-${BROWSE_PORT}` : '';
const STATE_FILE = process.env.BROWSE_STATE_FILE || `/tmp/browse-server${INSTANCE_SUFFIX}.json`;
const IDLE_TIMEOUT_MS = parseInt(process.env.BROWSE_IDLE_TIMEOUT || '1800000', 10); // 30 min

// ─── Buffer (from buffers.ts) ────────────────────────────────────
import { consoleBuffer, networkBuffer, addConsoleEntry, addNetworkEntry, consoleTotalAdded, networkTotalAdded, type LogEntry, type NetworkEntry } from './buffers';
export { consoleBuffer, networkBuffer, addConsoleEntry, addNetworkEntry, type LogEntry, type NetworkEntry };
const CONSOLE_LOG_PATH = `/tmp/browse-console${INSTANCE_SUFFIX}.log`;
const NETWORK_LOG_PATH = `/tmp/browse-network${INSTANCE_SUFFIX}.log`;
let lastConsoleFlushed = 0;
let lastNetworkFlushed = 0;

function flushBuffers() {
  // Use totalAdded cursor (not buffer.length) because the ring buffer
  // stays pinned at HIGH_WATER_MARK after wrapping.
  const newConsoleCount = consoleTotalAdded - lastConsoleFlushed;
  if (newConsoleCount > 0) {
    const count = Math.min(newConsoleCount, consoleBuffer.length);
    const newEntries = consoleBuffer.slice(-count);
    const lines = newEntries.map(e =>
      `[${new Date(e.timestamp).toISOString()}] [${e.level}] ${e.text}`
    ).join('\n') + '\n';
    fs.appendFileSync(CONSOLE_LOG_PATH, lines);
    lastConsoleFlushed = consoleTotalAdded;
  }

  const newNetworkCount = networkTotalAdded - lastNetworkFlushed;
  if (newNetworkCount > 0) {
    const count = Math.min(newNetworkCount, networkBuffer.length);
    const newEntries = networkBuffer.slice(-count);
    const lines = newEntries.map(e =>
      `[${new Date(e.timestamp).toISOString()}] ${e.method} ${e.url} → ${e.status || 'pending'} (${e.duration || '?'}ms, ${e.size || '?'}B)`
    ).join('\n') + '\n';
    fs.appendFileSync(NETWORK_LOG_PATH, lines);
    lastNetworkFlushed = networkTotalAdded;
  }
}

// Flush every 1 second
const flushInterval = setInterval(flushBuffers, 1000);

// ─── Idle Timer ────────────────────────────────────────────────
let lastActivity = Date.now();

function resetIdleTimer() {
  lastActivity = Date.now();
}

const idleCheckInterval = setInterval(() => {
  if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
    console.log(`[browse] Idle for ${IDLE_TIMEOUT_MS / 1000}s, shutting down`);
    shutdown();
  }
}, 60_000);

// ─── Server ────────────────────────────────────────────────────
const browserManager = new BrowserManager();
let isShuttingDown = false;

// Read/write/meta command sets for routing
const READ_COMMANDS = new Set([
  'text', 'html', 'links', 'forms', 'accessibility',
  'js', 'eval', 'css', 'attrs',
  'console', 'network', 'cookies', 'storage', 'perf',
]);

const WRITE_COMMANDS = new Set([
  'goto', 'back', 'forward', 'reload',
  'click', 'fill', 'select', 'hover', 'type', 'press', 'scroll', 'wait',
  'viewport', 'cookie', 'header', 'useragent',
]);

const META_COMMANDS = new Set([
  'tabs', 'tab', 'newtab', 'closetab',
  'status', 'stop', 'restart',
  'screenshot', 'pdf', 'responsive',
  'chain', 'diff',
  'url', 'snapshot',
]);

// Check if a port is available using node:net (works in both Bun and Node)
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

// Find port: deterministic from CONDUCTOR_PORT, or scan range
async function findPort(): Promise<number> {
  // Deterministic port from CONDUCTOR_PORT (e.g., 55040 - 45600 = 9440)
  if (BROWSE_PORT) {
    if (await isPortAvailable(BROWSE_PORT)) {
      return BROWSE_PORT;
    }
    throw new Error(`[browse] Port ${BROWSE_PORT} (from CONDUCTOR_PORT ${process.env.CONDUCTOR_PORT}) is in use`);
  }

  // Fallback: scan range
  const start = parseInt(process.env.BROWSE_PORT_START || '9400', 10);
  for (let port = start; port < start + 10; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`[browse] No available port in range ${start}-${start + 9}`);
}

async function handleCommand(body: any): Promise<Response> {
  const { command, args = [] } = body;

  if (!command) {
    return new Response(JSON.stringify({ error: 'Missing "command" field' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    let result: string;

    if (READ_COMMANDS.has(command)) {
      result = await handleReadCommand(command, args, browserManager);
    } else if (WRITE_COMMANDS.has(command)) {
      result = await handleWriteCommand(command, args, browserManager);
    } else if (META_COMMANDS.has(command)) {
      result = await handleMetaCommand(command, args, browserManager, shutdown);
    } else {
      return new Response(JSON.stringify({
        error: `Unknown command: ${command}`,
        hint: `Available commands: ${[...READ_COMMANDS, ...WRITE_COMMANDS, ...META_COMMANDS].sort().join(', ')}`,
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(result, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log('[browse] Shutting down...');
  clearInterval(flushInterval);
  clearInterval(idleCheckInterval);
  flushBuffers(); // Final flush

  await browserManager.close();

  // Clean up state file
  try { fs.unlinkSync(STATE_FILE); } catch {}

  process.exit(0);
}

// Handle signals
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ─── Start ─────────────────────────────────────────────────────
async function start() {
  // Clear old log files
  try { fs.unlinkSync(CONSOLE_LOG_PATH); } catch {}
  try { fs.unlinkSync(NETWORK_LOG_PATH); } catch {}

  const port = await findPort();

  // Launch browser
  await browserManager.launch();

  const startTime = Date.now();

  // Collect full request body from node:http IncomingMessage
  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk: Buffer) => { data += chunk; });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }

  // Send a Response object through node:http ServerResponse
  async function sendResponse(res: ServerResponse, response: Response) {
    const body = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(response.status, headers);
    res.end(body);
  }

  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    resetIdleTimer();

    const url = new URL(req.url!, `http://127.0.0.1:${port}`);

    // Health check — no auth required
    if (url.pathname === '/health') {
      const healthy = browserManager.isHealthy();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: healthy ? 'healthy' : 'unhealthy',
        uptime: Math.floor((Date.now() - startTime) / 1000),
        tabs: browserManager.getTabCount(),
        currentUrl: browserManager.getCurrentUrl(),
      }));
      return;
    }

    // All other endpoints require auth
    if (req.headers['authorization'] !== `Bearer ${AUTH_TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (url.pathname === '/command' && req.method === 'POST') {
      const bodyStr = await readBody(req);
      const body = JSON.parse(bodyStr);
      const response = await handleCommand(body);
      await sendResponse(res, response);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve());
  });

  // Write state file
  const state = {
    pid: process.pid,
    port,
    token: AUTH_TOKEN,
    startedAt: new Date().toISOString(),
    serverPath: path.resolve(import.meta.dir ?? __dirname, 'server.ts'),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });

  console.log(`[browse] Server running on http://127.0.0.1:${port} (PID: ${process.pid})`);
  console.log(`[browse] State file: ${STATE_FILE}`);
  console.log(`[browse] Idle timeout: ${IDLE_TIMEOUT_MS / 1000}s`);
}

start().catch((err) => {
  console.error(`[browse] Failed to start: ${err.message}`);
  process.exit(1);
});
