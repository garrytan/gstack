import { describe, test, expect, afterEach, beforeEach, mock } from 'bun:test';
import { spawn, type Subprocess } from 'bun';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { buildFetchHandler, __testInternals__, type ServerConfig } from '../src/server';
import { __resetRegistry } from '../src/token-registry';
import { resolveConfig } from '../src/config';

// End-to-end regression tests for the parent-process watchdog in server.ts.
// The watchdog has layered behavior since v0.18.1.0 (#1025) and v0.18.2.0
// (community wave #994 + our mode-gating follow-up):
//
//   1. BROWSE_PARENT_PID=0 disables the watchdog entirely (opt-in for CI + pair-agent).
//   2. BROWSE_HEADED=1 disables the watchdog entirely (server-side defense for headed
//      mode, where the user controls window lifecycle).
//   3. Default headless mode + parent dies: server STAYS ALIVE. The original
//      "kill on parent death" was inverted by #994 because Claude Code's Bash
//      sandbox kills the parent shell between every tool invocation, and #994
//      makes browse persist across $B calls. Idle timeout (30 min) handles
//      eventual cleanup.
//
// Tunnel mode coverage (parent dies → shutdown because idle timeout doesn't
// apply) is covered behaviorally in the in-process suite at the bottom of this
// file: the tick is exported via __testInternals__.parentWatchdogTick (same
// seam as idleCheckTick) and tunnelActive is simulated via setTunnelActive.
//
// Each test spawns the real server.ts. Tests 1 and 2 verify behavior via
// stdout log line (fast). Test 3 shrinks the poll cadence via
// BROWSE_PARENT_WATCHDOG_INTERVAL_MS (test seam in server.ts), waits for the
// tick's one-time "parent exited (server stays alive" log to prove a tick
// observed the death, then confirms the server REMAINS alive.

const ROOT = path.resolve(import.meta.dir, '..');
const SERVER_SCRIPT = path.join(ROOT, 'src', 'server.ts');

let tmpDir: string;
let serverProc: Subprocess | null = null;
let parentProc: Subprocess | null = null;

afterEach(async () => {
  // Kill any survivors so subsequent tests get a clean slate.
  try { parentProc?.kill('SIGKILL'); } catch {}
  try { serverProc?.kill('SIGKILL'); } catch {}
  // Give processes a moment to exit before tmpDir cleanup.
  await Bun.sleep(100);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  parentProc = null;
  serverProc = null;
});

function spawnServer(env: Record<string, string>, port: number): Subprocess {
  const stateFile = path.join(tmpDir, 'browse-state.json');
  return spawn(['bun', 'run', SERVER_SCRIPT], {
    env: {
      ...process.env,
      BROWSE_STATE_FILE: stateFile,
      BROWSE_PORT: String(port),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, no signal sent
    return true;
  } catch {
    return false;
  }
}

// Read stdout until we see the expected marker or timeout. Returns the captured
// text. Used to verify the watchdog code path ran as expected at startup.
async function readStdoutUntil(
  proc: Subprocess,
  marker: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const decoder = new TextDecoder();
  let captured = '';
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  try {
    while (Date.now() < deadline) {
      const readPromise = reader.read();
      const timed = Bun.sleep(Math.max(0, deadline - Date.now()));
      const result = await Promise.race([readPromise, timed.then(() => null)]);
      if (!result || result.done) break;
      captured += decoder.decode(result.value);
      if (captured.includes(marker)) return captured;
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return captured;
}

describe('parent-process watchdog (v0.18.1.0)', () => {
  test('BROWSE_PARENT_PID=0 disables the watchdog', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-pid0-'));
    serverProc = spawnServer({ BROWSE_PARENT_PID: '0' }, 34901);

    const out = await readStdoutUntil(
      serverProc,
      'Parent-process watchdog disabled (BROWSE_PARENT_PID=0)',
      5000,
    );
    expect(out).toContain('Parent-process watchdog disabled (BROWSE_PARENT_PID=0)');
    // Control: the "parent exited, shutting down" line must NOT appear —
    // that would mean the watchdog ran after we said to skip it.
    expect(out).not.toContain('Parent process');
  }, 15_000);

  test('BROWSE_HEADED=1 disables the watchdog (server-side guard)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-headed-'));
    // Pass a bogus parent PID to prove BROWSE_HEADED takes precedence.
    // If the server-side guard regresses, the watchdog would try to poll
    // this PID and eventually fire on the "dead parent."
    serverProc = spawnServer(
      { BROWSE_HEADED: '1', BROWSE_PARENT_PID: '999999' },
      34902,
    );

    const out = await readStdoutUntil(
      serverProc,
      'Parent-process watchdog disabled (headed mode)',
      5000,
    );
    expect(out).toContain('Parent-process watchdog disabled (headed mode)');
    expect(out).not.toContain('Parent process 999999 exited');
  }, 15_000);

  test('default headless mode: server STAYS ALIVE when parent dies (#994)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-default-'));

    // Spawn a real, short-lived "parent" that the watchdog will poll.
    parentProc = spawn(['sleep', '60'], { stdio: ['ignore', 'ignore', 'ignore'] });
    const parentPid = parentProc.pid!;

    // Default headless: no BROWSE_HEADED, real parent PID — watchdog active.
    // The poll cadence is shrunk via the server's env seam (250ms instead of
    // the production 15s) so observing a real tick doesn't cost a 20s sleep.
    serverProc = spawnServer({
      BROWSE_PARENT_PID: String(parentPid),
      BROWSE_PARENT_WATCHDOG_INTERVAL_MS: '250',
    }, 34903);
    const serverPid = serverProc.pid!;

    // Startup barrier: poll stdout for the listen line instead of a fixed 2s
    // sleep. The watchdog interval is registered at module load, before this
    // line prints, so once we see it the ticks are running.
    const bootOut = await readStdoutUntil(serverProc, 'Server running on', 15_000);
    expect(bootOut).toContain('Server running on');
    expect(isProcessAlive(serverPid)).toBe(true);

    // Kill the parent, then wait for a tick to OBSERVE the death: the
    // stay-alive branch logs a one-time latched line. Seeing it proves a tick
    // ran after parent death and chose NOT to shut down — pre-#994 the same
    // tick called shutdown instead. (Await exited first so the PID is reaped
    // and the tick's kill(pid, 0) probe sees ESRCH, not a zombie.)
    parentProc.kill('SIGKILL');
    await parentProc.exited;
    const marker = `Parent process ${parentPid} exited (server stays alive`;
    const out = await readStdoutUntil(serverProc, marker, 15_000);
    expect(out).toContain(marker);
    expect(out).not.toContain('shutting down');

    // Let several more ticks land (4+ at 250ms — the old fixed 20s sleep
    // covered ~1 production tick) and confirm the server is still alive —
    // that's the whole point of #994.
    await Bun.sleep(1_000);
    expect(isProcessAlive(serverPid)).toBe(true);
  }, 45_000);
});

