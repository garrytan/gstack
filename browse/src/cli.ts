/**
 * gstack CLI — thin wrapper that talks to the persistent server
 *
 * Flow:
 *   1. Read /tmp/browse-server.json for port + token
 *   2. If missing or stale PID → start server in background
 *   3. Health check
 *   4. Send command via HTTP POST
 *   5. Print response to stdout (or stderr for errors)
 */

import * as fs from 'fs';
import * as path from 'path';

const PORT_OFFSET = 45600;
const BROWSE_PORT = process.env.CONDUCTOR_PORT
  ? parseInt(process.env.CONDUCTOR_PORT, 10) - PORT_OFFSET
  : parseInt(process.env.BROWSE_PORT || '0', 10);
const INSTANCE_SUFFIX = BROWSE_PORT ? `-${BROWSE_PORT}` : '';
const STATE_FILE = process.env.BROWSE_STATE_FILE || `/tmp/browse-server${INSTANCE_SUFFIX}.json`;
// Serialize startup so parallel agent shells don't spawn duplicate daemons.
const LOCK_FILE = `${STATE_FILE}.lock`;
const MAX_START_WAIT = 8000; // 8 seconds to start
const LOCK_STALE_MS = 30_000;

export function resolveServerScript(
  env: Record<string, string | undefined> = process.env,
  metaDir: string = import.meta.dir,
  execPath: string = process.execPath
): string {
  if (env.BROWSE_SERVER_SCRIPT) {
    return env.BROWSE_SERVER_SCRIPT;
  }

  // Dev mode: cli.ts runs directly from browse/src
  if (metaDir.startsWith('/') && !metaDir.includes('$bunfs')) {
    const direct = path.resolve(metaDir, 'server.ts');
    if (fs.existsSync(direct)) {
      return direct;
    }
  }

  // Compiled binary: derive the source tree from browse/dist/browse
  if (execPath) {
    const adjacent = path.resolve(path.dirname(execPath), '..', 'src', 'server.ts');
    if (fs.existsSync(adjacent)) {
      return adjacent;
    }
  }

  // Legacy fallback for user-level installs
  return path.resolve(env.HOME || '/tmp', '.claude/skills/gstack/browse/src/server.ts');
}

const SERVER_SCRIPT = resolveServerScript();

interface ServerState {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
  serverPath: string;
}

interface StartLock {
  pid: number;
  createdAt: number;
}

