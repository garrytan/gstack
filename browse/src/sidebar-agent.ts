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
const SERVER_PORT = parseInt(process.env.BROWSE_SERVER_PORT || '34567', 10);
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const POLL_MS = 500;  // Fast polling — server already did the user-facing response
const B = process.env.BROWSE_BIN || path.resolve(__dirname, '../../.claude/skills/gstack/browse/dist/browse');

let lastLine = 0;
let authToken: string | null = null;
let isProcessing = false;

// ─── File drop relay ──────────────────────────────────────────

function getGitRoot(): string | null {
  try {
    const { execSync } = require('child_process');
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
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
  fs.mkdirSync(inboxDir, { recursive: true });

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

  fs.writeFileSync(tmpFile, JSON.stringify(inboxMessage, null, 2));
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
  } catch {
    return null;
  }
}

// ─── Event relay to server ──────────────────────────────────────

async function sendEvent(event: Record<string, any>): Promise<void> {
  if (!authToken) await refreshToken();
  if (!authToken) return;

  try {
    await fetch(`${SERVER_URL}/sidebar-agent/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify(event),
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

function summarizeToolInput(tool: string, input: any): string {
  if (!input) return '';
  if (tool === 'Bash' && input.command) {
    let cmd = shorten(input.command);
    return cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd;
  }
  if (tool === 'Read' && input.file_path) return shorten(input.file_path);
  if (tool === 'Edit' && input.file_path) return shorten(input.file_path);
  if (tool === 'Write' && input.file_path) return shorten(input.file_path);
  if (tool === 'Grep' && input.pattern) return `/${input.pattern}/`;
  if (tool === 'Glob' && input.pattern) return input.pattern;
  try { return shorten(JSON.stringify(input)).slice(0, 60); } catch { return ''; }
}

async function handleStreamEvent(event: any): Promise<void> {
  if (event.type === 'system' && event.session_id) {
    // Relay claude session ID for --resume support
    await sendEvent({ type: 'system', claudeSessionId: event.session_id });
  }

  if (event.type === 'assistant' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'tool_use') {
        await sendEvent({ type: 'tool_use', tool: block.name, input: summarizeToolInput(block.name, block.input) });
      } else if (block.type === 'text' && block.text) {
        await sendEvent({ type: 'text', text: block.text });
      }
    }
  }

  if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
    await sendEvent({ type: 'tool_use', tool: event.content_block.name, input: summarizeToolInput(event.content_block.name, event.content_block.input) });
  }

  if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
    await sendEvent({ type: 'text_delta', text: event.delta.text });
  }

  if (event.type === 'result') {
    await sendEvent({ type: 'result', text: event.result || '' });
  }
}

async function askClaude(queueEntry: any): Promise<void> {
  const { prompt, args, stateFile, cwd } = queueEntry;

  isProcessing = true;
  await sendEvent({ type: 'agent_start' });

  return new Promise((resolve) => {
    // Use args from queue entry (server sets --model, --allowedTools, prompt framing).
    // Fall back to defaults only if queue entry has no args (backward compat).
    let claudeArgs = args || ['-p', prompt, '--output-format', 'stream-json', '--verbose',
      '--allowedTools', 'Bash,Read,Glob,Grep'];

    // Validate cwd exists — queue may reference a stale worktree
    let effectiveCwd = cwd || process.cwd();
    try { fs.accessSync(effectiveCwd); } catch { effectiveCwd = process.cwd(); }

    const proc = spawn('claude', claudeArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: effectiveCwd,
      env: { ...process.env, BROWSE_STATE_FILE: stateFile || '' },
    });

    proc.stdin.end();

    let buffer = '';

    proc.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { handleStreamEvent(JSON.parse(line)); } catch {}
      }
    });

    proc.stderr.on('data', () => {}); // Claude logs to stderr, ignore

    proc.on('close', (code) => {
      if (buffer.trim()) {
        try { handleStreamEvent(JSON.parse(buffer)); } catch {}
      }
      sendEvent({ type: 'agent_done' }).then(() => {
        isProcessing = false;
        resolve();
      });
    });

    proc.on('error', (err) => {
      sendEvent({ type: 'agent_error', error: err.message }).then(() => {
        isProcessing = false;
        resolve();
      });
    });

    // Timeout (default 300s / 5 min — multi-page tasks need time)
    const timeoutMs = parseInt(process.env.SIDEBAR_AGENT_TIMEOUT || '300000', 10);
    setTimeout(() => {
      try { proc.kill(); } catch {}
      sendEvent({ type: 'agent_error', error: `Timed out after ${timeoutMs / 1000}s` }).then(() => {
        isProcessing = false;
        resolve();
      });
    }, timeoutMs);
  });
}

// ─── Poll loop ───────────────────────────────────────────────────

function countLines(): number {
  try {
    return fs.readFileSync(QUEUE, 'utf-8').split('\n').filter(Boolean).length;
  } catch { return 0; }
}

function readLine(n: number): string | null {
  try {
    const lines = fs.readFileSync(QUEUE, 'utf-8').split('\n').filter(Boolean);
    return lines[n - 1] || null;
  } catch { return null; }
}

async function poll() {
  if (isProcessing) return; // One at a time — server handles queuing

  const current = countLines();
  if (current <= lastLine) return;

  while (lastLine < current && !isProcessing) {
    lastLine++;
    const line = readLine(lastLine);
    if (!line) continue;

    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry.message && !entry.prompt) continue;

    console.log(`[sidebar-agent] Processing: "${entry.message}"`);
    // Write to inbox so workspace agent can pick it up
    writeToInbox(entry.message || entry.prompt, entry.pageUrl, entry.sessionId);
    try {
      await askClaude(entry);
    } catch (err) {
      console.error(`[sidebar-agent] Error:`, err);
      await sendEvent({ type: 'agent_error', error: String(err) });
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  const dir = path.dirname(QUEUE);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(QUEUE)) fs.writeFileSync(QUEUE, '');

  lastLine = countLines();
  await refreshToken();

  console.log(`[sidebar-agent] Started. Watching ${QUEUE} from line ${lastLine}`);
  console.log(`[sidebar-agent] Server: ${SERVER_URL}`);
  console.log(`[sidebar-agent] Browse binary: ${B}`);

  setInterval(poll, POLL_MS);
}

main().catch(console.error);
