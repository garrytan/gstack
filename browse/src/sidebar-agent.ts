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
import { safeUnlink } from './error-handling';
import {
  checkCanaryInStructure, logAttempt, hashPayload, extractDomain,
  combineVerdict, writeSessionState, readSessionState, THRESHOLDS,
  readDecision, clearDecision, excerptForReview,
  type LayerSignal,
} from './security';
import {
  loadTestsavant, scanPageContent, checkTranscript,
  shouldRunTranscriptCheck, getClassifierStatus,
  loadDeberta, scanPageContentDeberta,
  type ToolCallInput,
} from './security-classifier';

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
  canary?: string; // session-scoped token; leak = prompt injection evidence
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
  if (obj.canary !== undefined && typeof obj.canary !== 'string') return false;
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

/**
 * Scan a Claude stream event for the session canary. Returns the channel where
 * it leaked, or null if clean. Covers every outbound channel: text blocks,
 * text deltas, tool_use arguments (including nested URL/path/command strings),
 * and result payloads.
 */
function detectCanaryLeak(event: any, canary: string, buf?: DeltaBuffer): string | null {
  if (!canary) return null;

  if (event.type === 'assistant' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.includes(canary)) {
        return 'assistant_text';
      }
      if (block.type === 'tool_use' && checkCanaryInStructure(block.input, canary)) {
        return `tool_use:${block.name}`;
      }
    }
  }
  if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
    if (checkCanaryInStructure(event.content_block.input, canary)) {
      return `tool_use:${event.content_block.name}`;
    }
  }
  if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
    if (typeof event.delta.text === 'string') {
      // Rolling buffer: an attacker can ask Claude to emit the canary split
      // across two deltas (e.g., "CANARY-" then "ABCDEF"). A per-delta
      // substring check misses this. Concatenate the previous tail with
      // this chunk and search, then trim the tail to last canary.length-1
      // chars for the next event.
      const combined = buf ? buf.text_delta + event.delta.text : event.delta.text;
      if (combined.includes(canary)) return 'text_delta';
      if (buf) buf.text_delta = combined.slice(-(canary.length - 1));
    }
  }
  if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
    if (typeof event.delta.partial_json === 'string') {
      const combined = buf ? buf.input_json_delta + event.delta.partial_json : event.delta.partial_json;
      if (combined.includes(canary)) return 'tool_input_delta';
      if (buf) buf.input_json_delta = combined.slice(-(canary.length - 1));
    }
  }
  if (event.type === 'content_block_stop' && buf) {
    // Block boundary — reset the rolling buffer so a canary straddling
    // two independent tool_use blocks isn't inferred.
    buf.text_delta = '';
    buf.input_json_delta = '';
  }
  if (event.type === 'result' && typeof event.result === 'string' && event.result.includes(canary)) {
    return 'result';
  }
  return null;
}

/** Rolling-window tails for delta canary detection. See detectCanaryLeak. */
interface DeltaBuffer {
  text_delta: string;
  input_json_delta: string;
}

interface CanaryContext {
  canary: string;
  pageUrl: string;
  onLeak: (channel: string) => void;
  deltaBuf: DeltaBuffer;
}

interface ToolResultScanContext {
  scan: (toolName: string, text: string) => Promise<void>;
}

/**
 * Per-tab map of tool_use_id → tool name. Lets the tool_result handler
 * know what tool produced the content (Read, Grep, Glob, Bash $B ...) so
 * we can tag attack logs with the ingress source.
 */
const toolUseRegistry = new Map<string, { toolName: string; toolInput: unknown }>();

/**
 * Extract plain-text content from a tool_result block. The Claude stream
 * encodes it as either a string or an array of content blocks (text, image).
 * We care about text — images can't carry prompt injection at this layer.
 */
function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
  }
  return parts.join('\n');
}

/**
 * Tools whose outputs should be ML-scanned. Bash/$B outputs already get
 * scanned via the page-content flow. Read/Glob/Grep outputs have been
 * uncovered — Codex review flagged this gap. Adding coverage here closes it.
 */
const SCANNED_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash', 'WebFetch']);

