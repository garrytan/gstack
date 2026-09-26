import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BunTestOutputClassifier, strictTestExitCode, stripAnsiLine } from '../scripts/test-strict-output';
import { FreeRunReporter, eligibleFreeRetryFiles, normalizeRelativePath, runFreeShard } from '../scripts/test-free-shards';
import { runPaidShards } from '../scripts/test-paid-shards';

const file = 'test/planted-format.test.ts';
const terminal = 'Ran 2 tests across 1 file. [1.00ms]';
const failure = (marker: string, name = 'planted', duration = '0.11ms') => `${marker} ${name} [${duration}]`;
const legacy = '(fa' + 'il)';
const unicode = '\u2717';

describe('strict output reporter formats', () => {
  for (const marker of [legacy, unicode]) {
    test(`counts ${marker} failures across UTF-8 chunks and duration units`, () => {
      for (const duration of ['1ns', '1.2us', '2µs', '0.11ms', '1s']) {
        const classifier = new BunTestOutputClassifier();
        const reporter = new FreeRunReporter([file]);
        const bytes = Buffer.from(`${file}:\n\u001b[31m${failure(marker, 'planted', duration)}\u001b[0m\r\n${terminal}\n`);
        for (const byte of bytes) {
          classifier.write(new Uint8Array([byte]), 'stderr');
          reporter.write(new Uint8Array([byte]), 'stderr');
        }
        const summary = classifier.end();
        reporter.end();
        expect(summary.failedTests).toBe(1);
        expect(strictTestExitCode(0, summary, 1)).toBe(1);
        expect(reporter.report().failures).toEqual([{ file, testName: 'planted' }]);
      }
    });
  }

  test('a positive failure recap is evidence even without named result lines', () => {
    const classifier = new BunTestOutputClassifier();
    classifier.write(` 0 pass\n 2 fail\n${terminal}\n`);
    const summary = classifier.end();
    expect(summary.failedTests).toBe(2);
    expect(strictTestExitCode(0, summary, 1)).toBe(1);
  });

  test('a recap reconciles named failures without counting them again', () => {
    const classifier = new BunTestOutputClassifier();
    classifier.write(`${failure(legacy)}\n 1 pass\n 1 fail\n${terminal}\n`);
    expect(classifier.end().failedTests).toBe(1);
  });

  test('a larger failure recap retains missing results and an earlier failure cannot be cleared', () => {
    const classifier = new BunTestOutputClassifier();
    classifier.write(`${failure(legacy)}\n 0 pass\n 2 fail\n${terminal}\n 0 fail\n`);
    expect(classifier.end().failedTests).toBe(2);
  });

  test('quoted examples, ordinary diagnostics and a clean recap stay clean', () => {
    const classifier = new BunTestOutputClassifier();
    const reporter = new FreeRunReporter([file]);
    const text = [
      `${file}:`,
      JSON.stringify(failure(unicode)),
      `console.log said: ${failure(legacy)}`,
      `console.log said: 2 fail`,
      '" 2 fail"',
      `${unicode} ordinary diagnostic without a timing`,
      ' 2 pass',
      ' 0 fail',
      terminal,
    ].join('\n');
    classifier.write(text);
    reporter.write(text, 'stdout');
    reporter.end();
    expect(strictTestExitCode(0, classifier.end(), 1)).toBe(0);
    expect(reporter.report().failures).toEqual([]);
  });

  test('Unicode recaps do not invent a second failing file', () => {
    const reporter = new FreeRunReporter([file, 'test/control.test.ts']);
    reporter.write(`${file}:\n${failure(unicode)}\ntest/control.test.ts:\n1 tests failed:\n${failure(unicode)}\n`, 'stderr');
    reporter.end();
    expect(reporter.report().failures).toEqual([{ file, testName: 'planted' }]);
  });

  for (const origin of ['stdout', 'stderr'] as const) {
    test(`count-shaped ${origin} logs do not override a completed clean footer`, () => {
      const classifier = new BunTestOutputClassifier();
      const reporter = new FreeRunReporter([file]);
      const noise = ' 1 fail\n 0 pass\n 3 fail\nordinary log after an incomplete counts block\n';
      classifier.write(noise, origin);
      reporter.write(noise, origin);
      const footer = ` 2 pass\n 0 fail\n 2 expect() calls\n${terminal}\n`;
      classifier.write(footer, 'stderr');
      reporter.write(footer, 'stderr');
      reporter.end();
      expect(strictTestExitCode(0, classifier.end(), 1)).toBe(0);
      expect(reporter.report().unreportedFailures).toBe(0);
    });
  }

  test('a completed positive footer survives later clean output across streams', () => {
    const classifier = new BunTestOutputClassifier();
    const reporter = new FreeRunReporter([file]);
    for (const consumer of [classifier, reporter]) {
      consumer.write(' 0 pass\n 2 skip\n 1 todo\n 2 fail\n', 'stderr');
      consumer.write('ordinary interleaved stdout\n', 'stdout');
      consumer.write(' 4 expect() calls\nRan 5 tests across 1 file. [1.00ms]\n', 'stderr');
      consumer.write(` 2 pass\n 0 fail\n${terminal}\n`, 'stdout');
    }
    reporter.end();
    expect(classifier.end().failedTests).toBe(2);
    expect(reporter.report().unreportedFailures).toBe(2);
  });

  test('an incomplete counts block cannot borrow another stream\'s terminal summary', () => {
    const classifier = new BunTestOutputClassifier();
    const reporter = new FreeRunReporter([file]);
    for (const consumer of [classifier, reporter]) {
      consumer.write(' 0 pass\n 2 fail\nordinary diagnostic\n', 'stdout');
      consumer.write(` 2 pass\n 0 fail\n${terminal}\n`, 'stderr');
    }
    reporter.end();
    expect(strictTestExitCode(0, classifier.end(), 1)).toBe(0);
    expect(reporter.report().unreportedFailures).toBe(0);
  });
});

