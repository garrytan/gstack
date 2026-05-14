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
import { handleCookiePickerRoute, hasActivePicker } from './cookie-picker-routes';
import { sanitizeExtensionUrl } from './sidebar-utils';
import { COMMAND_DESCRIPTIONS, PAGE_CONTENT_COMMANDS, DOM_CONTENT_COMMANDS, wrapUntrustedContent, canonicalizeCommand, buildUnknownCommandError, ALL_COMMANDS } from './commands';
import {
  wrapUntrustedPageContent, datamarkContent,
  runContentFilters, type ContentFilterResult,
  markHiddenElements, getCleanTextWithStripping, cleanupHiddenMarkers,
} from './content-security';
import { generateCanary, injectCanary, getStatus as getSecurityStatus, writeDecision } from './security';
import { writeSecureFile, mkdirSecure } from './file-permissions';
import { handleSnapshot, SNAPSHOT_FLAGS } from './snapshot';
import {
  initRegistry, validateToken as validateScopedToken, checkScope, checkDomain,
  checkRate, createToken, createSetupKey, exchangeSetupKey, revokeToken,
  rotateRoot, listTokens, serializeRegistry, restoreRegistry, recordCommand,
  isRootToken, checkConnectRateLimit, type TokenInfo,
} from './token-registry';
import { validateTempPath } from './path-security';
import { resolveConfig, ensureStateDir, readVersionHash, resolveChromiumProfile, cleanSingletonLocks } from './config';
import { emitActivity, subscribe, getActivityAfter, getActivityHistory, getSubscriberCount } from './activity';
import { initAuditLog, writeAuditEntry } from './audit';
import { inspectElement, modifyStyle, resetModifications, getModificationHistory, detachSession, type InspectorResult } from './cdp-inspector';
// Bun.spawn used instead of child_process.spawn (compiled bun binaries
// fail posix_spawn on all executables including /bin/bash)
import { safeUnlink, safeUnlinkQuiet, safeKill } from './error-handling';
import { startSocksBridge, testUpstream, type BridgeHandle } from './socks-bridge';
import { parseProxyConfig, toUpstreamConfig, ProxyConfigError } from './proxy-config';
import { redactProxyUrl } from './proxy-redact';
import { shouldSpawnXvfb, pickFreeDisplay, spawnXvfb, xvfbInstallHint, type XvfbHandle } from './xvfb';
import { logTunnelDenial } from './tunnel-denial-log';
import {
  mintSseSessionToken, validateSseSessionToken, extractSseCookie,
  buildSseSetCookie, SSE_COOKIE_NAME,
} from './sse-session-cookie';
import {
  mintPtySessionToken, buildPtySetCookie, revokePtySessionToken,
} from './pty-session-cookie';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as crypto from 'crypto';

// ─── Config ─────────────────────────────────────────────────────
const config = resolveConfig();
ensureStateDir(config);
initAuditLog(config.auditLog);

// ─── Auth ───────────────────────────────────────────────────────
// AUTH_TOKEN is injectable via process.env.AUTH_TOKEN so embedders
// (gbrowser's gbd daemon spawn) can pre-allocate the token and hand it to
// the Bun child via env.
//
// Validation: require >= 16 chars after stripping ALL unicode whitespace
// (not just ASCII — .trim() misses U+200B / U+FEFF / U+00A0 / etc., which
// would otherwise let a misconfigured embedder ship a one-character BOM as
// the bearer secret). Reject tokens that are too short or contain only
// whitespace; fall back to randomUUID so the security boundary is never
// silently weakened by misconfiguration.
function sanitizeAuthToken(raw: string | undefined): string | null {
  if (!raw) return null;
  const stripped = raw.replace(/[\s ​-‍﻿]/g, '');
  if (stripped.length < 16) return null;
  return stripped;
}
const AUTH_TOKEN = sanitizeAuthToken(process.env.AUTH_TOKEN) || crypto.randomUUID();
initRegistry(AUTH_TOKEN);
const BROWSE_PORT = parseInt(process.env.BROWSE_PORT || '0', 10);
const IDLE_TIMEOUT_MS = parseInt(process.env.BROWSE_IDLE_TIMEOUT || '1800000', 10); // 30 min

/**
 * Port the local listener bound to. Set once the daemon picks a port.
 * Used by `$B skill run` to point spawned skill scripts at the daemon over
 * loopback. Module-level so handleCommandInternal can read it without threading
 * the port through every dispatch.
 */
let LOCAL_LISTEN_PORT: number = 0;
// Sidebar chat is always enabled in headed mode (ungated in v0.12.0)

// ─── Tunnel State ───────────────────────────────────────────────
//
// Dual-listener architecture: the daemon binds TWO HTTP listeners when a
// tunnel is active. The local listener serves bootstrap + CLI + sidebar
// (never exposed to ngrok). The tunnel listener serves only the pairing
// ceremony and scoped-token command endpoints (the ONLY port ngrok forwards).
//
// Security property comes from physical port separation: a tunnel caller
// cannot reach bootstrap endpoints because they live on a different TCP
// socket, not because of any per-request check.
let tunnelActive = false;
let tunnelUrl: string | null = null;
let tunnelListener: any = null;           // ngrok listener handle
let tunnelServer: ReturnType<typeof Bun.serve> | null = null; // tunnel HTTP listener

/** Which HTTP listener accepted this request. */
export type Surface = 'local' | 'tunnel';

/**
 * Factory contract for embedders (gbrowser phoenix overlay).
 *
 * Today the CLI calls `start()` which reads env vars and binds Bun.serve
 * itself. Embedders building on this server as a submodule (gbrowser's
 * fd-passing gbd architecture) need to inject auth + ports + a
 * BrowserManager they pre-launched, and own the listener themselves.
 *
 * Status: v1 surfaces this type as documentation. AUTH_TOKEN env-injection
 * is already live (see ~L70). `start()` is exported and the kickoff /
 * signal-handler registration is gated on `import.meta.main`, so phoenix
 * can `import { start } from '.../server'` without auto-starting. Full
 * `buildFetchHandler` extraction lands in a follow-up; see plan
 * `/Users/garrytan/.claude/plans/system-instruction-you-are-working-swirling-fountain.md`
 * Part 1.
 */
export interface ServerConfig {
  /** Bearer token clients must present. Today injected via AUTH_TOKEN env. */
  authToken: string;
  /** Local listener port. Used in /welcome URL + state-file. */
  browsePort: number;
  /** Idle shutdown timeout. Default 30 min. */
  idleTimeoutMs: number;
  /** Result of resolveConfig() — stateDir, auditLog, stateFile. */
  config: ReturnType<typeof resolveConfig>;
  /** Pre-launched BrowserManager. Caller owns lifecycle. */
  browserManager: BrowserManager;
  /** Optional Chromium profile path override. Resolved by resolveChromiumProfile(). */
  chromiumProfile?: string;
  /** Caller-owned. shutdown() does NOT call xvfb.stop(); caller is responsible. */
  xvfb?: XvfbHandle | null;
  /** Caller-owned. shutdown() does NOT call proxyBridge.close(); caller is responsible. */
  proxyBridge?: BridgeHandle | null;
  startTime: number;
  /**
   * Overlay hook. Runs AFTER gstack resolves auth and BEFORE route dispatch.
   * Invalid tokens are auto-rejected at the gstack layer (401 returned
   * before hook fires), so the hook only ever sees valid TokenInfo or null
   * (no token presented). Returning a Response short-circuits gstack
   * dispatch; returning null falls through.
   */
  beforeRoute?: (req: Request, surface: Surface, auth: TokenInfo | null) => Promise<Response | null>;
}

/**
 * Return shape of buildFetchHandler() — fetch handlers + lifecycle helpers
 * embedders need to drive their own Bun.serve binding. See ServerConfig.
 */
export interface ServerHandle {
  fetchLocal: (req: Request, server: any) => Promise<Response>;
  fetchTunnel: (req: Request, server: any) => Promise<Response>;
  /**
   * Drains buffers, kills terminal-agent, closes browser, clears intervals,
   * removes state files. Does NOT stop bound Bun.Server listeners — call
   * stopListeners() for that. CLI relies on process.exit() to drop sockets.
   */
  shutdown: (exitCode?: number) => Promise<void>;
  /**
   * Graceful listener stop for embedders. Calls server.stop(true) on each
   * passed Bun.Server. CLI doesn't need this (process.exit handles it).
   */
  stopListeners: (local: any, tunnel?: any) => Promise<void>;
}

/**
 * Build a ServerConfig-shaped object from process.env. Used by gstack's
 * own CLI when running `bun run dev` or the compiled binary directly.
 * Embedders construct their own ServerConfig explicitly.
 *
 * Reads env, calls resolveConfig(). Does NOT bind a listener or call
 * initAuditLog/initRegistry — those happen inside the buildFetchHandler
 * lifecycle.
 */
export function resolveConfigFromEnv(): Omit<ServerConfig, 'browserManager' | 'startTime'> & {
  config: ReturnType<typeof resolveConfig>;
} {
  return {
    // Same sanitizer as the module-level AUTH_TOKEN: strips ALL unicode
    // whitespace and rejects tokens shorter than 16 chars so a misconfigured
    // embedder can't ship a BOM/zero-width as the bearer secret.
    authToken: sanitizeAuthToken(process.env.AUTH_TOKEN) || crypto.randomUUID(),
    browsePort: parseInt(process.env.BROWSE_PORT || '0', 10),
    idleTimeoutMs: parseInt(process.env.BROWSE_IDLE_TIMEOUT || '1800000', 10),
    config: resolveConfig(),
  };
}

/**
 * Paths reachable over the tunnel surface. Everything else returns 404.
 *
 * `/connect` is the only unauthenticated tunnel endpoint — POST for setup-key
 * exchange, GET for an `{alive: true}` probe used by /pair and /tunnel/start
 * to detect dead ngrok tunnels. Other paths in this set require a scoped
 * token via Authorization: Bearer.
 *
 * Updating this set is a deliberate security decision. Every addition widens
 * the tunnel attack surface.
 */
const TUNNEL_PATHS = new Set<string>([
  '/connect',
  '/command',
  '/sidebar-chat',
]);

/**
 * Commands reachable via POST /command over the tunnel surface. A paired
 * remote agent can drive the browser (goto, click, text, etc.) but cannot
 * configure the daemon, bootstrap new sessions, import cookies, or reach
 * extension-inspector state. This allowlist maps to the eng-review decision
 * logged in the CEO plan for sec-wave v1.6.0.0.
 */
