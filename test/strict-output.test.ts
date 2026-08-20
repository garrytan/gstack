/**
 * Pins scripts/test-strict-output.ts — the verdict-integrity layer of the
 * sharded paid runner. Its whole reason to exist is refusing to trust a zero
 * exit when failures were printed OR fewer files ran than planned; paid-shards'
 * fake commands never emit real Bun result lines, so without this file that
 * core was exercised nowhere and a regex regression would silently revert the
 * paid tier to trusting exit codes.
 */

import { describe, expect, it } from 'bun:test';
import {
  BunTestOutputClassifier,
  installChildSignalForwarding,
  isTerminationRequested,
  strictTestExitCode,
  type TerminationSignalSource,
  type TerminationTimerApi,
} from '../scripts/test-strict-output';

describe('strictTestExitCode', () => {
  it('trusts a clean zero exit when the expected file count ran', () => {
    const summary = { failedTests: 0, unhandledBetweenTests: 0, terminalFileCounts: [1] };
    expect(strictTestExitCode(0, summary, 1)).toBe(0);
  });

  it('refuses a zero exit when fewer files ran than expected (invisible non-execution)', () => {
    const summary = { failedTests: 0, unhandledBetweenTests: 0, terminalFileCounts: [1] };
    expect(strictTestExitCode(0, summary, 2)).toBe(1);
  });

  it('refuses a zero exit when failure lines were printed', () => {
    const summary = { failedTests: 1, unhandledBetweenTests: 0, terminalFileCounts: [1] };
    expect(strictTestExitCode(0, summary, 1)).toBe(1);
  });

  it('refuses a zero exit on an unhandled error between tests', () => {
    const summary = { failedTests: 0, unhandledBetweenTests: 1, terminalFileCounts: [1] };
    expect(strictTestExitCode(0, summary, 1)).toBe(1);
  });

  it('propagates a non-zero child exit regardless of expectedFiles', () => {
    const summary = { failedTests: 0, unhandledBetweenTests: 0, terminalFileCounts: [1] };
    expect(strictTestExitCode(1, summary, 1)).toBe(1);
  });
});

describe('BunTestOutputClassifier', () => {
  it('counts a (fail) line split across write chunks', () => {
    const c = new BunTestOutputClassifier();
    c.write('[31m(fail) my te');
    c.write('st [3.42ms][0m\nRan 4 tests across 1 files. [2.10s]\n');
    const summary = c.end();
    expect(summary.failedTests).toBe(1);
    expect(summary.terminalFileCounts).toEqual([1]);
    // exit 0 + a printed failure must not be trusted
    expect(strictTestExitCode(0, summary, 1)).toBe(1);
  });

  it('records the terminal file count from the summary line', () => {
    const c = new BunTestOutputClassifier();
    c.write('Ran 0 tests across 1 files. [0.01s]\n');
    const summary = c.end();
    expect(summary.terminalFileCounts).toEqual([1]);
    // a fully diff-skipped single-file shard (0 tests, 1 file loaded) still
    // passes: 1 file ran, which is what was expected
    expect(strictTestExitCode(0, summary, 1)).toBe(0);
  });

  // stdout and stderr are independent pipes: a chunk from one can land
  // between two halves of a line from the other. A single shared buffer
  // glues the fragments into garbled lines — a sheared (fail) line goes
  // uncounted (defeating the exit-0-with-failures backstop) and a sheared
  // summary reads as truncation. Per-origin buffers keep each stream whole.
  it('a stderr chunk arriving mid-stdout-line does not shear either line', () => {
    const c = new BunTestOutputClassifier();
    c.write('some stdout noise without a newline yet', 'stdout');
    c.write('[31m(fail) planted [0.10ms][0m\n', 'stderr');
    c.write(' ...rest of the stdout line\n', 'stdout');
    const summary = c.end();
    expect(summary.failedTests).toBe(1);
  });

  it('a terminal summary split around a cross-stream chunk still counts', () => {
    const c = new BunTestOutputClassifier();
    c.write('Ran 4 tests acr', 'stdout');
    c.write('stderr diagnostics line\n', 'stderr');
    c.write('oss 2 files. [1.00s]\n', 'stdout');
    const summary = c.end();
    expect(summary.terminalFileCounts).toEqual([2]);
    expect(strictTestExitCode(0, summary, 2)).toBe(0);
  });
});

describe('installChildSignalForwarding — cancellation terminates the RUN', () => {
  // Installing any SIGINT/SIGTERM listener suppresses Node's default
  // terminate-on-signal. Pre-fix, the forwarder killed the current child and
  // the parent LIVED ON — the paid worker pool kept launching API-burning
  // shards after Ctrl-C. The parent must schedule its own exit and expose
  // isTerminationRequested() so launch loops stop taking new work.
  type Handler = () => void;
  const makeFakes = () => {
    const listeners = new Map<string, Handler[]>();
    const source: TerminationSignalSource = {
      on: (event, listener) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      },
      off: (event, listener) => {
        listeners.set(event, (listeners.get(event) ?? []).filter((l) => l !== listener));
      },
    };
    const emit = (event: string) => (listeners.get(event) ?? []).forEach((l) => l());
    const scheduled: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = [];
    const timer: TerminationTimerApi = {
      schedule: (callback, delayMs) => {
        const handle = { callback, delayMs, cancelled: false };
        scheduled.push(handle);
        return handle;
      },
      cancel: (handle) => {
        (handle as { cancelled: boolean }).cancelled = true;
      },
    };
    const kills: string[] = [];
    const child = { kill: (sig?: unknown) => { kills.push(String(sig)); return true; } };
    const exits: number[] = [];
    return { source, emit, timer, scheduled, kills, child, exits, exit: (code: number) => { exits.push(code); } };
  };

  it('first signal kills the child, marks termination, and schedules parent exit after the grace', () => {
    const f = makeFakes();
    installChildSignalForwarding(f.child, f.source, f.timer, 5_000, f.exit);
    expect(isTerminationRequested(f.source)).toBe(false);
    f.emit('SIGTERM');
    expect(f.kills).toEqual(['SIGTERM']);
    expect(isTerminationRequested(f.source)).toBe(true);
    // Two timers: child SIGKILL grace (5s) and parent exit (grace + 1s).
    const delays = f.scheduled.map((s) => s.delayMs);
    expect(delays).toContain(5_000);
    expect(delays).toContain(6_000);
    const parentExit = f.scheduled.find((s) => s.delayMs === 6_000)!;
    parentExit.callback();
    expect(f.exits).toEqual([143]);
  });

  it('parent exit fires even when the shard disposes cleanly first', () => {
    const f = makeFakes();
    const forwarding = installChildSignalForwarding(f.child, f.source, f.timer, 5_000, f.exit);
    f.emit('SIGINT');
    forwarding.dispose();
    const parentExit = f.scheduled.find((s) => s.delayMs === 6_000)!;
    expect(parentExit.cancelled).toBe(false);
    parentExit.callback();
    expect(f.exits).toEqual([130]);
  });

  it('one parent exit across many concurrent forwarders on the same source', () => {
    const f = makeFakes();
    installChildSignalForwarding(f.child, f.source, f.timer, 5_000, f.exit);
    installChildSignalForwarding({ kill: () => true }, f.source, f.timer, 5_000, f.exit);
    f.emit('SIGTERM');
    expect(f.scheduled.filter((s) => s.delayMs === 6_000).length).toBe(1);
  });
});