// The three tests above all fix the mode via env at SPAWN time, so none of them
// reaches the headed branch of the watchdog. That branch is only reachable by a
// RUNTIME promotion, which `handoff` performs: it swaps in a headed context on a
// running daemon without a restart, moving a daemon that legitimately registered
// a watchdog onto the fatal side of the check. The parent is usually a
// short-lived shell (Claude Code's Bash tool kills one after every invocation),
// so the next poll shut the daemon down and discarded whatever the user had been
// handed off to do — observed as repeated session loss mid-login.
//
// The fix must NOT clear the interval, though: the same tick is the
// tunnel-orphan reaper (idle timeout is disabled in tunnel mode, so parent
// death is the ONLY thing that reaps an internet-exposed daemon). Promotion
// sets a suppress flag the tick re-reads each pass — "being headed" no longer
// kills the daemon on parent death, but an active tunnel still does.
//
// Driving a real `handoff` needs a headed Chromium, which does not belong in the
// free tier, so this pins the WIRING instead — the same static-tripwire approach
// used by cdp-session-cleanup.test.ts and server-auth.test.ts. If either half of
// the contract is dropped, the crash returns silently and these fail. The
// behavioral halves (suppression + tunnel reaping) run in-process below.
describe('headed parent-death shutdown is suppressed on runtime promotion', () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

  test('handoff() notifies the server that it promoted the daemon', () => {
    const src = read('src/browser-manager.ts');
    const promote = src.indexOf("this.connectionMode = 'headed';", src.indexOf('async handoff('));
    expect(promote).toBeGreaterThan(-1);
    // The notification must follow the promotion closely; a call left far away
    // (or removed) is the regression this guards.
    expect(src.slice(promote, promote + 800)).toContain('this.onHeadedPromotion?.()');
  });

  test('the server binds that callback to the suppress-flag setter', () => {
    const src = read('src/server.ts');
    expect(src).toContain('function suppressHeadedParentShutdown()');
    // Bound on BOTH the module-level manager and any embedder-supplied one; the
    // watchdog reads activeBrowserManager, so binding only the default instance
    // leaves embedders (e.g. gbrowser) promoting silently.
    expect(src).toContain('browserManager.onHeadedPromotion = suppressHeadedParentShutdown');
    expect(src).toContain('cfgBrowserManager.onHeadedPromotion = suppressHeadedParentShutdown');
  });

  test('promotion must NOT clear the interval — the tick doubles as the tunnel-orphan reaper', () => {
    const src = read('src/server.ts');
    // The original #2565 absorption cleared the ENTIRE interval on promotion.
    // Sequence handoff → resume → /pair-agent tunnel then left an
    // internet-exposed daemon that nothing reaps. The tick must stay
    // registered and re-check the suppress flag + tunnelActive every pass.
    expect(src).not.toContain('clearInterval(parentWatchdogTimer)');
    expect(src).toContain('setInterval(parentWatchdogTick');
    const tickStart = src.indexOf('function parentWatchdogTick(');
    expect(tickStart).toBeGreaterThan(-1);
    const tick = src.slice(tickStart, src.indexOf('\n}', tickStart));
    expect(tick).toContain('headedParentShutdownSuppressed');
    expect(tick).toContain('tunnelActive');
  });
});

