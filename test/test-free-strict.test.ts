import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BunTestOutputClassifier,
  classifyBunTestOutputLine,
  exactTestFileSelectors,
  installChildSignalForwarding,
  parseBunTerminalSummaryLine,
  planDefaultFreeTestShards,
  strictTestExitCode,
  terminationSignalExitCode,
  type TerminationTimerApi,
} from '../scripts/test-free-strict';

describe('strict default free-test runner', () => {
  test('plans exactly one directly owned child per free test file', () => {
    const shards = planDefaultFreeTestShards([
      'test/z.test.ts',
      'browse/test/a.test.ts',
      'test/m.test.ts',
    ]);
    expect(shards).toEqual([
      ['browse/test/a.test.ts'],
      ['test/m.test.ts'],
      ['test/z.test.ts'],
    ]);
    expect(shards.every((shard) => shard.length === 1)).toBe(true);
  });

  test('uses absolute selectors so Bun substring matching cannot add a namesake file', () => {
    const root = path.join(path.parse(process.cwd()).root, 'repo');
    const [topLevel, nested] = exactTestFileSelectors([
      'test/learnings-injection.test.ts',
      'browse/test/learnings-injection.test.ts',
    ], root);
    expect(path.isAbsolute(topLevel)).toBe(true);
    expect(path.isAbsolute(nested)).toBe(true);
    expect(nested.includes(topLevel)).toBe(false);
  });

  test('keeps the Windows package entrypoint on singleton shards', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, '..', 'package.json'), 'utf8'));
    expect(packageJson.scripts['test:windows']).toBe(
      'bun run scripts/test-free-shards.ts --windows-only --shards 10000',
    );
  });

  test('recognizes Bun failed-test results with ANSI and CRLF', () => {
    expect(classifyBunTestOutputLine('(fail) suite > case [158.31ms]')).toBe('failed-test');
    expect(classifyBunTestOutputLine('\u001b[31m(fail) suite > case [1.00s]\u001b[0m\r')).toBe('failed-test');
    expect(classifyBunTestOutputLine('(fail) suite > case [12\u00b5s]')).toBe('failed-test');
  });

  test('recognizes the exact between-tests unhandled error banner', () => {
    expect(classifyBunTestOutputLine('# Unhandled error between tests')).toBe('unhandled-between-tests');
    expect(classifyBunTestOutputLine('\u001b[1m# Unhandled error between tests\u001b[0m\r')).toBe('unhandled-between-tests');
  });

  test('parses only exact Bun terminal summaries and their file count', () => {
    expect(parseBunTerminalSummaryLine('Ran 1 test across 1 file. [34.00ms]')).toBe(1);
    expect(parseBunTerminalSummaryLine('\u001b[32mRan 361 tests across 5 files. [1.89s]\u001b[0m\r')).toBe(5);
    expect(parseBunTerminalSummaryLine('Expected: Ran 1 test across 1 file. [1ms]')).toBeNull();
    expect(parseBunTerminalSummaryLine('12 | Ran 1 test across 1 file. [1ms]')).toBeNull();
    expect(parseBunTerminalSummaryLine('Ran tests across 1 file.')).toBeNull();
  });

  test('ignores source excerpts, assertion text, and ordinary test names', () => {
    const nonResults = [
      '42 | const sample = "(fail) suite > case [1ms]";',
      'Expected: "(fail) suite > case [1ms]"',
      '(pass) classifier > expected (fail) text [0.12ms]',
      'log: (fail) suite > case [1ms]',
      '# Unhandled error between tests is the expected fixture text',
      '  # Unhandled error between tests',
      '(fail) missing Bun duration',
    ];
    for (const line of nonResults) expect(classifyBunTestOutputLine(line)).toBeNull();
  });

  test('classifies markers split across arbitrary process chunks', () => {
    const classifier = new BunTestOutputClassifier();
    classifier.write('bun test v1\n(fa');
    classifier.write('il) suite > case [2.50');
    classifier.write('ms]\n# Unhandled error bet');
    classifier.write('ween tests\r\nRan 2 tests across 1 fi');
    classifier.write('le. [3.00ms]\n(pass) next [1ms]');
    expect(classifier.end()).toEqual({
      failedTests: 1,
      unhandledBetweenTests: 1,
      terminalFileCounts: [1],
    });
  });

  test('fails closed on markers or incomplete summaries while preserving child exits', () => {
    const clean = { failedTests: 0, unhandledBetweenTests: 0, terminalFileCounts: [] };
    const complete = { failedTests: 0, unhandledBetweenTests: 0, terminalFileCounts: [3] };
    const wrongCount = { failedTests: 0, unhandledBetweenTests: 0, terminalFileCounts: [2] };
    const failed = { failedTests: 1, unhandledBetweenTests: 0, terminalFileCounts: [3] };
    const unhandled = { failedTests: 0, unhandledBetweenTests: 1, terminalFileCounts: [3] };

    expect(strictTestExitCode(0, clean)).toBe(0);
    expect(strictTestExitCode(0, clean, 3)).toBe(1);
    expect(strictTestExitCode(0, complete, 3)).toBe(0);
    expect(strictTestExitCode(0, wrongCount, 3)).toBe(1);
    expect(strictTestExitCode(0, failed, 3)).toBe(1);
    expect(strictTestExitCode(0, unhandled, 3)).toBe(1);
    expect(strictTestExitCode(7, failed, 3)).toBe(7);
    expect(strictTestExitCode(130, clean)).toBe(130);
  });

  test('forwards termination, escalates deterministically, and reports signal exits', () => {
    const source = new EventEmitter();
    const kills: string[] = [];
    const scheduled: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = [];
    const timer: TerminationTimerApi = {
      schedule(callback, delayMs) {
        const handle = { callback, delayMs, cancelled: false };
        scheduled.push(handle);
        return handle;
      },
      cancel(handle) {
        (handle as (typeof scheduled)[number]).cancelled = true;
      },
    };
    const forwarding = installChildSignalForwarding(
      { kill: (signal) => { kills.push(String(signal)); return true; } },
      source,
      timer,
      1234,
    );

    source.emit('SIGTERM');
    expect(kills).toEqual(['SIGTERM']);
    expect(forwarding.receivedSignal).toBe('SIGTERM');
    expect(terminationSignalExitCode(forwarding.receivedSignal!)).toBe(143);
    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([1234]);

    scheduled[0].callback();
    expect(kills).toEqual(['SIGTERM', 'SIGKILL']);

    source.emit('SIGTERM');
    expect(kills).toEqual(['SIGTERM', 'SIGKILL', 'SIGKILL']);
    forwarding.dispose();
    source.emit('SIGTERM');
    expect(kills).toHaveLength(3);
  });

  test('hard-kills on parent exit and removes pending cleanup when disposed', () => {
    const source = new EventEmitter();
    const kills: string[] = [];
    let timerCancelled = false;
    const timer: TerminationTimerApi = {
      schedule: () => ({ pending: true }),
      cancel: () => { timerCancelled = true; },
    };
    const forwarding = installChildSignalForwarding(
      { kill: (signal) => { kills.push(String(signal)); return true; } },
      source,
      timer,
    );

    source.emit('exit');
    expect(kills).toEqual(['SIGKILL']);
    source.emit('SIGINT');
    expect(kills).toEqual(['SIGKILL', 'SIGINT']);
    expect(terminationSignalExitCode('SIGINT')).toBe(130);

    forwarding.dispose();
    expect(timerCancelled).toBe(true);
    source.emit('exit');
    expect(kills).toEqual(['SIGKILL', 'SIGINT']);
  });
});
