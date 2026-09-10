/**
 * Xvfb (X virtual framebuffer) auto-spawn for headed Chromium on Linux
 * containers without DISPLAY.
 *
 * The motivating use case: a headless container needs to run Chromium in
 * "headed" mode (visible window) — for example, to run with the
 * AutomationControlled flag off and pass anti-bot fingerprint checks. Xvfb
 * provides an off-screen X server that Chromium can render into.
 *
 * Design notes:
 *   - Pick a free display dynamically (try :99, :100, :101...). NEVER unlink
 *     /tmp/.X<n>-lock for displays we didn't create — that would steal an
 *     active X server from another process or user.
 *   - Validate orphan Xvfb processes by BOTH /proc/<pid>/cmdline matching
 *     'Xvfb' AND start-time matching the recorded value. PID reuse is real;
 *     a one-field check would let us send SIGTERM to an unrelated process
 *     that happened to inherit a recycled PID.
 *   - Skip spawn entirely on macOS/Windows (native windowing) and on Linux
 *     when DISPLAY or WAYLAND_DISPLAY is already set (codex F2).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { safeKill, isProcessAlive } from './error-handling';

export interface XvfbHandle {
  pid: number;
  startTime: string;
  display: string; // e.g. ":99"
  /** Best-effort cleanup. Validates ownership before kill. */
  close: () => void;
}

export interface ShouldSpawnDecision {
  spawn: boolean;
  reason: string;
}

const DISPLAY_RANGE_START = 99;
const DISPLAY_RANGE_END = 120;

/**
 * Decide whether the daemon should auto-spawn an Xvfb. Pure: takes env +
 * platform and returns a decision. Easy to unit test.
 */
export function shouldSpawnXvfb(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ShouldSpawnDecision {
  if (env.BROWSE_HEADED !== '1') return { spawn: false, reason: 'not headed mode' };
  if (platform !== 'linux') return { spawn: false, reason: `platform ${platform} uses native windowing` };
  if (env.DISPLAY) return { spawn: false, reason: `DISPLAY=${env.DISPLAY} already set` };
  if (env.WAYLAND_DISPLAY) return { spawn: false, reason: `WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY} set; Chromium uses Wayland natively` };
  return { spawn: true, reason: 'linux headed without DISPLAY/WAYLAND_DISPLAY' };
}

/**
 * Probe a display number — return true if no X server is currently listening
 * on it (i.e., we can safely spawn a new Xvfb there).
 */
export function isDisplayFree(displayNum: number): boolean {
  // xdpyinfo exits 0 if a display is reachable. Exit non-zero means no
  // server, which is what we want. xdpyinfo ships in x11-utils, which some
  // images with Xvfb still lack (first Linux CI run: ENOENT) — fall back to
  // the X socket/lock files, the same signal X servers themselves use.
  try {
    const result = Bun.spawnSync(['xdpyinfo', '-display', `:${displayNum}`], {
    windowsHide: true,
      stdout: 'ignore', stderr: 'ignore', timeout: 2000,
    });
    return result.exitCode !== 0;
  } catch {
    return !fs.existsSync(`/tmp/.X11-unix/X${displayNum}`)
      && !fs.existsSync(`/tmp/.X${displayNum}-lock`);
  }
}

/**
 * Walk the display range and return the first free one, or null if all
 * displays in the range are taken.
 */
export function pickFreeDisplay(
  rangeStart: number = DISPLAY_RANGE_START,
  rangeEnd: number = DISPLAY_RANGE_END,
): number | null {
  for (let n = rangeStart; n <= rangeEnd; n++) {
    if (isDisplayFree(n)) return n;
  }
  return null;
}

/**
 * Read the wall-clock start time of a PID via `ps -o lstart=`. Stable across
 * reads (unlike /proc/stat field 22 which reports jiffies since boot in a
 * format that's harder to compare). Returns an empty string if the process
 * is gone or ps fails.
 */
export function readPidStartTime(pid: number): string {
  if (!isProcessAlive(pid)) return '';
  try {
    const result = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'lstart='], {
      windowsHide: true,
      stdout: 'pipe', stderr: 'pipe', timeout: 2000,
    });
    if (result.exitCode !== 0) return '';
    return result.stdout.toString().trim();
  } catch {
    // Bun.spawnSync THROWS when the executable is missing (Windows shells
    // without an MSYS `ps`). This function's contract is "empty string if
    // ps fails" — a missing ps must not abort the caller (browser-manager
    // now calls this on the universal launch path, #2709).
    return '';
  }
}

/**
 * Read the cmdline of a PID via /proc/<pid>/cmdline. Returns empty string
 * if the process is gone or the cmdline isn't readable.
 */
