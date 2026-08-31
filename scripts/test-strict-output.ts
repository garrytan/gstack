/**
 * Strict Bun-test output classification + child lifecycle helpers.
 *
 * Works around a Bun test runner bug where failures can be printed even though
 * the child exits successfully: output is forwarded byte-for-byte as it
 * arrives, and only complete Bun result lines and terminal summaries are
 * classified. `strictTestExitCode` then refuses to trust a zero exit when the
 * output shows failures (or when fewer files ran than expected).
 *
 * Shared by the sharded paid-tier runner (scripts/test-paid-shards.ts) and any
 * future strict wrapper around `bun test`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const BUN_FAIL_RESULT = /^\(fail\) .+ \[(?:\d+(?:\.\d+)?)(?:ns|us|µs|ms|s)\]$/;
const BUN_BETWEEN_TESTS_ERROR = '# Unhandled error between tests';
const BUN_TERMINAL_SUMMARY = /^Ran (\d+) tests? across (\d+) files?\. \[(?:\d+(?:\.\d+)?)(?:ns|us|µs|ms|s)\]$/;

export type BunTestOutputFinding = 'failed-test' | 'unhandled-between-tests';

export interface BunTestOutputSummary {
  failedTests: number;
  unhandledBetweenTests: number;
  terminalFileCounts: number[];
  /** Test counts from the same terminal lines — feeds the hollow-shard guard. */
  terminalTestCounts: number[];
}

export type ForwardedTerminationSignal = 'SIGINT' | 'SIGTERM';

export interface TerminationSignalSource {
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
}

export interface TerminationTimerApi {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface ChildSignalForwarding {
  readonly receivedSignal: ForwardedTerminationSignal | null;
  dispose(): void;
}

const DEFAULT_TERMINATION_TIMER: TerminationTimerApi = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Per-source termination bookkeeping, shared across every forwarder bound to
 * the same source. Installing ANY signal listener suppresses Node's default
 * terminate-on-SIGINT/SIGTERM, so without this the parent runner survived
 * cancellation: it killed the current child, then kept LAUNCHING new shards
 * (observed: paid runs continuing to burn API spend after Ctrl-C). The first
 * signal now also schedules the parent's own exit after the children's
 * SIGKILL grace, and runners consult isTerminationRequested() before
 * launching more work.
 */
interface SourceTerminationState {
  requested: boolean;
  exitScheduled: boolean;
}
const SOURCE_TERMINATION_STATE = new WeakMap<TerminationSignalSource, SourceTerminationState>();
function terminationStateFor(source: TerminationSignalSource): SourceTerminationState {
  let state = SOURCE_TERMINATION_STATE.get(source);
  if (!state) {
    state = { requested: false, exitScheduled: false };
    SOURCE_TERMINATION_STATE.set(source, state);
  }
  return state;
}
export function isTerminationRequested(source: TerminationSignalSource = process): boolean {
  return SOURCE_TERMINATION_STATE.get(source)?.requested ?? false;
}
const signalExitCode = (signal: ForwardedTerminationSignal): number =>
  128 + (signal === 'SIGINT' ? 2 : 15);

/**
 * Bind one active child to the parent's termination lifecycle. SIGINT and
 * SIGTERM get a grace period so Bun can clean up; a repeated signal, timeout,
 * or synchronous parent exit uses SIGKILL so the child cannot be orphaned.
 * The parent itself exits shortly after the grace window (or immediately on
 * a repeated signal) — cancellation must terminate the RUN, not just the
 * currently-running children.
 */
export function installChildSignalForwarding(
  child: Pick<ChildProcess, 'kill'>,
  source: TerminationSignalSource = process,
  timer: TerminationTimerApi = DEFAULT_TERMINATION_TIMER,
  graceMs = 5_000,
  exitImpl: (code: number) => void = (code) => process.exit(code),
): ChildSignalForwarding {
  let receivedSignal: ForwardedTerminationSignal | null = null;
  let forceTimer: unknown = null;
  let disposed = false;

  const scheduleParentExit = (signal: ForwardedTerminationSignal, delayMs: number): void => {
    const state = terminationStateFor(source);
    state.requested = true;
    if (state.exitScheduled) return;
    state.exitScheduled = true;
    // Never cancelled by dispose(): once cancellation is requested, the run
    // is going down even if this particular shard finishes cleanly first.
    timer.schedule(() => exitImpl(signalExitCode(signal)), delayMs);
  };

  const forward = (signal: ForwardedTerminationSignal): void => {
    if (disposed) return;
    if (receivedSignal !== null) {
      child.kill('SIGKILL');
      scheduleParentExit(signal, 0);
      return;
    }
    receivedSignal = signal;
    child.kill(signal);
    forceTimer = timer.schedule(() => {
      forceTimer = null;
      child.kill('SIGKILL');
    }, graceMs);
    // Exit AFTER the children's SIGKILL grace so the group kills land first.
    scheduleParentExit(signal, graceMs + 1_000);
  };
  const onSigint = () => forward('SIGINT');
  const onSigterm = () => forward('SIGTERM');
  const onExit = () => { child.kill('SIGKILL'); };

  source.on('SIGINT', onSigint);
  source.on('SIGTERM', onSigterm);
  source.on('exit', onExit);

  return {
    get receivedSignal() {
      return receivedSignal;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      source.off('SIGINT', onSigint);
      source.off('SIGTERM', onSigterm);
      source.off('exit', onExit);
      if (forceTimer !== null) timer.cancel(forceTimer);
      forceTimer = null;
    },
  };
}

/**
 * SIGKILL the shard's whole process group. Orphaned grandchildren (browsers,
 * claude sessions) are how a stalled run once burned a core for 15.7 hours.
 */
export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === 'win32' || typeof child.pid !== 'number') {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return; // group already gone
    if (code !== 'EPERM') throw err;
    // Observed on macOS after a SIGKILLed group is reaped: signalling the
    // now-empty group id returns EPERM, not ESRCH. Throwing here loses the
    // shard's real outcome (a timeout gets recorded as a failure) and, from
    // the timeout timer, leaves the shard promise unsettled — a hang, which
    // is the exact failure class this runner exists to kill. Fall back to the
    // direct pid so a genuinely-live child is still signalled.
    try {
      child.kill(signal);
    } catch {
      // Best-effort reap: nothing actionable is left if this fails too.
    }
  }
}