describe('real runner callers reject false-zero failure formats', () => {
  const cases: Array<{ name: string; lines: string[]; stdout?: string; failed: boolean; missing: number }> = [
    { name: 'legacy', lines: [failure(legacy), ' 1 pass', ' 1 fail'], failed: true, missing: 0 },
    { name: 'unicode', lines: [failure(unicode), ' 1 pass', ' 1 fail'], failed: true, missing: 0 },
    { name: 'recap-only', lines: [' 0 pass', ' 2 fail'], failed: true, missing: 2 },
    { name: 'partial-result', lines: [failure(legacy), ' 0 pass', ' 2 fail'], failed: true, missing: 1 },
    { name: 'filtered-recap-only', lines: [' 0 pass', ' 3 filtered out', ' 2 fail'], failed: true, missing: 2 },
    { name: 'filtered-partial-result', lines: [failure(legacy), ' 0 pass', ' 3 filtered out', ' 2 fail'], failed: true, missing: 1 },
    { name: 'error-recap', lines: [' 0 pass', ' 2 fail', ' 1 error'], failed: true, missing: 2 },
    { name: 'errors-recap', lines: [' 0 pass', ' 2 fail', ' 2 errors'], failed: true, missing: 2 },
    { name: 'snapshot-counts', lines: [' 0 pass', ' 2 fail', ' 1 snapshots, 2 expect() calls'], failed: true, missing: 2 },
    { name: 'snapshot-added', lines: [' 0 pass', ' 2 fail', 'snapshots: +1 added', ' 2 expect() calls'], failed: true, missing: 2 },
    { name: 'snapshot-results', lines: [' 0 pass', ' 2 fail', 'snapshots: 1 passed, 1 added, 1 failed', ' 3 expect() calls'], failed: true, missing: 2 },
    { name: 'interrupted-recap-only', lines: [' 0 pass', ' 2 fail', 'diagnostic from inherited stderr'], failed: true, missing: 2 },
    { name: 'interrupted-partial-result', lines: [failure(legacy), ' 0 pass', ' 2 fail', 'diagnostic from inherited stderr'], failed: true, missing: 1 },
    { name: 'metadata-before-fail', lines: [' 0 pass', 'unrecognized footer metadata', ' 2 fail'], failed: true, missing: 2 },
    { name: 'durationless-legacy', lines: [failure(legacy), `${legacy} untimed`, ' 0 pass', ' 2 fail'], failed: true, missing: 1 },
    { name: 'durationless-unicode', lines: [failure(unicode), `${unicode} untimed`, ' 0 pass', ' 2 fail'], failed: true, missing: 1 },
    { name: 'duplicate-names', lines: [failure(legacy), failure(legacy), ' 0 pass', ' 2 fail'], failed: true, missing: 0 },
    { name: 'clean', lines: [JSON.stringify(failure(unicode)), ' 2 pass', ' 0 fail'], failed: false, missing: 0 },
    { name: 'clean-count-log-stderr', lines: [' 1 fail', ' 2 pass', ' 0 fail'], failed: false, missing: 0 },
    { name: 'clean-count-log-stdout', lines: [' 2 pass', ' 0 fail'], stdout: ' 1 fail\n', failed: false, missing: 0 },
    { name: 'clean-reset-interrupted-counts', lines: [' 0 pass', ' 3 fail', 'ordinary diagnostic', ' 2 pass', ' 0 fail'], failed: false, missing: 0 },
  ];

  for (const fixture of cases) {
    test(`free runner preserves ${fixture.name} verdict and attribution`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'free-format-'));
      const lines: string[] = [];
      const consoleLines: string[] = [];
      const text = [file + ':', ...fixture.lines, terminal].join('\n') + '\n';
      try {
        const outcome = await runFreeShard([file], 1, 1, {
          commandFor: () => ({ command: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(fixture.stdout ?? '')}); process.stderr.write(${JSON.stringify(text)})`] }),
          logFilePath: join(dir, 'run.log'),
          wallTimeoutMs: 5_000,
          consoleWrite: line => consoleLines.push(line),
          log: line => lines.push(line),
        });
        expect(outcome.exitCode).toBe(0);
        expect(outcome.status).toBe(fixture.failed ? 'failed' : 'passed');
        expect(outcome.unattributedFailures).toBe(fixture.missing);
        if (fixture.missing > 0) {
          expect(eligibleFreeRetryFiles([outcome])).toBeNull();
          expect(lines.join('\n')).toContain(`${fixture.missing} failure(s) reported without named result lines`);
        } else if (fixture.failed) {
          expect(outcome.failingFiles).toEqual([file]);
          expect(eligibleFreeRetryFiles([outcome])).toEqual([file]);
          expect(consoleLines.join('')).toContain(fixture.lines[0]);
          expect(lines.join('\n')).toContain(`${fixture.name === 'duplicate-names' ? 2 : 1} failing test(s)`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test(`paid runner preserves ${fixture.name} verdict without a paid agent`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'paid-format-'));
      const text = [file + ':', ...fixture.lines, terminal].join('\n') + '\n';
      const stdout = spyOn(process.stdout, 'write').mockImplementation(() => true);
      const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const result = await runPaidShards([[file]], {
          jobs: 1,
          timeoutMs: 5_000,
          commandFor: () => ({ command: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(fixture.stdout ?? '')}); process.stderr.write(${JSON.stringify(text)})`] }),
          logDir: dir,
          log: () => {},
        });
        expect(result.outcomes[0].exitCode).toBe(0);
        expect(result.outcomes[0].status).toBe(fixture.failed ? 'failed' : 'passed');
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('native Bun footers through the real free runner', () => {
  for (const [name, assertion] of [
    ['passed-snapshot', `expect('stable').toMatchInlineSnapshot('"stable"')`],
    ['added-snapshot', `expect('stable').toMatchSnapshot()`],
    ['failed-snapshot', `expect('stable').toMatchInlineSnapshot('"different"')`],
  ]) {
    test(`${name} preserves filtered, todo and duplicate-name accounting`, async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'native-footer-')));
      const fixture = normalizeRelativePath(join(dir, 'footer.test.ts'));
      const logPath = join(dir, 'native.log');
      try {
        writeFileSync(fixture, [
          "import { expect, test } from 'bun:test';",
          `test('selected snapshot', async () => { await Bun.sleep(1); ${assertion}; });`,
          "test('selected duplicate', async () => { await Bun.sleep(1); expect(1).toBe(2); });",
          "test('selected duplicate', async () => { await Bun.sleep(1); expect(1).toBe(2); });",
          "test.todo('selected todo');",
          "test('filtered case', () => {});",
        ].join('\n'));
        const outcome = await runFreeShard([fixture], 1, 1, {
          commandFor: () => ({ command: process.execPath, args: ['test', ...(name === 'added-snapshot' ? ['--update-snapshots'] : []), '--test-name-pattern', 'selected', fixture] }),
          logFilePath: logPath,
          wallTimeoutMs: 10_000,
          consoleWrite: () => {},
          log: () => {},
        });
        expect(outcome.exitCode).toBe(1);
        expect(outcome.status).toBe('failed');
        expect(outcome.unattributedFailures).toBe(0);
        expect(eligibleFreeRetryFiles([outcome])).toEqual(outcome.failingFiles);

        const replay = readFileSync(logPath, 'utf8').split('\n')
          .filter(line => !stripAnsiLine(line).startsWith(legacy) && !stripAnsiLine(line).startsWith(unicode)).join('\n');
        const classifier = new BunTestOutputClassifier();
        const reporter = new FreeRunReporter([fixture]);
        classifier.write(replay, 'stderr');
        reporter.write(replay, 'stderr');
        reporter.end();
        const summary = classifier.end();
        expect(summary.failedTests).toBe(name === 'failed-snapshot' ? 3 : 2);
        expect(strictTestExitCode(0, summary, 1)).toBe(1);
        expect(reporter.report().unreportedFailures).toBe(summary.failedTests);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('native fixture retry path identity', () => {
  const windowsFile = 'C:\\fixture\\native-footer\\footer.test.ts';
  for (const printed of [windowsFile, windowsFile.replaceAll('\\', '/')]) {
    test(`Windows-shaped header ${printed} retains the planned retry path`, async () => {
      const planned = normalizeRelativePath(windowsFile);
      const dir = mkdtempSync(join(tmpdir(), 'windows-footer-'));
      const text = `${printed}:\n${failure(legacy)}\n 1 pass\n 1 fail\n${terminal}\n`;
      try {
        const outcome = await runFreeShard([planned], 1, 1, {
          commandFor: () => ({ command: process.execPath, args: ['-e', `process.stderr.write(${JSON.stringify(text)}); process.exitCode = 1;`] }),
          logFilePath: join(dir, 'native.log'),
          wallTimeoutMs: 5_000,
          consoleWrite: () => {},
          log: () => {},
        });
        expect(outcome.exitCode).toBe(1);
        expect(outcome.status).toBe('failed');
        expect(outcome.unattributedFailures).toBe(0);
        expect(eligibleFreeRetryFiles([outcome])).toEqual([planned]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
