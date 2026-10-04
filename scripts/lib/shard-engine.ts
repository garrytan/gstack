/**
 * Shard engine: the one owner of how a test shard runs — process-group spawn,
 * wall timeout + group kill, signal forwarding, strict Bun output verdicts,
 * per-shard tmp/Chromium sandbox, log files, duration seeds, CLI flag loop.
 * Lanes (scripts/test-free-shards.ts, scripts/test-paid-shards.ts) keep only
 * policy: selection, budgets, manifests, retries, and a LanePolicy, e.g.
 *   const LANE: LanePolicy = { acceptsSeedDuration: ms => ms > 0, zeroExecution: () => 'passed' };
 *   const result = await runShardChild({ command, args, cwd, env, timeoutMs, hookStreams });
 * Enforced by ratchet (c) (test/module-size-ratchet.test.ts). Moved from
 * scripts/test-strict-output.ts, which re-exports this module.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..', '..');
// Strict Bun-test output classification works around a Bun test runner bug
// where failures can be printed even though the child exits successfully:
// output is forwarded byte-for-byte as it arrives, only complete Bun result
// lines and terminal summaries are classified, and `strictTestExitCode`
// refuses a zero exit when the output shows failures or fewer files ran.
const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const BUN_FAIL_RESULT = /^(?:\(fail\)|✗) (.+) \[(?:\d+(?:\.\d+)?)(?:ns|us|µs|ms|s)\]$/;
const BUN_BETWEEN_TESTS_ERROR = '# Unhandled error between tests';
const BUN_TERMINAL_SUMMARY = /^Ran (\d+) tests? across (\d+) files?\. \[(?:\d+(?:\.\d+)?)(?:ns|us|µs|ms|s)\]$/;
// The counts block bun prints just before the terminal summary (" 1 pass",
// " 2 skip", " 0 fail"). "Ran N tests" COUNTS skipped tests, so N alone
// cannot distinguish a shard that verified work from one whose every test
// self-skipped (external-service binary missing, tier mismatch) — the
// green-by-skip class. Anchored to whole-line matches; nested bun-test
// children can still contribute counts (same known limit as the terminal
// summary — see the last-summary-anchoring TODO in the audit).
const BUN_SKIP_COUNT = /^\s*(\d+) skip$/;
const BUN_PASS_COUNT = /^\s*(\d+) pass$/;
const BUN_FAIL_COUNT = /^\s*(\d+) fail$/;

export type BunTestOutputFinding = 'failed-test' | 'unhandled-between-tests';

export interface BunTestOutputSummary {
  failedTests: number;
  unhandledBetweenTests: number;
  terminalFileCounts: number[];
  /** Test counts from the same terminal lines — feeds the hollow-shard guard. */
  terminalTestCounts: number[];
  /** Sum of bun's " N skip" count lines. "Ran N tests" includes skips, so
   *  this is what separates verified work from green-by-skip. */
  skippedTests: number;
  /** Sum of bun's " N pass" count lines. */
  passedTests: number;
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
  if (parseBunFailureResult(line) !== null) return 'failed-test';
  if (line === BUN_BETWEEN_TESTS_ERROR) return 'unhandled-between-tests';
  return null;
}