export const TUNNEL_COMMANDS = new Set<string>([
  // Original 17
  'goto', 'click', 'text', 'screenshot',
  'html', 'links', 'forms', 'accessibility',
  'attrs', 'media', 'data',
  'scroll', 'press', 'type', 'select', 'wait', 'eval',
  // Tab + navigation primitives operator docs and CLI hints already promised
  'newtab', 'tabs', 'back', 'forward', 'reload',
  // Read/inspect/write operators paired agents need to be useful
  'snapshot', 'fill', 'url', 'closetab',
]);

/**
 * Pure gate: returns true iff the command is reachable over the tunnel surface.
 * Extracted from the inline /command handler so the gate logic is unit-testable
 * without standing up an HTTP listener. Behavior is identical to the inline
 * check; the function canonicalizes the command (so aliases hit the same set)
 * and returns false for null/undefined input.
 */
export function canDispatchOverTunnel(command: string | undefined | null): boolean {
  if (typeof command !== 'string' || command.length === 0) return false;
  const cmd = canonicalizeCommand(command);
  return TUNNEL_COMMANDS.has(cmd);
}

/**
 * Read ngrok authtoken from env var, ~/.gstack/ngrok.env, or ngrok's native
 * config files.  Returns null if nothing found.  Shared between the
 * /tunnel/start handler and the BROWSE_TUNNEL=1 auto-start flow.
 */
function resolveNgrokAuthtoken(): string | null {
  let authtoken = process.env.NGROK_AUTHTOKEN;
  if (authtoken) return authtoken;

  const home = process.env.HOME || '';
  const ngrokEnvPath = path.join(home, '.gstack', 'ngrok.env');
  if (fs.existsSync(ngrokEnvPath)) {
    try {
      const envContent = fs.readFileSync(ngrokEnvPath, 'utf-8');
      const match = envContent.match(/^NGROK_AUTHTOKEN=(.+)$/m);
      if (match) return match[1].trim();
    } catch {}
  }

  const ngrokConfigs = [
    path.join(home, 'Library', 'Application Support', 'ngrok', 'ngrok.yml'),
    path.join(home, '.config', 'ngrok', 'ngrok.yml'),
    path.join(home, '.ngrok2', 'ngrok.yml'),
  ];
  for (const conf of ngrokConfigs) {
    try {
      const content = fs.readFileSync(conf, 'utf-8');
      const match = content.match(/authtoken:\s*(.+)/);
      if (match) return match[1].trim();
    } catch {}
  }
  return null;
}

/**
 * Tear down the tunnel: close the ngrok listener and stop the tunnel-surface
 * Bun.serve listener.  Safe to call with nothing running.  Always clears
 * tunnel state regardless of individual close failures.
 */
async function closeTunnel(): Promise<void> {
  try { if (tunnelListener) await tunnelListener.close(); } catch {}
  try { if (tunnelServer) tunnelServer.stop(true); } catch {}
  tunnelListener = null;
  tunnelServer = null;
  tunnelUrl = null;
  tunnelActive = false;
}

function validateAuth(req: Request): boolean {
  const header = req.headers.get('authorization');
  return header === `Bearer ${AUTH_TOKEN}`;
}

/**
 * Terminal-agent discovery. The non-compiled bun process at
 * `browse/src/terminal-agent.ts` writes its chosen port to
 * `<stateDir>/terminal-port` and the loopback handshake token to
 * `<stateDir>/terminal-internal-token` once it boots. Read on demand —
 * lazy so we don't break tests that don't spawn the agent.
 */
function readTerminalPort(): number | null {
  try {
    const f = path.join(path.dirname(config.stateFile), 'terminal-port');
    const v = parseInt(fs.readFileSync(f, 'utf-8').trim(), 10);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
}
function readTerminalInternalToken(): string | null {
  try {
    const f = path.join(path.dirname(config.stateFile), 'terminal-internal-token');
    const t = fs.readFileSync(f, 'utf-8').trim();
    return t.length > 16 ? t : null;
  } catch { return null; }
}

/**
 * Push a freshly-minted PTY cookie token to the terminal-agent so its
 * /ws upgrade can validate the cookie. Loopback POST authenticated with
 * the internal token written by the agent at startup. Fire-and-forget;
 * if the agent isn't up yet, the extension just retries /pty-session.
 */
async function grantPtyToken(token: string): Promise<boolean> {
  const port = readTerminalPort();
  const internal = readTerminalInternalToken();
  if (!port || !internal) return false;
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/internal/grant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${internal}`,
      },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(2000),
    });
    return resp.ok;
  } catch { return false; }
}

/** Extract bearer token from request. Returns the token string or null. */
function extractToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7);
}

/** Validate token and return TokenInfo. Returns null if invalid/expired. */
function getTokenInfo(req: Request): TokenInfo | null {
  const token = extractToken(req);
  if (!token) return null;
  return validateScopedToken(token);
}

/** Check if request is from root token (local use). */
function isRootRequest(req: Request): boolean {
  const token = extractToken(req);
  return token !== null && isRootToken(token);
}

// Sidebar model router was here (sonnet vs opus by message intent). Ripped
// alongside the chat queue; the interactive PTY just runs whatever model
// the user's `claude` CLI is configured with.

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

/**
 * Per-process state-file temp path. The state-file write pattern is
 * `writeFileSync(tmp, ...) → renameSync(tmp, stateFile)` for atomicity,
 * but a shared `${stateFile}.tmp` filename means two concurrent writers
 * (cold-start race when N CLIs hit a fresh repo simultaneously, parallel
 * /tunnel/start handlers, or a combination) collide on the rename: the
 * first writer's renameSync moves the shared temp file out of the way,
 * the second writer's writeFileSync re-creates it, the second rename
 * then races with the first writer's already-renamed state. Worst case
 * the second renameSync throws ENOENT mid-air, killing one of the
 * spawning daemons during startup.
 *
 * Per-process suffix (pid + 4 random bytes) makes each writer's temp
 * path unique. The atomic rename still gives last-writer-wins semantics
 * for the final state.json content; the only behavior change is that
 * concurrent writers no longer kill each other on the rename.
 */
function tmpStatePath(): string {
  return `${config.stateFile}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
}


// ─── Sidebar agent / chat state ripped ──────────────────────────────
// ChatEntry, SidebarSession, TabAgentState interfaces; chatBuffer,
// chatBuffers, sidebarSession, agentProcess, agentStatus, agentStartTime,
// agentTabId, messageQueue, currentMessage, tabAgents; addChatEntry,
// loadSession, createSession, persistSession, processAgentEvent,
// killAgent, listSessions, getTabAgent, getTabAgentStatus, and the
// agentHealthInterval all lived here. Replaced by the live PTY in
// terminal-agent.ts; chat queue + per-tab agent multiplexing are no
// longer needed.

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
  } catch (err: any) {
    console.error('[browse] Buffer flush failed:', err.message);
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
  // Headed mode: the user is looking at the browser. Never auto-die.
  // Only shut down when the user explicitly disconnects or closes the window.
  if (browserManager.getConnectionMode() === 'headed') return;
  // Tunnel mode: remote agents may send commands sporadically. Never auto-die.
  if (tunnelActive) return;
  if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
    console.log(`[browse] Idle for ${IDLE_TIMEOUT_MS / 1000}s, shutting down`);
    shutdown();
  }
}, 60_000);

// ─── Parent-Process Watchdog ────────────────────────────────────────
// When the spawning CLI process (e.g. a Claude Code session) exits, this
// server can become an orphan — keeping chrome-headless-shell alive and
// causing console-window flicker on Windows. Poll the parent PID every 15s
// and self-terminate if it is gone.
//
// Headed mode (BROWSE_HEADED=1 or BROWSE_PARENT_PID=0): The user controls
// the browser window lifecycle. The CLI exits immediately after connect,
// so the watchdog would kill the server prematurely. Disabled in both cases
// as defense-in-depth — the CLI sets PID=0 for headed mode, and the server
// also checks BROWSE_HEADED in case a future launcher forgets.
// Cleanup happens via browser disconnect event or $B disconnect.
const BROWSE_PARENT_PID = parseInt(process.env.BROWSE_PARENT_PID || '0', 10);
// Outer gate: if the spawner explicitly marks this as headed (env var set at
// launch time), skip registering the watchdog entirely. Cheaper than entering
// the closure every 15s. The CLI's connect path sets BROWSE_HEADED=1 + PID=0,
// so this branch is the normal path for /open-gstack-browser.
const IS_HEADED_WATCHDOG = process.env.BROWSE_HEADED === '1';
if (BROWSE_PARENT_PID > 0 && !IS_HEADED_WATCHDOG) {
  let parentGone = false;
  setInterval(() => {
    try {
      process.kill(BROWSE_PARENT_PID, 0); // signal 0 = existence check only, no signal sent
    } catch {
      // Parent exited. Resolution order:
      // 1. Active cookie picker (one-time code or session live)? Stay alive
      //    regardless of mode — tearing down the server mid-import leaves the
      //    picker UI with a stale "Failed to fetch" error.
      // 2. Headed / tunnel mode? Shutdown. The idle timeout doesn't apply in
      //    these modes (see idleCheckInterval above — both early-return), so
      //    ignoring parent death here would leak orphan daemons after
      //    /pair-agent or /open-gstack-browser sessions.
      // 3. Normal (headless) mode? Stay alive. Claude Code's Bash tool kills
      //    the parent shell between invocations. The idle timeout (30 min)
      //    handles eventual cleanup.
      if (hasActivePicker()) return;
      const headed = browserManager.getConnectionMode() === 'headed';
      if (headed || tunnelActive) {
        console.log(`[browse] Parent process ${BROWSE_PARENT_PID} exited in ${headed ? 'headed' : 'tunnel'} mode, shutting down`);
        shutdown();
      } else if (!parentGone) {
        parentGone = true;
        console.log(`[browse] Parent process ${BROWSE_PARENT_PID} exited (server stays alive, idle timeout will clean up)`);
      }
    }
  }, 15_000);
} else if (IS_HEADED_WATCHDOG) {
  console.log('[browse] Parent-process watchdog disabled (headed mode)');
} else if (BROWSE_PARENT_PID === 0) {
  console.log('[browse] Parent-process watchdog disabled (BROWSE_PARENT_PID=0)');
}

// ─── Command Sets (from commands.ts — single source of truth) ───
import { READ_COMMANDS, WRITE_COMMANDS, META_COMMANDS } from './commands';
export { READ_COMMANDS, WRITE_COMMANDS, META_COMMANDS };