export function readPidCmdline(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim();
  } catch {
    // No /proc on darwin — the platform #2709's reap actually targets. Fall
    // back to ps (same pattern as readPidStartTime above); without this the
    // reap's cmdline identity gate always saw '' on macOS and the reap was
    // a structural no-op exactly where the spinning-GPU orphan lives.
    try {
      const result = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'command='], {
        windowsHide: true,
        stdout: 'pipe', stderr: 'pipe', timeout: 2000,
      });
      if (result.exitCode !== 0) return '';
      return result.stdout.toString().trim();
    } catch {
      return '';
    }
  }
}

/**
 * Read argv[0] of a PID via /proc/<pid>/cmdline (NUL-separated). Returns
 * empty string if the process is gone or the cmdline isn't readable.
 */
export function readPidArgv0(pid: number): string {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
    return raw.split('\0', 1)[0] ?? '';
  } catch {
    return '';
  }
}

/**
 * Validate that PID is still our Xvfb child. Both checks must pass:
 *   1. argv[0]'s basename IS the Xvfb binary. A substring match over the
 *      whole cmdline is identity-kill poison: any process whose ARGUMENTS
 *      mention xvfb (the test runner executing xvfb.test.ts, an editor with
 *      the file open) would pass and become killable. First Linux CI run
 *      caught exactly that — the suite identified itself as our Xvfb.
 *   2. Start time matches the recorded value (PID reuse defense)
 */
export function isOurXvfb(pid: number, recordedStartTime: string): boolean {
  if (!pid || !recordedStartTime) return false;
  const argv0 = readPidArgv0(pid);
  if (!argv0) return false;
  const base = argv0.split('/').pop() ?? '';
  if (base.toLowerCase() !== 'xvfb') return false;
  const currentStart = readPidStartTime(pid);
  if (!currentStart) return false;
  return currentStart === recordedStartTime;
}

/**
 * Spawn Xvfb on the given display. Returns a handle including the validated
 * start-time so future cleanup can confirm ownership.
 *
 * Throws if Xvfb isn't installed (caller should print a platform-specific
 * install hint).
 */
export async function spawnXvfb(displayNum: number): Promise<XvfbHandle> {
  const display = `:${displayNum}`;

  // Spawn detached: Xvfb's lifetime is tied to whether we've explicitly
  // killed it via the handle's close() method, not to the parent process.
  const proc = Bun.spawn(['Xvfb', display, '-screen', '0', '1920x1080x24', '-ac'], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  proc.unref();

  // Wait for the X server to become reachable — Xvfb takes a few hundred ms
  // to bind. Probe via xdpyinfo with retries.
  const deadline = Date.now() + 3000;
  let ready = false;
  while (Date.now() < deadline) {
    await Bun.sleep(100);
    if (!isDisplayFree(displayNum)) { ready = true; break; }
    // If Xvfb crashed during startup, fail fast.
    if (proc.exitCode != null) {
      throw new Error(`Xvfb on ${display} exited during startup (code ${proc.exitCode}). Hint: install xvfb (apt-get install xvfb / yum install xorg-x11-server-Xvfb).`);
    }
  }
  if (!ready) {
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    throw new Error(`Xvfb on ${display} never became reachable within 3s timeout`);
  }

  const startTime = readPidStartTime(proc.pid);
  return {
    pid: proc.pid,
    startTime,
    display,
    close: () => cleanupXvfb({ pid: proc.pid, startTime, display }),
  };
}

/**
 * Cleanup an Xvfb child if it's still ours. Validates ownership first; if
 * the PID has been recycled or the cmdline doesn't match, leave it alone.
 *
 * Best-effort: never throws.
 */
export function cleanupXvfb(state: { pid: number; startTime: string; display: string }): void {
  if (!state.pid) return;
  if (!isOurXvfb(state.pid, state.startTime)) return;
  try { safeKill(state.pid, 'SIGTERM'); } catch { /* swallow */ }
  // Wait briefly for Xvfb to exit, then SIGKILL if still alive.
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(state.pid)) break;
  }
  if (isProcessAlive(state.pid)) {
    try { safeKill(state.pid, 'SIGKILL'); } catch { /* swallow */ }
  }
}

/**
 * Print a platform-specific install hint and return the message string.
 * Used by server.ts when Xvfb isn't installed.
 */
export function xvfbInstallHint(): string {
  return 'Xvfb not installed. apt-get install xvfb (Debian/Ubuntu) or yum install xorg-x11-server-Xvfb (RHEL/CentOS). Note: minimal containers (alpine, distroless) may also need fonts, dbus, gtk libs for headed Chromium to render.';
}
