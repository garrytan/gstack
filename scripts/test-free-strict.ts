#!/usr/bin/env bun
/**
 * Run the default free suite while working around a Bun test runner bug where
 * failures can be printed even though the child exits successfully.
 *
 * The shared free-test enumerator supplies the canonical roots and exclusions.
 * Output is forwarded byte-for-byte as it arrives; only complete Bun result
 * lines and terminal summaries are classified.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import * as path from 'node:path';
import {
  buildShardArgs,
  collectFreeTestFiles,
  planBoundedFreeTestShards,
} from './test-free-shards';

const ROOT = path.resolve(import.meta.dir, '..');
const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const BUN_FAIL_RESULT = /^\(fail\) .+ \[(?:\d+(?:\.\d+)?)(?:ns|us|\u00b5s|ms|s)\]$/;
const BUN_BETWEEN_TESTS_ERROR = '# Unhandled error between tests';
const BUN_TERMINAL_SUMMARY = /^Ran \d+ tests? across (\d+) files?\. \[(?:\d+(?:\.\d+)?)(?:ns|us|\u00b5s|ms|s)\]$/;

export type BunTestOutputFinding = 'failed-test' | 'unhandled-between-tests';

export interface BunTestOutputSummary {
  failedTests: number;
  unhandledBetweenTests: number;
  terminalFileCounts: number[];
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

function killWithoutThrowing(
  child: Pick<ChildProcess, 'kill'>,
  signal: NodeJS.Signals,
): void {
  try {
    child.kill(signal);
  } catch {
    // The child may have exited between close detection and signal delivery.
  }
}

/**
 * Bind one active child to the parent's termination lifecycle. SIGINT and
 * SIGTERM get a grace period so Bun can clean up; a repeated signal, timeout,
 * or synchronous parent exit uses SIGKILL so the child cannot be orphaned.
 */
export function installChildSignalForwarding(
  child: Pick<ChildProcess, 'kill'>,
  source: TerminationSignalSource = process,
  timer: TerminationTimerApi = DEFAULT_TERMINATION_TIMER,
  graceMs = 5_000,
): ChildSignalForwarding {
  let receivedSignal: ForwardedTerminationSignal | null = null;
  let forceTimer: unknown = null;
  let disposed = false;

  const forward = (signal: ForwardedTerminationSignal): void => {
    if (disposed) return;
    if (receivedSignal !== null) {
      killWithoutThrowing(child, 'SIGKILL');
      return;
    }
    receivedSignal = signal;
    killWithoutThrowing(child, signal);
    forceTimer = timer.schedule(() => {
      forceTimer = null;
      killWithoutThrowing(child, 'SIGKILL');
    }, graceMs);
  };
  const onSigint = () => forward('SIGINT');
  const onSigterm = () => forward('SIGTERM');
  const onExit = () => killWithoutThrowing(child, 'SIGKILL');

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

export function terminationSignalExitCode(signal: ForwardedTerminationSignal): number {
  return signal === 'SIGINT' ? 130 : 143;
}

export function classifyBunTestOutputLine(rawLine: string): BunTestOutputFinding | null {
  const line = rawLine.replace(ANSI_ESCAPE, '').replace(/\r$/, '');
  if (BUN_FAIL_RESULT.test(line)) return 'failed-test';
  if (line === BUN_BETWEEN_TESTS_ERROR) return 'unhandled-between-tests';
  return null;
}

export function parseBunTerminalSummaryLine(rawLine: string): number | null {
  const line = rawLine.replace(ANSI_ESCAPE, '').replace(/\r$/, '');
  const match = BUN_TERMINAL_SUMMARY.exec(line);
  return match ? Number.parseInt(match[1], 10) : null;
}

/** Incrementally classifies output without assuming process chunks align to lines. */
export class BunTestOutputClassifier {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private failedTests = 0;
  private unhandledBetweenTests = 0;
  private terminalFileCounts: number[] = [];

  write(chunk: Uint8Array | string): void {
    this.pending += typeof chunk === 'string'
      ? chunk
      : this.decoder.write(Buffer.from(chunk));
    this.consumeCompleteLines();
  }

  end(): BunTestOutputSummary {
    this.pending += this.decoder.end();
    if (this.pending.length > 0) this.classify(this.pending);
    this.pending = '';
    return this.summary();
  }

  summary(): BunTestOutputSummary {
    return {
      failedTests: this.failedTests,
      unhandledBetweenTests: this.unhandledBetweenTests,
      terminalFileCounts: [...this.terminalFileCounts],
    };
  }

  private consumeCompleteLines(): void {
    let newline = this.pending.indexOf('\n');
    while (newline !== -1) {
      this.classify(this.pending.slice(0, newline));
      this.pending = this.pending.slice(newline + 1);
      newline = this.pending.indexOf('\n');
    }
  }

  private classify(line: string): void {
    const finding = classifyBunTestOutputLine(line);
    if (finding === 'failed-test') this.failedTests += 1;
    if (finding === 'unhandled-between-tests') this.unhandledBetweenTests += 1;
    const terminalFileCount = parseBunTerminalSummaryLine(line);
    if (terminalFileCount !== null) this.terminalFileCounts.push(terminalFileCount);
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

/** The default safety boundary is one Bun process per test file. */
export function planDefaultFreeTestShards(files: string[], rootDir = ROOT): string[][] {
  return planBoundedFreeTestShards(files, { rootDir, maxFilesPerShard: 1 });
}

/**
 * Bun treats positional test paths as substring filters. Resolve every
 * canonical relative path before spawning so `test/foo.test.ts` cannot also
 * select `browse/test/foo.test.ts`.
 */
export function exactTestFileSelectors(files: string[], rootDir = ROOT): string[] {
  return files.map((file) => path.isAbsolute(file) ? path.normalize(file) : path.resolve(rootDir, file));
}

function forwardAndClassify(
  stream: NodeJS.ReadableStream,
  destination: NodeJS.WriteStream,
  classifier: BunTestOutputClassifier,
): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk: Buffer | string) => {
      classifier.write(chunk);
      destination.write(chunk);
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });
}

