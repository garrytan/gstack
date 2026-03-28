/**
 * gstack browse server — persistent Chromium daemon
 *
 * Architecture:
 *   Bun.serve HTTP on localhost → routes commands to Playwright
 *   Console/network/dialog buffers: CircularBuffer in-memory + async disk flush
 *   Chromium crash → server EXITS with clear error (CLI auto-restarts)
 *   Auto-shutdown after BROWSE_IDLE_TIMEOUT (default 30 min)
 *
 * State:
 *   State file: <project-root>/.gstack/browse.json (set via BROWSE_STATE_FILE env)
 *   Log files:  <project-root>/.gstack/browse-{console,network,dialog}.log
 *   Port:       random 10000-60000 (or BROWSE_PORT env for debug override)
 */

import { BrowserManager } from './browser-manager';
import { handleReadCommand } from './read-commands';
import { handleWriteCommand } from './write-commands';
import { handleMetaCommand } from './meta-commands';
import { handleCookiePickerRoute } from './cookie-picker-routes';
import { sanitizeExtensionUrl } from './sidebar-utils';
import { COMMAND_DESCRIPTIONS } from './commands';
import { handleSnapshot, SNAPSHOT_FLAGS } from './snapshot';
import { resolveConfig, ensureStateDir, readVersionHash } from './config';
import { emitActivity, subscribe, getActivityAfter, getActivityHistory, getSubscriberCount } from './activity';
// Bun.spawn used instead of child_process.spawn (compiled bun binaries
// fail posix_spawn on all executables including /bin/bash)
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as crypto from 'crypto';

// ─── Config ─────────────────────────────────────────────────────
const config = resolveConfig();
ensureStateDir(config);

// ─── Auth ───────────────────────────────────────────────────────
const AUTH_TOKEN = crypto.randomUUID();
const BROWSE_PORT = parseInt(process.env.BROWSE_PORT || '0', 10);
const IDLE_TIMEOUT_MS = parseInt(process.env.BROWSE_IDLE_TIMEOUT || '1800000', 10); // 30 min
// Sidebar chat is always enabled in headed mode (ungated in v0.12.0)

function validateAuth(req: Request): boolean {
  const header = req.headers.get('authorization');
  return header === `Bearer ${AUTH_TOKEN}`;
}

// ─── Help text (auto-generated from COMMAND_DESCRIPTIONS) ────────
function generateHelpText(): string {
  // Group commands by category
  const groups = new Map<string, string[]>();
  for (const [cmd, meta] of Object.entries(COMMAND_DESCRIPTIONS)) {
    const display = meta.usage || cmd;
    const list = groups.get(meta.category) || [];
    list.push(display);
    groups.set(meta.category, list);
  }

  const categoryOrder = [
    'Navigation', 'Reading', 'Interaction', 'Inspection',
    'Visual', 'Snapshot', 'Meta', 'Tabs', 'Server',
  ];

  const lines = ['gstack browse — headless browser for AI agents', '', 'Commands:'];
  for (const cat of categoryOrder) {
    const cmds = groups.get(cat);
    if (!cmds) continue;
    lines.push(`  ${(cat + ':').padEnd(15)}${cmds.join(', ')}`);
  }

  // Snapshot flags from source of truth
  lines.push('');
  lines.push('Snapshot flags:');
  const flagPairs: string[] = [];
  for (const flag of SNAPSHOT_FLAGS) {
    const label = flag.valueHint ? `${flag.short} ${flag.valueHint}` : flag.short;
    flagPairs.push(`${label}  ${flag.long}`);
  }
  // Print two flags per line for compact display
  for (let i = 0; i < flagPairs.length; i += 2) {
    const left = flagPairs[i].padEnd(28);
    const right = flagPairs[i + 1] || '';
    lines.push(`  ${left}${right}`);
  }

  return lines.join('\n');
}

// ─── Buffer (from buffers.ts) ────────────────────────────────────
import { consoleBuffer, networkBuffer, dialogBuffer, addConsoleEntry, addNetworkEntry, addDialogEntry, type LogEntry, type NetworkEntry, type DialogEntry } from './buffers';
export { consoleBuffer, networkBuffer, dialogBuffer, addConsoleEntry, addNetworkEntry, addDialogEntry, type LogEntry, type NetworkEntry, type DialogEntry };

const CONSOLE_LOG_PATH = config.consoleLog;
const NETWORK_LOG_PATH = config.networkLog;
const DIALOG_LOG_PATH = config.dialogLog;

// ─── Sidebar Agent (integrated — no separate process) ─────────────

interface ChatEntry {
  id: number;
  ts: string;
  role: 'user' | 'assistant' | 'agent';
  message?: string;
  type?: string;
  tool?: string;
  input?: string;
  text?: string;
  error?: string;
}

interface SidebarSession {
  id: string;
  name: string;
  claudeSessionId: string | null;
  worktreePath: string | null;
  createdAt: string;
  lastActiveAt: string;
}

const SESSIONS_DIR = path.join(process.env.HOME || '/tmp', '.gstack', 'sidebar-sessions');
const AGENT_TIMEOUT_MS = 300_000; // 5 minutes — multi-page tasks need time
const MAX_QUEUE = 5;

