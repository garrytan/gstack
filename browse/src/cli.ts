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
import { spawn as nodeSpawn } from 'node:child_process';

const PORT_OFFSET = 45600;
const BROWSE_PORT = process.env.CONDUCTOR_PORT
  ? parseInt(process.env.CONDUCTOR_PORT, 10) - PORT_OFFSET
  : parseInt(process.env.BROWSE_PORT || '0', 10);
const INSTANCE_SUFFIX = BROWSE_PORT ? `-${BROWSE_PORT}` : '';
const STATE_FILE = process.env.BROWSE_STATE_FILE || `/tmp/browse-server${INSTANCE_SUFFIX}.json`;
const MAX_START_WAIT = 8000; // 8 seconds to start

const IS_WINDOWS = process.platform === 'win32';

export function resolveServerScript(
  env: Record<string, string | undefined> = process.env,
  metaDir: string = import.meta.dir,
  execPath: string = process.execPath
): string {
  if (env.BROWSE_SERVER_SCRIPT) {
    return env.BROWSE_SERVER_SCRIPT;
  }

  // Dev mode: cli.ts runs directly from browse/src (Unix paths start with /, Windows with drive letter)
  if (!metaDir.includes('$bunfs')) {
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
  return path.resolve(env.HOME || env.USERPROFILE || '/tmp', '.claude/skills/gstack/browse/src/server.ts');
}

/**
 * On Windows, Bun's subprocess management hangs when Playwright spawns Chromium.
 * Use a pre-bundled server.js with Node instead. On Unix, Bun works fine.
 */
export function resolveServerBundle(
  env: Record<string, string | undefined> = process.env,
  execPath: string = process.execPath
): string | null {
  if (!IS_WINDOWS) return null;

  // Look for compiled server.js next to the browse binary
  if (execPath) {
    const bundled = path.resolve(path.dirname(execPath), 'server.js');
    if (fs.existsSync(bundled)) return bundled;
  }

  // Fallback: check user-level install
  const fallback = path.resolve(env.HOME || env.USERPROFILE || '/tmp', '.claude/skills/gstack/browse/dist/server.js');
  if (fs.existsSync(fallback)) return fallback;

  return null;
}

const SERVER_SCRIPT = resolveServerScript();
const SERVER_BUNDLE = resolveServerBundle();

interface ServerState {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
  serverPath: string;
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

// ─── Server Lifecycle ──────────────────────────────────────────
async function startServer(): Promise<ServerState> {
  // Clean up stale state file
  try { fs.unlinkSync(STATE_FILE); } catch {}

  // Start server as detached background process
  // On Windows, Bun + Playwright hangs on chromium.launch(), so use Node with
  // a pre-bundled server.js. On Unix, Bun runs the .ts source directly.
  // We also use node:child_process on Windows for proper detaching (Bun.spawn
  // + unref doesn't fully detach on Windows, causing the server to die with the CLI).
  const useNode = IS_WINDOWS && SERVER_BUNDLE;
  const spawnCmd = useNode ? 'node' : 'bun';
  const spawnArgs = useNode ? [SERVER_BUNDLE] : ['run', SERVER_SCRIPT];

  if (IS_WINDOWS) {
    // node:child_process with detached:true properly orphans on Windows
    const child = nodeSpawn(spawnCmd, spawnArgs, {
      stdio: 'ignore',
      detached: true,
      env: { ...process.env },
    });
    child.unref();
  } else {
    const proc = Bun.spawn([spawnCmd, ...spawnArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    proc.unref();
  }

  // Wait for state file to appear
  const start = Date.now();
  while (Date.now() - start < MAX_START_WAIT) {
    const state = readState();
    if (state && isProcessAlive(state.pid)) {
      return state;
    }
    await Bun.sleep(100);
  }

  throw new Error(`Server failed to start within ${MAX_START_WAIT / 1000}s`);
}

async function ensureServer(): Promise<ServerState> {
  const state = readState();

  if (state && isProcessAlive(state.pid)) {
    // Server appears alive — do a health check
    try {
      const resp = await fetch(`http://127.0.0.1:${state.port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) {
        const health = await resp.json() as any;
        if (health.status === 'healthy') {
          return state;
        }
      }
    } catch {
      // Health check failed — server is dead or unhealthy
    }
  }

  // Need to (re)start
  console.error('[browse] Starting server...');
  return startServer();
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
      process.stdout.write(text);
      if (!text.endsWith('\n')) process.stdout.write('\n');
    } else {
      // Try to parse as JSON error
      try {
        const err = JSON.parse(text);
        console.error(err.error || text);
        if (err.hint) console.error(err.hint);
      } catch {
        console.error(text);
      }
      process.exit(1);
    }
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
                scroll [sel] | wait <sel> | viewport <WxH>
Inspection:     js <expr> | eval <file> | css <sel> <prop> | attrs <sel>
                console [--clear] | network [--clear]
                cookies | storage [set <k> <v>] | perf
Visual:         screenshot [path] | pdf [path] | responsive [prefix]
Snapshot:       snapshot [-i] [-c] [-d N] [-s sel]
Compare:        diff <url1> <url2>
Multi-step:     chain (reads JSON from stdin)
Tabs:           tabs | tab <id> | newtab [url] | closetab [id]
Server:         status | cookie <n>=<v> | header <n>:<v>
                useragent <str> | stop | restart

Refs:           After 'snapshot', use @e1, @e2... as selectors:
                click @e3 | fill @e4 "value" | hover @e1`);
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