function waitForClose(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (typeof code === 'number') {
        resolve(code);
        return;
      }
      console.error(`[test:strict] Bun test terminated by signal ${signal ?? 'unknown'}`);
      resolve(1);
    });
  });
}

async function runBestEffortSlopDiff(): Promise<ForwardedTerminationSignal | null> {
  let forwarding: ChildSignalForwarding | null = null;
  try {
    const child = spawn(process.execPath, ['run', 'slop:diff'], {
      cwd: ROOT,
      env: process.env,
      stdio: ['inherit', 'inherit', 'ignore'],
      windowsHide: true,
    });
    forwarding = installChildSignalForwarding(child);
    await waitForClose(child);
    return forwarding.receivedSignal;
  } catch {
    // This command was best-effort in the previous package.json entry too.
    return forwarding?.receivedSignal ?? null;
  } finally {
    forwarding?.dispose();
  }
}

export async function runDefaultFreeTests(): Promise<number> {
  const files = collectFreeTestFiles(ROOT);
  if (files.length === 0) throw new Error('No free test files were discovered.');
  const shards = planDefaultFreeTestShards(files, ROOT);
  console.log(`[test:strict] ${files.length} files across ${shards.length} singleton shards`);

  for (let index = 0; index < shards.length; index += 1) {
    const shard = shards[index];
    console.log(`[test:strict] shard ${index + 1}/${shards.length} (${shard.length} files)`);
    const exitCode = await runStrictTestShard(shard);
    if (exitCode !== 0) return exitCode;
  }

  const slopSignal = await runBestEffortSlopDiff();
  return slopSignal === null ? 0 : terminationSignalExitCode(slopSignal);
}

export async function runStrictTestShard(files: string[]): Promise<number> {
  if (files.length === 0) throw new Error('Cannot run an empty free-test shard.');
  const child = spawn(process.execPath, buildShardArgs(exactTestFileSelectors(files)), {
    cwd: ROOT,
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const forwarding = installChildSignalForwarding(child);

  if (!child.stdout || !child.stderr) {
    killWithoutThrowing(child, 'SIGKILL');
    forwarding.dispose();
    throw new Error('Bun test output pipes were not created');
  }

  const stdoutClassifier = new BunTestOutputClassifier();
  const stderrClassifier = new BunTestOutputClassifier();
  const stdoutDone = forwardAndClassify(child.stdout, process.stdout, stdoutClassifier);
  const stderrDone = forwardAndClassify(child.stderr, process.stderr, stderrClassifier);
  let childExitCode: number;
  try {
    childExitCode = await waitForClose(child);
    await Promise.all([stdoutDone, stderrDone]);
  } finally {
    forwarding.dispose();
  }

  if (forwarding.receivedSignal !== null) {
    return terminationSignalExitCode(forwarding.receivedSignal);
  }

  const stdoutSummary = stdoutClassifier.end();
  const stderrSummary = stderrClassifier.end();
  const summary: BunTestOutputSummary = {
    failedTests: stdoutSummary.failedTests + stderrSummary.failedTests,
    unhandledBetweenTests:
      stdoutSummary.unhandledBetweenTests + stderrSummary.unhandledBetweenTests,
    terminalFileCounts: [
      ...stdoutSummary.terminalFileCounts,
      ...stderrSummary.terminalFileCounts,
    ],
  };
  const exitCode = strictTestExitCode(childExitCode, summary, files.length);

  if (childExitCode === 0 && exitCode !== 0) {
    if (summary.failedTests > 0 || summary.unhandledBetweenTests > 0) {
      console.error(
        `[test:strict] Bun exited 0 despite ${summary.failedTests} failed test result(s) `
        + `and ${summary.unhandledBetweenTests} unhandled between-tests error(s).`,
      );
    }
    if (!summary.terminalFileCounts.includes(files.length)) {
      const reported = summary.terminalFileCounts.length > 0
        ? summary.terminalFileCounts.join(', ')
        : 'none';
      console.error(
        `[test:strict] Bun exited 0 without a terminal summary for all ${files.length} `
        + `expected file(s); reported file counts: ${reported}.`,
      );
    }
  }
  return exitCode;
}

if (import.meta.main) {
  try {
    process.exitCode = await runDefaultFreeTests();
  } catch (error) {
    console.error(`[test:strict] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