async function handleStreamEvent(event: any, tabId?: number, canaryCtx?: CanaryContext, toolResultScanCtx?: ToolResultScanContext): Promise<void> {
  // Canary check runs BEFORE any outbound send — we never want to relay
  // a leaked token to the sidepanel UI.
  if (canaryCtx) {
    const channel = detectCanaryLeak(event, canaryCtx.canary, canaryCtx.deltaBuf);
    if (channel) {
      canaryCtx.onLeak(channel);
      return; // drop the event — never relay content that leaked the canary
    }
  }

  if (event.type === 'system' && event.session_id) {
    // Relay claude session ID for --resume support
    await sendEvent({ type: 'system', claudeSessionId: event.session_id }, tabId);
  }

  if (event.type === 'assistant' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'tool_use') {
        // Register the tool_use so we can correlate tool_results back to
        // the originating tool when they arrive in the next user-role message.
        if (block.id) toolUseRegistry.set(block.id, { toolName: block.name, toolInput: block.input });
        await sendEvent({ type: 'tool_use', tool: block.name, input: summarizeToolInput(block.name, block.input) }, tabId);
      } else if (block.type === 'text' && block.text) {
        await sendEvent({ type: 'text', text: block.text }, tabId);
      }
    }
  }

  // Tool results come back in user-role messages. Content can be a string
  // or an array of typed content blocks.
  if (event.type === 'user' && event.message?.content) {
    for (const block of event.message.content) {
      if (block && typeof block === 'object' && block.type === 'tool_result') {
        const meta = block.tool_use_id ? toolUseRegistry.get(block.tool_use_id) : null;
        const toolName = meta?.toolName ?? 'Unknown';
        const text = extractToolResultText(block.content);
        // Scan this tool output with the ML classifier if the tool is in
        // the SCANNED_TOOLS set and the content is non-trivial.
        if (SCANNED_TOOLS.has(toolName) && text.length >= 32 && toolResultScanCtx) {
          // Fire-and-forget — never block the stream handler. If BLOCK
          // fires, onToolResultBlock handles kill + emit.
          toolResultScanCtx.scan(toolName, text).catch(() => {});
        }
        if (block.tool_use_id) toolUseRegistry.delete(block.tool_use_id);
      }
    }
  }

  if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
    if (event.content_block.id) {
      toolUseRegistry.set(event.content_block.id, {
        toolName: event.content_block.name,
        toolInput: event.content_block.input,
      });
    }
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

/**
 * Fire the prompt-injection-detected event to the server. This terminates
 * the session from the sidepanel's perspective and renders the canary leak
 * banner. Also logs locally (salted hash + domain only) and fires telemetry
 * if configured.
 */
async function onCanaryLeaked(params: {
  tabId: number;
  channel: string;
  canary: string;
  pageUrl: string;
}): Promise<void> {
  const { tabId, channel, canary, pageUrl } = params;
  const domain = extractDomain(pageUrl);
  console.warn(`[sidebar-agent] CANARY LEAK detected on ${channel} for tab ${tabId} (domain=${domain || 'unknown'})`);

  // Local log — salted hash + domain only, never the payload
  logAttempt({
    ts: new Date().toISOString(),
    urlDomain: domain,
    payloadHash: hashPayload(canary), // hash the canary, not the payload (which might be leaked content)
    confidence: 1.0,
    layer: 'canary',
    verdict: 'block',
  });

  // Broadcast to sidepanel so it can render the approved banner
  await sendEvent({
    type: 'security_event',
    verdict: 'block',
    reason: 'canary_leaked',
    layer: 'canary',
    channel,
    domain,
  }, tabId);

  // Also emit agent_error so the sidepanel's existing error surface
  // reflects that the session terminated. Keeps old clients working.
  await sendEvent({
    type: 'agent_error',
    error: `Session terminated — prompt injection detected${domain ? ` from ${domain}` : ''}`,
  }, tabId);
}

/**
 * Pre-spawn ML scan of the user message. If the classifier fires at BLOCK,
 * we log the attempt, emit a security_event to the sidepanel, and DO NOT
 * spawn claude. Returns true if the scan blocked the session.
 *
 * Fail-open: any classifier error or degraded state returns false (safe) so
 * the sidebar keeps working. The architectural controls (XML framing +
 * command allowlist, live in server.ts:554-577) still defend.
 */