// ─── Inspector State (in-memory) ──────────────────────────────
let inspectorData: InspectorResult | null = null;
let inspectorTimestamp: number = 0;

// Inspector SSE subscribers
type InspectorSubscriber = (event: any) => void;
const inspectorSubscribers = new Set<InspectorSubscriber>();

function emitInspectorEvent(event: any): void {
  for (const notify of inspectorSubscribers) {
    queueMicrotask(() => {
      try { notify(event); } catch (err: any) {
        console.error('[browse] Inspector event subscriber threw:', err.message);
      }
    });
  }
}

// ─── Server ────────────────────────────────────────────────────
const browserManager = new BrowserManager();
// When the user closes the headed browser window, run full cleanup
// (kill sidebar-agent, save session, remove profile locks, delete state file)
// before exiting with code 2. Exit code 2 distinguishes user-close from crashes (1).
browserManager.onDisconnect = () => shutdown(2);
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

/** Internal command result — used by handleCommand and chain subcommand routing */
interface CommandResult {
  status: number;
  result: string;
  headers?: Record<string, string>;
  json?: boolean; // true if result is JSON (errors), false for text/plain
}

/**
 * Core command execution logic. Returns a structured result instead of HTTP Response.
 * Used by both the HTTP handler (handleCommand) and chain subcommand routing.
 *
 * Options:
 *   skipRateCheck: true when called from chain (chain counts as 1 request)
 *   skipActivity: true when called from chain (chain emits 1 event for all subcommands)
 *   chainDepth: recursion guard — reject nested chains (depth > 0 means inside a chain)
 */
async function handleCommandInternal(
  body: { command: string; args?: string[]; tabId?: number },
  tokenInfo?: TokenInfo | null,
  opts?: { skipRateCheck?: boolean; skipActivity?: boolean; chainDepth?: number },
): Promise<CommandResult> {
  const { args = [], tabId } = body;
  const rawCommand = body.command;

  if (!rawCommand) {
    return { status: 400, result: JSON.stringify({ error: 'Missing "command" field' }), json: true };
  }

  // ─── Alias canonicalization (before scope, watch, tab-ownership, dispatch) ─
  // Agent-friendly names like 'setcontent' route to canonical 'load-html'. Must
  // happen BEFORE scope check so a read-scoped token calling 'setcontent' is still
  // rejected (load-html lives in SCOPE_WRITE). Audit logging preserves rawCommand
  // so the trail records what the agent actually typed.
  const command = canonicalizeCommand(rawCommand);
  const isAliased = command !== rawCommand;

  // ─── Recursion guard: reject nested chains ──────────────────
  if (command === 'chain' && (opts?.chainDepth ?? 0) > 0) {
    return { status: 400, result: JSON.stringify({ error: 'Nested chain commands are not allowed' }), json: true };
  }

  // ─── Scope check (for scoped tokens) ──────────────────────────
  if (tokenInfo && tokenInfo.clientId !== 'root') {
    if (!checkScope(tokenInfo, command)) {
      return {
        status: 403, json: true,
        result: JSON.stringify({
          error: `Command "${command}" not allowed by your token scope`,
          hint: `Your scopes: ${tokenInfo.scopes.join(', ')}. Ask the user to re-pair with --admin for eval/cookies/storage access.`,
        }),
      };
    }

    // Domain check for navigation commands
    if ((command === 'goto' || command === 'newtab') && args[0]) {
      if (!checkDomain(tokenInfo, args[0])) {
        return {
          status: 403, json: true,
          result: JSON.stringify({
            error: `Domain not allowed by your token scope`,
            hint: `Allowed domains: ${tokenInfo.domains?.join(', ') || 'none configured'}`,
          }),
        };
      }
    }

    // Rate check (skipped for chain subcommands — chain counts as 1 request)
    if (!opts?.skipRateCheck) {
      const rateResult = checkRate(tokenInfo);
      if (!rateResult.allowed) {
        return {
          status: 429, json: true,
          result: JSON.stringify({
            error: 'Rate limit exceeded',
            hint: `Max ${tokenInfo.rateLimit} requests/second. Retry after ${rateResult.retryAfterMs}ms.`,
          }),
          headers: { 'Retry-After': String(Math.ceil((rateResult.retryAfterMs || 1000) / 1000)) },
        };
      }
    }

    // Record command execution for idempotent key exchange tracking
    if (!opts?.skipRateCheck && tokenInfo.token) recordCommand(tokenInfo.token);
  }

  // Pin to a specific tab if requested (set by BROWSE_TAB env var in sidebar agents).
  // This prevents parallel agents from interfering with each other's tab context.
  // Safe because Bun's event loop is single-threaded — no concurrent handleCommand.
  let savedTabId: number | null = null;
  if (tabId !== undefined && tabId !== null) {
    savedTabId = browserManager.getActiveTabId();
    // bringToFront: false — internal tab pinning must NOT steal window focus
    try { browserManager.switchTab(tabId, { bringToFront: false }); } catch (err: any) {
      console.warn('[browse] Failed to pin tab', tabId, ':', err.message);
    }
  }

  // ─── Tab ownership check (own-only tokens / pair-agent isolation) ──
  //
  // Only `own-only` tokens (pair-agent over tunnel) are bound to their own
  // tabs. `shared` tokens — the default for skill spawns and local scoped
  // clients — can drive any tab; the capability gate (scope checks above)
  // and rate limits already constrain what they can do.
  //
  // Skip for `newtab` — it creates a tab rather than accessing one.
  if (command !== 'newtab' && tokenInfo && tokenInfo.clientId !== 'root' && tokenInfo.tabPolicy === 'own-only') {
    const targetTab = tabId ?? browserManager.getActiveTabId();
    if (!browserManager.checkTabAccess(targetTab, tokenInfo.clientId, { isWrite: WRITE_COMMANDS.has(command), ownOnly: true })) {
      return {
        status: 403, json: true,
        result: JSON.stringify({
          error: 'Tab not owned by your agent. Use newtab to create your own tab.',
          hint: `Tab ${targetTab} is owned by ${browserManager.getTabOwner(targetTab) || 'root'}. Your agent: ${tokenInfo.clientId}.`,
        }),
      };
    }
  }

  // ─── newtab with ownership for scoped tokens ──────────────
  if (command === 'newtab' && tokenInfo && tokenInfo.clientId !== 'root') {
    const newId = await browserManager.newTab(args[0] || undefined, tokenInfo.clientId);
    return {
      status: 200, json: true,
      result: JSON.stringify({
        tabId: newId,
        owner: tokenInfo.clientId,
        hint: 'Include "tabId": ' + newId + ' in subsequent commands to target this tab.',
      }),
    };
  }

  // Block mutation commands while watching (read-only observation mode)
  if (browserManager.isWatching() && WRITE_COMMANDS.has(command)) {
    return {
      status: 400, json: true,
      result: JSON.stringify({ error: 'Cannot run mutation commands while watching. Run `$B watch stop` first.' }),
    };
  }

  // Activity: emit command_start (skipped for chain subcommands)
  const startTime = Date.now();
  if (!opts?.skipActivity) {
    emitActivity({
      type: 'command_start',
      command,
      args,
      url: browserManager.getCurrentUrl(),
      tabs: browserManager.getTabCount(),
      mode: browserManager.getConnectionMode(),
      clientId: tokenInfo?.clientId,
    });
  }

  try {
    let result: string;

    const session = browserManager.getActiveSession();

    // Per-request warnings collected during hidden-element detection,
    // surfaced into the envelope the LLM sees. Carries across the read
    // phase into the centralized wrap block below.
    let hiddenContentWarnings: string[] = [];

    if (READ_COMMANDS.has(command)) {
      const isScoped = tokenInfo && tokenInfo.clientId !== 'root';
      // Hidden-element / ARIA-injection detection for every scoped
      // DOM-reading channel (text, html, links, forms, accessibility,
      // attrs, data, media, ux-audit). Previously only `text` received
      // stripping; other channels let hidden injection payloads reach
      // the LLM despite the envelope wrap. Detections become CONTENT
      // WARNINGS on the outgoing envelope so the model can see what it
      // would have otherwise trusted silently.
      if (isScoped && DOM_CONTENT_COMMANDS.has(command)) {
        const page = session.getPage();
        try {
          const strippedDescs = await markHiddenElements(page);
          if (strippedDescs.length > 0) {
            console.warn(`[browse] Content security: ${strippedDescs.length} hidden elements flagged on ${command} for ${tokenInfo.clientId}`);
            hiddenContentWarnings = strippedDescs.slice(0, 8).map(d =>
              `hidden content: ${d.slice(0, 120)}`,
            );
            if (strippedDescs.length > 8) {
              hiddenContentWarnings.push(`hidden content: +${strippedDescs.length - 8} more flagged elements`);
            }
          }
          if (command === 'text') {
            const target = session.getActiveFrameOrPage();
            result = await getCleanTextWithStripping(target);
          } else {
            result = await handleReadCommand(command, args, session, browserManager);
          }
        } finally {
          await cleanupHiddenMarkers(page);
        }
      } else {
        result = await handleReadCommand(command, args, session, browserManager);
      }
    } else if (WRITE_COMMANDS.has(command)) {
      result = await handleWriteCommand(command, args, session, browserManager);
    } else if (META_COMMANDS.has(command)) {
      // Pass chain depth + executeCommand callback so chain routes subcommands
      // through the full security pipeline (scope, domain, tab, wrapping).
      const chainDepth = (opts?.chainDepth ?? 0);
      result = await handleMetaCommand(command, args, browserManager, shutdown, tokenInfo, {
        chainDepth,
        daemonPort: LOCAL_LISTEN_PORT,
        executeCommand: (body, ti) => handleCommandInternal(body, ti, {
          skipRateCheck: true,    // chain counts as 1 request
          skipActivity: true,     // chain emits 1 event for all subcommands
          chainDepth: chainDepth + 1,  // recursion guard
        }),
      });
      // Start periodic snapshot interval when watch mode begins
      if (command === 'watch' && args[0] !== 'stop' && browserManager.isWatching()) {
        const watchInterval = setInterval(async () => {
          if (!browserManager.isWatching()) {
            clearInterval(watchInterval);
            return;
          }
          try {
            const snapshot = await handleSnapshot(['-i'], browserManager.getActiveSession());
            browserManager.addWatchSnapshot(snapshot);
          } catch {
            // Page may be navigating — skip this snapshot
          }
        }, 5000);
        browserManager.watchInterval = watchInterval;
      }
    } else if (command === 'help') {
      const helpText = generateHelpText();
      return { status: 200, result: helpText };
    } else {
      // Use the rich unknown-command helper: names the input, suggests the closest
      // match via Levenshtein (≤ 2 distance, ≥ 4 chars input), and appends an upgrade
      // hint if the command is listed in NEW_IN_VERSION.
      return {
        status: 400, json: true,
        result: JSON.stringify({
          error: buildUnknownCommandError(rawCommand, ALL_COMMANDS),
          hint: `Available commands: ${[...READ_COMMANDS, ...WRITE_COMMANDS, ...META_COMMANDS].sort().join(', ')}`,
        }),
      };
    }

    // ─── Centralized content wrapping (single location for all commands) ───
    // Scoped tokens: content filter + enhanced envelope + datamarking
    // Root tokens: basic untrusted content wrapper (backward compat)
    // Chain exempt from top-level wrapping (each subcommand wrapped individually)
    if (PAGE_CONTENT_COMMANDS.has(command) && command !== 'chain') {
      const isScoped = tokenInfo && tokenInfo.clientId !== 'root';
      if (isScoped) {
        // Run content filters
        const filterResult: ContentFilterResult = runContentFilters(
          result, browserManager.getCurrentUrl(), command,
        );
        if (filterResult.blocked) {
          return { status: 403, json: true, result: JSON.stringify({ error: filterResult.message }) };
        }
        // Datamark text command output only (not html, forms, or structured data)
        if (command === 'text') {
          result = datamarkContent(result);
        }
        // Enhanced envelope wrapping for scoped tokens.
        // Merge per-request hidden-element warnings with content-filter
        // warnings so both reach the LLM through the same CONTENT
        // WARNINGS header.
        const combinedWarnings = [...filterResult.warnings, ...hiddenContentWarnings];
        result = wrapUntrustedPageContent(
          result, command,
          combinedWarnings.length > 0 ? combinedWarnings : undefined,
        );
      } else {
        // Root token: basic wrapping (backward compat, Decision 2)
        result = wrapUntrustedContent(result, browserManager.getCurrentUrl());
      }
    }

    // Activity: emit command_end (skipped for chain subcommands)
    const successDuration = Date.now() - startTime;
    if (!opts?.skipActivity) {
      emitActivity({
        type: 'command_end',
        command,
        args,
        url: browserManager.getCurrentUrl(),
        duration: successDuration,
        status: 'ok',
        result: result,
        tabs: browserManager.getTabCount(),
        mode: browserManager.getConnectionMode(),
        clientId: tokenInfo?.clientId,
      });
    }

    writeAuditEntry({
      ts: new Date().toISOString(),
      cmd: command,
      aliasOf: isAliased ? rawCommand : undefined,
      args: args.join(' '),
      origin: browserManager.getCurrentUrl(),
      durationMs: successDuration,
      status: 'ok',
      hasCookies: browserManager.hasCookieImports(),
      mode: browserManager.getConnectionMode(),
    });

    browserManager.resetFailures();
    // Restore original active tab if we pinned to a specific one
    if (savedTabId !== null) {
      try { browserManager.switchTab(savedTabId, { bringToFront: false }); } catch (restoreErr: any) {
        console.warn('[browse] Failed to restore tab after command:', restoreErr.message);
      }
    }
    return { status: 200, result };
  } catch (err: any) {
    // Restore original active tab even on error
    if (savedTabId !== null) {
      try { browserManager.switchTab(savedTabId, { bringToFront: false }); } catch (restoreErr: any) {
        console.warn('[browse] Failed to restore tab after error:', restoreErr.message);
      }
    }

    // Activity: emit command_end (error) — skipped for chain subcommands
    const errorDuration = Date.now() - startTime;
    if (!opts?.skipActivity) {
      emitActivity({
        type: 'command_end',
        command,
        args,
        url: browserManager.getCurrentUrl(),
        duration: errorDuration,
        status: 'error',
        error: err.message,
        tabs: browserManager.getTabCount(),
        mode: browserManager.getConnectionMode(),
        clientId: tokenInfo?.clientId,
      });
    }

    writeAuditEntry({
      ts: new Date().toISOString(),
      cmd: command,
      aliasOf: isAliased ? rawCommand : undefined,
      args: args.join(' '),
      origin: browserManager.getCurrentUrl(),
      durationMs: errorDuration,
      status: 'error',
      error: err.message,
      hasCookies: browserManager.hasCookieImports(),
      mode: browserManager.getConnectionMode(),
    });

    browserManager.incrementFailures();
    let errorMsg = wrapError(err);
    const hint = browserManager.getFailureHint();
    if (hint) errorMsg += '\n' + hint;
    return { status: 500, result: JSON.stringify({ error: errorMsg }), json: true };
  }
}

