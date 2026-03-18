/**
 * Node-compatible server entry point for Windows.
 *
 * Bun's subprocess/WebSocket handling breaks Playwright on Windows.
 * This script runs the browse server under Node instead, providing
 * a Bun.serve() shim and importing the rest of the codebase.
 *
 * Usage: node --import tsx server-node.mjs
 */

import { createServer } from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Bun API Shim ──────────────────────────────────────────────
// Provide just enough Bun globals for the server code to work.
// Only used on Windows where we MUST run under Node for Playwright.
globalThis.Bun = {
  serve: null, // Replaced below with our own server implementation
  sleep: (ms) => new Promise(r => setTimeout(r, ms)),
  which: (name) => {
    // Validate input to prevent command injection via shell interpolation
    if (typeof name !== 'string' || !/^[\w.\-]+$/.test(name)) return null;
    const { execSync } = require('child_process');
    try {
      return execSync(`where ${name}`, { encoding: 'utf-8' }).trim().split('\n')[0];
    } catch { return null; }
  },
  stdin: process.stdin,
};

// ─── Import server modules (TypeScript via --experimental-strip-types) ──
const { BrowserManager } = await import('./browser-manager.ts');
const { handleReadCommand } = await import('./read-commands.ts');
const { handleWriteCommand } = await import('./write-commands.ts');
const { handleMetaCommand } = await import('./meta-commands.ts');
const { COMMAND_DESCRIPTIONS, READ_COMMANDS, WRITE_COMMANDS, META_COMMANDS } = await import('./commands.ts');
const { SNAPSHOT_FLAGS } = await import('./snapshot.ts');
const { resolveConfig, ensureStateDir, readVersionHash } = await import('./config.ts');
const { consoleBuffer, networkBuffer, dialogBuffer, addConsoleEntry, addNetworkEntry, addDialogEntry } = await import('./buffers.ts');

// ─── Config ─────────────────────────────────────────────────────
const config = resolveConfig();
ensureStateDir(config);

const AUTH_TOKEN = crypto.randomUUID();
const BROWSE_PORT = parseInt(process.env.BROWSE_PORT || '0', 10);
const IDLE_TIMEOUT_MS = parseInt(process.env.BROWSE_IDLE_TIMEOUT || '1800000', 10);

// ─── Help Text ──────────────────────────────────────────────────
function generateHelpText() {
  const groups = new Map();
  for (const [cmd, meta] of Object.entries(COMMAND_DESCRIPTIONS)) {
    const display = meta.usage || cmd;
    const list = groups.get(meta.category) || [];
    list.push(display);
    groups.set(meta.category, list);
  }
  const categoryOrder = ['Navigation', 'Reading', 'Interaction', 'Inspection', 'Visual', 'Snapshot', 'Meta', 'Tabs', 'Server'];
  const lines = ['gstack browse — headless browser for AI agents', '', 'Commands:'];
  for (const cat of categoryOrder) {
    const cmds = groups.get(cat);
    if (!cmds) continue;
    lines.push(`  ${(cat + ':').padEnd(15)}${cmds.join(', ')}`);
  }
  lines.push('');
  lines.push('Snapshot flags:');
  const flagPairs = [];
  for (const flag of SNAPSHOT_FLAGS) {
    const label = flag.valueHint ? `${flag.short} ${flag.valueHint}` : flag.short;
    flagPairs.push(`${label}  ${flag.long}`);
  }
  for (let i = 0; i < flagPairs.length; i += 2) {
    const left = flagPairs[i].padEnd(28);
    const right = flagPairs[i + 1] || '';
    lines.push(`  ${left}${right}`);
  }
  return lines.join('\n');
}

// ─── Buffers & Logging ──────────────────────────────────────────
const CONSOLE_LOG_PATH = config.consoleLog;
const NETWORK_LOG_PATH = config.networkLog;
const DIALOG_LOG_PATH = config.dialogLog;
let lastConsoleFlushed = 0;
let lastNetworkFlushed = 0;
let lastDialogFlushed = 0;
let flushInProgress = false;

async function flushBuffers() {
  if (flushInProgress) return;
  flushInProgress = true;
  try {
    const newConsoleCount = consoleBuffer.totalAdded - lastConsoleFlushed;
    if (newConsoleCount > 0) {
      const entries = consoleBuffer.last(Math.min(newConsoleCount, consoleBuffer.length));
      const lines = entries.map(e => `[${new Date(e.timestamp).toISOString()}] [${e.level}] ${e.text}`).join('\n') + '\n';
      fs.appendFileSync(CONSOLE_LOG_PATH, lines);
      lastConsoleFlushed = consoleBuffer.totalAdded;
    }
    const newNetworkCount = networkBuffer.totalAdded - lastNetworkFlushed;
    if (newNetworkCount > 0) {
      const entries = networkBuffer.last(Math.min(newNetworkCount, networkBuffer.length));
      const lines = entries.map(e => `[${new Date(e.timestamp).toISOString()}] ${e.method} ${e.url} → ${e.status || 'pending'} (${e.duration || '?'}ms, ${e.size || '?'}B)`).join('\n') + '\n';
      fs.appendFileSync(NETWORK_LOG_PATH, lines);
      lastNetworkFlushed = networkBuffer.totalAdded;
    }
    const newDialogCount = dialogBuffer.totalAdded - lastDialogFlushed;
    if (newDialogCount > 0) {
      const entries = dialogBuffer.last(Math.min(newDialogCount, dialogBuffer.length));
      const lines = entries.map(e => `[${new Date(e.timestamp).toISOString()}] [${e.type}] "${e.message}" → ${e.action}${e.response ? ` "${e.response}"` : ''}`).join('\n') + '\n';
      fs.appendFileSync(DIALOG_LOG_PATH, lines);
      lastDialogFlushed = dialogBuffer.totalAdded;
    }
  } catch {} finally { flushInProgress = false; }
}