let sidebarSession: SidebarSession | null = null;
let agentProcess: ChildProcess | null = null;
let agentStatus: 'idle' | 'processing' | 'hung' = 'idle';
let agentStartTime: number | null = null;
let messageQueue: Array<{message: string, ts: string, extensionUrl?: string | null}> = [];
let currentMessage: string | null = null;
let chatBuffer: ChatEntry[] = [];
let chatNextId = 0;

// Find the browse binary for the claude subprocess system prompt
function findBrowseBin(): string {
  const candidates = [
    path.resolve(__dirname, '..', 'dist', 'browse'),
    path.resolve(__dirname, '..', '..', '.claude', 'skills', 'gstack', 'browse', 'dist', 'browse'),
    path.join(process.env.HOME || '', '.claude', 'skills', 'gstack', 'browse', 'dist', 'browse'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return 'browse'; // fallback to PATH
}

const BROWSE_BIN = findBrowseBin();

function findClaudeBin(): string | null {
  const home = process.env.HOME || '';
  const candidates = [
    // Conductor app bundled binary (not a symlink — works reliably)
    path.join(home, 'Library', 'Application Support', 'com.conductor.app', 'bin', 'claude'),
    // Direct versioned binary (not a symlink)
    ...(() => {
      try {
        const versionsDir = path.join(home, '.local', 'share', 'claude', 'versions');
        const entries = fs.readdirSync(versionsDir).filter(e => /^\d/.test(e)).sort().reverse();
        return entries.map(e => path.join(versionsDir, e));
      } catch { return []; }
    })(),
    // Standard install (symlink — resolve it)
    path.join(home, '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  // Also check if 'claude' is in current PATH
  try {
    const proc = Bun.spawnSync(['which', 'claude'], { stdout: 'pipe', stderr: 'pipe', timeout: 2000 });
    if (proc.exitCode === 0) {
      const p = proc.stdout.toString().trim();
      if (p) candidates.unshift(p);
    }
  } catch {}
  for (const c of candidates) {
    try {
      if (!fs.existsSync(c)) continue;
      // Resolve symlinks — posix_spawn can fail on symlinks in compiled bun binaries
      return fs.realpathSync(c);
    } catch {}
  }
  return null;
}

function shortenPath(str: string): string {
  return str
    .replace(new RegExp(BROWSE_BIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '$B')
    .replace(/\/Users\/[^/]+/g, '~')
    .replace(/\/conductor\/workspaces\/[^/]+\/[^/]+/g, '')
    .replace(/\.claude\/skills\/gstack\//g, '')
    .replace(/browse\/dist\/browse/g, '$B');
}

function summarizeToolInput(tool: string, input: any): string {
  if (!input) return '';
  if (tool === 'Bash' && input.command) {
    let cmd = shortenPath(input.command);
    return cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd;
  }
  if (tool === 'Read' && input.file_path) return shortenPath(input.file_path);
  if (tool === 'Edit' && input.file_path) return shortenPath(input.file_path);
  if (tool === 'Write' && input.file_path) return shortenPath(input.file_path);
  if (tool === 'Grep' && input.pattern) return `/${input.pattern}/`;
  if (tool === 'Glob' && input.pattern) return input.pattern;
  try { return shortenPath(JSON.stringify(input)).slice(0, 60); } catch { return ''; }
}

function addChatEntry(entry: Omit<ChatEntry, 'id'>): ChatEntry {
  const full: ChatEntry = { ...entry, id: chatNextId++ };
  chatBuffer.push(full);
  // Persist to disk (best-effort)
  if (sidebarSession) {
    const chatFile = path.join(SESSIONS_DIR, sidebarSession.id, 'chat.jsonl');
    try { fs.appendFileSync(chatFile, JSON.stringify(full) + '\n'); } catch {}
  }
  return full;
}

function loadSession(): SidebarSession | null {
  try {
    const activeFile = path.join(SESSIONS_DIR, 'active.json');
    const activeData = JSON.parse(fs.readFileSync(activeFile, 'utf-8'));
    const sessionFile = path.join(SESSIONS_DIR, activeData.id, 'session.json');
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf-8')) as SidebarSession;
    // Load chat history
    const chatFile = path.join(SESSIONS_DIR, session.id, 'chat.jsonl');
    try {
      const lines = fs.readFileSync(chatFile, 'utf-8').split('\n').filter(Boolean);
      chatBuffer = lines.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      chatNextId = chatBuffer.length > 0 ? Math.max(...chatBuffer.map(e => e.id)) + 1 : 0;
    } catch {}
    return session;
  } catch {
    return null;
  }
}

/**
 * Create a git worktree for session isolation.
 * Falls back to null (use main cwd) if:
 *  - not in a git repo
 *  - git worktree add fails (submodules, LFS, permissions)
 *  - worktree dir already exists (collision from prior crash)
 */
function createWorktree(sessionId: string): string | null {
  try {
    // Check if we're in a git repo
    const gitCheck = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
      stdout: 'pipe', stderr: 'pipe', timeout: 3000,
    });
    if (gitCheck.exitCode !== 0) return null;
    const repoRoot = gitCheck.stdout.toString().trim();

    const worktreeDir = path.join(process.env.HOME || '/tmp', '.gstack', 'worktrees', sessionId.slice(0, 8));

    // Clean up if dir exists from prior crash
    if (fs.existsSync(worktreeDir)) {
      Bun.spawnSync(['git', 'worktree', 'remove', '--force', worktreeDir], {
        cwd: repoRoot, stdout: 'pipe', stderr: 'pipe', timeout: 5000,
      });
      try { fs.rmSync(worktreeDir, { recursive: true, force: true }); } catch {}
    }

    // Get current branch/commit
    const headCheck = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe', timeout: 3000,
    });
    if (headCheck.exitCode !== 0) return null;
    const head = headCheck.stdout.toString().trim();

    // Create worktree (detached HEAD — no branch conflicts)
    const result = Bun.spawnSync(['git', 'worktree', 'add', '--detach', worktreeDir, head], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe', timeout: 10000,
    });

    if (result.exitCode !== 0) {
      console.log(`[browse] Worktree creation failed: ${result.stderr.toString().trim()}`);
      return null;
    }

    console.log(`[browse] Created worktree: ${worktreeDir}`);
    return worktreeDir;
  } catch (err: any) {
    console.log(`[browse] Worktree creation error: ${err.message}`);
    return null;
  }
}

function removeWorktree(worktreePath: string | null): void {
  if (!worktreePath) return;
  try {
    const gitCheck = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
      stdout: 'pipe', stderr: 'pipe', timeout: 3000,
    });
    if (gitCheck.exitCode === 0) {
      Bun.spawnSync(['git', 'worktree', 'remove', '--force', worktreePath], {
        cwd: gitCheck.stdout.toString().trim(), stdout: 'pipe', stderr: 'pipe', timeout: 5000,
      });
    }
    // Cleanup dir if git worktree remove didn't
    try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch {}
  } catch {}
}