export function parseBunFailureResult(rawLine: string): string | null {
  return BUN_FAIL_RESULT.exec(stripAnsiLine(rawLine))?.[1] ?? null;
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

export class BunFailureSummaryParser {
  private readonly pending: Partial<Record<ClassifierOrigin, { failures: number | null }>> = {};

  consume(rawLine: string, origin: ClassifierOrigin): number | null {
    const line = stripAnsiLine(rawLine);
    if (BUN_PASS_COUNT.test(line)) {
      this.pending[origin] = { failures: null };
      return null;
    }
    const pending = this.pending[origin];
    if (!pending) return null;
    const fail = BUN_FAIL_COUNT.exec(line);
    if (fail) {
      pending.failures = Math.max(pending.failures ?? 0, Number.parseInt(fail[1], 10));
      return null;
    }
    if (parseBunTerminalSummary(line) !== null) {
      delete this.pending[origin];
      return pending.failures;
    }
    return null;
  }
}

export class BunTestOutputClassifier {
  private readonly decoders: Record<ClassifierOrigin, StringDecoder> = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  };
  private pending: Record<ClassifierOrigin, string> = { stdout: '', stderr: '' };
  private failedTests = 0;
  private reportedFailedTests = 0;
  private readonly failureSummary = new BunFailureSummaryParser();
  private unhandledBetweenTests = 0;
  private terminalFileCounts: number[] = [];
  private terminalTestCounts: number[] = [];
  private skippedTests = 0;
  private passedTests = 0;

  write(chunk: Uint8Array | string, origin: ClassifierOrigin = 'stdout'): void {
    this.pending[origin] += typeof chunk === 'string'
      ? chunk
      : this.decoders[origin].write(Buffer.from(chunk));
    this.consumeCompleteLines(origin);
  }

  end(): BunTestOutputSummary {
    for (const origin of ['stdout', 'stderr'] as const) {
      this.pending[origin] += this.decoders[origin].end();
      if (this.pending[origin].length > 0) this.classify(this.pending[origin], origin);
      this.pending[origin] = '';
    }
    return this.summary();
  }

  summary(): BunTestOutputSummary {
    return {
      failedTests: Math.max(this.failedTests, this.reportedFailedTests),
      unhandledBetweenTests: this.unhandledBetweenTests,
      terminalFileCounts: [...this.terminalFileCounts],
      terminalTestCounts: [...this.terminalTestCounts],
      skippedTests: this.skippedTests,
      passedTests: this.passedTests,
    };
  }

  private consumeCompleteLines(origin: ClassifierOrigin): void {
    let newline = this.pending[origin].indexOf('\n');
    while (newline !== -1) {
      this.classify(this.pending[origin].slice(0, newline), origin);
      this.pending[origin] = this.pending[origin].slice(newline + 1);
      newline = this.pending[origin].indexOf('\n');
    }
  }

  private classify(line: string, origin: ClassifierOrigin): void {
    const finding = classifyBunTestOutputLine(line);
    if (finding === 'failed-test') this.failedTests += 1;
    if (finding === 'unhandled-between-tests') this.unhandledBetweenTests += 1;
    const stripped = stripAnsiLine(line);
    const skip = BUN_SKIP_COUNT.exec(stripped);
    if (skip !== null) this.skippedTests += Number.parseInt(skip[1], 10);
    const pass = BUN_PASS_COUNT.exec(stripped);
    if (pass !== null) this.passedTests += Number.parseInt(pass[1], 10);
    const fail = this.failureSummary.consume(stripped, origin);
    if (fail !== null) this.reportedFailedTests = Math.max(this.reportedFailedTests, fail);
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

export function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
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
    let ended = false;
    const incomplete = () => reject(new Error(`incomplete ${origin} capture: stream closed before end`));
    stream.on('data', (chunk: Buffer | string) => {
      classifier.write(chunk, origin);
      destination.write(chunk);
    });
    stream.once('end', () => { ended = true; resolve(); });
    stream.on('error', reject);
    stream.once('close', () => { if (!ended) incomplete(); });
    // Bun can return an already-destroyed pipe whose close event is past.
    if ('destroyed' in stream && stream.destroyed && !ended) {
      if ('errored' in stream && stream.errored) reject(stream.errored);
      else incomplete();
    }
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
  deadlineMs?: number;
  /**
   * Hook the freshly-spawned child's stdout/stderr. Stream POLICY (classifier
   * tees, log spooling, console forwarding, reporters) is entirely the
   * caller's. Runs synchronously right after spawn; child close and every
   * returned promise must settle within the same deadline. A wall-expired
   * return reports incomplete capture instead of treating the prefix as final.
   */
  hookStreams: (child: ChildProcess) => Array<Promise<void>>;
  /**
   * Lane-owned companions of the child (the free lane's detached-browser
   * tracker). Created right after spawn; `signal` runs after every forwarded
   * group kill, and `settle` runs after the final group kill while parent
   * signals are still forwarded.
   */
  attach?: (child: ChildProcess) => ShardChildCompanion;
}

export interface ShardChildCompanion {
  signal(force: boolean): void;
  settle(): Promise<void>;
}

export interface ShardChildResult {
  exitCode: number | null;
  /** True when the shared deadline expired; no further child work is allowed. */
  timedOut: boolean;
  /** The child's pid — the process-GROUP id on POSIX (detached spawn). */
  groupPid: number | null;
  incompleteCapture?: {
    childClosed: boolean;
    pendingStreams: number;
    failedStreams: number;
    deadlineMs: number;
  };
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
 *     signal group survivors with SIGKILL.
 *
 * Caller-side cleanup that must run even on a spawn failure (log streams,
 * reporters, temp dirs) belongs in the caller's own try/finally around this
 * call: a spawn 'error' event THROWS from here after the finally block runs,
 * preserving the runners' existing could-not-run handling.
 */
const REAP_GRACE_MS = 250;

export async function runShardChild(options: RunShardChildOptions): Promise<ShardChildResult> {
  const deadlineMs = Math.min(options.deadlineMs ?? Infinity, Date.now() + options.timeoutMs);
  if (!Number.isFinite(deadlineMs)) throw new Error('Shard deadline must be finite');
  if (deadlineMs <= Date.now()) {
    return { exitCode: null, timedOut: true, groupPid: null,
      incompleteCapture: { childClosed: false, pendingStreams: 0, failedStreams: 0, deadlineMs } };
  }
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  const groupPid = child.pid ?? null;
  const companion = options.attach?.(child);
  // Group-kill on parent SIGINT/SIGTERM too, not just on timeout.
  const forwarding = installChildSignalForwarding({
    kill: (signal?: NodeJS.Signals | number) => {
      killProcessGroup(child, (signal as NodeJS.Signals) ?? 'SIGTERM');
      companion?.signal(signal === 'SIGKILL');
      return true;
    },
  });

  let timedOut = false;
  let childClosed = false;
  let pendingStreams = 0;
  let failedStreams = 0;
  let exitCode: number | null = null;
  let failed = false;
  let firstError: unknown;
  const rememberError = (error: unknown) => {
    if (failed) return;
    failed = true;
    firstError = error;
  };
  const kill = () => {
    try { killProcessGroup(child, 'SIGKILL'); }
    catch (error) { rememberError(error); }
  };
  let close!: () => void;
  const closed = new Promise<void>(resolve => { close = resolve; });
  let reap!: () => void;
  const reaped = new Promise<void>(resolve => { reap = resolve; });
  const onExit = (code: number | null) => { exitCode = code; reap(); };
  const onClose = (code: number | null) => { exitCode = code; childClosed = true; close(); reap(); };
  child.once('exit', onExit);
  child.once('close', onClose);
  child.on('error', rememberError);
  let expire!: () => void;
  const expired = new Promise<void>(resolve => { expire = resolve; });
  const killTimer = setTimeout(() => {
    timedOut = true;
    kill();
    expire();
  }, Math.max(0, deadlineMs - Date.now()));

  try {
    let streams: Array<Promise<void>> = [];
    try { streams = options.hookStreams(child); }
    catch (error) {
      rememberError(error);
      kill();
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
    pendingStreams = streams.length;
    const drainage = Promise.all(streams.map(stream => Promise.resolve(stream).then(
      () => { pendingStreams -= 1; },
      (error: unknown) => { pendingStreams -= 1; failedStreams += 1; rememberError(error); },
    )));
    await Promise.race([Promise.all([closed, drainage]), expired]);
    if (Date.now() >= deadlineMs) timedOut = true;
    // A wall-killed child is normally reaped within milliseconds; wait that
    // long (bounded) so callers never observe a live pid after a timeout.
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([reaped, new Promise<void>(resolve => { reapTimer = setTimeout(resolve, REAP_GRACE_MS); })]);
    clearTimeout(reapTimer);
  } finally {
    clearTimeout(killTimer);
    kill();
    if (companion) {
      try { await companion.settle(); }
      catch (error) { rememberError(error); }
    }
    forwarding.dispose();
    child.off('exit', onExit);
    child.off('close', onClose);
    if (!childClosed || pendingStreams > 0) {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    }
  }
  const result: ShardChildResult = { exitCode, timedOut, groupPid };
  if (!childClosed || pendingStreams > 0 || failedStreams > 0) {
    result.incompleteCapture = { childClosed, pendingStreams, failedStreams, deadlineMs };
  }
  if (failed) {
    if (firstError instanceof Error && Object.isExtensible(firstError)) {
      Reflect.defineProperty(firstError, 'shardResult', { value: result, configurable: true });
    }
    throw firstError;
  }
  return result;
}

// --- Per-shard sandbox, logs, duration seeds, verdicts, CLI flags ---

/**
 * Per-shard temp + Chromium-profile isolation. Two concurrent shards on one
 * profile dir kill each other's browser, and shared tmp cross-contaminates;
 * a group-SIGKILLed shard never runs its own cleanup, so the lane removes
 * `stateDir` afterwards (the cleanup backstop). `realpath` resolves a
 * symlinked tmpdir (macOS /var -> /private/var) for lanes that compare paths.
 */
export function createShardSandbox(
  prefix: string,
  baseEnv: NodeJS.ProcessEnv,
  options: { realpath?: boolean } = {},
): { stateDir: string; tmp: string; env: NodeJS.ProcessEnv } {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const stateDir = options.realpath ? fs.realpathSync(created) : created;
  const tmp = path.join(stateDir, 'tmp');
  fs.mkdirSync(tmp);
  const env: NodeJS.ProcessEnv = {
    ...baseEnv, TMPDIR: tmp, TEMP: tmp, TMP: tmp,
    CHROMIUM_PROFILE: path.join(stateDir, 'chromium-profile'),
  };
  return { stateDir, tmp, env };
}

/**
 * Asynchronous best-effort backstop removal: a SIGKILLed shard can leave a
 * full git workspace plus a Chromium profile, and a synchronous recursive
 * delete would stall every sibling shard's classification and timers.
 */
export async function removeShardSandbox(stateDir: string): Promise<void> {
  try { await fs.promises.rm(stateDir, { recursive: true, force: true }); }
  catch { /* a locked file must not turn a real verdict into an exception */ }
}

/** Run once per file, alone: readers `jobs` at a time, then exclusive files one by one. Stops on termination. */
export async function forEachFileAlone(
  readers: string[], exclusive: string[], jobs: number, run: (file: string, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const worker = async (files: string[], offset: number) => {
    while (cursor < files.length && !isTerminationRequested()) {
      const index = cursor++;
      await run(files[index], offset + index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, () => worker(readers, 0)));
  cursor = 0;
  await worker(exclusive, readers.length);
}

let shardLogSequence = 0;

/** Timestamped log path; pid + sequence defeat same-millisecond collisions. */
export function nextShardLogPath(directory: string, stem: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  shardLogSequence += 1;
  return path.join(directory, `${stem}-${stamp}-${process.pid}-${shardLogSequence}.log`);
}

export interface ShardLog {
  readonly path: string;
  readonly stream: fs.WriteStream;
  /** Set on the first write error; later chunks are dropped, never thrown. */
  failed: boolean;
  write(chunk: Buffer | string): void;
}

/** Full-stream capture: every child byte is spooled to disk, never held in RAM. */
export function openShardLog(logPath: string, label: string, mode?: number): ShardLog {
  const stream = fs.createWriteStream(logPath, mode === undefined ? undefined : { mode });
  const log: ShardLog = {
    path: logPath, stream, failed: false,
    write(chunk) { if (!log.failed) stream.write(chunk); },
  };
  stream.on('error', (err) => {
    if (log.failed) return;
    log.failed = true;
    console.error(`${label} could not write the full log at ${logPath}: ${err.message}`);
  });
  return log;
}

export type DurationSeedRead =
  | { status: 'missing' }
  | { status: 'corrupt'; error: Error }
  | { status: 'ok'; durations: Record<string, number> };

/** One reader for `{ durations: { file: ms } }` seeds; the lane decides which values count. */
export function readDurationSeed(file: string, accepts: (ms: number) => boolean): DurationSeedRead {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf-8'); }
  catch { return { status: 'missing' }; }
  try {
    const parsed = JSON.parse(raw) as { durations?: Record<string, unknown> };
    return { status: 'ok', durations: Object.fromEntries(Object.entries(parsed.durations ?? {})
      .filter((entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1]) && accepts(entry[1]))) };
  } catch (error) {
    return { status: 'corrupt', error: error as Error };
  }
}

/** Atomic temp+rename: a killed writer never leaves a truncated seed behind. */
export function writeDurationSeed(file: string, durations: Record<string, number>): void {
  const payload = {
    version: 1,
    recordedAt: new Date().toISOString(),
    durations: Object.fromEntries(Object.entries(durations).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

/** What a strictly passed shard that executed zero tests becomes. */
export type ZeroExecutionVerdict = 'passed' | 'passed-with-warning' | 'passed-empty';

/** Classification rules each lane injects; the engine applies them, never decides them. */
export interface LanePolicy {
  /** Which recorded seed durations the lane trusts (free >= 0, paid > 0). */
  acceptsSeedDuration(ms: number): boolean;
  /** `promisedAll`: the run promised every test (EVALS_ALL) rather than a selection. */
  zeroExecution(run: { promisedAll: boolean }): ZeroExecutionVerdict;
}

export function zeroExecutionVerdict(
  executedTests: number | null,
  policy: LanePolicy,
  run: { promisedAll: boolean },
): ZeroExecutionVerdict {
  return executedTests === 0 ? policy.zeroExecution(run) : 'passed';
}

export type StrictShardStatus = 'passed' | 'failed' | 'timed-out';

/**
 * The verdict both lanes share: a wall timeout is its own status; otherwise
 * a shard passes only with complete evidence (log, capture, cleanup) AND a
 * strict exit of zero, which requires bun's summary to count every planned file.
 */
export function strictShardStatus(input: {
  timedOut: boolean;
  evidenceComplete: boolean;
  exitCode: number | null;
  summary: BunTestOutputSummary;
  expectedFiles: number;
}): StrictShardStatus {
  if (input.timedOut) return 'timed-out';
  return input.evidenceComplete && strictTestExitCode(input.exitCode ?? 1, input.summary, input.expectedFiles) === 0
    ? 'passed' : 'failed';
}

/** Usage text for `--help`: the lane's own text, else its declared flags. */
export function cliUsage(handlers: Record<string, unknown>, usage?: string, script = process.argv[1] ?? 'runner'): string {
  return usage ?? [`Usage: bun run ${path.relative(process.cwd(), script) || script} [flags]`, '', 'Flags:',
    ...Object.keys(handlers).sort().map(flag => `  ${flag}`), '', 'See docs/TESTING_INTERNALS.md for what each flag does.'].join('\n');
}

/**
 * Shared flag loop. Each lane declares its flags; a handler that takes a
 * value calls `next()` (the following argv entry, or undefined) and owns its
 * own validation message. Any undeclared flag is `Unknown argument: <flag>`.
 * `--help` / `-h` (unless a lane declares them) print the usage and exit 0
 * before any work starts, so asking for help never runs a suite.
 */
export function parseCliFlags(
  argv: string[],
  handlers: Record<string, (next: () => string | undefined) => void>,
  usage?: string,
): void {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if ((arg === '--help' || arg === '-h') && !Object.hasOwn(handlers, arg)) {
      process.stdout.write(`${cliUsage(handlers, usage)}\n`);
      process.exit(0);
    }
    const handler = Object.hasOwn(handlers, arg) ? handlers[arg] : undefined;
    if (!handler) throw new Error(`Unknown argument: ${arg}`);
    handler(() => argv[++index]);
  }
}
