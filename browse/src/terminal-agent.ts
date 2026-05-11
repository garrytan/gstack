/**
 * Terminal Agent — PTY-backed Claude Code terminal for the gstack browser
 * sidebar. Translates the phoenix gbrowser PTY (cmd/gbd/terminal.go) into
 * Bun, with a few changes informed by codex's outside-voice review:
 *
 *  - Lives in a separate non-compiled bun process from sidebar-agent.ts so
 *    a bug in WS framing or PTY cleanup can't take down the chat path.
 *  - Binds 127.0.0.1 only — never on the dual-listener tunnel surface.
 *  - Origin validation on the WS upgrade is REQUIRED (not defense-in-depth)
 *    because a localhost shell WS is a real cross-site WebSocket-hijacking
 *    target.
 *  - Cookie-based auth via /internal/grant from the parent server, not a
 *    token in /health.
 *  - Lazy spawn: claude PTY is not spawned until the WS receives its first
 *    data frame. Sidebar opens that never type don't burn a claude session.
 *  - PTY dies with WS close (one PTY per WS). v1.1 may add session
 *    survival; for v1 we match phoenix's lifecycle.
 *
 * The PTY uses Bun's `terminal:` spawn option (verified at impl time on
 * Bun 1.3.10): pass cols/rows + a data callback; write input via
 * `proc.terminal.write(buf)`; resize via `proc.terminal.resize(cols, rows)`.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { writeSecureFile, mkdirSecure } from './file-permissions';
import { safeUnlink } from './error-handling';

const STATE_FILE = process.env.BROWSE_STATE_FILE || path.join(process.env.HOME || '/tmp', '.gstack', 'browse.json');
const PORT_FILE = path.join(path.dirname(STATE_FILE), 'terminal-port');
const BROWSE_SERVER_PORT = parseInt(process.env.BROWSE_SERVER_PORT || '0', 10);
const EXTENSION_ID = process.env.BROWSE_EXTENSION_ID || ''; // optional: tighten Origin check
const INTERNAL_TOKEN = crypto.randomBytes(32).toString('base64url'); // shared with parent server via env at spawn

// In-memory cookie token registry. Parent posts /internal/grant after
// /pty-session; we validate WS cookies against this set.
const validTokens = new Set<string>();

// Active PTY session per WS. One terminal per connection. Codex finding #4:
// uncaught handlers below catch bugs in framing/cleanup so they don't kill
// the listener loop.
process.on('uncaughtException', (err) => {
  console.error('[terminal-agent] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[terminal-agent] unhandledRejection:', reason);
});

interface PtySession {
  proc: any | null;        // Bun.Subprocess once spawned
  cols: number;
  rows: number;
  cookie: string;
  spawned: boolean;
}

const sessions = new WeakMap<any, PtySession>(); // ws -> session

/** Find claude on PATH. */
function findClaude(): string | null {
  // Test-only override. Lets the integration tests spawn /bin/bash instead
  // of requiring claude to be installed on every CI runner. NEVER read in
  // production (sidebar UI). Documented in browse/test/terminal-agent-integration.test.ts.
  const override = process.env.BROWSE_TERMINAL_BINARY;
  if (override && fs.existsSync(override)) return override;
  // Bun.which is sync and respects PATH. Falls back to a small list of
  // common install locations if PATH is stripped (e.g., launched from
  // Conductor with a minimal env).
  const which = (Bun as any).which?.('claude');
  if (which) return which;
  const candidates = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    `${process.env.HOME}/.local/bin/claude`,
    `${process.env.HOME}/.bun/bin/claude`,
    `${process.env.HOME}/.npm-global/bin/claude`,
  ];
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {}
  }
  return null;
}

/** Probe + persist claude availability for the bootstrap card. */
function writeClaudeAvailable(): void {
  const stateDir = path.dirname(STATE_FILE);
  try { mkdirSecure(stateDir); } catch {}
  const found = findClaude();
  const status = {
    available: !!found,
    path: found || undefined,
    install_url: 'https://docs.anthropic.com/en/docs/claude-code',
    checked_at: new Date().toISOString(),
  };
  const target = path.join(stateDir, 'claude-available.json');
  const tmp = path.join(stateDir, `.tmp-claude-${process.pid}`);
  try {
    writeSecureFile(tmp, JSON.stringify(status, null, 2));
    fs.renameSync(tmp, target);
  } catch {
    safeUnlink(tmp);
  }
}