function createSession(): SidebarSession {
  const id = crypto.randomUUID();
  const worktreePath = createWorktree(id);
  const session: SidebarSession = {
    id,
    name: 'Chrome sidebar',
    claudeSessionId: null,
    worktreePath,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  };
  const sessionDir = path.join(SESSIONS_DIR, id);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(session, null, 2));
  fs.writeFileSync(path.join(sessionDir, 'chat.jsonl'), '');
  fs.writeFileSync(path.join(SESSIONS_DIR, 'active.json'), JSON.stringify({ id }));
  chatBuffer = [];
  chatNextId = 0;
  return session;
}

function saveSession(): void {
  if (!sidebarSession) return;
  sidebarSession.lastActiveAt = new Date().toISOString();
  const sessionFile = path.join(SESSIONS_DIR, sidebarSession.id, 'session.json');
  try { fs.writeFileSync(sessionFile, JSON.stringify(sidebarSession, null, 2)); } catch {}
}

function listSessions(): Array<SidebarSession & { chatLines: number }> {
  try {
    const dirs = fs.readdirSync(SESSIONS_DIR).filter(d => d !== 'active.json');
    return dirs.map(d => {
      try {
        const session = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, d, 'session.json'), 'utf-8'));
        let chatLines = 0;
        try { chatLines = fs.readFileSync(path.join(SESSIONS_DIR, d, 'chat.jsonl'), 'utf-8').split('\n').filter(Boolean).length; } catch {}
        return { ...session, chatLines };
      } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function processAgentEvent(event: any): void {
  if (event.type === 'system' && event.session_id && sidebarSession && !sidebarSession.claudeSessionId) {
    // Capture session_id from first claude init event for --resume
    sidebarSession.claudeSessionId = event.session_id;
    saveSession();
  }

  if (event.type === 'assistant' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'tool_use') {
        addChatEntry({ ts: new Date().toISOString(), role: 'agent', type: 'tool_use', tool: block.name, input: summarizeToolInput(block.name, block.input) });
      } else if (block.type === 'text' && block.text) {
        addChatEntry({ ts: new Date().toISOString(), role: 'agent', type: 'text', text: block.text });
      }
    }
  }

  if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
    addChatEntry({ ts: new Date().toISOString(), role: 'agent', type: 'tool_use', tool: event.content_block.name, input: summarizeToolInput(event.content_block.name, event.content_block.input) });
  }

  if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
    addChatEntry({ ts: new Date().toISOString(), role: 'agent', type: 'text_delta', text: event.delta.text });
  }

  if (event.type === 'result') {
    addChatEntry({ ts: new Date().toISOString(), role: 'agent', type: 'result', text: event.text || event.result || '' });
  }
}