// ─── Behavioral: suppressed watchdog still reaps tunnel orphans ────────────
//
// In-process, via the same __testInternals__ seam server-factory.test.ts uses
// for idleCheckTick. parentWatchdogTick(deadPid) simulates the 15s poll
// discovering a dead parent; setTunnelActive simulates /pair-agent's
// tunnel-create flow; suppressHeadedParentShutdown is exactly what the
// handoff promotion callback invokes.
function makeMinimalConfig(mode: 'launched' | 'headed', tmpDir: string): ServerConfig {
  const base = resolveConfig();
  return {
    authToken: 'watchdog-test-' + crypto.randomBytes(16).toString('hex'),
    browsePort: 34567,
    idleTimeoutMs: 1_800_000,
    // State paths pointed at a scratch dir so shutdown()'s cleanup can never
    // touch a real daemon's files on the machine running the tests.
    config: { ...base, stateFile: path.join(tmpDir, 'browse-state.json'), stateDir: tmpDir },
    browserManager: {
      getConnectionMode: () => mode,
      isWatching: () => false,
      stopWatch: () => {},
      close: async () => {},
      onDisconnect: null,
    } as any,
    startTime: Date.now(),
    // Skip terminal-agent teardown: identity files live under the REAL state
    // dir conventions and this suite must stay hermetic.
    ownsTerminalAgent: false,
  };
}

describe('suppressed watchdog still reaps tunnel orphans (behavioral)', () => {
  // A PID above darwin/linux default pid_max: process.kill(pid, 0) throws
  // ESRCH, which the tick reads as "parent exited".
  const DEAD_PID = 999_999;
  let scratch: string;
  const savedChromiumProfile = process.env.CHROMIUM_PROFILE;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-tick-'));
    // shutdown() runs cleanSingletonLocks(resolveChromiumProfile()); point it
    // at scratch so the operator's real profile is never inspected.
    process.env.CHROMIUM_PROFILE = path.join(scratch, 'chromium-profile');
    __resetRegistry();
    __testInternals__.setTunnelActive(false);
    __testInternals__.setLastActivity(Date.now());
    __testInternals__.resetShutdownState();
    __testInternals__.resetParentWatchdogState();
  });

  afterEach(() => {
    if (savedChromiumProfile === undefined) delete process.env.CHROMIUM_PROFILE;
    else process.env.CHROMIUM_PROFILE = savedChromiumProfile;
    __testInternals__.setTunnelActive(false);
    __testInternals__.resetShutdownState();
    __testInternals__.resetParentWatchdogState();
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
  });

  // Drain the fire-and-forget shutdown promise chain (flushBuffers + close)
  // the same way server-factory.test.ts does before asserting on exit.
  async function drainShutdown(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
  }

  test('after promotion suppression, parent death does NOT shut down a headed daemon (#2565)', async () => {
    const exitMock = mock((_code?: number) => {});
    const originalExit = process.exit;
    (process as any).exit = exitMock;
    try {
      buildFetchHandler(makeMinimalConfig('headed', scratch));
      __testInternals__.suppressHeadedParentShutdown(); // what handoff promotion triggers
      __testInternals__.parentWatchdogTick(DEAD_PID);
      await drainShutdown();
      expect(exitMock).not.toHaveBeenCalled();
    } finally {
      (process as any).exit = originalExit;
    }
  });

  test('CRITICAL: suppression active + tunnel live — parent death still shuts down', async () => {
    const exitMock = mock((_code?: number) => {});
    const originalExit = process.exit;
    (process as any).exit = exitMock;
    try {
      buildFetchHandler(makeMinimalConfig('headed', scratch));
      __testInternals__.suppressHeadedParentShutdown();
      __testInternals__.setTunnelActive(true); // handoff → resume → /pair-agent tunnel
      __testInternals__.parentWatchdogTick(DEAD_PID);
      await drainShutdown();
      // The tick is the ONLY reaper for tunnel orphans (idle timeout is
      // disabled in tunnel mode). If this fails, an internet-exposed daemon
      // outlives its parent forever.
      expect(exitMock).toHaveBeenCalled();
    } finally {
      (process as any).exit = originalExit;
    }
  });
});