/**
 * System-prompt hint passed to claude via --append-system-prompt. Tells
 * claude what tab-awareness affordances exist in this session so it
 * doesn't have to discover them by trial. The user can override anything
 * here just by saying so — system prompt is a soft hint, not a contract.
 *
 * Two paths claude has:
 *   1. Read live state from <stateDir>/tabs.json + active-tab.json
 *      (updated continuously by the gstack browser extension).
 *   2. Run $B tab, $B tabs, $B tab-each <command> to act on tabs. The
 *      tab-each helper fans a single command across every open tab and
 *      returns per-tab results as JSON.
 */
function buildTabAwarenessHint(stateDir: string): string {
  const tabsFile = path.join(stateDir, 'tabs.json');
  const activeFile = path.join(stateDir, 'active-tab.json');
  return [
    'You are running inside the gstack browser sidebar with live access to the user\'s browser tabs.',
    '',
    'Tab state files (kept fresh automatically by the extension):',
    `  ${tabsFile}        — all open tabs (id, url, title, active, pinned)`,
    `  ${activeFile}    — the currently active tab`,
    'Read these any time the user asks about "tabs", "the current page", or anything multi-tab. Do NOT shell out to $B tabs just to learn what\'s open — read the file.',
    '',
    'Tab manipulation commands (via $B):',
    '  $B tab <id>                 — switch to a tab',
    '  $B newtab [url]             — open a new tab',
    '  $B closetab [id]            — close a tab (current if no id)',
    '  $B tab-each <command>       — fan out a command across every tab; returns JSON results',
    '',
    'When the user asks for multi-tab work, prefer $B tab-each. Examples:',
    '  $B tab-each snapshot -i     — grab a snapshot from every tab',
    '  $B tab-each text            — pull clean text from every tab',
    '  $B tab-each title           — list every tab\'s title',
    '',
    'You\'re in a real terminal with a real PTY — slash commands, /resume, ANSI colors all work as in a normal claude session.',
  ].join('\n');
}

/** Spawn claude in a PTY. Returns null if claude not on PATH. */
function spawnClaude(cols: number, rows: number, onData: (chunk: Buffer) => void) {
  const claudePath = findClaude();
  if (!claudePath) return null;

  // Match phoenix env so claude knows which browse server to talk to and
  // doesn't try to autostart its own. BROWSE_HEADED=1 keeps the existing
  // headed-mode browser; BROWSE_NO_AUTOSTART prevents claude's gstack
  // tooling from racing to spawn another server.
  const env: Record<string, string> = {
    ...process.env as any,
    BROWSE_PORT: String(BROWSE_SERVER_PORT),
    BROWSE_STATE_FILE: STATE_FILE,
    BROWSE_NO_AUTOSTART: '1',
    BROWSE_HEADED: '1',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };

  // --append-system-prompt is the right injection surface (per `claude --help`):
  // it gets appended to the model's system prompt, so claude treats this as
  // contextual guidance, not a user message. Don't use a leading PTY write
  // for this — that would show up as if the user typed the hint, polluting
  // the visible transcript.
  const stateDir = path.dirname(STATE_FILE);
  const tabHint = buildTabAwarenessHint(stateDir);

  const proc = (Bun as any).spawn([claudePath, '--append-system-prompt', tabHint], {
    terminal: {
      rows,
      cols,
      data(_terminal: any, chunk: Buffer) { onData(chunk); },
    },
    env,
  });
  return proc;
}

/** Cleanup a PTY session: SIGINT, then SIGKILL after 3s. */
function disposeSession(session: PtySession): void {
  try { session.proc?.terminal?.close?.(); } catch {}
  if (session.proc?.pid) {
    try { session.proc.kill?.('SIGINT'); } catch {}
    setTimeout(() => {
      try {
        if (session.proc && !session.proc.killed) session.proc.kill?.('SIGKILL');
      } catch {}
    }, 3000);
  }
  session.proc = null;
  session.spawned = false;
}

/**
 * Build the HTTP server. Two routes:
 *   POST /internal/grant — parent server pushes a fresh cookie token
 *   GET  /ws             — extension upgrades to WebSocket (PTY transport)
 *
 * Everything else returns 404. The listener binds 127.0.0.1 only.
 */
