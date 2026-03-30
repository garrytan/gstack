/**
 * gstack CLI — thin wrapper that talks to the persistent server
 *
 * Flow:
 *   1. Read .gstack/browse.json for port + token
 *   2. If missing or stale PID → start server in background
 *   3. Health check + version mismatch detection
 *   4. Send command via HTTP POST
 *   5. Print response to stdout (or stderr for errors)
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveConfig, ensureStateDir, readVersionHash } from './config';

const config = resolveConfig();
const IS_WINDOWS = process.platform === 'win32';
const MAX_START_WAIT = IS_WINDOWS ? 15000 : (process.env.CI ? 30000 : 8000); // Node+Chromium takes longer on Windows

export function resolveServerScript(
  env: Record<string, string | undefined> = process.env,
  metaDir: string = import.meta.dir,
  execPath: string = process.execPath
): string {
  if (env.BROWSE_SERVER_SCRIPT) {
    return env.BROWSE_SERVER_SCRIPT;
  }

  // Dev mode: cli.ts runs directly from browse/src
  // On macOS/Linux, import.meta.dir starts with /
  // On Windows, it starts with a drive letter (e.g., C:\...)
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

  throw new Error(
    'Cannot find server.ts. Set BROWSE_SERVER_SCRIPT env or run from the browse source tree.'
  );
}

const SERVER_SCRIPT = resolveServerScript();

/**
 * On Windows, resolve the Node.js-compatible server bundle.
 * Falls back to null if not found (server will use Bun instead).
 */
export function resolveNodeServerScript(
  metaDir: string = import.meta.dir,
  execPath: string = process.execPath
): string | null {
  // Dev mode
  if (!metaDir.includes('$bunfs')) {
    const distScript = path.resolve(metaDir, '..', 'dist', 'server-node.mjs');
    if (fs.existsSync(distScript)) return distScript;
  }

  // Compiled binary: browse/dist/browse → browse/dist/server-node.mjs
  if (execPath) {
    const adjacent = path.resolve(path.dirname(execPath), 'server-node.mjs');
    if (fs.existsSync(adjacent)) return adjacent;
  }

  return null;
}

const NODE_SERVER_SCRIPT = IS_WINDOWS ? resolveNodeServerScript() : null;

// On Windows, hard-fail if server-node.mjs is missing — the Bun path is known broken.
if (IS_WINDOWS && !NODE_SERVER_SCRIPT) {
  throw new Error(
    'server-node.mjs not found. Run `bun run build` to generate the Windows server bundle.'
  );
}

interface ServerState {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
  serverPath: string;
  binaryVersion?: string;
  mode?: 'launched' | 'headed';
}