/** HTTP wrapper — converts CommandResult to Response */
async function handleCommand(body: any, tokenInfo?: TokenInfo | null): Promise<Response> {
  const cr = await handleCommandInternal(body, tokenInfo);
  const contentType = cr.json ? 'application/json' : 'text/plain';
  return new Response(cr.result, {
    status: cr.status,
    headers: { 'Content-Type': contentType, ...cr.headers },
  });
}

async function shutdown(exitCode: number = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log('[browse] Shutting down...');
  // Kill the terminal-agent daemon (spawned by cli.ts, detached). Without
  // this, the agent keeps sitting on its WebSocket port.
  try {
    const { spawnSync } = require('child_process');
    spawnSync('pkill', ['-f', 'terminal-agent\\.ts'], { stdio: 'ignore', timeout: 3000 });
  } catch (err: any) {
    console.warn('[browse] Failed to kill terminal-agent:', err.message);
  }
  // Best-effort cleanup of agent state files so a reconnect doesn't try to
  // hit a dead port.
  try { safeUnlinkQuiet(path.join(path.dirname(config.stateFile), 'terminal-port')); } catch {}
  try { safeUnlinkQuiet(path.join(path.dirname(config.stateFile), 'terminal-internal-token')); } catch {}
  // Clean up CDP inspector sessions
  try { detachSession(); } catch (err: any) {
    console.warn('[browse] Failed to detach CDP session:', err.message);
  }
  inspectorSubscribers.clear();
  // Stop watch mode if active
  if (browserManager.isWatching()) browserManager.stopWatch();
  clearInterval(flushInterval);
  clearInterval(idleCheckInterval);
  await flushBuffers(); // Final flush (async now)

  await browserManager.close();

  // Clean up Chromium profile locks (prevent SingletonLock on next launch).
  // Defensive guard inside the helper refuses to clean unrecognized dirs.
  cleanSingletonLocks(resolveChromiumProfile());

  // Clean up state file
  safeUnlinkQuiet(config.stateFile);

  process.exit(exitCode);
}

// Handle signals
//
// Node passes the signal name (e.g. 'SIGTERM') as the first arg to listeners.
// Wrap calls to shutdown() so it receives no args — otherwise the string gets
// passed as exitCode and process.exit() coerces it to NaN, exiting with code 1
// instead of 0. (Caught in v0.18.1.0 #1025.)
//
// Gated on `import.meta.main` so embedders (gbrowser phoenix) that import
// server.ts as a submodule can register their own signal handlers without
// fighting with gstack's. CLI path is unchanged.
if (import.meta.main) {
  // SIGINT (Ctrl+C): user intentionally stopping → shutdown.
  process.on('SIGINT', () => shutdown());
  // SIGTERM behavior depends on mode:
  // - Normal (headless) mode: Claude Code's Bash sandbox fires SIGTERM when the
  //   parent shell exits between tool invocations. Ignoring it keeps the server
  //   alive across $B calls. Idle timeout (30 min) handles eventual cleanup.
  // - Headed / tunnel mode: idle timeout doesn't apply in these modes. Respect
  //   SIGTERM so external tooling (systemd, supervisord, CI) can shut cleanly
  //   without waiting forever. Ctrl+C and /stop still work either way.
  // - Active cookie picker: never tear down mid-import regardless of mode —
  //   would strand the picker UI with "Failed to fetch."
  process.on('SIGTERM', () => {
    if (hasActivePicker()) {
      console.log('[browse] Received SIGTERM but cookie picker is active, ignoring to avoid stranding the picker UI');
      return;
    }
    const headed = browserManager.getConnectionMode() === 'headed';
    if (headed || tunnelActive) {
      console.log(`[browse] Received SIGTERM in ${headed ? 'headed' : 'tunnel'} mode, shutting down`);
      shutdown();
    } else {
      console.log('[browse] Received SIGTERM (ignoring — use /stop or Ctrl+C for intentional shutdown)');
    }
  });
  // Windows: taskkill /F bypasses SIGTERM, but 'exit' fires for some shutdown paths.
  // Defense-in-depth — primary cleanup is the CLI's stale-state detection via health check.
  if (process.platform === 'win32') {
    process.on('exit', () => {
      safeUnlinkQuiet(config.stateFile);
    });
  }
}

// Emergency cleanup for crashes (OOM, uncaught exceptions, browser disconnect)
function emergencyCleanup() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  // Xvfb cleanup MUST happen before state-file deletion. spawnXvfb detaches
  // the child, so without this, an uncaught exception leaves the Xvfb
  // running with no PID record — orphan accumulates and eventually
  // exhausts the :99-:120 display range. Read the state file FIRST,
  // call cleanupXvfb (validates cmdline + start-time before kill), THEN
  // delete the state file.
  try {
    if (fs.existsSync(config.stateFile)) {
      const raw = fs.readFileSync(config.stateFile, 'utf-8');
      const state = JSON.parse(raw);
      if (state.xvfbPid && state.xvfbStartTime) {
        // Lazy import — emergencyCleanup may run on platforms where
        // ./xvfb's Linux-specific helpers fail to load. Best effort.
        try {
          const { cleanupXvfb } = require('./xvfb');
          cleanupXvfb({
            pid: state.xvfbPid,
            startTime: state.xvfbStartTime,
            display: state.xvfbDisplay || ':99',
          });
        } catch { /* best effort */ }
      }
    }
  } catch { /* state file unparseable — fall through to lock + state cleanup */ }

  // Clean Chromium profile locks via the shared helper (defensive guard
  // refuses to operate on unrecognized profile dirs).
  cleanSingletonLocks(resolveChromiumProfile());
  safeUnlinkQuiet(config.stateFile);
}
// Same import.meta.main gate as SIGINT/SIGTERM — embedders register their
// own crash handlers.
if (import.meta.main) {
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
}