// ─── State File ────────────────────────────────────────────────
function readState(): ServerState | null {
  try {
    const data = fs.readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(): StartLock | null {
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8')) as StartLock;
  } catch {
    return null;
  }
}

function tryAcquireStartLock(): boolean {
  try {
    fs.writeFileSync(
      LOCK_FILE,
      JSON.stringify({ pid: process.pid, createdAt: Date.now() } satisfies StartLock),
      { flag: 'wx', mode: 0o600 }
    );
    return true;
  } catch (err: any) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

function clearOwnedStartLock() {
  const lock = readLock();
  if (lock?.pid === process.pid) {
    try { fs.unlinkSync(LOCK_FILE); } catch {}
  }
}

function clearStaleStartLock() {
  const lock = readLock();
  if (!lock) return;
  if (!isProcessAlive(lock.pid) || Date.now() - lock.createdAt > LOCK_STALE_MS) {
    try { fs.unlinkSync(LOCK_FILE); } catch {}
  }
}

async function fetchHealth(state: ServerState, timeout = 2000): Promise<{ status: string } | null> {
  try {
    const resp = await fetch(`http://127.0.0.1:${state.port}/health`, {
      signal: AbortSignal.timeout(timeout),
    });
    if (!resp.ok) return null;
    return await resp.json() as { status: string };
  } catch {
    return null;
  }
}

async function getHealthyState(): Promise<ServerState | null> {
  const state = readState();
  if (!state || !isProcessAlive(state.pid)) {
    return null;
  }
  const health = await fetchHealth(state);
  if (health?.status === 'healthy') {
    return state;
  }
  return null;
}

// ─── Server Lifecycle ──────────────────────────────────────────
async function spawnServerProcess(): Promise<ServerState> {
  const existing = readState();
  if (existing && !isProcessAlive(existing.pid)) {
    try { fs.unlinkSync(STATE_FILE); } catch {}
  }

  const proc = Bun.spawn(['bun', 'run', SERVER_SCRIPT], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  // Don't hold the CLI open
  proc.unref();

  const start = Date.now();
  while (Date.now() - start < MAX_START_WAIT) {
    const state = readState();
    if (state && isProcessAlive(state.pid)) {
      const health = await fetchHealth(state, 1000);
      if (health?.status === 'healthy') {
        return state;
      }
    }
    await Bun.sleep(100);
  }

  const stderr = proc.stderr;
  if (stderr) {
    const reader = stderr.getReader();
    const { value } = await reader.read();
    if (value) {
      const errText = new TextDecoder().decode(value);
      throw new Error(`Server failed to start:\n${errText}`);
    }
  }
  throw new Error(`Server failed to start within ${MAX_START_WAIT / 1000}s`);
}

async function startServer(): Promise<ServerState> {
  const start = Date.now();
  while (Date.now() - start < MAX_START_WAIT) {
    const healthy = await getHealthyState();
    if (healthy) return healthy;

    // Another CLI process may already be starting the daemon. Wait for it
    // unless the lock is stale, then take over.
    clearStaleStartLock();
    if (tryAcquireStartLock()) {
      try {
        const healthyAfterLock = await getHealthyState();
        if (healthyAfterLock) return healthyAfterLock;
        return await spawnServerProcess();
      } finally {
        clearOwnedStartLock();
      }
    }

    await Bun.sleep(100);
  }

  const healthy = await getHealthyState();
  if (healthy) return healthy;
  throw new Error('[browse] Timed out waiting for server startup');
}

async function ensureServer(): Promise<ServerState> {
  const healthy = await getHealthyState();
  if (healthy) {
    return healthy;
  }

  console.error('[browse] Starting server...');
  return startServer();
}

async function waitForServerStop(pid: number, timeout = MAX_START_WAIT): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error('[browse] Timed out waiting for server shutdown');
}

function writeCommandOutput(text: string) {
  process.stdout.write(text);
  if (!text.endsWith('\n')) process.stdout.write('\n');
}

// ─── Command Dispatch ──────────────────────────────────────────
async function sendCommand(state: ServerState, command: string, args: string[], retries = 0): Promise<void> {
  const body = JSON.stringify({ command, args });

  try {
    const resp = await fetch(`http://127.0.0.1:${state.port}/command`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`,
      },
      body,
      signal: AbortSignal.timeout(30000),
    });

    if (resp.status === 401) {
      // Token mismatch — server may have restarted
      console.error('[browse] Auth failed — server may have restarted. Retrying...');
      const newState = readState();
      if (newState && newState.token !== state.token) {
        return sendCommand(newState, command, args);
      }
      throw new Error('Authentication failed');
    }

    const text = await resp.text();

    if (resp.ok) {
      writeCommandOutput(text);

      if (command === 'stop') {
        // "stop" returns success before the server exits. Wait for the daemon
        // and state file to disappear so the CLI only exits green on a real stop.
        await waitForServerStop(state.pid);
        return;
      }

      if (command === 'restart') {
        // "restart" is "clean stop, then ensure a fresh daemon exists" — not
        // "drop the socket and hope the next command recovers it."
        await waitForServerStop(state.pid);
        const newState = await ensureServer();
        if (newState.pid === state.pid) {
          throw new Error('[browse] Restart did not replace the server process');
        }
        return;
      }

      return;
    }

    // Try to parse as JSON error
    try {
      const err = JSON.parse(text);
      console.error(err.error || text);
      if (err.hint) console.error(err.hint);
    } catch {
      console.error(text);
    }
    process.exit(1);
  } catch (err: any) {
    if (err.name === 'AbortError') {
      console.error('[browse] Command timed out after 30s');
      process.exit(1);
    }
    // Connection error — server may have crashed
    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.message?.includes('fetch failed')) {
      if (retries >= 1) throw new Error('[browse] Server crashed twice in a row — aborting');
      console.error('[browse] Server connection lost. Restarting...');
      const newState = await startServer();
      return sendCommand(newState, command, args, retries + 1);
    }
    throw err;
  }
}

// ─── Main ──────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`gstack browse — Fast headless browser for AI coding agents

Usage: browse <command> [args...]

Navigation:     goto <url> | back | forward | reload | url
Content:        text | html [sel] | links | forms | accessibility
Interaction:    click <sel> | fill <sel> <val> | select <sel> <val>
                hover <sel> | type <text> | press <key>
                scroll [sel] | wait <sel|--networkidle|--load> | viewport <WxH>
                upload <sel> <file1> [file2...]
                cookie-import <json-file>
                cookie-import-browser [browser] [--domain <d>]
Inspection:     js <expr> | eval <file> | css <sel> <prop> | attrs <sel>
                console [--clear|--errors] | network [--clear] | dialog [--clear]
                cookies | storage [set <k> <v>] | perf
                is <prop> <sel> (visible|hidden|enabled|disabled|checked|editable|focused)
Visual:         screenshot [path] | pdf [path] | responsive [prefix]
Snapshot:       snapshot [-i] [-c] [-d N] [-s sel] [-D] [-a] [-o path] [-C]
                -D/--diff: diff against previous snapshot
                -a/--annotate: annotated screenshot with ref labels
                -C/--cursor-interactive: find non-ARIA clickable elements
Compare:        diff <url1> <url2>
Multi-step:     chain (reads JSON from stdin)
Tabs:           tabs | tab <id> | newtab [url] | closetab [id]
Server:         status | cookie <n>=<v> [origin] | header <n>:<v>
                useragent <str> | stop | restart
Dialogs:        dialog-accept [text] | dialog-dismiss

Refs:           After 'snapshot', use @e1, @e2... as selectors:
                click @e3 | fill @e4 "value" | hover @e1
                @c refs from -C: click @c1`);
    process.exit(0);
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  // Special case: chain reads from stdin
  if (command === 'chain' && commandArgs.length === 0) {
    const stdin = await Bun.stdin.text();
    commandArgs.push(stdin.trim());
  }

  const state = await ensureServer();
  await sendCommand(state, command, commandArgs);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[browse] ${err.message}`);
    process.exit(1);
  });
}