function spawnClaude(userMessage: string, extensionUrl?: string | null): void {
  agentStatus = 'processing';
  agentStartTime = Date.now();
  currentMessage = userMessage;

  // Prefer the URL from the Chrome extension (what the user actually sees)
  // over Playwright's page.url() which can be stale in headed mode.
  const sanitizedExtUrl = sanitizeExtensionUrl(extensionUrl);
  const playwrightUrl = browserManager.getCurrentUrl() || 'about:blank';
  const pageUrl = sanitizedExtUrl || playwrightUrl;
  const B = BROWSE_BIN;
  const systemPrompt = [
    'You are a browser assistant running in a Chrome sidebar.',
    `The user is currently viewing: ${pageUrl}`,
    `Browse binary: ${B}`,
    '',
    'IMPORTANT: You are controlling a SHARED browser. The user may have navigated',
    'manually. Always run `' + B + ' url` first to check the actual current URL.',
    'If it differs from above, the user navigated — work with the ACTUAL page.',
    'Do NOT navigate away from the user\'s current page unless they ask you to.',
    '',
    'Commands (run via bash):',
    `  ${B} goto <url>    ${B} click <@ref>    ${B} fill <@ref> <text>`,
    `  ${B} snapshot -i   ${B} text            ${B} screenshot`,
    `  ${B} back          ${B} forward         ${B} reload`,
    '',
    'Rules: run snapshot -i before clicking. Keep responses SHORT.',
  ].join('\n');

  const prompt = `${systemPrompt}\n\nUser: ${userMessage}`;
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose',
    '--allowedTools', 'Bash,Read,Glob,Grep'];
  if (sidebarSession?.claudeSessionId) {
    args.push('--resume', sidebarSession.claudeSessionId);
  }

  addChatEntry({ ts: new Date().toISOString(), role: 'agent', type: 'agent_start' });

  // Compiled bun binaries CANNOT spawn external processes (posix_spawn
  // fails with ENOENT on everything, including /bin/bash). Instead,
  // write the command to a queue file that the sidebar-agent process
  // (running as non-compiled bun) picks up and spawns claude.
  const agentQueue = process.env.SIDEBAR_QUEUE_PATH || path.join(process.env.HOME || '/tmp', '.gstack', 'sidebar-agent-queue.jsonl');
  const gstackDir = path.dirname(agentQueue);
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    message: userMessage,
    prompt,
    args,
    stateFile: config.stateFile,
    cwd: (sidebarSession as any)?.worktreePath || process.cwd(),
    sessionId: sidebarSession?.claudeSessionId || null,
    pageUrl: pageUrl,
  });
  try {
    fs.mkdirSync(gstackDir, { recursive: true });
    fs.appendFileSync(agentQueue, entry + '\n');
  } catch (err: any) {
    addChatEntry({ ts: new Date().toISOString(), role: 'agent', type: 'agent_error', error: `Failed to queue: ${err.message}` });
    agentStatus = 'idle';
    agentStartTime = null;
    currentMessage = null;
    return;
  }
  // The sidebar-agent.ts process polls this file and spawns claude.
  // It POST events back via /sidebar-event which processAgentEvent handles.
  // Agent status transitions happen when we receive agent_done/agent_error events.
}

function killAgent(): void {
  if (agentProcess) {
    try { agentProcess.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { agentProcess?.kill('SIGKILL'); } catch {} }, 3000);
  }
  agentProcess = null;
  agentStartTime = null;
  currentMessage = null;
  agentStatus = 'idle';
}

// Agent health check — detect hung processes
let agentHealthInterval: ReturnType<typeof setInterval> | null = null;
function startAgentHealthCheck(): void {
  agentHealthInterval = setInterval(() => {
    if (agentStatus === 'processing' && agentStartTime && Date.now() - agentStartTime > AGENT_TIMEOUT_MS) {
      agentStatus = 'hung';
      console.log(`[browse] Sidebar agent hung (>${AGENT_TIMEOUT_MS / 1000}s)`);
    }
  }, 10000);
}

// Initialize session on startup
function initSidebarSession(): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  sidebarSession = loadSession();
  if (!sidebarSession) {
    sidebarSession = createSession();
  }
  console.log(`[browse] Sidebar session: ${sidebarSession.id} (${chatBuffer.length} chat entries loaded)`);
  startAgentHealthCheck();
}
let lastConsoleFlushed = 0;
let lastNetworkFlushed = 0;
let lastDialogFlushed = 0;
let flushInProgress = false;

