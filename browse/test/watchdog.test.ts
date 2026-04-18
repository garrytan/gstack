import { describe, test, expect, afterEach } from 'bun:test';
import { spawn, type Subprocess } from 'bun';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

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
// apply) is not covered by an automated test here — tunnelActive is a runtime
// variable set by /pair-agent's tunnel-create flow, not an env var, so faking
// it would require invasive test-only hooks. The mode check is documented
// inline at the watchdog and SIGTERM handlers, and would regress visibly for
// /pair-agent users (server lingers after disconnect).
//
// Each test spawns the real server.ts. Tests 1 and 2 verify behavior via
// stdout log line (fast). Test 3 waits for the watchdog poll cycle to confirm
// the server REMAINS alive after parent death (slow — ~20s observation window).

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
    serverProc = spawnServer({ BROWSE_PARENT_PID: String(parentPid) }, 34903);
    const serverPid = serverProc.pid!;

    // Give the server a moment to start and register the watchdog interval.
    await Bun.sleep(2000);
    expect(isProcessAlive(serverPid)).toBe(true);

    // Kill the parent. The watchdog polls every 15s, so first tick after
    // parent death lands within ~15s. Pre-#994 the server would shutdown
    // here. Post-#994 the server logs the parent exit and stays alive.
    parentProc.kill('SIGKILL');

    // Wait long enough for at least one watchdog tick (15s) plus margin.
    // Server should still be alive — that's the whole point of #994.
    await Bun.sleep(20_000);
    expect(isProcessAlive(serverPid)).toBe(true);
  }, 45_000);
});
