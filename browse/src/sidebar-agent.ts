/**
 * Sidebar Agent — polls agent-queue from server, spawns claude -p for each
 * message, streams live events back to the server via /sidebar-agent/event.
 *
 * This runs as a NON-COMPILED bun process because compiled bun binaries
 * cannot posix_spawn external executables. The server writes to the queue
 * file, this process reads it and spawns claude.
 *
 * Usage: BROWSE_BIN=/path/to/browse bun run browse/src/sidebar-agent.ts
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const QUEUE = process.env.SIDEBAR_QUEUE_PATH || path.join(process.env.HOME || '/tmp', '.gstack', 'sidebar-agent-queue.jsonl');
const KILL_FILE = path.join(path.dirname(QUEUE), 'sidebar-agent-kill');
const SERVER_PORT = parseInt(process.env.BROWSE_SERVER_PORT || '34567', 10);
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const POLL_MS = 200;  // 200ms poll — keeps time-to-first-token low
const B = process.env.BROWSE_BIN || path.resolve(__dirname, '../../.claude/skills/gstack/browse/dist/browse');

const CANCEL_DIR = path.join(process.env.HOME || '/tmp', '.gstack');
function cancelFileForTab(tabId: number): string {
  return path.join(CANCEL_DIR, `sidebar-agent-cancel-${tabId}`);
}

interface QueueEntry {
  prompt: string;
  args?: string[];
  stateFile?: string;
  cwd?: string;
  tabId?: number | null;
  message?: string | null;
  pageUrl?: string | null;
  sessionId?: string | null;
  ts?: string;
}

function isValidQueueEntry(e: unknown): e is QueueEntry {
  if (typeof e !== 'object' || e === null) return false;
  const obj = e as Record<string, unknown>;
  if (typeof obj.prompt !== 'string' || obj.prompt.length === 0) return false;
  if (obj.args !== undefined && (!Array.isArray(obj.args) || !obj.args.every(a => typeof a === 'string'))) return false;
  if (obj.stateFile !== undefined) {
    if (typeof obj.stateFile !== 'string') return false;
    if (obj.stateFile.includes('..')) return false;
  }
  if (obj.cwd !== undefined) {
    if (typeof obj.cwd !== 'string') return false;
    if (obj.cwd.includes('..')) return false;
  }
  if (obj.tabId !== undefined && obj.tabId !== null && typeof obj.tabId !== 'number') return false;
  if (obj.message !== undefined && obj.message !== null && typeof obj.message !== 'string') return false;
  if (obj.pageUrl !== undefined && obj.pageUrl !== null && typeof obj.pageUrl !== 'string') return false;
  if (obj.sessionId !== undefined && obj.sessionId !== null && typeof obj.sessionId !== 'string') return false;
  return true;
}

let lastLine = 0;
let authToken: string | null = null;
// Per-tab processing — each tab can run its own agent concurrently
const processingTabs = new Set<number>();
// Active claude subprocesses — keyed by tabId for targeted kill
const activeProcs = new Map<number, ReturnType<typeof spawn>>();
let activeProc: ReturnType<typeof spawn> | null = null;
// Kill-file timestamp last seen — avoids double-kill on same write
let lastKillTs = 0;

// ─── File drop relay ──────────────────────────────────────────

function getGitRoot(): string | null {
  try {
    const { execSync } = require('child_process');
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err: any) {
    console.debug('[sidebar-agent] Not in a git repo:', err.message);
    return null;
  }
}

function writeToInbox(message: string, pageUrl?: string, sessionId?: string): void {
  const gitRoot = getGitRoot();
  if (!gitRoot) {
    console.error('[sidebar-agent] Cannot write to inbox — not in a git repo');
    return;
  }

  const inboxDir = path.join(gitRoot, '.context', 'sidebar-inbox');
  fs.mkdirSync(inboxDir, { recursive: true, mode: 0o700 });

  const now = new Date();
  const timestamp = now.toISOString().replace(/:/g, '-');
  const filename = `${timestamp}-observation.json`;
  const tmpFile = path.join(inboxDir, `.${filename}.tmp`);
  const finalFile = path.join(inboxDir, filename);

  const inboxMessage = {
    type: 'observation',
    timestamp: now.toISOString(),
    page: { url: pageUrl || 'unknown', title: '' },
    userMessage: message,
    sidebarSessionId: sessionId || 'unknown',
  };

  fs.writeFileSync(tmpFile, JSON.stringify(inboxMessage, null, 2), { mode: 0o600 });
  fs.renameSync(tmpFile, finalFile);
  console.log(`[sidebar-agent] Wrote inbox message: ${filename}`);
}

// ─── Auth ────────────────────────────────────────────────────────

async function refreshToken(): Promise<string | null> {
  // Read token from state file (same-user, mode 0o600) instead of /health
  try {
    const stateFile = process.env.BROWSE_STATE_FILE ||
      path.join(process.env.HOME || '/tmp', '.gstack', 'browse.json');
    const data = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    authToken = data.token || null;
    return authToken;
  } catch (err: any) {
    console.error('[sidebar-agent] Failed to refresh auth token:', err.message);
    return null;
  }
}

// ─── Event relay to server ──────────────────────────────────────

async function sendEvent(event: Record<string, any>, tabId?: number): Promise<void> {
  if (!authToken) await refreshToken();
  if (!authToken) return;

  try {
    await fetch(`${SERVER_URL}/sidebar-agent/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({ ...event, tabId: tabId ?? null }),
    });
  } catch (err) {
    console.error('[sidebar-agent] Failed to send event:', err);
  }
}

// ─── Claude subprocess ──────────────────────────────────────────

function shorten(str: string): string {
  return str
    .replace(new RegExp(B.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '$B')
    .replace(/\/Users\/[^/]+/g, '~')
    .replace(/\/conductor\/workspaces\/[^/]+\/[^/]+/g, '')
    .replace(/\.claude\/skills\/gstack\//g, '')
    .replace(/browse\/dist\/browse/g, '$B');
}

function describeToolCall(tool: string, input: any): string {
  if (!input) return '';

  // For Bash commands, generate a plain-English description
  if (tool === 'Bash' && input.command) {
    const cmd = input.command;

    // Browse binary commands — the most common case
    const browseMatch = cmd.match(/\$B\s+(\w+)|browse[^\s]*\s+(\w+)/);
    if (browseMatch) {
      const browseCmd = browseMatch[1] || browseMatch[2];
      const args = cmd.split(/\s+/).slice(2).join(' ');
      switch (browseCmd) {
        case 'goto': return `Opening ${args.replace(/['"]/g, '')}`;
        case 'snapshot': return args.includes('-i') ? 'Scanning for interactive elements' : args.includes('-D') ? 'Checking what changed' : 'Taking a snapshot of the page';
        case 'screenshot': return `Saving screenshot${args ? ` to ${shorten(args)}` : ''}`;
        case 'click': return `Clicking ${args}`;
        case 'fill': { const parts = args.split(/\s+/); return `Typing "${parts.slice(1).join(' ')}" into ${parts[0]}`; }
        case 'text': return 'Reading page text';
        case 'html': return args ? `Reading HTML of ${args}` : 'Reading full page HTML';
        case 'links': return 'Finding all links on the page';
        case 'forms': return 'Looking for forms';
        case 'console': return 'Checking browser console for errors';
        case 'network': return 'Checking network requests';
        case 'url': return 'Checking current URL';
        case 'back': return 'Going back';
        case 'forward': return 'Going forward';
        case 'reload': return 'Reloading the page';
        case 'scroll': return args ? `Scrolling to ${args}` : 'Scrolling down';
        case 'wait': return `Waiting for ${args}`;
        case 'inspect': return args ? `Inspecting CSS of ${args}` : 'Getting CSS for last picked element';
        case 'style': return `Changing CSS: ${args}`;
        case 'cleanup': return 'Removing page clutter (ads, popups, banners)';
        case 'prettyscreenshot': return 'Taking a clean screenshot';
        case 'css': return `Checking CSS property: ${args}`;
        case 'is': return `Checking if element is ${args}`;
        case 'diff': return `Comparing ${args}`;
        case 'responsive': return 'Taking screenshots at mobile, tablet, and desktop sizes';
        case 'status': return 'Checking browser status';
        case 'tabs': return 'Listing open tabs';
        case 'focus': return 'Bringing browser to front';
        case 'select': return `Selecting option in ${args}`;
        case 'hover': return `Hovering over ${args}`;
        case 'viewport': return `Setting viewport to ${args}`;
        case 'upload': return `Uploading file to ${args.split(/\s+/)[0]}`;
        default: return `Running browse ${browseCmd} ${args}`.trim();
      }
    }

    // Non-browse bash commands
    if (cmd.includes('git ')) return `Running: ${shorten(cmd)}`;
    let short = shorten(cmd);
    return short.length > 100 ? short.slice(0, 100) + '…' : short;
  }

  if (tool === 'Read' && input.file_path) {
    // Skip Claude's internal tool-result file reads — they're plumbing, not user-facing
    if (input.file_path.includes('/tool-results/') || input.file_path.includes('/.claude/projects/')) return '';
    return `Reading ${shorten(input.file_path)}`;
  }
  if (tool === 'Edit' && input.file_path) return `Editing ${shorten(input.file_path)}`;
  if (tool === 'Write' && input.file_path) return `Writing ${shorten(input.file_path)}`;
  if (tool === 'Grep' && input.pattern) return `Searching for "${input.pattern}"`;
  if (tool === 'Glob' && input.pattern) return `Finding files matching ${input.pattern}`;
  try { return shorten(JSON.stringify(input)).slice(0, 80); } catch { return ''; }
}

// Keep the old name as an alias for backward compat
function summarizeToolInput(tool: string, input: any): string {
  return describeToolCall(tool, input);
}

async function handleStreamEvent(event: any, tabId?: number): Promise<void> {
  if (event.type === 'system' && event.session_id) {
    // Relay claude session ID for --resume support
    await sendEvent({ type: 'system', claudeSessionId: event.session_id }, tabId);
  }

  if (event.type === 'assistant' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'tool_use') {
        await sendEvent({ type: 'tool_use', tool: block.name, input: summarizeToolInput(block.name, block.input) }, tabId);
      } else if (block.type === 'text' && block.text) {
        await sendEvent({ type: 'text', text: block.text }, tabId);
      }
    }
  }

  if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
    await sendEvent({ type: 'tool_use', tool: event.content_block.name, input: summarizeToolInput(event.content_block.name, event.content_block.input) }, tabId);
  }

  if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
    await sendEvent({ type: 'text_delta', text: event.delta.text }, tabId);
  }

  // Relay tool results so the sidebar can show what happened
  if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
    // Tool input streaming — skip, we already announced the tool
  }

  if (event.type === 'result') {
    await sendEvent({ type: 'result', text: event.result || '' }, tabId);
  }

  // Tool result events — summarize and relay
  if (event.type === 'tool_result' || (event.type === 'assistant' && event.message?.content)) {
    // Tool results come in the next assistant turn — handled above
  }
}

async function askClaude(queueEntry: QueueEntry): Promise<void> {
  const { prompt, args, stateFile, cwd, tabId } = queueEntry;
  const tid = tabId ?? 0;

  processingTabs.add(tid);
  await sendEvent({ type: 'agent_start' }, tid);

  return new Promise((resolve) => {
    // Use args from queue entry (server sets --model, --allowedTools, prompt framing).
    // Fall back to defaults only if queue entry has no args (backward compat).
    // Write doesn't expand attack surface beyond what Bash already provides.
    // The security boundary is the localhost-only message path, not the tool allowlist.
    let claudeArgs = args || ['-p', prompt, '--output-format', 'stream-json', '--verbose',
      '--allowedTools', 'Bash,Read,Glob,Grep,Write'];

    // Validate cwd exists — queue may reference a stale worktree
    let effectiveCwd = cwd || process.cwd();
    try { fs.accessSync(effectiveCwd); } catch (err: any) {
      console.warn('[sidebar-agent] Worktree path inaccessible, falling back to cwd:', effectiveCwd, err.message);
      effectiveCwd = process.cwd();
    }

    // Clear any stale cancel signal for this tab before starting
    const cancelFile = cancelFileForTab(tid);
    try { fs.unlinkSync(cancelFile); } catch {}

    const proc = spawn('claude', claudeArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: effectiveCwd,
      env: {
        ...process.env,
        BROWSE_STATE_FILE: stateFile || '',
        // Connect to the existing headed browse server, never start a new one.
        // BROWSE_PORT tells the CLI which port to check.
        // BROWSE_NO_AUTOSTART prevents spawning an invisible headless browser
        // if the headed server is down — fail fast with a clear error instead.
        BROWSE_PORT: process.env.BROWSE_PORT || '34567',
        BROWSE_NO_AUTOSTART: '1',
        // Pin this agent to its tab — prevents cross-tab interference
        // when multiple agents run simultaneously
        BROWSE_TAB: String(tid),
      },
    });

    // Track active procs so kill-file polling can terminate them
    activeProcs.set(tid, proc);
    activeProc = proc;

    proc.stdin.end();

    // Poll for per-tab cancel signal from server's killAgent()
    const cancelCheck = setInterval(() => {
      try {
        if (fs.existsSync(cancelFile)) {
          console.log(`[sidebar-agent] Cancel signal received for tab ${tid} — killing claude subprocess`);
          try { proc.kill('SIGTERM'); } catch {}
          setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
          fs.unlinkSync(cancelFile);
          clearInterval(cancelCheck);
        }
      } catch {}
    }, 500);

    let buffer = '';

    proc.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { handleStreamEvent(JSON.parse(line), tid); } catch (err: any) {
          console.error(`[sidebar-agent] Tab ${tid}: Failed to parse stream line:`, line.slice(0, 100), err.message);
        }
      }
    });

    let stderrBuffer = '';
    proc.stderr.on('data', (data: Buffer) => {
      stderrBuffer += data.toString();
    });

    proc.on('close', (code) => {
      clearInterval(cancelCheck);
      activeProc = null;
      activeProcs.delete(tid);
      if (buffer.trim()) {
        try { handleStreamEvent(JSON.parse(buffer), tid); } catch (err: any) {
          console.error(`[sidebar-agent] Tab ${tid}: Failed to parse final buffer:`, buffer.slice(0, 100), err.message);
        }
      }
      const doneEvent: Record<string, any> = { type: 'agent_done' };
      if (code !== 0 && stderrBuffer.trim()) {
        doneEvent.stderr = stderrBuffer.trim().slice(-500);
      }
      sendEvent(doneEvent, tid).then(() => {
        processingTabs.delete(tid);
        resolve();
      });
    });

    proc.on('error', (err) => {
      clearInterval(cancelCheck);
      activeProc = null;
      const errorMsg = stderrBuffer.trim()
        ? `${err.message}\nstderr: ${stderrBuffer.trim().slice(-500)}`
        : err.message;
      sendEvent({ type: 'agent_error', error: errorMsg }, tid).then(() => {
        processingTabs.delete(tid);
        resolve();
      });
    });

    // Timeout (default 300s / 5 min — multi-page tasks need time)
    const timeoutMs = parseInt(process.env.SIDEBAR_AGENT_TIMEOUT || '300000', 10);
    setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (killErr: any) {
        console.warn(`[sidebar-agent] Tab ${tid}: Failed to kill timed-out process:`, killErr.message);
      }
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
      const timeoutMsg = stderrBuffer.trim()
        ? `Timed out after ${timeoutMs / 1000}s\nstderr: ${stderrBuffer.trim().slice(-500)}`
        : `Timed out after ${timeoutMs / 1000}s`;
      sendEvent({ type: 'agent_error', error: timeoutMsg }, tid).then(() => {
        processingTabs.delete(tid);
        resolve();
      });
    }, timeoutMs);
  });
}

// ─── Poll loop ───────────────────────────────────────────────────

function countLines(): number {
  try {
    return fs.readFileSync(QUEUE, 'utf-8').split('\n').filter(Boolean).length;
  } catch (err: any) {
    console.error('[sidebar-agent] Failed to read queue file:', err.message);
    return 0;
  }
}

function readLine(n: number): string | null {
  try {
    const lines = fs.readFileSync(QUEUE, 'utf-8').split('\n').filter(Boolean);
    return lines[n - 1] || null;
  } catch (err: any) {
    console.error(`[sidebar-agent] Failed to read queue line ${n}:`, err.message);
    return null;
  }
}

async function poll() {
  const current = countLines();
  if (current <= lastLine) return;

  while (lastLine < current) {
    lastLine++;
    const line = readLine(lastLine);
    if (!line) continue;

    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch (err: any) {
      console.warn(`[sidebar-agent] Skipping malformed queue entry at line ${lastLine}:`, line.slice(0, 80), err.message);
      continue;
    }
    if (!isValidQueueEntry(parsed)) {
      console.warn(`[sidebar-agent] Skipping invalid queue entry at line ${lastLine}: failed schema validation`);
      continue;
    }
    const entry = parsed;

    const tid = entry.tabId ?? 0;
    // Skip if this tab already has an agent running — server queues per-tab
    if (processingTabs.has(tid)) continue;

    console.log(`[sidebar-agent] Processing tab ${tid}: "${entry.message}"`);
    // Write to inbox so workspace agent can pick it up
    writeToInbox(entry.message || entry.prompt, entry.pageUrl, entry.sessionId);
    // Fire and forget — each tab's agent runs concurrently
    askClaude(entry).catch((err) => {
      console.error(`[sidebar-agent] Error on tab ${tid}:`, err);
      sendEvent({ type: 'agent_error', error: String(err) }, tid);
    });
  }
}

// ─── Main ────────────────────────────────────────────────────────

function pollKillFile(): void {
  try {
    const stat = fs.statSync(KILL_FILE);
    const mtime = stat.mtimeMs;
    if (mtime > lastKillTs) {
      lastKillTs = mtime;
      if (activeProcs.size > 0) {
        console.log(`[sidebar-agent] Kill signal received — terminating ${activeProcs.size} active agent(s)`);
        for (const [tid, proc] of activeProcs) {
          try { proc.kill('SIGTERM'); } catch {}
          setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000);
          processingTabs.delete(tid);
        }
        activeProcs.clear();
      }
    }
  } catch {
    // Kill file doesn't exist yet — normal state
  }
}

async function main() {
  const dir = path.dirname(QUEUE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(QUEUE)) fs.writeFileSync(QUEUE, '', { mode: 0o600 });
  try { fs.chmodSync(QUEUE, 0o600); } catch {}

  lastLine = countLines();
  await refreshToken();

  console.log(`[sidebar-agent] Started. Watching ${QUEUE} from line ${lastLine}`);
  console.log(`[sidebar-agent] Server: ${SERVER_URL}`);
  console.log(`[sidebar-agent] Browse binary: ${B}`);

  setInterval(poll, POLL_MS);
  setInterval(pollKillFile, POLL_MS);
}

main().catch(console.error);