// ─── State File ────────────────────────────────────────────────
function readState(): ServerState | null {
  try {
    const data = fs.readFileSync(config.stateFile, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (IS_WINDOWS) {
    // Bun's compiled binary can't signal Windows PIDs (always throws ESRCH).
    // Use tasklist as a fallback. Only for one-shot calls — too slow for polling loops.
    try {
      const result = Bun.spawnSync(
        ['tasklist', '/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
        { stdout: 'pipe', stderr: 'pipe', timeout: 3000 }
      );
      return result.stdout.toString().includes(`"${pid}"`);
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * HTTP health check — definitive proof the server is alive and responsive.
 * Used in all polling loops instead of isProcessAlive() (which is slow on Windows).
 */
export async function isServerHealthy(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return false;
    const health = await resp.json() as any;
    return health.status === 'healthy';
  } catch {
    return false;
  }
}

// ─── Process Management ─────────────────────────────────────────
async function killServer(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) return;

  if (IS_WINDOWS) {
    // taskkill /T /F kills the process tree (Node + Chromium)
    try {
      Bun.spawnSync(
        ['taskkill', '/PID', String(pid), '/T', '/F'],
        { stdout: 'pipe', stderr: 'pipe', timeout: 5000 }
      );
    } catch {}
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && isProcessAlive(pid)) {
      await Bun.sleep(100);
    }
    return;
  }

  try { process.kill(pid, 'SIGTERM'); } catch { return; }

  // Wait up to 2s for graceful shutdown
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await Bun.sleep(100);
  }

  // Force kill if still alive
  if (isProcessAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

/**
 * Clean up legacy /tmp/browse-server*.json files from before project-local state.
 * Verifies PID ownership before sending signals.
 */
function cleanupLegacyState(): void {
  // No legacy state on Windows — /tmp and `ps` don't exist, and gstack
  // never ran on Windows before the Node.js fallback was added.
  if (IS_WINDOWS) return;

  try {
    const files = fs.readdirSync('/tmp').filter(f => f.startsWith('browse-server') && f.endsWith('.json'));
    for (const file of files) {
      const fullPath = `/tmp/${file}`;
      try {
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
        if (data.pid && isProcessAlive(data.pid)) {
          // Verify this is actually a browse server before killing
          const check = Bun.spawnSync(['ps', '-p', String(data.pid), '-o', 'command='], {
            stdout: 'pipe', stderr: 'pipe', timeout: 2000,
          });
          const cmd = check.stdout.toString().trim();
          if (cmd.includes('bun') || cmd.includes('server.ts')) {
            try { process.kill(data.pid, 'SIGTERM'); } catch {}
          }
        }
        fs.unlinkSync(fullPath);
      } catch {
        // Best effort — skip files we can't parse or clean up
      }
    }
    // Clean up legacy log files too
    const logFiles = fs.readdirSync('/tmp').filter(f =>
      f.startsWith('browse-console') || f.startsWith('browse-network') || f.startsWith('browse-dialog')
    );
    for (const file of logFiles) {
      try { fs.unlinkSync(`/tmp/${file}`); } catch {}
    }
  } catch {
    // /tmp read failed — skip legacy cleanup
  }
}

// ─── Server Lifecycle ──────────────────────────────────────────
async function startServer(extraEnv?: Record<string, string>): Promise<ServerState> {
  ensureStateDir(config);

  // Clean up stale state file and error log
  try { fs.unlinkSync(config.stateFile); } catch {}
  try { fs.unlinkSync(path.join(config.stateDir, 'browse-startup-error.log')); } catch {}

  let proc: any = null;

  if (IS_WINDOWS && NODE_SERVER_SCRIPT) {
    // Windows: Bun.spawn() + proc.unref() doesn't truly detach on Windows —
    // when the CLI exits, the server dies with it. Use Node's child_process.spawn
    // with { detached: true } instead, which is the gold standard for Windows
    // process independence. Credit: PR #191 by @fqueiro.
    const launcherCode =
      `const{spawn}=require('child_process');` +
      `spawn(process.execPath,[${JSON.stringify(NODE_SERVER_SCRIPT)}],` +
      `{detached:true,stdio:['ignore','ignore','ignore'],env:Object.assign({},process.env,` +
      `{BROWSE_STATE_FILE:${JSON.stringify(config.stateFile)}})}).unref()`;
    Bun.spawnSync(['node', '-e', launcherCode], { stdio: ['ignore', 'ignore', 'ignore'] });
  } else {
    // macOS/Linux: Bun.spawn + unref works correctly
    proc = Bun.spawn(['bun', 'run', SERVER_SCRIPT], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BROWSE_STATE_FILE: config.stateFile, ...extraEnv },
    });
    proc.unref();
  }

  // Wait for server to become healthy.
  // Use HTTP health check (not isProcessAlive) — it's fast (~instant ECONNREFUSED)
  // and works reliably on all platforms including Windows.
  const start = Date.now();
  while (Date.now() - start < MAX_START_WAIT) {
    const state = readState();
    if (state && await isServerHealthy(state.port)) {
      return state;
    }
    await Bun.sleep(100);
  }

  // Server didn't start in time — try to get error details
  if (proc?.stderr) {
    // macOS/Linux: read stderr from the spawned process
    const reader = proc.stderr.getReader();
    const { value } = await reader.read();
    if (value) {
      const errText = new TextDecoder().decode(value);
      throw new Error(`Server failed to start:\n${errText}`);
    }
  } else {
    // Windows: check startup error log (server writes errors to disk since
    // stderr is unavailable due to stdio: 'ignore' for detachment)
    const errorLogPath = path.join(config.stateDir, 'browse-startup-error.log');
    try {
      const errorLog = fs.readFileSync(errorLogPath, 'utf-8').trim();
      if (errorLog) {
        throw new Error(`Server failed to start:\n${errorLog}`);
      }
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  throw new Error(`Server failed to start within ${MAX_START_WAIT / 1000}s`);
}

/**
 * Acquire an exclusive lockfile to prevent concurrent ensureServer() races (TOCTOU).
 * Returns a cleanup function that releases the lock.
 */
function acquireServerLock(): (() => void) | null {
  const lockPath = `${config.stateFile}.lock`;
  try {
    // 'wx' — create exclusively, fails if file already exists (atomic check-and-create)
    // Using string flag instead of numeric constants for Bun Windows compatibility
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, `${process.pid}\n`);
    fs.closeSync(fd);
    return () => { try { fs.unlinkSync(lockPath); } catch {} };
  } catch {
    // Lock already held — check if the holder is still alive
    try {
      const holderPid = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
      if (holderPid && isProcessAlive(holderPid)) {
        return null; // Another live process holds the lock
      }
      // Stale lock — remove and retry
      fs.unlinkSync(lockPath);
      return acquireServerLock();
    } catch {
      return null;
    }
  }
}

async function ensureServer(): Promise<ServerState> {
  const state = readState();

  // Health-check-first: HTTP is definitive proof the server is alive and responsive.
  // This replaces the PID-gated approach which breaks on Windows (Bun's process.kill
  // always throws ESRCH for Windows PIDs in compiled binaries).
  if (state && await isServerHealthy(state.port)) {
    // Check for binary version mismatch (auto-restart on update)
    const currentVersion = readVersionHash();
    if (currentVersion && state.binaryVersion && currentVersion !== state.binaryVersion) {
      console.error('[browse] Binary updated, restarting server...');
      await killServer(state.pid);
      return startServer();
    }
    return state;
  }

  // Guard: never silently replace a headed server with a headless one.
  // Headed mode means a user-visible Chrome window is (or was) controlled.
  // Silently replacing it would be confusing — tell the user to reconnect.
  if (state && state.mode === 'headed' && isProcessAlive(state.pid)) {
    console.error(`[browse] Headed server running (PID ${state.pid}) but not responding.`);
    console.error(`[browse] Run '$B connect' to restart.`);
    process.exit(1);
  }

  // Ensure state directory exists before lock acquisition (lock file lives there)
  ensureStateDir(config);

  // Acquire lock to prevent concurrent restart races (TOCTOU)
  const releaseLock = acquireServerLock();
  if (!releaseLock) {
    // Another process is starting the server — wait for it
    console.error('[browse] Another instance is starting the server, waiting...');
    const start = Date.now();
    while (Date.now() - start < MAX_START_WAIT) {
      const freshState = readState();
      if (freshState && await isServerHealthy(freshState.port)) return freshState;
      await Bun.sleep(200);
    }
    throw new Error('Timed out waiting for another instance to start the server');
  }

  try {
    // Re-read state under lock in case another process just started the server
    const freshState = readState();
    if (freshState && await isServerHealthy(freshState.port)) {
      return freshState;
    }

    // Kill the old server to avoid orphaned chromium processes
    if (state && state.pid) {
      await killServer(state.pid);
    }
    console.error('[browse] Starting server...');
    return await startServer();
  } finally {
    releaseLock();
  }
}

// ─── Command Dispatch ──────────────────────────────────────────
async function sendCommand(state: ServerState, command: string, args: string[], retries = 0): Promise<void> {
  // BROWSE_TAB env var pins commands to a specific tab (set by sidebar-agent per-tab)
  const browseTab = process.env.BROWSE_TAB;
  const body = JSON.stringify({ command, args, ...(browseTab ? { tabId: parseInt(browseTab, 10) } : {}) });

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
      // Kill the old server to avoid orphaned chromium processes
      const oldState = readState();
      if (oldState && oldState.pid) {
        await killServer(oldState.pid);
      }
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
Visual:         screenshot [--viewport] [--clip x,y,w,h] [@ref|sel] [path]
                pdf [path] | responsive [prefix]
Snapshot:       snapshot [-i] [-c] [-d N] [-s sel] [-D] [-a] [-o path] [-C]
                -D/--diff: diff against previous snapshot
                -a/--annotate: annotated screenshot with ref labels
                -C/--cursor-interactive: find non-ARIA clickable elements
Compare:        diff <url1> <url2>
Multi-step:     chain (reads JSON from stdin)
Tabs:           tabs | tab <id> | newtab [url] | closetab [id]
Server:         status | cookie <n>=<v> | header <n>:<v>
                useragent <str> | stop | restart
Dialogs:        dialog-accept [text] | dialog-dismiss

Refs:           After 'snapshot', use @e1, @e2... as selectors:
                click @e3 | fill @e4 "value" | hover @e1
                @c refs from -C: click @c1`);
    process.exit(0);
  }

  // One-time cleanup of legacy /tmp state files
  cleanupLegacyState();

  const command = args[0];
  const commandArgs = args.slice(1);

  // ─── Headed Connect (pre-server command) ────────────────────
  // connect must be handled BEFORE ensureServer() because it needs
  // to restart the server in headed mode with the Chrome extension.
  if (command === 'connect') {
    // Check if already in headed mode and healthy
    const existingState = readState();
    if (existingState && existingState.mode === 'headed' && isProcessAlive(existingState.pid)) {
      try {
        const resp = await fetch(`http://127.0.0.1:${existingState.port}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (resp.ok) {
          console.log('Already connected in headed mode.');
          process.exit(0);
        }
      } catch {
        // Headed server alive but not responding — kill and restart
      }
    }

    // Kill ANY existing server (SIGTERM → wait 2s → SIGKILL)
    if (existingState && isProcessAlive(existingState.pid)) {
      try { process.kill(existingState.pid, 'SIGTERM'); } catch {}
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (isProcessAlive(existingState.pid)) {
        try { process.kill(existingState.pid, 'SIGKILL'); } catch {}
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Kill orphaned Chromium processes that may still hold the profile lock.
    // The server PID is the Bun process; Chromium is a child that can outlive it
    // if the server is killed abruptly (SIGKILL, crash, manual rm of state file).
    const profileDir = path.join(process.env.HOME || '/tmp', '.gstack', 'chromium-profile');
    try {
      const singletonLock = path.join(profileDir, 'SingletonLock');
      const lockTarget = fs.readlinkSync(singletonLock); // e.g. "hostname-12345"
      const orphanPid = parseInt(lockTarget.split('-').pop() || '', 10);
      if (orphanPid && isProcessAlive(orphanPid)) {
        try { process.kill(orphanPid, 'SIGTERM'); } catch {}
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (isProcessAlive(orphanPid)) {
          try { process.kill(orphanPid, 'SIGKILL'); } catch {}
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    } catch {
      // No lock symlink or not readable — nothing to kill
    }

    // Clean up Chromium profile locks (can persist after crashes)
    for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try { fs.unlinkSync(path.join(profileDir, lockFile)); } catch {}
    }

    // Delete stale state file
    try { fs.unlinkSync(config.stateFile); } catch {}

    console.log('Launching headed Chromium with extension + sidebar agent...');
    try {
      // Start server in headed mode with extension auto-loaded
      // Use a well-known port so the Chrome extension auto-connects
      const serverEnv: Record<string, string> = {
        BROWSE_HEADED: '1',
        BROWSE_PORT: '34567',
        BROWSE_SIDEBAR_CHAT: '1',
      };
      const newState = await startServer(serverEnv);

      // Print connected status
      const resp = await fetch(`http://127.0.0.1:${newState.port}/command`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${newState.token}`,
        },
        body: JSON.stringify({ command: 'status', args: [] }),
        signal: AbortSignal.timeout(5000),
      });
      const status = await resp.text();
      console.log(`Connected to real Chrome\n${status}`);

      // Auto-start sidebar agent
      // __dirname is inside $bunfs in compiled binaries — resolve from execPath instead
      let agentScript = path.resolve(__dirname, 'sidebar-agent.ts');
      if (!fs.existsSync(agentScript)) {
        agentScript = path.resolve(path.dirname(process.execPath), '..', 'src', 'sidebar-agent.ts');
      }
      try {
        if (!fs.existsSync(agentScript)) {
          throw new Error(`sidebar-agent.ts not found at ${agentScript}`);
        }
        // Clear old agent queue
        const agentQueue = path.join(process.env.HOME || '/tmp', '.gstack', 'sidebar-agent-queue.jsonl');
        try { fs.writeFileSync(agentQueue, ''); } catch {}

        // Resolve browse binary path the same way — execPath-relative
        let browseBin = path.resolve(__dirname, '..', 'dist', 'browse');
        if (!fs.existsSync(browseBin)) {
          browseBin = process.execPath; // the compiled binary itself
        }

        // Kill any existing sidebar-agent processes before starting a new one.
        // Old agents have stale auth tokens and will silently fail to relay events,
        // causing the server to mark the agent as "hung".
        try {
          const { spawnSync } = require('child_process');
          spawnSync('pkill', ['-f', 'sidebar-agent\\.ts'], { stdio: 'ignore', timeout: 3000 });
        } catch {}

        const agentProc = Bun.spawn(['bun', 'run', agentScript], {
          cwd: config.projectDir,
          env: {
            ...process.env,
            BROWSE_BIN: browseBin,
            BROWSE_STATE_FILE: config.stateFile,
            BROWSE_SERVER_PORT: String(newState.port),
          },
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        agentProc.unref();
        console.log(`[browse] Sidebar agent started (PID: ${agentProc.pid})`);
      } catch (err: any) {
        console.error(`[browse] Sidebar agent failed to start: ${err.message}`);
        console.error(`[browse] Run manually: bun run ${agentScript}`);
      }
    } catch (err: any) {
      console.error(`[browse] Connect failed: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // ─── Headed Disconnect (pre-server command) ─────────────────
  // disconnect must be handled BEFORE ensureServer() because the headed
  // guard blocks all commands when the server is unresponsive.
  if (command === 'disconnect') {
    const existingState = readState();
    if (!existingState || existingState.mode !== 'headed') {
      console.log('Not in headed mode — nothing to disconnect.');
      process.exit(0);
    }
    // Try graceful shutdown via server
    try {
      const resp = await fetch(`http://127.0.0.1:${existingState.port}/command`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${existingState.token}`,
        },
        body: JSON.stringify({ command: 'disconnect', args: [] }),
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) {
        console.log('Disconnected from real browser.');
        process.exit(0);
      }
    } catch {
      // Server not responding — force cleanup
    }
    // Force kill + cleanup
    if (isProcessAlive(existingState.pid)) {
      try { process.kill(existingState.pid, 'SIGTERM'); } catch {}
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (isProcessAlive(existingState.pid)) {
        try { process.kill(existingState.pid, 'SIGKILL'); } catch {}
      }
    }
    // Clean profile locks and state file
    const profileDir = path.join(process.env.HOME || '/tmp', '.gstack', 'chromium-profile');
    for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try { fs.unlinkSync(path.join(profileDir, lockFile)); } catch {}
    }
    try { fs.unlinkSync(config.stateFile); } catch {}
    console.log('Disconnected (server was unresponsive — force cleaned).');
    process.exit(0);
  }

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