/**
 * Strip ANSI escapes and a trailing CR from one output line. Every line
 * matcher (here and in the free runner's console filter / failure
 * attribution) MUST match against this form — a prior grep for `(fail)`
 * lines missed real failures because color codes sat inside the line.
 */
export function stripAnsiLine(rawLine: string): string {
  return rawLine.replace(ANSI_ESCAPE, '').replace(/\r$/, '');
}

export function classifyBunTestOutputLine(rawLine: string): BunTestOutputFinding | null {
  const line = stripAnsiLine(rawLine);
  if (BUN_FAIL_RESULT.test(line)) return 'failed-test';
  if (line === BUN_BETWEEN_TESTS_ERROR) return 'unhandled-between-tests';
  return null;
}

export function parseBunTerminalSummaryLine(rawLine: string): number | null {
  return parseBunTerminalSummary(rawLine)?.files ?? null;
}

export function parseBunTerminalSummary(rawLine: string): { tests: number; files: number } | null {
  const line = stripAnsiLine(rawLine);
  const match = BUN_TERMINAL_SUMMARY.exec(line);
  return match
    ? { tests: Number.parseInt(match[1], 10), files: Number.parseInt(match[2], 10) }
    : null;
}

/**
 * Incrementally classifies output without assuming process chunks align to
 * lines. Buffers are PER ORIGIN: stdout and stderr are independent pipes, so
 * a chunk from one can arrive between two halves of a line from the other.
 * A single shared buffer would glue those fragments into garbled lines — a
 * sheared `(fail)` line goes uncounted and a sheared terminal summary reads
 * as truncation. Counters are shared; only line assembly is per-stream.
 */
export type ClassifierOrigin = 'stdout' | 'stderr';

export class BunTestOutputClassifier {
  private readonly decoders: Record<ClassifierOrigin, StringDecoder> = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  };
  private pending: Record<ClassifierOrigin, string> = { stdout: '', stderr: '' };
  private failedTests = 0;
  private unhandledBetweenTests = 0;
  private terminalFileCounts: number[] = [];
  private terminalTestCounts: number[] = [];

  write(chunk: Uint8Array | string, origin: ClassifierOrigin = 'stdout'): void {
    this.pending[origin] += typeof chunk === 'string'
      ? chunk
      : this.decoders[origin].write(Buffer.from(chunk));
    this.consumeCompleteLines(origin);
  }

  end(): BunTestOutputSummary {
    for (const origin of ['stdout', 'stderr'] as const) {
      this.pending[origin] += this.decoders[origin].end();
      if (this.pending[origin].length > 0) this.classify(this.pending[origin]);
      this.pending[origin] = '';
    }
    return this.summary();
  }

  summary(): BunTestOutputSummary {
    return {
      failedTests: this.failedTests,
      unhandledBetweenTests: this.unhandledBetweenTests,
      terminalFileCounts: [...this.terminalFileCounts],
      terminalTestCounts: [...this.terminalTestCounts],
    };
  }

  private consumeCompleteLines(origin: ClassifierOrigin): void {
    let newline = this.pending[origin].indexOf('\n');
    while (newline !== -1) {
      this.classify(this.pending[origin].slice(0, newline));
      this.pending[origin] = this.pending[origin].slice(newline + 1);
      newline = this.pending[origin].indexOf('\n');
    }
  }

  private classify(line: string): void {
    const finding = classifyBunTestOutputLine(line);
    if (finding === 'failed-test') this.failedTests += 1;
    if (finding === 'unhandled-between-tests') this.unhandledBetweenTests += 1;
    const terminal = parseBunTerminalSummary(line);
    if (terminal !== null) {
      this.terminalFileCounts.push(terminal.files);
      this.terminalTestCounts.push(terminal.tests);
    }
  }
}