// ─── Start ─────────────────────────────────────────────────────
/**
 * Entry point for `bun run dev` and the compiled binary.
 *
 * Exported so embedders (gbrowser phoenix overlay) can call it
 * directly with env vars set, bypassing the module-level `import.meta.main`
 * gate. Phoenix's eventual fd-passing path will use `buildFetchHandler`
 * directly; until that lands, calling `start()` from a non-main entry is
 * supported via env (AUTH_TOKEN, BROWSE_PORT, BROWSE_OWN_SIGNALS).
 */
export async function start() {
  // Clear old log files
  safeUnlink(CONSOLE_LOG_PATH);
  safeUnlink(NETWORK_LOG_PATH);
  safeUnlink(DIALOG_LOG_PATH);

  const port = await findPort();
  LOCAL_LISTEN_PORT = port;

  // ─── Proxy config (D8 + codex F5) ──────────────────────────────
  // BROWSE_PROXY_URL is set by the CLI when --proxy was passed. For SOCKS5
  // with auth, we run a local 127.0.0.1 bridge that relays to the
  // authenticated upstream (Chromium can't do SOCKS5 auth itself). For
  // HTTP/HTTPS or unauthenticated SOCKS5, we pass the URL directly to
  // Chromium's proxy.server option.
  let proxyBridge: BridgeHandle | null = null;
  const proxyUrl = process.env.BROWSE_PROXY_URL;
  if (proxyUrl) {
    let parsed;
    try {
      parsed = parseProxyConfig({
        proxyUrl,
        envUser: process.env.BROWSE_PROXY_USER,
        envPass: process.env.BROWSE_PROXY_PASS,
      });
    } catch (err) {
      if (err instanceof ProxyConfigError) {
        console.error(`[browse] error: ${err.message} (${err.hint})`);
        process.exit(1);
      }
      throw err;
    }

    if (parsed.scheme === 'socks5' && parsed.hasAuth) {
      // Pre-flight: verify upstream accepts our creds before launching
      // Chromium. 5s budget, 3 retries with 500ms backoff (D4: handles VPN
      // warm-up race). On failure, exit with redacted error.
      console.log(`[browse] Testing SOCKS5 upstream ${redactProxyUrl(proxyUrl)}...`);
      try {
        const test = await testUpstream({
          upstream: toUpstreamConfig(parsed),
          budgetMs: 5000,
          retries: 3,
          backoffMs: 500,
        });
        console.log(`[browse] [proxy] upstream test ok in ${test.ms}ms (${test.attempts} attempt${test.attempts === 1 ? '' : 's'})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[browse] [proxy] FAIL upstream ${redactProxyUrl(proxyUrl)}: ${msg}`);
        process.exit(1);
      }

      proxyBridge = await startSocksBridge({ upstream: toUpstreamConfig(parsed) });
      console.log(`[browse] [proxy] bridge listening on 127.0.0.1:${proxyBridge.port}`);
      browserManager.setProxyConfig({ server: `socks5://127.0.0.1:${proxyBridge.port}` });
    } else {
      // HTTP/HTTPS or unauth SOCKS5 — pass through to Chromium directly.
      browserManager.setProxyConfig({
        server: `${parsed.scheme}://${parsed.host}:${parsed.port}`,
        ...(parsed.userId ? { username: parsed.userId } : {}),
        ...(parsed.password ? { password: parsed.password } : {}),
      });
      console.log(`[browse] [proxy] using ${redactProxyUrl(proxyUrl)} (pass-through to Chromium)`);
    }

    // Tear down bridge on shutdown.
    process.on('exit', () => {
      if (proxyBridge) {
        proxyBridge.close().catch(() => { /* shutting down anyway */ });
      }
    });
  }

  // ─── Xvfb auto-spawn (Linux + headed + no DISPLAY) ─────────────
  // codex F2: walk display range to pick a free one (never hardcode :99);
  // record start-time alongside PID so cleanup can validate ownership and
  // not kill a recycled PID.
  let xvfb: XvfbHandle | null = null;
  const xvfbDecision = shouldSpawnXvfb(process.env, process.platform);
  if (xvfbDecision.spawn) {
    const displayNum = pickFreeDisplay();
    if (displayNum == null) {
      console.error('[browse] no free X display in range :99-:120 — refusing to clobber existing X servers');
      process.exit(1);
    }
    try {
      xvfb = await spawnXvfb(displayNum);
      process.env.DISPLAY = xvfb.display;
      console.log(`[browse] [xvfb] spawned on ${xvfb.display} (pid ${xvfb.pid})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[browse] [xvfb] FAILED: ${msg}`);
      console.error(`[browse] [xvfb] hint: ${xvfbInstallHint()}`);
      process.exit(1);
    }
    process.on('exit', () => { try { xvfb?.close(); } catch { /* shutting down */ } });
  } else if (process.env.BROWSE_HEADED === '1') {
    console.log(`[browse] [xvfb] skipped: ${xvfbDecision.reason}`);
  }

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

  // ─── Request handler factory ────────────────────────────────────
  //
  // Same logic serves both the local listener (bootstrap, CLI, sidebar) and
  // the tunnel listener (pairing + scoped-token commands).  The factory
  // closes over `surface` so the filter that runs before route dispatch
  // knows which socket accepted the request.
  //
  // On the tunnel surface: reject anything not in TUNNEL_PATHS (404), reject
  // root-token bearers (403), and require a scoped token for everything
  // except /connect.  Denials are logged to ~/.gstack/security/attempts.jsonl.
  const makeFetchHandler = (surface: Surface) => async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    // ─── Tunnel surface filter (runs before any route dispatch) ──
    if (surface === 'tunnel') {
      const isGetConnect = req.method === 'GET' && url.pathname === '/connect';
      const allowed = TUNNEL_PATHS.has(url.pathname);
      if (!allowed && !isGetConnect) {
        logTunnelDenial(req, url, 'path_not_on_tunnel');
        return new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (isRootRequest(req)) {
        logTunnelDenial(req, url, 'root_token_on_tunnel');
        return new Response(JSON.stringify({
          error: 'Root token rejected on tunnel surface',
          hint: 'Remote agents must pair via /connect to receive a scoped token.',
        }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname !== '/connect' && !getTokenInfo(req)) {
        logTunnelDenial(req, url, 'missing_scoped_token');
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // GET /connect — alive probe.  Unauth on both surfaces.  Used by /pair
    // and /tunnel/start to detect dead ngrok tunnels via the tunnel URL,
    // since /health is not tunnel-reachable under the dual-listener design.
    //
    // Shares the same rate limit as POST /connect — otherwise a tunnel
    // caller can probe unlimited GETs and lock out nothing, which makes
    // the endpoint a free daemon-enumeration surface.
    if (url.pathname === '/connect' && req.method === 'GET') {
      if (!checkConnectRateLimit()) {
        return new Response(JSON.stringify({ error: 'Rate limited' }), {
          status: 429, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ alive: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

      // Cookie picker routes — HTML page unauthenticated, data/action routes require auth
      if (url.pathname.startsWith('/cookie-picker')) {
        return handleCookiePickerRoute(url, req, browserManager, AUTH_TOKEN);
      }

      // Welcome page — served when GStack Browser launches in headed mode
      if (url.pathname === '/welcome') {
        const welcomePath = (() => {
          // Gate GSTACK_SLUG on a strict regex BEFORE interpolating it into
          // the filesystem path. Without this, a slug like "../../etc/passwd"
          // would resolve to ~/.gstack/projects/../../etc/passwd/... — path
          // traversal.  Not exploitable today (attacker needs local env-var
          // access), but the gate is one regex and buys us defense-in-depth.
          const rawSlug = process.env.GSTACK_SLUG || 'unknown';
          const slug = /^[a-z0-9_-]+$/.test(rawSlug) ? rawSlug : 'unknown';
          const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
          const projectWelcome = `${homeDir}/.gstack/projects/${slug}/designs/welcome-page-20260331/finalized.html`;
          if (fs.existsSync(projectWelcome)) return projectWelcome;
          // Fallback: built-in welcome page from gstack install.  Reject
          // SKILL_ROOT values containing '..' for the same defense-in-depth
          // reason as the GSTACK_SLUG regex above.  Not exploitable today
          // (env set at install time), but the gate is one check.
          const rawSkillRoot = process.env.GSTACK_SKILL_ROOT || `${homeDir}/.claude/skills/gstack`;
          if (rawSkillRoot.includes('..')) return null;
          const builtinWelcome = `${rawSkillRoot}/browse/src/welcome.html`;
          if (fs.existsSync(builtinWelcome)) return builtinWelcome;
          return null;
        })();
        if (welcomePath) {
          try {
            const html = require('fs').readFileSync(welcomePath, 'utf-8');
            return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
          } catch (err: any) {
            console.error('[browse] Failed to read welcome page:', welcomePath, err.message);
          }
        }
        // No welcome page found — serve a simple fallback (avoid ERR_UNSAFE_REDIRECT on Windows)
        return new Response(
          `<!DOCTYPE html><html><head><title>GStack Browser</title>
          <style>body{background:#111;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
          .msg{text-align:center;opacity:.7;}.gold{color:#f5a623;font-size:2em;margin-bottom:12px;}</style></head>
          <body><div class="msg"><div class="gold">◈</div><p>GStack Browser ready.</p><p style="font-size:.85em">Waiting for commands from Claude Code.</p></div></body></html>`,
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }

      // Health check — no auth required, does NOT reset idle timer
      if (url.pathname === '/health') {
        const healthy = await browserManager.isHealthy();
        return new Response(JSON.stringify({
          status: healthy ? 'healthy' : 'unhealthy',
          mode: browserManager.getConnectionMode(),
          uptime: Math.floor((Date.now() - startTime) / 1000),
          tabs: browserManager.getTabCount(),
          // Auth token for extension bootstrap. Safe: /health is localhost-only.
          // Previously served unconditionally, but that leaks the token if the
          // server is tunneled to the internet (ngrok, SSH tunnel).
          // In headed mode the server is always local, so return token unconditionally
          // (fixes Playwright Chromium extensions that don't send Origin header).
          ...(browserManager.getConnectionMode() === 'headed' ||
              req.headers.get('origin')?.startsWith('chrome-extension://')
              ? { token: AUTH_TOKEN } : {}),
          // The chat queue is gone — Terminal pane is the sole sidebar
          // surface. Keep `chatEnabled: false` so any older extension
          // build still treats the chat input as disabled.
          chatEnabled: false,
          // Security module status — drives the shield icon in the sidepanel.
          // Returns {status: 'protected'|'degraded'|'inactive', layers: {...}}.
          // The chat-path classifier no longer feeds this since
          // sidebar-agent.ts was ripped; only the page-content side
          // (canary, content-security) keeps reporting in.
          security: getSecurityStatus(),
          // Terminal-agent discovery. ONLY a port number — never a token.
          // Tokens flow via the /pty-session HttpOnly cookie path. See
          // `pty-session-cookie.ts` for the rationale (codex outside-voice
          // finding #2: don't reuse this endpoint for shell auth).
          terminalPort: readTerminalPort(),
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // ─── /pty-session — mint Terminal-tab WebSocket cookie ───────────
      //
      // The extension POSTs here with the bootstrap AUTH_TOKEN, gets back a
      // short-lived HttpOnly cookie scoped to the terminal-agent's /ws
      // upgrade. We push the cookie value to the agent over loopback so the
      // upgrade can validate it. The cookie travels automatically with the
      // browser's WebSocket upgrade because it's same-origin to the agent
      // when the daemon binds 127.0.0.1. NEVER added to TUNNEL_PATHS — the
      // tunnel surface 404s any /pty-session attempt by default-deny.
      if (url.pathname === '/pty-session' && req.method === 'POST') {
        if (!validateAuth(req)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401, headers: { 'Content-Type': 'application/json' },
          });
        }
        const port = readTerminalPort();
        if (!port) {
          return new Response(JSON.stringify({
            error: 'terminal-agent not ready',
          }), { status: 503, headers: { 'Content-Type': 'application/json' } });
        }
        const minted = mintPtySessionToken();
        const granted = await grantPtyToken(minted.token);
        if (!granted) {
          revokePtySessionToken(minted.token);
          return new Response(JSON.stringify({
            error: 'failed to grant terminal session',
          }), { status: 503, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          terminalPort: port,
          // Returned in the JSON body so the extension can pass it to
          // `new WebSocket(url, [token])`. Browsers translate that to a
          // `Sec-WebSocket-Protocol` header — the only auth header we can
          // set from the browser WebSocket API. SameSite=Strict cookies
          // don't survive the port change between server.ts (34567) and
          // the agent (random port), and HttpOnly + cross-origin makes
          // the cookie path unreliable across browsers anyway.
          //
          // The token is short-lived (30 min, auto-revoked on WS close)
          // and never persisted to disk on the extension side. The
          // pre-existing AUTH_TOKEN leak via /health is a separate
          // concern (v1.1+ TODO).
          ptySessionToken: minted.token,
          expiresAt: minted.expiresAt,
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            // Set-Cookie is kept for non-browser callers / future use,
            // but the WS upgrade no longer depends on it.
            'Set-Cookie': buildPtySetCookie(minted.token),
          },
        });
      }

      // ─── /connect — setup key exchange for /pair-agent ceremony ────
      if (url.pathname === '/connect' && req.method === 'POST') {
        if (!checkConnectRateLimit()) {
          return new Response(JSON.stringify({
            error: 'Too many connection attempts. Wait 1 minute.',
          }), { status: 429, headers: { 'Content-Type': 'application/json' } });
        }
        try {
          const connectBody = await req.json() as { setup_key?: string };
          if (!connectBody.setup_key) {
            return new Response(JSON.stringify({ error: 'Missing setup_key' }), {
              status: 400, headers: { 'Content-Type': 'application/json' },
            });
          }
          const session = exchangeSetupKey(connectBody.setup_key);
          if (!session) {
            return new Response(JSON.stringify({
              error: 'Invalid, expired, or already-used setup key',
            }), { status: 401, headers: { 'Content-Type': 'application/json' } });
          }
          console.log(`[browse] Remote agent connected: ${session.clientId} (scopes: ${session.scopes.join(',')})`);
          return new Response(JSON.stringify({
            token: session.token,
            expires: session.expiresAt,
            scopes: session.scopes,
            agent: session.clientId,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        } catch {
          return new Response(JSON.stringify({ error: 'Invalid request body' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      // ─── /token — mint scoped tokens (root-only) ──────────────────
      if (url.pathname === '/token' && req.method === 'POST') {
        if (!isRootRequest(req)) {
          return new Response(JSON.stringify({
            error: 'Only the root token can mint sub-tokens',
          }), { status: 403, headers: { 'Content-Type': 'application/json' } });
        }
        try {
          const tokenBody = await req.json() as any;
          if (!tokenBody.clientId) {
            return new Response(JSON.stringify({ error: 'Missing clientId' }), {
              status: 400, headers: { 'Content-Type': 'application/json' },
            });
          }
          const session = createToken({
            clientId: tokenBody.clientId,
            scopes: tokenBody.scopes,
            domains: tokenBody.domains,
            tabPolicy: tokenBody.tabPolicy,
            rateLimit: tokenBody.rateLimit,
            expiresSeconds: tokenBody.expiresSeconds,
          });
          return new Response(JSON.stringify({
            token: session.token,
            expires: session.expiresAt,
            scopes: session.scopes,
            agent: session.clientId,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        } catch {
          return new Response(JSON.stringify({ error: 'Invalid request body' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      // ─── /token/:clientId — revoke a scoped token (root-only) ─────
      if (url.pathname.startsWith('/token/') && req.method === 'DELETE') {
        if (!isRootRequest(req)) {
          return new Response(JSON.stringify({ error: 'Root token required' }), {
            status: 403, headers: { 'Content-Type': 'application/json' },
          });
        }
        const clientId = url.pathname.slice('/token/'.length);
        const revoked = revokeToken(clientId);
        if (!revoked) {
          return new Response(JSON.stringify({ error: `Agent "${clientId}" not found` }), {
            status: 404, headers: { 'Content-Type': 'application/json' },
          });
        }
        console.log(`[browse] Revoked token for: ${clientId}`);
        return new Response(JSON.stringify({ revoked: clientId }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }

      // ─── /agents — list connected agents (root-only) ──────────────
      if (url.pathname === '/agents' && req.method === 'GET') {
        if (!isRootRequest(req)) {
          return new Response(JSON.stringify({ error: 'Root token required' }), {
            status: 403, headers: { 'Content-Type': 'application/json' },
          });
        }
        const agents = listTokens().map(t => ({
          clientId: t.clientId,
          scopes: t.scopes,
          domains: t.domains,
          expiresAt: t.expiresAt,
          commandCount: t.commandCount,
          createdAt: t.createdAt,
        }));
        return new Response(JSON.stringify({ agents }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }

      // ─── /pair — create setup key for pair-agent ceremony (root-only) ───
      if (url.pathname === '/pair' && req.method === 'POST') {
        if (!isRootRequest(req)) {
          return new Response(JSON.stringify({ error: 'Root token required' }), {
            status: 403, headers: { 'Content-Type': 'application/json' },
          });
        }
        try {
          const pairBody = await req.json() as any;
          // Default: full access (read+write+admin+meta). The trust boundary is
          // the pairing ceremony itself, not the scope. --control adds browser-wide
          // destructive commands (stop, restart, disconnect). --restrict limits scope.
          const scopes = pairBody.control || pairBody.admin
            ? ['read', 'write', 'admin', 'meta', 'control'] as const
            : (pairBody.scopes || ['read', 'write', 'admin', 'meta']) as const;
          const setupKey = createSetupKey({
            clientId: pairBody.clientId,
            scopes: [...scopes],
            domains: pairBody.domains,
            rateLimit: pairBody.rateLimit,
          });
          // Verify tunnel is actually alive before reporting it (ngrok may have died externally).
          // Probe via GET /connect — under dual-listener /health is NOT on the tunnel allowlist,
          // so the old probe would return 404 and always mark the tunnel as dead.
          let verifiedTunnelUrl: string | null = null;
          if (tunnelActive && tunnelUrl) {
            try {
              const probe = await fetch(`${tunnelUrl}/connect`, {
                method: 'GET',
                headers: { 'ngrok-skip-browser-warning': 'true' },
                signal: AbortSignal.timeout(5000),
              });
              if (probe.ok) {
                verifiedTunnelUrl = tunnelUrl;
              } else {
                console.warn(`[browse] Tunnel probe failed (HTTP ${probe.status}), marking tunnel as dead`);
                await closeTunnel();
              }
            } catch {
              console.warn('[browse] Tunnel probe timed out or unreachable, marking tunnel as dead');
              await closeTunnel();
            }
          }
          return new Response(JSON.stringify({
            setup_key: setupKey.token,
            expires_at: setupKey.expiresAt,
            scopes: setupKey.scopes,
            tunnel_url: verifiedTunnelUrl,
            server_url: `http://127.0.0.1:${server?.port || 0}`,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        } catch {
          return new Response(JSON.stringify({ error: 'Invalid request body' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      // ─── /tunnel/start — start ngrok tunnel on demand (root-only) ──
      //
      // Dual-listener model: binds a SECOND Bun.serve listener on an
      // ephemeral 127.0.0.1 port dedicated to tunnel traffic, then points
      // ngrok.forward() at THAT port.  The existing local listener (which
      // serves /health+token, /cookie-picker, /inspector/*, welcome, etc.)
      // is never exposed to ngrok.
      //
      // Hard fail if the tunnel listener bind fails — NEVER fall back to
      // the local port, which would silently defeat the whole security
      // property.
      if (url.pathname === '/tunnel/start' && req.method === 'POST') {
        if (!isRootRequest(req)) {
          return new Response(JSON.stringify({ error: 'Root token required' }), {
            status: 403, headers: { 'Content-Type': 'application/json' },
          });
        }
        if (tunnelActive && tunnelUrl && tunnelServer) {
          // Verify tunnel is still alive before returning cached URL.
          // Probe GET /connect (the only unauth-reachable path on the tunnel
          // surface); /health is NOT tunnel-reachable under dual-listener.
          try {
            const probe = await fetch(`${tunnelUrl}/connect`, {
              method: 'GET',
              headers: { 'ngrok-skip-browser-warning': 'true' },
              signal: AbortSignal.timeout(5000),
            });
            if (probe.ok) {
              return new Response(JSON.stringify({ url: tunnelUrl, already_active: true }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
              });
            }
          } catch {}
          // Tunnel is dead — tear down cleanly before restarting
          console.warn('[browse] Cached tunnel is dead, restarting...');
          await closeTunnel();
        }

        // 1) Resolve ngrok authtoken from env / .gstack / native config
        const authtoken = resolveNgrokAuthtoken();
        if (!authtoken) {
          return new Response(JSON.stringify({
            error: 'No ngrok authtoken found',
            hint: 'Run: ngrok config add-authtoken YOUR_TOKEN',
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }

        // 2) Bind the tunnel listener on an ephemeral port.  HARD FAIL if
        //    this errors — never fall back to the local port.
        let boundTunnel: ReturnType<typeof Bun.serve>;
        try {
          boundTunnel = Bun.serve({
            port: 0,
            hostname: '127.0.0.1',
            fetch: makeFetchHandler('tunnel'),
          });
        } catch (err: any) {
          return new Response(JSON.stringify({
            error: `Failed to bind tunnel listener: ${err.message}`,
          }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }
        const tunnelPort = boundTunnel.port;

        // 3) Point ngrok at the TUNNEL port (not the local port).  If this
        //    fails, tear the listener back down so we don't leak sockets.
        try {
          const ngrok = await import('@ngrok/ngrok');
          const domain = process.env.NGROK_DOMAIN;
          const forwardOpts: any = { addr: tunnelPort, authtoken };
          if (domain) forwardOpts.domain = domain;

          tunnelListener = await ngrok.forward(forwardOpts);
          tunnelUrl = tunnelListener.url();
          tunnelServer = boundTunnel;
          tunnelActive = true;
          console.log(`[browse] Tunnel listener bound on 127.0.0.1:${tunnelPort}, ngrok → ${tunnelUrl}`);

          // Update state file
          const stateContent = JSON.parse(fs.readFileSync(config.stateFile, 'utf-8'));
          stateContent.tunnel = { url: tunnelUrl, domain: domain || null, startedAt: new Date().toISOString() };
          const tmpState = tmpStatePath();
          fs.writeFileSync(tmpState, JSON.stringify(stateContent, null, 2), { mode: 0o600 });
          fs.renameSync(tmpState, config.stateFile);

          return new Response(JSON.stringify({ url: tunnelUrl }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        } catch (err: any) {
          // Clean up BOTH ngrok and the Bun listener on failure.  If
          // ngrok.forward() succeeded but tunnelListener.url() or the
          // state-file write threw, we'd otherwise leak an active ngrok
          // session on the user's account.
          try { if (tunnelListener) await tunnelListener.close(); } catch {}
          try { boundTunnel.stop(true); } catch {}
          tunnelListener = null;
          return new Response(JSON.stringify({
            error: `Failed to open ngrok tunnel: ${err.message}`,
          }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }
      }

      // ─── SSE session cookie mint (auth required) ──────────────────
      //
      // Issues a short-lived view-only token in an HttpOnly SameSite=Strict
      // cookie so EventSource calls can authenticate without putting the
      // root token in a URL. The returned cookie is valid ONLY on the SSE
      // endpoints (/activity/stream, /inspector/events); it is not a
      // scoped token and cannot be used against /command.
      //
      // The extension calls this once at bootstrap with the root Bearer
      // header, then opens EventSource with `withCredentials: true` which
      // sends the cookie back automatically.
      if (url.pathname === '/sse-session' && req.method === 'POST') {
        if (!validateAuth(req)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const minted = mintSseSessionToken();
        return new Response(JSON.stringify({
          expiresAt: minted.expiresAt,
          cookie: SSE_COOKIE_NAME,
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': buildSseSetCookie(minted.token),
          },
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
        // Auth: Bearer header OR view-only SSE session cookie (EventSource
        // can't send Authorization headers, so the extension fetches a cookie
        // via POST /sse-session first, then opens EventSource with
        // withCredentials: true). The ?token= query param is NO LONGER
        // accepted — URLs leak to logs/referer/history. See N1 in the
        // v1.6.0.0 security wave plan.
        const cookieToken = extractSseCookie(req);
        if (!validateAuth(req) && !validateSseSessionToken(cookieToken)) {
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
              } catch (err: any) {
                console.debug('[browse] Activity SSE stream error, unsubscribing:', err.message);
                unsubscribe();
              }
            });

            // 3. Heartbeat every 15s
            const heartbeat = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(`: heartbeat\n\n`));
              } catch (err: any) {
                console.debug('[browse] Activity SSE heartbeat failed:', err.message);
                clearInterval(heartbeat);
                unsubscribe();
              }
            }, 15000);

            // 4. Cleanup on disconnect
            req.signal.addEventListener('abort', () => {
              clearInterval(heartbeat);
              unsubscribe();
              try { controller.close(); } catch {
                // Expected: stream already closed
              }
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


      // ─── Sidebar chat endpoints ripped ──────────────────────────────
      // /sidebar-tabs, /sidebar-tabs/switch, /sidebar-chat[/clear],
      // /sidebar-command, /sidebar-agent/{event,kill,stop},
      // /sidebar-queue/dismiss, /sidebar-session{,/new,/list} all lived
      // here. They drove the one-shot claude -p chat queue. Replaced by
      // the interactive PTY in terminal-agent.ts; the queue + browser-tab
      // multiplexing are no longer needed.


      // ─── Batch endpoint — N commands, 1 HTTP round-trip ─────────────
      // Accepts both root AND scoped tokens (same as /command).
      // Executes commands sequentially through the full security pipeline.
      // Designed for remote agents where tunnel latency dominates.
      if (url.pathname === '/batch' && req.method === 'POST') {
        const tokenInfo = getTokenInfo(req);
        if (!tokenInfo) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        resetIdleTimer();
        const body = await req.json();
        const { commands } = body;

        if (!Array.isArray(commands) || commands.length === 0) {
          return new Response(JSON.stringify({ error: '"commands" must be a non-empty array' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (commands.length > 50) {
          return new Response(JSON.stringify({ error: 'Max 50 commands per batch' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const startTime = Date.now();
        emitActivity({
          type: 'command_start',
          command: 'batch',
          args: [`${commands.length} commands`],
          url: browserManager.getCurrentUrl(),
          tabs: browserManager.getTabCount(),
          mode: browserManager.getConnectionMode(),
          clientId: tokenInfo?.clientId,
        });

        const results: Array<{ index: number; status: number; result: string; command: string; tabId?: number }> = [];
        for (let i = 0; i < commands.length; i++) {
          const cmd = commands[i];
          if (!cmd || typeof cmd.command !== 'string') {
            results.push({ index: i, status: 400, result: JSON.stringify({ error: 'Missing "command" field' }), command: '' });
            continue;
          }
          // Reject nested batches
          if (cmd.command === 'batch') {
            results.push({ index: i, status: 400, result: JSON.stringify({ error: 'Nested batch commands are not allowed' }), command: 'batch' });
            continue;
          }
          const cr = await handleCommandInternal(
            { command: cmd.command, args: cmd.args, tabId: cmd.tabId },
            tokenInfo,
            { skipRateCheck: true, skipActivity: true },
          );
          results.push({
            index: i,
            status: cr.status,
            result: cr.result,
            command: cmd.command,
            tabId: cmd.tabId,
          });
        }

        const duration = Date.now() - startTime;
        emitActivity({
          type: 'command_end',
          command: 'batch',
          args: [`${commands.length} commands`],
          url: browserManager.getCurrentUrl(),
          duration,
          status: 'ok',
          result: `${results.filter(r => r.status === 200).length}/${commands.length} succeeded`,
          tabs: browserManager.getTabCount(),
          mode: browserManager.getConnectionMode(),
          clientId: tokenInfo?.clientId,
        });

        return new Response(JSON.stringify({
          results,
          duration,
          total: commands.length,
          succeeded: results.filter(r => r.status === 200).length,
          failed: results.filter(r => r.status !== 200).length,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // ─── File serving endpoint (for remote agents to retrieve downloaded files) ────
      if (url.pathname === '/file' && req.method === 'GET') {
        const tokenInfo = getTokenInfo(req);
        if (!tokenInfo) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401, headers: { 'Content-Type': 'application/json' },
          });
        }
        const filePath = url.searchParams.get('path');
        if (!filePath) {
          return new Response(JSON.stringify({ error: 'Missing "path" query parameter' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
          });
        }
        try {
          validateTempPath(filePath);
        } catch (err: any) {
          return new Response(JSON.stringify({ error: err.message }), {
            status: 403, headers: { 'Content-Type': 'application/json' },
          });
        }
        if (!fs.existsSync(filePath)) {
          return new Response(JSON.stringify({ error: 'File not found' }), {
            status: 404, headers: { 'Content-Type': 'application/json' },
          });
        }
        const stat = fs.statSync(filePath);
        if (stat.size > 200 * 1024 * 1024) {
          return new Response(JSON.stringify({ error: 'File too large (max 200MB)' }), {
            status: 413, headers: { 'Content-Type': 'application/json' },
          });
        }
        const ext = path.extname(filePath).toLowerCase();
        const MIME_MAP: Record<string, string> = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
          '.avif': 'image/avif',
          '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
          '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
          '.pdf': 'application/pdf', '.json': 'application/json',
          '.html': 'text/html', '.txt': 'text/plain', '.mhtml': 'message/rfc822',
        };
        const contentType = MIME_MAP[ext] || 'application/octet-stream';
        resetIdleTimer();
        return new Response(Bun.file(filePath), {
          headers: {
            'Content-Type': contentType,
            'Content-Length': String(stat.size),
            'Content-Disposition': `inline; filename="${path.basename(filePath)}"`,
            'Cache-Control': 'no-cache',
          },
        });
      }

      // ─── Command endpoint (accepts both root AND scoped tokens) ────
      // Must be checked BEFORE the blanket root-only auth gate below,
      // because scoped tokens from /connect are valid for /command.
      if (url.pathname === '/command' && req.method === 'POST') {
        const tokenInfo = getTokenInfo(req);
        if (!tokenInfo) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        resetIdleTimer();
        const body = await req.json() as any;
        // Tunnel surface: only commands in TUNNEL_COMMANDS are allowed.
        // Paired remote agents drive the browser but cannot configure the
        // daemon, launch new browsers, import cookies, or rotate tokens.
        if (surface === 'tunnel') {
          if (!canDispatchOverTunnel(body?.command)) {
            logTunnelDenial(req, url, `disallowed_command:${body?.command}`);
            return new Response(JSON.stringify({
              error: `Command '${body?.command}' is not allowed over the tunnel surface`,
              hint: `Tunnel commands: ${[...TUNNEL_COMMANDS].sort().join(', ')}`,
            }), { status: 403, headers: { 'Content-Type': 'application/json' } });
          }
        }
        return handleCommand(body, tokenInfo);
      }

      // ─── Auth-required endpoints (root token only) ─────────────────

      if (!validateAuth(req)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // ─── Inspector endpoints ──────────────────────────────────────

      // POST /inspector/pick — receive element pick from extension, run CDP inspection
      if (url.pathname === '/inspector/pick' && req.method === 'POST') {
        const body = await req.json();
        const { selector, activeTabUrl } = body;
        if (!selector) {
          return new Response(JSON.stringify({ error: 'Missing selector' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
          });
        }
        try {
          const page = browserManager.getPage();
          const result = await inspectElement(page, selector);
          inspectorData = result;
          inspectorTimestamp = Date.now();
          // Also store on browserManager for CLI access
          (browserManager as any)._inspectorData = result;
          (browserManager as any)._inspectorTimestamp = inspectorTimestamp;
          emitInspectorEvent({ type: 'pick', selector, timestamp: inspectorTimestamp });
          return new Response(JSON.stringify(result), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        } catch (err: any) {
          return new Response(JSON.stringify({ error: err.message }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      // GET /inspector — return latest inspector data
      if (url.pathname === '/inspector' && req.method === 'GET') {
        if (!inspectorData) {
          return new Response(JSON.stringify({ data: null }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        }
        const stale = inspectorTimestamp > 0 && (Date.now() - inspectorTimestamp > 60000);
        return new Response(JSON.stringify({ data: inspectorData, timestamp: inspectorTimestamp, stale }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /inspector/apply — apply a CSS modification
      if (url.pathname === '/inspector/apply' && req.method === 'POST') {
        const body = await req.json();
        const { selector, property, value } = body;
        if (!selector || !property || value === undefined) {
          return new Response(JSON.stringify({ error: 'Missing selector, property, or value' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
          });
        }
        try {
          const page = browserManager.getPage();
          const mod = await modifyStyle(page, selector, property, value);
          emitInspectorEvent({ type: 'apply', modification: mod, timestamp: Date.now() });
          return new Response(JSON.stringify(mod), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        } catch (err: any) {
          return new Response(JSON.stringify({ error: err.message }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      // POST /inspector/reset — clear all modifications
      if (url.pathname === '/inspector/reset' && req.method === 'POST') {
        try {
          const page = browserManager.getPage();
          await resetModifications(page);
          emitInspectorEvent({ type: 'reset', timestamp: Date.now() });
          return new Response(JSON.stringify({ ok: true }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        } catch (err: any) {
          return new Response(JSON.stringify({ error: err.message }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      // GET /inspector/history — return modification list
      if (url.pathname === '/inspector/history' && req.method === 'GET') {
        return new Response(JSON.stringify({ history: getModificationHistory() }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }

      // GET /inspector/events — SSE for inspector state changes (auth required)
      if (url.pathname === '/inspector/events' && req.method === 'GET') {
        // Same auth model as /activity/stream: Bearer OR view-only cookie.
        // ?token= query param dropped (see N1 in the v1.6.0.0 security plan).
        const cookieToken = extractSseCookie(req);
        if (!validateAuth(req) && !validateSseSessionToken(cookieToken)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401, headers: { 'Content-Type': 'application/json' },
          });
        }
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            // Send current state immediately
            if (inspectorData) {
              controller.enqueue(encoder.encode(
                `event: state\ndata: ${JSON.stringify({ data: inspectorData, timestamp: inspectorTimestamp })}\n\n`
              ));
            }

            // Subscribe for live events
            const notify: InspectorSubscriber = (event) => {
              try {
                controller.enqueue(encoder.encode(
                  `event: inspector\ndata: ${JSON.stringify(event)}\n\n`
                ));
              } catch (err: any) {
                console.debug('[browse] Inspector SSE stream error:', err.message);
                inspectorSubscribers.delete(notify);
              }
            };
            inspectorSubscribers.add(notify);

            // Heartbeat every 15s
            const heartbeat = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(`: heartbeat\n\n`));
              } catch (err: any) {
                console.debug('[browse] Inspector SSE heartbeat failed:', err.message);
                clearInterval(heartbeat);
                inspectorSubscribers.delete(notify);
              }
            }, 15000);

            // Cleanup on disconnect
            req.signal.addEventListener('abort', () => {
              clearInterval(heartbeat);
              inspectorSubscribers.delete(notify);
              try { controller.close(); } catch (err: any) {
                // Expected: stream already closed
              }
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

      return new Response('Not found', { status: 404 });
  };
  // ─── End of makeFetchHandler ────────────────────────────────────

  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch: makeFetchHandler('local'),
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
    // D2 daemon-mismatch detection: CLI computes the same hash from its
    // resolved flags and refuses if it differs from this stored value.
    ...(process.env.BROWSE_CONFIG_HASH ? { configHash: process.env.BROWSE_CONFIG_HASH } : {}),
    // Xvfb child PID + start-time + display so disconnect (or a future
    // daemon launch on this state file) can validate-then-cleanup orphans
    // without clobbering a recycled PID.
    ...(xvfb ? { xvfbPid: xvfb.pid, xvfbStartTime: xvfb.startTime, xvfbDisplay: xvfb.display } : {}),
  };
  const tmpFile = tmpStatePath();
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmpFile, config.stateFile);

  browserManager.serverPort = port;

  // Navigate to welcome page if in headed mode and still on about:blank
  if (browserManager.getConnectionMode() === 'headed') {
    try {
      const currentUrl = browserManager.getCurrentUrl();
      if (currentUrl === 'about:blank' || currentUrl === '') {
        const page = browserManager.getPage();
        page.goto(`http://127.0.0.1:${port}/welcome`, { timeout: 3000 }).catch((err: any) => {
          console.warn('[browse] Failed to navigate to welcome page:', err.message);
        });
      }
    } catch (err: any) {
      console.warn('[browse] Welcome page navigation setup failed:', err.message);
    }
  }

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
  } catch (err: any) {
    console.warn('[browse] Failed to clean stale state files:', err.message);
  }

  console.log(`[browse] Server running on http://127.0.0.1:${port} (PID: ${process.pid})`);
  console.log(`[browse] State file: ${config.stateFile}`);
  console.log(`[browse] Idle timeout: ${IDLE_TIMEOUT_MS / 1000}s`);

  // initSidebarSession() ripped alongside the chat queue (it loaded
  // chat.jsonl into memory and started the agent-health watchdog —
  // both functions are gone). The Terminal pane manages its own state
  // directly via terminal-agent.ts.

  // ─── Tunnel startup (optional) ────────────────────────────────
  // Start ngrok tunnel if BROWSE_TUNNEL=1 is set.  Uses the dual-listener
  // pattern: bind a dedicated tunnel listener on an ephemeral port and
  // point ngrok.forward() at IT, not the local daemon port.
  if (process.env.BROWSE_TUNNEL === '1') {
    const authtoken = resolveNgrokAuthtoken();
    if (!authtoken) {
      console.error('[browse] BROWSE_TUNNEL=1 but no NGROK_AUTHTOKEN found. Set it via env var or ~/.gstack/ngrok.env');
    } else {
      let boundTunnel: ReturnType<typeof Bun.serve> | null = null;
      try {
        boundTunnel = Bun.serve({
          port: 0,
          hostname: '127.0.0.1',
          fetch: makeFetchHandler('tunnel'),
        });
        const tunnelPort = boundTunnel.port;

        const ngrok = await import('@ngrok/ngrok');
        const domain = process.env.NGROK_DOMAIN;
        const forwardOpts: any = { addr: tunnelPort, authtoken };
        if (domain) forwardOpts.domain = domain;

        tunnelListener = await ngrok.forward(forwardOpts);
        tunnelUrl = tunnelListener.url();
        tunnelServer = boundTunnel;
        tunnelActive = true;

        console.log(`[browse] Tunnel listener bound on 127.0.0.1:${tunnelPort}, ngrok → ${tunnelUrl}`);

        // Update state file with tunnel URL
        const stateContent = JSON.parse(fs.readFileSync(config.stateFile, 'utf-8'));
        stateContent.tunnel = { url: tunnelUrl, domain: domain || null, startedAt: new Date().toISOString() };
        const tmpState = tmpStatePath();
        fs.writeFileSync(tmpState, JSON.stringify(stateContent, null, 2), { mode: 0o600 });
        fs.renameSync(tmpState, config.stateFile);
      } catch (err: any) {
        console.error(`[browse] Failed to start tunnel: ${err.message}`);
        // Same cleanup as /tunnel/start's error path: tear down BOTH
        // ngrok and the Bun listener so we don't leak an ngrok session
        // if the error happened after ngrok.forward() resolved.
        try { if (tunnelListener) await tunnelListener.close(); } catch {}
        try { if (boundTunnel) boundTunnel.stop(true); } catch {}
        tunnelListener = null;
      }
    }
  } else if (process.env.BROWSE_TUNNEL_LOCAL_ONLY === '1') {
    // Test-only: bind the dual-listener tunnel surface on 127.0.0.1 with NO
    // ngrok forwarding. Lets paid evals exercise the surface==='tunnel' gate
    // without an ngrok authtoken or live network. Production tunneling still
    // requires BROWSE_TUNNEL=1 + a valid authtoken above.
    try {
      const boundTunnel = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch: makeFetchHandler('tunnel'),
      });
      tunnelServer = boundTunnel;
      tunnelActive = true;
      const tunnelPort = boundTunnel.port;
      console.log(`[browse] Tunnel listener bound (local-only test mode) on 127.0.0.1:${tunnelPort}`);
      const stateContent = JSON.parse(fs.readFileSync(config.stateFile, 'utf-8'));
      stateContent.tunnelLocalPort = tunnelPort;
      const tmpState = tmpStatePath();
      fs.writeFileSync(tmpState, JSON.stringify(stateContent, null, 2), { mode: 0o600 });
      fs.renameSync(tmpState, config.stateFile);
    } catch (err: any) {
      console.error(`[browse] BROWSE_TUNNEL_LOCAL_ONLY=1 listener bind failed: ${err.message}`);
    }
  }
}

// Auto-kickoff only when this module is the entry point. Embedders
// (gbrowser phoenix overlay) import { start, buildFetchHandler, ... }
// without triggering the listener-binding side effects.
if (import.meta.main) {
  start().catch((err) => {
    console.error(`[browse] Failed to start: ${err.message}`);
    // Write error to disk for the CLI to read — on Windows, the CLI can't capture
    // stderr because the server is launched with detached: true, stdio: 'ignore'.
    try {
      const errorLogPath = path.join(config.stateDir, 'browse-startup-error.log');
      mkdirSecure(config.stateDir);
      writeSecureFile(errorLogPath, `${new Date().toISOString()} ${err.message}\n${err.stack || ''}\n`);
    } catch {
      // stateDir may not exist — nothing more we can do
    }
    process.exit(1);
  });
}