function buildServer() {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0, // PTY connections are long-lived; default idleTimeout would kill them

    fetch(req, server) {
      const url = new URL(req.url);

      // /internal/grant — loopback-only handshake from parent server.
      if (url.pathname === '/internal/grant' && req.method === 'POST') {
        const auth = req.headers.get('authorization');
        if (auth !== `Bearer ${INTERNAL_TOKEN}`) {
          return new Response('forbidden', { status: 403 });
        }
        return req.json().then((body: any) => {
          if (typeof body?.token === 'string' && body.token.length > 16) {
            validTokens.add(body.token);
          }
          return new Response('ok');
        }).catch(() => new Response('bad', { status: 400 }));
      }

      // /internal/revoke — drop a token (called on WS close or bootstrap reload)
      if (url.pathname === '/internal/revoke' && req.method === 'POST') {
        const auth = req.headers.get('authorization');
        if (auth !== `Bearer ${INTERNAL_TOKEN}`) {
          return new Response('forbidden', { status: 403 });
        }
        return req.json().then((body: any) => {
          if (typeof body?.token === 'string') validTokens.delete(body.token);
          return new Response('ok');
        }).catch(() => new Response('bad', { status: 400 }));
      }

      // /claude-available — bootstrap card hits this when user clicks "I installed it".
      if (url.pathname === '/claude-available' && req.method === 'GET') {
        writeClaudeAvailable();
        const found = findClaude();
        return new Response(JSON.stringify({ available: !!found, path: found }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // /ws — WebSocket upgrade. CRITICAL gates:
      //   (1) Origin must be chrome-extension://<id>. Cross-site WS hijacking
      //       defense — required, not optional.
      //   (2) Token must be in validTokens. We accept the token via two
      //       transports for compatibility:
      //         - Sec-WebSocket-Protocol (preferred for browsers — the only
      //           auth header settable from the browser WebSocket API)
      //         - Cookie gstack_pty (works for non-browser callers and
      //           same-port browser callers; doesn't survive the cross-port
      //           jump from server.ts:34567 to the agent's random port
      //           when SameSite=Strict is set)
      //       Either path works; both verify against the same in-memory
      //       validTokens Set, populated by the parent server's
      //       authenticated /pty-session → /internal/grant chain.
      if (url.pathname === '/ws') {
        const origin = req.headers.get('origin') || '';
        const isExtensionOrigin = origin.startsWith('chrome-extension://');
        if (!isExtensionOrigin) {
          return new Response('forbidden origin', { status: 403 });
        }
        if (EXTENSION_ID && origin !== `chrome-extension://${EXTENSION_ID}`) {
          return new Response('forbidden origin', { status: 403 });
        }

        // Try Sec-WebSocket-Protocol first. Format: a single token, possibly
        // with a `gstack-pty.` prefix (which we strip). Browsers send a
        // comma-separated list when multiple were requested; we pick the
        // first that matches a known token.
        const protoHeader = req.headers.get('sec-websocket-protocol') || '';
        let token: string | null = null;
        let acceptedProtocol: string | null = null;
        for (const raw of protoHeader.split(',').map(s => s.trim()).filter(Boolean)) {
          const candidate = raw.startsWith('gstack-pty.') ? raw.slice('gstack-pty.'.length) : raw;
          if (validTokens.has(candidate)) {
            token = candidate;
            acceptedProtocol = raw;
            break;
          }
        }

        // Fallback: Cookie gstack_pty (legacy / non-browser callers).
        if (!token) {
          const cookieHeader = req.headers.get('cookie') || '';
          for (const part of cookieHeader.split(';')) {
            const [name, ...rest] = part.trim().split('=');
            if (name === 'gstack_pty') {
              const candidate = rest.join('=') || null;
              if (candidate && validTokens.has(candidate)) {
                token = candidate;
              }
              break;
            }
          }
        }

        if (!token) {
          return new Response('unauthorized', { status: 401 });
        }

        const upgraded = server.upgrade(req, {
          data: { cookie: token },
          // Echo the protocol back so the browser accepts the upgrade.
          // Required when the client sends Sec-WebSocket-Protocol — the
          // server MUST select one of the offered protocols, otherwise
          // the browser closes the connection immediately.
          ...(acceptedProtocol ? { headers: { 'Sec-WebSocket-Protocol': acceptedProtocol } } : {}),
        });
        return upgraded ? undefined : new Response('upgrade failed', { status: 500 });
      }

      return new Response('not found', { status: 404 });
    },

    websocket: {
      message(ws, raw) {
        let session = sessions.get(ws);
        if (!session) {
          session = {
            proc: null,
            cols: 80,
            rows: 24,
            cookie: (ws.data as any)?.cookie || '',
            spawned: false,
          };
          sessions.set(ws, session);
        }

        // Text frames are control messages: {type: "resize", cols, rows} or
        // {type: "tabSwitch", tabId, url, title}. Binary frames are raw input
        // bytes destined for the PTY stdin.
        if (typeof raw === 'string') {
          let msg: any;
          try { msg = JSON.parse(raw); } catch { return; }
          if (msg?.type === 'resize') {
            const cols = Math.max(2, Math.floor(Number(msg.cols) || 80));
            const rows = Math.max(2, Math.floor(Number(msg.rows) || 24));
            session.cols = cols;
            session.rows = rows;
            try { session.proc?.terminal?.resize?.(cols, rows); } catch {}
            return;
          }
          if (msg?.type === 'tabSwitch') {
            handleTabSwitch(msg);
            return;
          }
          if (msg?.type === 'tabState') {
            handleTabState(msg);
            return;
          }
          // Unknown text frame — ignore.
          return;
        }

        // Binary input. Lazy-spawn claude on the first byte.
        if (!session.spawned) {
          session.spawned = true;
          // UTF-8 boundary detection to prevent splitting multi-byte characters (issue #1272).
          // Buffer incomplete UTF-8 sequences until the next chunk completes them.
          let leftover = Buffer.alloc(0);
          const proc = spawnClaude(session.cols, session.rows, (chunk) => {
            const combined = Buffer.concat([leftover, Buffer.from(chunk)]);
            // Find the last index where a UTF-8 codepoint ends. Look back at most 3 bytes.
            let safeEnd = combined.length;
            for (let i = combined.length - 1; i >= Math.max(0, combined.length - 3); i--) {
              const b = combined[i];
              if ((b & 0x80) === 0) { safeEnd = i + 1; break; }              // ASCII
              if ((b & 0xC0) === 0x80) continue;                             // continuation byte
              const expected = (b & 0xE0) === 0xC0 ? 2 : (b & 0xF0) === 0xE0 ? 3 : 4;
              safeEnd = (combined.length - i >= expected) ? combined.length : i;
              break;
            }
            const flush = combined.slice(0, safeEnd);
            leftover = combined.slice(safeEnd);
            if (flush.length) {
              try { ws.sendBinary(flush); } catch {}
            }
          });
          if (!proc) {
            try {
              ws.send(JSON.stringify({
                type: 'error',
                code: 'CLAUDE_NOT_FOUND',
                message: 'claude CLI not on PATH. Install: https://docs.anthropic.com/en/docs/claude-code',
              }));
              ws.close(4404, 'claude not found');
            } catch {}
            return;
          }
          session.proc = proc;
          // Watch for child exit so the WS closes cleanly when claude exits.
          proc.exited?.then?.(() => {
            try { ws.close(1000, 'pty exited'); } catch {}
          });
        }
        try {
          // raw is a Uint8Array; Bun.Terminal.write accepts string|Buffer.
          // Convert to Buffer for safety.
          session.proc?.terminal?.write?.(Buffer.from(raw as Uint8Array));
        } catch (err) {
          console.error('[terminal-agent] terminal.write failed:', err);
        }
      },

      close(ws) {
        const session = sessions.get(ws);
        if (session) {
          disposeSession(session);
          if (session.cookie) {
            // Drop the cookie so it can't be replayed against a new PTY.
            validTokens.delete(session.cookie);
          }
          sessions.delete(ws);
        }
      },
    },
  });
}

/**
 * Tab-switch helper: write the active tab to a state file (claude reads it)
 * and notify the parent server so its activeTabId stays synced. Skips
 * chrome:// and chrome-extension:// internal pages.
 */
/**
 * Live tab snapshot. Writes <stateDir>/tabs.json (full list) and updates
 * <stateDir>/active-tab.json (current active). claude can read these any
 * time without invoking $B tabs — saves a round-trip when the model just
 * needs to check the landscape before deciding what to do.
 */
function handleTabState(msg: {
  active?: { tabId?: number; url?: string; title?: string } | null;
  tabs?: Array<{ tabId?: number; url?: string; title?: string; active?: boolean; windowId?: number; pinned?: boolean; audible?: boolean }>;
  reason?: string;
}): void {
  const stateDir = path.dirname(STATE_FILE);
  try { mkdirSecure(stateDir); } catch {}

  // tabs.json — full list
  if (Array.isArray(msg.tabs)) {
    const payload = {
      updatedAt: new Date().toISOString(),
      reason: msg.reason || 'unknown',
      tabs: msg.tabs.map(t => ({
        tabId: t.tabId ?? null,
        url: t.url || '',
        title: t.title || '',
        active: !!t.active,
        windowId: t.windowId ?? null,
        pinned: !!t.pinned,
        audible: !!t.audible,
      })),
    };
    const target = path.join(stateDir, 'tabs.json');
    const tmp = path.join(stateDir, `.tmp-tabs-${process.pid}`);
    try {
      writeSecureFile(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, target);
    } catch {
      safeUnlink(tmp);
    }
  }

  // active-tab.json — single active tab. Skip chrome-internal pages so
  // claude doesn't see chrome:// or chrome-extension:// URLs as
  // "current target."
  const active = msg.active;
  if (active && active.url && !active.url.startsWith('chrome://') && !active.url.startsWith('chrome-extension://')) {
    const ctxFile = path.join(stateDir, 'active-tab.json');
    const tmp = path.join(stateDir, `.tmp-tab-${process.pid}`);
    try {
      writeSecureFile(tmp, JSON.stringify({
        tabId: active.tabId ?? null,
        url: active.url,
        title: active.title ?? '',
      }));
      fs.renameSync(tmp, ctxFile);
    } catch {
      safeUnlink(tmp);
    }
  }
}

function handleTabSwitch(msg: { tabId?: number; url?: string; title?: string }): void {
  const url = msg.url || '';
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return;

  const stateDir = path.dirname(STATE_FILE);
  const ctxFile = path.join(stateDir, 'active-tab.json');
  const tmp = path.join(stateDir, `.tmp-tab-${process.pid}`);
  try {
    writeSecureFile(tmp, JSON.stringify({
      tabId: msg.tabId ?? null,
      url,
      title: msg.title ?? '',
    }));
    fs.renameSync(tmp, ctxFile);
  } catch {
    safeUnlink(tmp);
  }

  // Best-effort sync to parent server so its activeTabId tracking matches.
  // No await; this is fire-and-forget.
  if (BROWSE_SERVER_PORT > 0) {
    fetch(`http://127.0.0.1:${BROWSE_SERVER_PORT}/command`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${readBrowseToken()}`,
      },
      body: JSON.stringify({
        command: 'tab',
        args: [String(msg.tabId ?? ''), '--no-focus'],
      }),
    }).catch(() => {});
  }
}

function readBrowseToken(): string {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const j = JSON.parse(raw);
    return j.token || '';
  } catch { return ''; }
}

// Boot.
function main() {
  writeClaudeAvailable();
  const server = buildServer();
  const port = (server as any).port || (server as any).address?.port;
  if (!port) {
    console.error('[terminal-agent] failed to bind: no port');
    process.exit(1);
  }

  // Write port file atomically so the parent server can pick it up.
  const dir = path.dirname(PORT_FILE);
  try { mkdirSecure(dir); } catch {}
  const tmp = `${PORT_FILE}.tmp-${process.pid}`;
  writeSecureFile(tmp, String(port));
  fs.renameSync(tmp, PORT_FILE);

  // Hand the parent the internal token so it can call /internal/grant.
  // Parent learns INTERNAL_TOKEN via env (TERMINAL_AGENT_INTERNAL_TOKEN below).
  // We just print it on stdout for the supervising process to pick up if it's
  // not already in env. Defense against env races at spawn time.
  console.log(`[terminal-agent] listening on 127.0.0.1:${port} pid=${process.pid}`);

  // Cleanup port file on exit.
  const cleanup = () => { safeUnlink(PORT_FILE); process.exit(0); };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
}

// Export the internal token so cli.ts can pass the SAME value to the parent
// server via env. Parent reads BROWSE_TERMINAL_INTERNAL_TOKEN and uses it
// for /internal/grant calls.
//
// In practice, the agent generates INTERNAL_TOKEN once at boot and writes it
// to a state file the parent reads. This avoids env-passing races. See main().
const INTERNAL_TOKEN_FILE = path.join(path.dirname(STATE_FILE), 'terminal-internal-token');
try {
  mkdirSecure(path.dirname(INTERNAL_TOKEN_FILE));
  writeSecureFile(INTERNAL_TOKEN_FILE, INTERNAL_TOKEN);
} catch {}

main();