async function preSpawnSecurityCheck(entry: QueueEntry): Promise<boolean> {
  const { message, canary, pageUrl, tabId } = entry;
  if (!message || message.length === 0) return false;
  const tid = tabId ?? 0;

  // L4: scan the user message for direct injection patterns (TestSavantAI)
  // L4c: also scan with DeBERTa-v3 when ensemble is enabled (opt-in)
  const [contentSignal, debertaSignal] = await Promise.all([
    scanPageContent(message),
    scanPageContentDeberta(message),
  ]);
  const signals: LayerSignal[] = [contentSignal, debertaSignal];

  // L4b: only bother with Haiku if another layer already lit up at >= LOG_ONLY.
  // Saves ~70% of Haiku calls per plan §E1 "gating optimization".
  if (shouldRunTranscriptCheck(signals)) {
    const transcriptSignal = await checkTranscript({
      user_message: message,
      tool_calls: [], // no tool calls yet at session start
    });
    signals.push(transcriptSignal);
  }

  const result = combineVerdict(signals);
  if (result.verdict !== 'block') return false;

  // BLOCK verdict. Log + emit + refuse to spawn.
  const domain = extractDomain(pageUrl ?? '');
  const leaderSignal = signals.reduce((a, b) => (a.confidence > b.confidence ? a : b));

  logAttempt({
    ts: new Date().toISOString(),
    urlDomain: domain,
    payloadHash: hashPayload(message),
    confidence: result.confidence,
    layer: leaderSignal.layer,
    verdict: 'block',
  });

  console.warn(`[sidebar-agent] Pre-spawn BLOCK (${result.reason}) for tab ${tid}, confidence=${result.confidence.toFixed(3)}`);

  await sendEvent({
    type: 'security_event',
    verdict: 'block',
    reason: result.reason ?? 'ml_classifier',
    layer: leaderSignal.layer,
    confidence: result.confidence,
    domain,
  }, tid);
  await sendEvent({
    type: 'agent_error',
    error: `Session blocked — prompt injection detected${domain ? ` from ${domain}` : ' in your message'}`,
  }, tid);

  return true;
}

