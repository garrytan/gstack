/**
 * Windows-safe resolution + spawn for gstack's bash bins. Two Windows-only
 * bugs made every hook subprocess a silent no-op; both are fixed here so all
 * call sites are covered at once.
 *
 * 1. `new URL(import.meta.url).pathname` yields `/C:/Users/...`; path.resolve
 *    then rebases it onto the drive root as `C:\C:\Users\...`. fileURLToPath
 *    is the correct conversion. (ENOENT before the bin ever ran.)
 * 2. `bin/gstack-*` are extensionless bash scripts. Windows has no shebang
 *    support, so they must be handed to bash explicitly.
 *
 * Also home to runExternal: the contained runner for EXTERNAL executables
 * (third-party binaries a hook hands data to; see its doc comment). Unlike
 * runBin it refuses win32, because its guarantee is process-group containment.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync, type SpawnSyncOptions } from 'child_process';

// Forward slashes on purpose: Bun's spawnSync on Windows returns ENOENT for a
// backslash exe path containing spaces.
const GIT_BASH = 'C:/Program Files/Git/bin/bash.exe';

/** bash Windows itself can execute — env override, Git Bash, then PATH. */
function bashExe(): string {
  return process.env.GSTACK_BASH || (fs.existsSync(GIT_BASH) ? GIT_BASH : 'bash');
}

/** gstack install root. This file lives at hosts/claude/hooks/. */
export function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..');
}

/** Absolute path to a `bin/` script. */
export function binPath(name: string): string {
  return path.join(repoRoot(), 'bin', name);
}

/** Resolve `name` under bin/ and run it, via bash on Windows. */
export function runBin(name: string, args: string[], opts: SpawnSyncOptions) {
  const bin = binPath(name);
  return process.platform === 'win32'
    ? spawnSync(bashExe(), [bin, ...args], opts)
    : spawnSync(bin, args, opts);
}

/** Kept tail of the child's stderr, for the caller's error log. */
const STDERR_TAIL_BYTES = 500;
/** After a group kill, how long to wait for 'exit'/'close' before resolving anyway (kept under the callers' post-spawn reserve). */
const KILL_GRACE_MS = 100;
/** After the direct child exits, how long to keep draining stdout before resolving. */
const EXIT_DRAIN_MS = 150;

export interface RunExternalOptions {
  /** bytes written to the child's stdin, then stdin is closed */
  input?: Buffer | string;
  /** wall-clock limit; on expiry the child's whole process group is SIGKILLed */
  timeoutMs: number;
  /** stdout cap in bytes; exceeding it kills the group and reports error 'ENOBUFS' (default 1 MiB) */
  maxBuffer?: number;
  /** the child's COMPLETE environment (callers allowlist; never pass process.env for a third-party binary) */
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** called once the child is running with a function that SIGKILLs its whole process group (for a caller's signal handler) */
  onSpawn?: (killGroup: () => void) => void;
  /** test seam: override process.platform */
  platform?: NodeJS.Platform;
}

export interface RunExternalResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  /** last STDERR_TAIL_BYTES of stderr, for the error log — never forwarded */
  stderrTail: string;
  /** 'EPLATFORM' (win32 unsupported), 'ENOBUFS', 'ETIMEDOUT', or a spawn errno */
  error?: string;
  /**
   * errno from writing the child's stdin (EPIPE when it exits before reading
   * a large input). Advisory and separate from `error`: a child that exited 0
   * with output still answered.
   */
  stdinError?: string;
  timedOut: boolean;
}