const flushInterval = setInterval(flushBuffers, 1000);

// ─── Idle Timer ──────────────────────────────────────────────────
let lastActivity = Date.now();
function resetIdleTimer() { lastActivity = Date.now(); }
const idleCheckInterval = setInterval(() => {
  if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
    console.log(`[browse] Idle for ${IDLE_TIMEOUT_MS / 1000}s, shutting down`);
    shutdown();
  }
}, 60_000);

// ─── Browser & Server ────────────────────────────────────────────
const browserManager = new BrowserManager();
let isShuttingDown = false;

function wrapError(err) {
  const msg = err.message || String(err);
  if (err.name === 'TimeoutError' || msg.includes('Timeout') || msg.includes('timeout')) {
    if (msg.includes('locator.click') || msg.includes('locator.fill') || msg.includes('locator.hover')) {
      return 'Element not found or not interactable within timeout. Check your selector or run \'snapshot\' for fresh refs.';
    }
    if (msg.includes('page.goto') || msg.includes('Navigation')) {
      return 'Page navigation timed out. The URL may be unreachable or the page may be loading slowly.';
    }
    return `Operation timed out: ${msg.split('\n')[0]}`;
  }
  if (msg.includes('resolved to') && msg.includes('elements')) {
    return "Selector matched multiple elements. Be more specific or use @refs from 'snapshot'.";
  }
  return msg;
}

async function handleCommand(body) {
  const { command, args = [] } = body;
  if (!command) return { status: 400, body: JSON.stringify({ error: 'Missing "command" field' }) };

  try {
    let result;
    if (READ_COMMANDS.has(command)) result = await handleReadCommand(command, args, browserManager);
    else if (WRITE_COMMANDS.has(command)) result = await handleWriteCommand(command, args, browserManager);
    else if (META_COMMANDS.has(command)) result = await handleMetaCommand(command, args, browserManager, shutdown);
    else if (command === 'help') return { status: 200, body: generateHelpText() };
    else return { status: 400, body: JSON.stringify({ error: `Unknown command: ${command}`, hint: `Available: ${[...READ_COMMANDS, ...WRITE_COMMANDS, ...META_COMMANDS].sort().join(', ')}` }) };
    return { status: 200, body: result };
  } catch (err) {
    return { status: 500, body: JSON.stringify({ error: wrapError(err) }) };
  }
}

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[browse] Shutting down...');
  clearInterval(flushInterval);
  clearInterval(idleCheckInterval);
  await flushBuffers();
  await browserManager.close();
  try { fs.unlinkSync(config.stateFile); } catch {}
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('exit', () => {
  try { fs.unlinkSync(config.stateFile); } catch {}
});

// ─── Start ───────────────────────────────────────────────────────
async function start() {
  try { fs.unlinkSync(CONSOLE_LOG_PATH); } catch {}
  try { fs.unlinkSync(NETWORK_LOG_PATH); } catch {}
  try { fs.unlinkSync(DIALOG_LOG_PATH); } catch {}

  // Find port
  const MIN_PORT = 10000;
  const MAX_PORT = 60000;
  let port = BROWSE_PORT;
  if (!port) {
    for (let attempt = 0; attempt < 5; attempt++) {
      port = MIN_PORT + Math.floor(Math.random() * (MAX_PORT - MIN_PORT));
      try {
        await new Promise((resolve, reject) => {
          const test = createServer();
          test.listen(port, '127.0.0.1', () => { test.close(); resolve(); });
          test.on('error', reject);
        });
        break;
      } catch { port = 0; }
    }
    if (!port) throw new Error('No available port');
  }

  // Launch browser (Node's Playwright works on Windows)
  await browserManager.launch();

  const startTime = Date.now();
  const server = createServer(async (req, res) => {
    resetIdleTimer();
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    // Cookie picker — browser cookie import requires macOS Keychain, not supported on Windows
    if (url.pathname.startsWith('/cookie-picker')) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Browser cookie import is only supported on macOS' }));
      return;
    }

    // Health check
    if (url.pathname === '/health') {
      const healthy = await browserManager.isHealthy();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: healthy ? 'healthy' : 'unhealthy',
        uptime: Math.floor((Date.now() - startTime) / 1000),
        tabs: browserManager.getTabCount(),
        currentUrl: browserManager.getCurrentUrl(),
      }));
      return;
    }

    // Auth check
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    // Command handling
    if (url.pathname === '/command' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      const result = await handleCommand(parsed);
      const contentType = result.status === 200 ? 'text/plain' : 'application/json';
      res.writeHead(result.status, { 'Content-Type': contentType });
      res.end(result.body);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, '127.0.0.1', () => {
    // Write state file
    const state = {
      pid: process.pid,
      port,
      token: AUTH_TOKEN,
      startedAt: new Date().toISOString(),
      serverPath: path.resolve(__dirname, 'server.ts'),
      binaryVersion: readVersionHash() || undefined,
    };
    const tmpFile = config.stateFile + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmpFile, config.stateFile);

    browserManager.serverPort = port;
    console.log(`[browse] Server running on http://127.0.0.1:${port} (PID: ${process.pid})`);
    console.log(`[browse] State file: ${config.stateFile}`);
    console.log(`[browse] Idle timeout: ${IDLE_TIMEOUT_MS / 1000}s`);
  });
}

start().catch((err) => {
  console.error(`[browse] Failed to start: ${err.message}`);
  process.exit(1);
});