export function strictTestExitCode(
  childExitCode: number,
  summary: BunTestOutputSummary,
  expectedFiles?: number,
): number {
  if (childExitCode !== 0) return childExitCode;
  if (summary.failedTests > 0 || summary.unhandledBetweenTests > 0) return 1;
  if (expectedFiles !== undefined && !summary.terminalFileCounts.includes(expectedFiles)) return 1;
  return 0;
}

/**
 * Bun treats positional test paths as substring filters. Resolve every
 * canonical relative path before spawning so `test/foo.test.ts` cannot also
 * select `browse/test/foo.test.ts`.
 */
export function exactTestFileSelectors(files: string[], rootDir = ROOT): string[] {
  return files.map((file) => path.isAbsolute(file) ? path.normalize(file) : path.resolve(rootDir, file));
}

export function forwardAndClassify(
  stream: NodeJS.ReadableStream,
  destination: NodeJS.WriteStream,
  classifier: BunTestOutputClassifier,
  origin: ClassifierOrigin = 'stdout',
): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk: Buffer | string) => {
      classifier.write(chunk, origin);
      destination.write(chunk);
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });
}

// --- Shared shard-child lifecycle ---

export interface RunShardChildOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** External wall-clock deadline; on expiry the child's process GROUP is SIGKILLed. */
  timeoutMs: number;
  /**
   * Hook the freshly-spawned child's stdout/stderr. Stream POLICY (classifier
   * tees, log spooling, console forwarding, reporters) is entirely the
   * caller's. Runs synchronously right after spawn; the returned promises are
   * awaited AFTER the child closes, so trailing output is fully drained
   * before the caller reads its classifier/reporter state.
   */
  hookStreams: (child: ChildProcess) => Array<Promise<void>>;
}

export interface ShardChildResult {
  exitCode: number | null;
  /** True when the wall timer fired and SIGKILLed the group. */
  timedOut: boolean;
  /** The child's pid — the process-GROUP id on POSIX (detached spawn). */
  groupPid: number | null;
}

/**
 * The child lifecycle both sharded runners need, extracted from
 * scripts/test-paid-shards.ts runPaidShard (scripts/test-free-shards.ts
 * runFreeShard duplicates the same ~35 lines verbatim today and is designed
 * to migrate here in a later change):
 *
 *   - spawn detached on POSIX so the child owns its process group,
 *   - forward parent SIGINT/SIGTERM to the whole group (not just the child),
 *   - arm an EXTERNAL wall-clock timer that SIGKILLs the group — a spinning
 *     child main thread never fires its own in-process timer,
 *   - in EVERY exit path: disarm the timer, detach the signal forwarder, and
 *     reap group survivors with SIGKILL.
 *
 * Caller-side cleanup that must run even on a spawn failure (log streams,
 * reporters, temp dirs) belongs in the caller's own try/finally around this
 * call: a spawn 'error' event THROWS from here after the finally block runs,
 * preserving the runners' existing could-not-run handling.
 */
export async function runShardChild(options: RunShardChildOptions): Promise<ShardChildResult> {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  const groupPid = child.pid ?? null;
  // Group-kill on parent SIGINT/SIGTERM too, not just on timeout.
  const forwarding = installChildSignalForwarding({
    kill: (signal?: NodeJS.Signals | number) => {
      killProcessGroup(child, (signal as NodeJS.Signals) ?? 'SIGTERM');
      return true;
    },
  });

  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    killProcessGroup(child, 'SIGKILL');
  }, options.timeoutMs);

  let exitCode: number | null = null;
  try {
    const streams = options.hookStreams(child);
    exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
    await Promise.all(streams);
  } finally {
    clearTimeout(killTimer);
    forwarding.dispose();
    // Reap survivors of this shard even on the clean path.
    killProcessGroup(child, 'SIGKILL');
  }
  return { exitCode, timedOut, groupPid };
}