/**
 * Run an EXTERNAL executable (not a gstack bin) with containment a hook can
 * rely on:
 *   - `detached: true` makes the child a process-group leader, so a timeout
 *     kills the whole group (`process.kill(-pid)`) — a fork-style vendor shim
 *     cannot outlive the reported timeout the way a bare child kill allows.
 *   - resolves when the DIRECT child exits (after a short stdout drain), not
 *     only on 'close': a child that exits 0 but leaves a background process
 *     holding its pipes gets its output delivered and the straggler group-
 *     killed, instead of being reported as a timeout with its answer dropped.
 *   - NOTHING in the group outlives the call: the group is killed on every
 *     resolve, including a clean 'close' (a helper the child forked with its
 *     stdio redirected would otherwise run on unsupervised). A child that
 *     must leave a daemon behind has to setsid it; that is the child's
 *     explicit choice, visible in its own code, not an accident of ours.
 *   - a child that has already exited when the deadline fires keeps its
 *     result: the deadline then ends the drain, it does not rewrite a
 *     completed exit as a timeout.
 *   - stderr is drained continuously (an undrained pipe blocks a noisy child
 *     before it writes stdout) and only its tail is kept, never forwarded.
 *   - stdin gets an error listener, so a child that exits before reading a
 *     large input surfaces EPIPE as `stdinError`, not an unhandled event.
 *   - stdout is capped; the cap kills the group and reports ENOBUFS.
 *   - win32 is refused ('EPLATFORM'): there are no process groups to kill, so
 *     the containment guarantee cannot be given (Windows support for the
 *     bridges that use this is tracked in TODOS.md).
 * Async on purpose: spawnSync can only signal the direct child.
 */
export function runExternal(exe: string, args: string[], opts: RunExternalOptions): Promise<RunExternalResult> {
  const platform = opts.platform ?? process.platform;
  const maxBuffer = opts.maxBuffer ?? 1024 * 1024;
  const empty = (error: string): RunExternalResult =>
    ({ status: null, signal: null, stdout: Buffer.alloc(0), stderrTail: '', error, timedOut: false });
  if (platform === 'win32') return Promise.resolve(empty('EPLATFORM'));
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, args, {
        detached: true,
        cwd: opts.cwd,
        env: opts.env as NodeJS.ProcessEnv | undefined,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve(empty((e as NodeJS.ErrnoException)?.code ?? 'ESPAWN'));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let stderrTail = '';
    let error: string | undefined;
    let stdinError: string | undefined;
    let timedOut = false;
    let done = false;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const killGroup = (): void => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    };
    const finish = (status: number | null, signal: NodeJS.Signals | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (drainTimer) clearTimeout(drainTimer);
      // Nothing in the group outlives the call; a straggler holding our pipes
      // must not pin this process either.
      killGroup();
      for (const s of [child.stdout, child.stderr, child.stdin]) { try { s?.destroy(); } catch { /* closed */ } }
      try { child.unref(); } catch { /* fine */ }
      resolve({ status, signal, stdout: Buffer.concat(chunks), stderrTail, ...(stdinError ? { stdinError } : {}), error, timedOut });
    };
    const timer = setTimeout(() => {
      // The child already answered and exited; the deadline only ends the drain.
      if (exited) { finish(exited.code, exited.signal); return; }
      timedOut = true;
      error = error ?? 'ETIMEDOUT';
      killGroup();
      // If 'exit' never arrives (a grandchild holding the pipes open past the
      // kill), resolve anyway: the caller's own deadline is what matters.
      graceTimer = setTimeout(() => finish(null, 'SIGKILL'), KILL_GRACE_MS);
    }, Math.max(1, opts.timeoutMs));
    opts.onSpawn?.(killGroup);
    child.on('error', (e) => { error = (e as NodeJS.ErrnoException)?.code ?? 'ESPAWN'; finish(null, null); });
    child.stdout?.on('data', (d: Buffer) => {
      if (done) return;
      total += d.length;
      if (total > maxBuffer) { error = 'ENOBUFS'; killGroup(); return; }
      chunks.push(d);
    });
    child.stderr?.on('data', (d: Buffer) => { stderrTail = (stderrTail + d.toString('utf8')).slice(-STDERR_TAIL_BYTES); });
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      if (done) return;
      // A killed child (timeout, ENOBUFS) has nothing worth draining: resolve
      // now so the caller keeps its post-spawn reserve.
      if (timedOut || error) { finish(code, signal); return; }
      // stdio may still be open (a background grandchild inherited the pipes):
      // drain what the child itself wrote, then resolve with its real exit and
      // kill whatever is still holding the group.
      drainTimer = setTimeout(() => { killGroup(); finish(code, signal); }, EXIT_DRAIN_MS);
    });
    child.on('close', (code, signal) => finish(code, signal));
    if (child.stdin) {
      child.stdin.on('error', (e) => { stdinError = stdinError ?? ((e as NodeJS.ErrnoException)?.code ?? 'EPIPE'); });
      if (opts.input !== undefined) child.stdin.end(opts.input); else child.stdin.end();
    }
  });
}