async function flushBuffers() {
  if (flushInProgress) return; // Guard against concurrent flush
  flushInProgress = true;

  try {
    // Console buffer
    const newConsoleCount = consoleBuffer.totalAdded - lastConsoleFlushed;
    if (newConsoleCount > 0) {
      const entries = consoleBuffer.last(Math.min(newConsoleCount, consoleBuffer.length));
      const lines = entries.map(e =>
        `[${new Date(e.timestamp).toISOString()}] [${e.level}] ${e.text}`
      ).join('\n') + '\n';
      fs.appendFileSync(CONSOLE_LOG_PATH, lines);
      lastConsoleFlushed = consoleBuffer.totalAdded;
    }

    // Network buffer
    const newNetworkCount = networkBuffer.totalAdded - lastNetworkFlushed;
    if (newNetworkCount > 0) {
      const entries = networkBuffer.last(Math.min(newNetworkCount, networkBuffer.length));
      const lines = entries.map(e =>
        `[${new Date(e.timestamp).toISOString()}] ${e.method} ${e.url} → ${e.status || 'pending'} (${e.duration || '?'}ms, ${e.size || '?'}B)`
      ).join('\n') + '\n';
      fs.appendFileSync(NETWORK_LOG_PATH, lines);
      lastNetworkFlushed = networkBuffer.totalAdded;
    }

    // Dialog buffer
    const newDialogCount = dialogBuffer.totalAdded - lastDialogFlushed;
    if (newDialogCount > 0) {
      const entries = dialogBuffer.last(Math.min(newDialogCount, dialogBuffer.length));
      const lines = entries.map(e =>
        `[${new Date(e.timestamp).toISOString()}] [${e.type}] "${e.message}" → ${e.action}${e.response ? ` "${e.response}"` : ''}`
      ).join('\n') + '\n';
      fs.appendFileSync(DIALOG_LOG_PATH, lines);
      lastDialogFlushed = dialogBuffer.totalAdded;
    }
  } catch {
    // Flush failures are non-fatal — buffers are in memory
  } finally {
    flushInProgress = false;
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

// ─── Command Sets (from commands.ts — single source of truth) ───
import { READ_COMMANDS, WRITE_COMMANDS, META_COMMANDS } from './commands';
export { READ_COMMANDS, WRITE_COMMANDS, META_COMMANDS };

// ─── Server ────────────────────────────────────────────────────
const browserManager = new BrowserManager();
let isShuttingDown = false;

// Test if a port is available by binding and immediately releasing.
// Uses net.createServer instead of Bun.serve to avoid a race condition
// in the Node.js polyfill where listen/close are async but the caller
// expects synchronous bind semantics. See: #486
function isPortAvailable(port: number, hostname: string = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, hostname, () => {
      srv.close(() => resolve(true));
    });
  });
}

// Find port: explicit BROWSE_PORT, or random in 10000-60000
async function findPort(): Promise<number> {
  // Explicit port override (for debugging)
  if (BROWSE_PORT) {
    if (await isPortAvailable(BROWSE_PORT)) {
      return BROWSE_PORT;
    }
    throw new Error(`[browse] Port ${BROWSE_PORT} (from BROWSE_PORT env) is in use`);
  }

  // Random port with retry
  const MIN_PORT = 10000;
  const MAX_PORT = 60000;
  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const port = MIN_PORT + Math.floor(Math.random() * (MAX_PORT - MIN_PORT));
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`[browse] No available port after ${MAX_RETRIES} attempts in range ${MIN_PORT}-${MAX_PORT}`);
}

/**
 * Translate Playwright errors into actionable messages for AI agents.
 */
function wrapError(err: any): string {
  const msg = err.message || String(err);
  // Timeout errors
  if (err.name === 'TimeoutError' || msg.includes('Timeout') || msg.includes('timeout')) {
    if (msg.includes('locator.click') || msg.includes('locator.fill') || msg.includes('locator.hover')) {
      return `Element not found or not interactable within timeout. Check your selector or run 'snapshot' for fresh refs.`;
    }
    if (msg.includes('page.goto') || msg.includes('Navigation')) {
      return `Page navigation timed out. The URL may be unreachable or the page may be loading slowly.`;
    }
    return `Operation timed out: ${msg.split('\n')[0]}`;
  }
  // Multiple elements matched
  if (msg.includes('resolved to') && msg.includes('elements')) {
    return `Selector matched multiple elements. Be more specific or use @refs from 'snapshot'.`;
  }
  // Pass through other errors
  return msg;
}