async function askClaude(queueEntry: QueueEntry): Promise<void> {
  const { prompt, args, stateFile, cwd, tabId, canary, pageUrl } = queueEntry;
  const tid = tabId ?? 0;

  processingTabs.add(tid);
  await sendEvent({ type: 'agent_start' }, tid);

  // Pre-spawn ML scan: if the user message trips the ensemble, refuse to
  // spawn claude. Fail-open on classifier errors.
  if (await preSpawnSecurityCheck(queueEntry)) {
    processingTabs.delete(tid);
    return;
  }

  return new Promise((resolve) => {
    // Canary context is set after proc is spawned (needs proc reference for kill).
    let canaryCtx: CanaryContext | undefined;
    let canaryTriggered = false;

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
    safeUnlink(cancelFile);

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

    // Now that proc exists, set up the canary-leak handler. It fires at most
    // once; on fire we kill the subprocess, emit security_event + agent_error,
    // and let the normal close handler resolve the promise.
    if (canary) {
      canaryCtx = {
        canary,
        pageUrl: pageUrl ?? '',
        deltaBuf: { text_delta: '', input_json_delta: '' },
        onLeak: (channel: string) => {
          if (canaryTriggered) return;
          canaryTriggered = true;
          onCanaryLeaked({ tabId: tid, channel, canary, pageUrl: pageUrl ?? '' });
          try { proc.kill('SIGTERM'); } catch (err: any) { if (err?.code !== 'ESRCH') throw err; }
          setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch (err: any) { if (err?.code !== 'ESRCH') throw err; }
          }, 2000);
        },
      };
    }

    // Tool-result ML scan context. Addresses the Codex review gap: Read,
    // Grep, Glob, and WebFetch outputs enter Claude's context without
    // passing through the Bash $B pipeline that content-security.ts
    // already wraps. Scan them here.
    let toolResultBlockFired = false;
    const toolResultScanCtx: ToolResultScanContext = {
      scan: async (toolName: string, text: string) => {
        if (toolResultBlockFired) return;
        // Parallel L4 + L4c ensemble scan (DeBERTa no-op when disabled).
        // We run L4/L4c AND Haiku in parallel on tool outputs regardless of
        // L4's score, because BrowseSafe-Bench shows L4 (TestSavantAI) has
        // low recall on browser-agent-specific attacks (~15% at v1). Gating
        // Haiku on L4 meant our best signal almost never ran. The cost is
        // ~$0.002 + ~300ms per tool output, bounded by the Haiku timeout
        // and offset by Haiku actually seeing the real attack context.
        //
        // Haiku only runs when the Claude CLI is available (checkHaikuAvailable
        // caches the probe). In environments without it, the call returns a
        // degraded signal and the verdict falls back to L4 alone.
        const [contentSignal, debertaSignal, transcriptSignal] = await Promise.all([
          scanPageContent(text),
          scanPageContentDeberta(text),
          checkTranscript({
            user_message: queueEntry.message ?? '',
            tool_calls: [{ tool_name: toolName, tool_input: {} }],
            tool_output: text,
          }),
        ]);
        const signals: LayerSignal[] = [contentSignal, debertaSignal, transcriptSignal];
        const result = combineVerdict(signals, { toolOutput: true });
        if (result.verdict !== 'block') return;
        toolResultBlockFired = true;
        const domain = extractDomain(pageUrl ?? '');
        const payloadHash = hashPayload(text.slice(0, 4096));

        // Log pending — if the user overrides, we'll update via a separate
        // log line. The attempts.jsonl is append-only so both entries survive.
        logAttempt({
          ts: new Date().toISOString(),
          urlDomain: domain,
          payloadHash,
          confidence: result.confidence,
          layer: 'testsavant_content',
          verdict: 'block',
        });
        console.warn(`[sidebar-agent] Tool-result BLOCK on ${toolName} for tab ${tid} (confidence=${result.confidence.toFixed(3)}) — awaiting user decision`);

        // Surface a REVIEWABLE block event. Sidepanel renders the suspected
        // text + layer scores + [Allow and continue] / [Block session] buttons.
        // The user has 60s to decide; default is BLOCK (safe fallback).
        const layerScores = signals
          .filter((s) => s.confidence > 0)
          .map((s) => ({ layer: s.layer, confidence: s.confidence }));
        await sendEvent({
          type: 'security_event',
          verdict: 'block',
          reason: 'tool_result_ml',
          layer: 'testsavant_content',
          confidence: result.confidence,
          domain,
          tool: toolName,
          reviewable: true,
          suspected_text: excerptForReview(text),
          signals: layerScores,
        }, tid);

        // Poll for the user's decision. Default to BLOCK on timeout.
        const REVIEW_TIMEOUT_MS = 60_000;
        const POLL_MS = 500;
        clearDecision(tid); // clear any stale decision from a prior session
        const deadline = Date.now() + REVIEW_TIMEOUT_MS;
        let decision: 'allow' | 'block' = 'block';
        let decisionReason = 'timeout';
        while (Date.now() < deadline) {
          const rec = readDecision(tid);
          if (rec?.decision === 'allow' || rec?.decision === 'block') {
            decision = rec.decision;
            decisionReason = rec.reason ?? 'user';
            break;
          }
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
        clearDecision(tid);

        if (decision === 'allow') {
          // User overrode. Log the override so the audit trail captures it.
          // toolResultBlockFired stays true so we don't re-prompt within the
          // same message — one override per BLOCK event.
          logAttempt({
            ts: new Date().toISOString(),
            urlDomain: domain,
            payloadHash,
            confidence: result.confidence,
            layer: 'testsavant_content',
            verdict: 'user_overrode',
          });
          await sendEvent({
            type: 'security_event',
            verdict: 'user_overrode',
            reason: 'tool_result_ml',
            layer: 'testsavant_content',
            confidence: result.confidence,
            domain,
            tool: toolName,
          }, tid);
          console.warn(`[sidebar-agent] Tab ${tid}: user overrode BLOCK — session continues`);
          // Let the block stay consumed; reset the flag so subsequent tool
          // results get scanned fresh.
          toolResultBlockFired = false;
          return;
        }

        // User chose BLOCK (or timed out). Kill the session as before.
        await sendEvent({
          type: 'agent_error',
          error: `Session terminated — prompt injection detected in ${toolName} output${decisionReason === 'timeout' ? ' (review timeout)' : ''}`,
        }, tid);
        try { proc.kill('SIGTERM'); } catch (err: any) { if (err?.code !== 'ESRCH') throw err; }
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch (err: any) { if (err?.code !== 'ESRCH') throw err; }
        }, 2000);
      },
    };

    // Poll for per-tab cancel signal from server's killAgent()
    const cancelCheck = setInterval(() => {
      try {
        if (fs.existsSync(cancelFile)) {
          console.log(`[sidebar-agent] Cancel signal received for tab ${tid} — killing claude subprocess`);
          try { proc.kill('SIGTERM'); } catch (err: any) { if (err?.code !== 'ESRCH') throw err; }
          setTimeout(() => { try { proc.kill('SIGKILL'); } catch (err: any) { if (err?.code !== 'ESRCH') throw err; } }, 3000);
          fs.unlinkSync(cancelFile);
          clearInterval(cancelCheck);
        }
      } catch (err: any) { if (err?.code !== 'ENOENT') throw err; }
    }, 500);

    let buffer = '';

    proc.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { handleStreamEvent(JSON.parse(line), tid, canaryCtx, toolResultScanCtx); } catch (err: any) {
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
        try { handleStreamEvent(JSON.parse(buffer), tid, canaryCtx, toolResultScanCtx); } catch (err: any) {
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
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch (err: any) { if (err?.code !== 'ESRCH') throw err; } }, 3000);
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
          try { proc.kill('SIGTERM'); } catch (err: any) { if (err?.code !== 'ESRCH') throw err; }
          setTimeout(() => { try { proc.kill('SIGKILL'); } catch (err: any) { if (err?.code !== 'ESRCH') throw err; } }, 2000);
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
  try { fs.chmodSync(QUEUE, 0o600); } catch (err: any) { if (err?.code !== 'ENOENT') throw err; }

  lastLine = countLines();
  await refreshToken();

  console.log(`[sidebar-agent] Started. Watching ${QUEUE} from line ${lastLine}`);
  console.log(`[sidebar-agent] Server: ${SERVER_URL}`);
  console.log(`[sidebar-agent] Browse binary: ${B}`);

  // If GSTACK_SECURITY_ENSEMBLE=deberta is set, also warm the DeBERTa-v3
  // ensemble classifier. Fire-and-forget alongside TestSavantAI — they
  // warm in parallel. No-op when the env var is unset.
  loadDeberta((msg) => console.log(`[security-classifier] ${msg}`))
    .catch((err) => console.warn('[sidebar-agent] DeBERTa warmup failed:', err?.message));

  // Warm up the ML classifier in the background. First call triggers a 112MB
  // download (~30s on average broadband). Non-blocking — the sidebar stays
  // functional on cold start; classifier just reports 'off' until warmed.
  //
  // On warmup completion (success or failure), write the classifier status to
  // ~/.gstack/security/session-state.json so server.ts's /health endpoint can
  // report it to the sidepanel for shield icon rendering.
  loadTestsavant((msg) => console.log(`[security-classifier] ${msg}`))
    .then(() => {
      const s = getClassifierStatus();
      console.log(`[sidebar-agent] Classifier warmup complete: ${JSON.stringify(s)}`);
      const existing = readSessionState();
      writeSessionState({
        sessionId: existing?.sessionId ?? String(process.pid),
        canary: existing?.canary ?? '',
        warnedDomains: existing?.warnedDomains ?? [],
        classifierStatus: s,
        lastUpdated: new Date().toISOString(),
      });
    })
    .catch((err) => console.warn('[sidebar-agent] Classifier warmup failed (degraded mode):', err?.message));

  setInterval(poll, POLL_MS);
  setInterval(pollKillFile, POLL_MS);
}

main().catch(console.error);