async function handleCommand(body: any): Promise<Response> {
  const { command, args = [] } = body;

  if (!command) {
    return new Response(JSON.stringify({ error: 'Missing "command" field' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Block mutation commands while watching (read-only observation mode)
  if (browserManager.isWatching() && WRITE_COMMANDS.has(command)) {
    return new Response(JSON.stringify({
      error: 'Cannot run mutation commands while watching. Run `$B watch stop` first.',
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Activity: emit command_start
  const startTime = Date.now();
  emitActivity({
    type: 'command_start',
    command,
    args,
    url: browserManager.getCurrentUrl(),
    tabs: browserManager.getTabCount(),
    mode: browserManager.getConnectionMode(),
  });

  try {
    let result: string;

    if (READ_COMMANDS.has(command)) {
      result = await handleReadCommand(command, args, browserManager);
    } else if (WRITE_COMMANDS.has(command)) {
      result = await handleWriteCommand(command, args, browserManager);
    } else if (META_COMMANDS.has(command)) {
      result = await handleMetaCommand(command, args, browserManager, shutdown);
      // Start periodic snapshot interval when watch mode begins
      if (command === 'watch' && args[0] !== 'stop' && browserManager.isWatching()) {
        const watchInterval = setInterval(async () => {
          if (!browserManager.isWatching()) {
            clearInterval(watchInterval);
            return;
          }
          try {
            const snapshot = await handleSnapshot(['-i'], browserManager);
            browserManager.addWatchSnapshot(snapshot);
          } catch {
            // Page may be navigating — skip this snapshot
          }
        }, 5000);
        browserManager.watchInterval = watchInterval;
      }
    } else if (command === 'help') {
      const helpText = generateHelpText();
      return new Response(helpText, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    } else {
      return new Response(JSON.stringify({
        error: `Unknown command: ${command}`,
        hint: `Available commands: ${[...READ_COMMANDS, ...WRITE_COMMANDS, ...META_COMMANDS].sort().join(', ')}`,
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Activity: emit command_end (success)
    emitActivity({
      type: 'command_end',
      command,
      args,
      url: browserManager.getCurrentUrl(),
      duration: Date.now() - startTime,
      status: 'ok',
      result: result,
      tabs: browserManager.getTabCount(),
      mode: browserManager.getConnectionMode(),
    });

    browserManager.resetFailures();
    return new Response(result, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  } catch (err: any) {
    // Activity: emit command_end (error)
    emitActivity({
      type: 'command_end',
      command,
      args,
      url: browserManager.getCurrentUrl(),
      duration: Date.now() - startTime,
      status: 'error',
      error: err.message,
      tabs: browserManager.getTabCount(),
      mode: browserManager.getConnectionMode(),
    });

    browserManager.incrementFailures();
    let errorMsg = wrapError(err);
    const hint = browserManager.getFailureHint();
    if (hint) errorMsg += '\n' + hint;
    return new Response(JSON.stringify({ error: errorMsg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log('[browse] Shutting down...');
  // Stop watch mode if active
  if (browserManager.isWatching()) browserManager.stopWatch();
  killAgent();
  messageQueue = [];
  saveSession(); // Persist chat history before exit
  if (sidebarSession?.worktreePath) removeWorktree(sidebarSession.worktreePath);
  if (agentHealthInterval) clearInterval(agentHealthInterval);
  clearInterval(flushInterval);
  clearInterval(idleCheckInterval);
  await flushBuffers(); // Final flush (async now)

  await browserManager.close();

  // Clean up Chromium profile locks (prevent SingletonLock on next launch)
  const profileDir = path.join(process.env.HOME || '/tmp', '.gstack', 'chromium-profile');
  for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { fs.unlinkSync(path.join(profileDir, lockFile)); } catch {}
  }

  // Clean up state file
  try { fs.unlinkSync(config.stateFile); } catch {}

  process.exit(0);
}

// Handle signals
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
// Windows: taskkill /F bypasses SIGTERM, but 'exit' fires for some shutdown paths.
// Defense-in-depth — primary cleanup is the CLI's stale-state detection via health check.
if (process.platform === 'win32') {
  process.on('exit', () => {
    try { fs.unlinkSync(config.stateFile); } catch {}
  });
}

// Emergency cleanup for crashes (OOM, uncaught exceptions, browser disconnect)
function emergencyCleanup() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  // Kill agent subprocess if running
  try { killAgent(); } catch {}
  // Save session state so chat history persists across crashes
  try { saveSession(); } catch {}
  // Clean Chromium profile locks
  const profileDir = path.join(process.env.HOME || '/tmp', '.gstack', 'chromium-profile');
  for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { fs.unlinkSync(path.join(profileDir, lockFile)); } catch {}
  }
  try { fs.unlinkSync(config.stateFile); } catch {}
}
process.on('uncaughtException', (err) => {
  console.error('[browse] FATAL uncaught exception:', err.message);
  emergencyCleanup();
  process.exit(1);
});
process.on('unhandledRejection', (err: any) => {
  console.error('[browse] FATAL unhandled rejection:', err?.message || err);
  emergencyCleanup();
  process.exit(1);
});

// ─── Start ─────────────────────────────────────────────────────
async function start() {
  // Clear old log files
  try { fs.unlinkSync(CONSOLE_LOG_PATH); } catch {}
  try { fs.unlinkSync(NETWORK_LOG_PATH); } catch {}
  try { fs.unlinkSync(DIALOG_LOG_PATH); } catch {}

  const port = await findPort();

  // Launch browser (headless or headed with extension)
  // BROWSE_HEADLESS_SKIP=1 skips browser launch entirely (for HTTP-only testing)
  const skipBrowser = process.env.BROWSE_HEADLESS_SKIP === '1';
  if (!skipBrowser) {
    const headed = process.env.BROWSE_HEADED === '1';
    if (headed) {
      await browserManager.launchHeaded(AUTH_TOKEN);
      console.log(`[browse] Launched headed Chromium with extension`);
    } else {
      await browserManager.launch();
    }
  }

  const startTime = Date.now();
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const url = new URL(req.url);

      // Cookie picker routes — HTML page unauthenticated, data/action routes require auth
      if (url.pathname.startsWith('/cookie-picker')) {
        return handleCookiePickerRoute(url, req, browserManager, AUTH_TOKEN);
      }

      // Health check — no auth required, does NOT reset idle timer
      if (url.pathname === '/health') {
        const healthy = await browserManager.isHealthy();
        return new Response(JSON.stringify({
          status: healthy ? 'healthy' : 'unhealthy',
          mode: browserManager.getConnectionMode(),
          uptime: Math.floor((Date.now() - startTime) / 1000),
          tabs: browserManager.getTabCount(),
          currentUrl: browserManager.getCurrentUrl(),
          // token removed — see .auth.json for extension bootstrap
          chatEnabled: true,
          agent: {
            status: agentStatus,
            runningFor: agentStartTime ? Date.now() - agentStartTime : null,
            currentMessage,
            queueLength: messageQueue.length,
          },
          session: sidebarSession ? { id: sidebarSession.id, name: sidebarSession.name } : null,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Refs endpoint — auth required, does NOT reset idle timer
      if (url.pathname === '/refs') {
        if (!validateAuth(req)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const refs = browserManager.getRefMap();
        return new Response(JSON.stringify({
          refs,
          url: browserManager.getCurrentUrl(),
          mode: browserManager.getConnectionMode(),
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Activity stream — SSE, auth required, does NOT reset idle timer
      if (url.pathname === '/activity/stream') {
        // Inline auth: accept Bearer header OR ?token= query param (EventSource can't send headers)
        const streamToken = url.searchParams.get('token');
        if (!validateAuth(req) && streamToken !== AUTH_TOKEN) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const afterId = parseInt(url.searchParams.get('after') || '0', 10);
        const encoder = new TextEncoder();

        const stream = new ReadableStream({
          start(controller) {
            // 1. Gap detection + replay
            const { entries, gap, gapFrom, availableFrom } = getActivityAfter(afterId);
            if (gap) {
              controller.enqueue(encoder.encode(`event: gap\ndata: ${JSON.stringify({ gapFrom, availableFrom })}\n\n`));
            }
            for (const entry of entries) {
              controller.enqueue(encoder.encode(`event: activity\ndata: ${JSON.stringify(entry)}\n\n`));
            }

            // 2. Subscribe for live events
            const unsubscribe = subscribe((entry) => {
              try {
                controller.enqueue(encoder.encode(`event: activity\ndata: ${JSON.stringify(entry)}\n\n`));
              } catch {
                unsubscribe();
              }
            });

            // 3. Heartbeat every 15s
            const heartbeat = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(`: heartbeat\n\n`));
              } catch {
                clearInterval(heartbeat);
                unsubscribe();
              }
            }, 15000);

            // 4. Cleanup on disconnect
            req.signal.addEventListener('abort', () => {
              clearInterval(heartbeat);
              unsubscribe();
              try { controller.close(); } catch {}
            });
          },
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        });
      }

      // Activity history — REST, auth required, does NOT reset idle timer
      if (url.pathname === '/activity/history') {
        if (!validateAuth(req)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        const { entries, totalAdded } = getActivityHistory(limit);
        return new Response(JSON.stringify({ entries, totalAdded, subscribers: getSubscriberCount() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // ─── Sidebar endpoints (auth required — token from /health) ────

      // Sidebar routes are always available in headed mode (ungated in v0.12.0)

      // Sidebar chat history — read from in-memory buffer
      if (url.pathname === '/sidebar-chat') {
        if (!validateAuth(req)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        const afterId = parseInt(url.searchParams.get('after') || '0', 10);
        const entries = chatBuffer.filter(e => e.id >= afterId);
        return new Response(JSON.stringify({ entries, total: chatNextId }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }

      // Sidebar → server: user message → queue or process immediately
      if (url.pathname === '/sidebar-command' && req.method === 'POST') {
        if (!validateAuth(req)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        const body = await req.json();
        const msg = body.message?.trim();
        if (!msg) {
          return new Response(JSON.stringify({ error: 'Empty message' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        // The Chrome extension sends the active tab's URL — prefer it over
        // Playwright's page.url() which can be stale in headed mode when
        // the user navigates manually.
        const extensionUrl = body.activeTabUrl || null;
        const ts = new Date().toISOString();
        addChatEntry({ ts, role: 'user', message: msg });
        if (sidebarSession) { sidebarSession.lastActiveAt = ts; saveSession(); }

        if (agentStatus === 'idle') {
          spawnClaude(msg, extensionUrl);
          return new Response(JSON.stringify({ ok: true, processing: true }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        } else if (messageQueue.length < MAX_QUEUE) {
          messageQueue.push({ message: msg, ts, extensionUrl });
          return new Response(JSON.stringify({ ok: true, queued: true, position: messageQueue.length }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        } else {
          return new Response(JSON.stringify({ error: 'Queue full (max 5)' }), {
            status: 429, headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      // Clear sidebar chat
      if (url.pathname === '/sidebar-chat/clear' && req.method === 'POST') {
        if (!validateAuth(req)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        chatBuffer = [];
        chatNextId = 0;
        if (sidebarSession) {
          try { fs.writeFileSync(path.join(SESSIONS_DIR, sidebarSession.id, 'chat.jsonl'), ''); } catch {}
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // Kill hung agent
      if (url.pathname === '/sidebar-agent/kill' && req.method === 'POST') {
        if (!validateAuth(req)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        killAgent();
        addChatEntry({ ts: new Date().toISOString(), role: 'agent', type: 'agent_error', error: 'Killed by user' });
        // Process next in queue
        if (messageQueue.length > 0) {
          const next = messageQueue.shift()!;
          spawnClaude(next.message, next.extensionUrl);
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // Stop agent (user-initiated) — queued messages remain for dismissal
      if (url.pathname === '/sidebar-agent/stop' && req.method === 'POST') {
        if (!validateAuth(req)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        killAgent();
        addChatEntry({ ts: new Date().toISOString(), role: 'agent', type: 'agent_error', error: 'Stopped by user' });
        return new Response(JSON.stringify({ ok: true, queuedMessages: messageQueue.length }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }

      // Dismiss a queued message by index
      if (url.pathname === '/sidebar-queue/dismiss' && req.method === 'POST') {
        if (!validateAuth(req)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        const body = await req.json();
        const idx = body.index;
        if (typeof idx === 'number' && idx >= 0 && idx < messageQueue.length) {
          messageQueue.splice(idx, 1);
        }
        return new Response(JSON.stringify({ ok: true, queueLength: messageQueue.length }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }

      // Session info
      if (url.pathname === '/sidebar-session') {
        if (!validateAuth(req)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          session: sidebarSession,
          agent: { status: agentStatus, runningFor: agentStartTime ? Date.now() - agentStartTime : null, currentMessage, queueLength: messageQueue.length, queue: messageQueue },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // Create new session
      if (url.pathname === '/sidebar-session/new' && req.method === 'POST') {
        if (!validateAuth(req)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        killAgent();
        messageQueue = [];
        // Clean up old session's worktree before creating new one
        if (sidebarSession?.worktreePath) removeWorktree(sidebarSession.worktreePath);
        sidebarSession = createSession();
        return new Response(JSON.stringify({ ok: true, session: sidebarSession }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }

      // List all sessions
      if (url.pathname === '/sidebar-session/list') {
        if (!validateAuth(req)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ sessions: listSessions(), activeId: sidebarSession?.id }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }

      // Agent event relay — sidebar-agent.ts POSTs events here
      if (url.pathname === '/sidebar-agent/event' && req.method === 'POST') {
        if (!validateAuth(req)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        const body = await req.json();
        processAgentEvent(body);
        // Handle agent lifecycle events
        if (body.type === 'agent_done' || body.type === 'agent_error') {
          agentProcess = null;
          agentStartTime = null;
          currentMessage = null;
          if (body.type === 'agent_done') {
            addChatEntry({ ts: new Date().toISOString(), role: 'agent', type: 'agent_done' });
          }
          // Process next queued message
          if (messageQueue.length > 0) {
            const next = messageQueue.shift()!;
            spawnClaude(next.message, next.extensionUrl);
          } else {
            agentStatus = 'idle';
          }
        }
        // Capture claude session ID for --resume
        if (body.claudeSessionId && sidebarSession && !sidebarSession.claudeSessionId) {
          sidebarSession.claudeSessionId = body.claudeSessionId;
          saveSession();
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // ─── Auth-required endpoints ──────────────────────────────────

      if (!validateAuth(req)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/command' && req.method === 'POST') {
        resetIdleTimer();  // Only commands reset idle timer
        const body = await req.json();
        return handleCommand(body);
      }

      return new Response('Not found', { status: 404 });
    },
  });

  // Write state file (atomic: write .tmp then rename)
  const state: Record<string, unknown> = {
    pid: process.pid,
    port,
    token: AUTH_TOKEN,
    startedAt: new Date().toISOString(),
    serverPath: path.resolve(import.meta.dir, 'server.ts'),
    binaryVersion: readVersionHash() || undefined,
    mode: browserManager.getConnectionMode(),
  };
  const tmpFile = config.stateFile + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmpFile, config.stateFile);

  browserManager.serverPort = port;

  // Clean up stale state files (older than 7 days)
  try {
    const stateDir = path.join(config.stateDir, 'browse-states');
    if (fs.existsSync(stateDir)) {
      const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
      for (const file of fs.readdirSync(stateDir)) {
        const filePath = path.join(stateDir, file);
        const stat = fs.statSync(filePath);
        if (Date.now() - stat.mtimeMs > SEVEN_DAYS) {
          fs.unlinkSync(filePath);
          console.log(`[browse] Deleted stale state file: ${file}`);
        }
      }
    }
  } catch {}

  console.log(`[browse] Server running on http://127.0.0.1:${port} (PID: ${process.pid})`);
  console.log(`[browse] State file: ${config.stateFile}`);
  console.log(`[browse] Idle timeout: ${IDLE_TIMEOUT_MS / 1000}s`);

  // Initialize sidebar session (load existing or create new)
  initSidebarSession();
}

start().catch((err) => {
  console.error(`[browse] Failed to start: ${err.message}`);
  // Write error to disk for the CLI to read — on Windows, the CLI can't capture
  // stderr because the server is launched with detached: true, stdio: 'ignore'.
  try {
    const errorLogPath = path.join(config.stateDir, 'browse-startup-error.log');
    fs.mkdirSync(config.stateDir, { recursive: true });
    fs.writeFileSync(errorLogPath, `${new Date().toISOString()} ${err.message}\n${err.stack || ''}\n`);
  } catch {
    // stateDir may not exist — nothing more we can do
  }
  process.exit(1);
});
