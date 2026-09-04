import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  isFreeTestFile,
  collectFreeTestFiles,
  detectWindowsFragility,
  curateWindowsSafe,
  stableHash,
  assignFilesToShards,
  buildShardArgs,
  normalizeRelativePath,
  runFreeShard,
  FreeRunReporter,
  buildRunEpilogue,
  FREE_TEST_TIMEOUT_MS,
  DEFAULT_WALL_TIMEOUT_MS,
  PER_FILE_WALL_MS,
  wallTimeoutForShard,
  KNOWN_WINDOWS_INCOMPATIBLE,
  TEST_ROOTS,
  TREE_MUTATING,
  WORKER_HOSTILE,
} from '../scripts/test-free-shards';
import {
  loadFreeTestDurations,
  packShardsByDuration,
  wallTimeoutForPackedShard,
  DEFAULT_WALL_TIMEOUT_MS as WALL_BASE_MS,
} from '../scripts/test-free-shards';

const ROOT = path.resolve(import.meta.dir, '..');

describe('test-free-shards: enumeration', () => {
  test('isFreeTestFile rejects non-test files', () => {
    expect(isFreeTestFile('test/foo.ts')).toBe(false);
    expect(isFreeTestFile('test/foo.test.ts')).toBe(true);
    expect(isFreeTestFile('test/foo.test.tsx')).toBe(true);
    expect(isFreeTestFile('test/foo.test.mjs')).toBe(true);
  });

  test('isFreeTestFile rejects paid eval tests', () => {
    expect(isFreeTestFile('test/skill-e2e-foo.test.ts')).toBe(false);
    expect(isFreeTestFile('test/skill-llm-eval.test.ts')).toBe(false);
    expect(isFreeTestFile('test/codex-e2e.test.ts')).toBe(false);
    expect(isFreeTestFile('test/codex-e2e-sol-scope.test.ts')).toBe(false);
    expect(isFreeTestFile('test/gemini-e2e.test.ts')).toBe(false);
  });

  test('collectFreeTestFiles returns sorted, deduped, only-free list', () => {
    const files = collectFreeTestFiles(ROOT);
    expect(files.length).toBeGreaterThan(10);
    expect(files).toEqual([...files].sort());
    expect(new Set(files).size).toBe(files.length);
    for (const f of files) {
      expect(isFreeTestFile(f)).toBe(true);
    }
  });

  test('normalizeRelativePath converts Windows backslashes to forward slashes', () => {
    expect(normalizeRelativePath('test\\foo\\bar.test.ts')).toBe('test/foo/bar.test.ts');
    expect(normalizeRelativePath('test/foo/bar.test.ts')).toBe('test/foo/bar.test.ts');
  });
});

describe('test-free-shards: Windows curation', () => {
  function withTempFile(content: string, fn: (filePath: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curation-test-'));
    const file = path.join(dir, 'sample.test.ts');
    fs.writeFileSync(file, content);
    try {
      fn(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test('detects /bin/bash hardcode', () => {
    withTempFile(`spawn('/bin/bash', ['-c', 'echo hi']);`, (f) => {
      expect(detectWindowsFragility(f)?.reason).toBe('hardcoded /bin/sh or /bin/bash');
    });
  });

  test('detects spawn("sh", ...)', () => {
    // tripwire-exempt: string fixture fed to detectWindowsFragility, not a call
    withTempFile(`spawnSync('sh', ['-c', 'command -v claude']);`, (f) => {
      expect(detectWindowsFragility(f)?.reason).toBe('spawn("sh", ...)');
    });
  });

  test('detects raw /tmp/ paths', () => {
    withTempFile(`const TMPERR = '/tmp/codex-err.txt';`, (f) => {
      expect(detectWindowsFragility(f)?.reason).toBe('raw /tmp/ path (use os.tmpdir())');
    });
  });

  test('detects which claude shell command', () => {
    // tripwire-exempt: string fixture fed to detectWindowsFragility, not a call
    withTempFile(`execSync('which claude').trim();`, (f) => {
      expect(detectWindowsFragility(f)?.reason).toBe('which claude (use Bun.which)');
    });
  });

  test('Windows-safe code passes the filter', () => {
    withTempFile(`import { spawn } from 'child_process'; spawn(claude.command, args);`, (f) => {
      expect(detectWindowsFragility(f)).toBeNull();
    });
  });

  test('curateWindowsSafe partitions files into safe + excluded', () => {
    const files = collectFreeTestFiles(ROOT);
    const result = curateWindowsSafe(files, ROOT);
    expect(result.safe.length + result.excluded.length).toBe(files.length);
    // Sanity: at least one excluded entry, since we know test/ship-version-sync.test.ts uses /bin/bash
    expect(result.excluded.length).toBeGreaterThan(0);
    // Every excluded entry has a non-empty reason
    for (const { reason } of result.excluded) {
      expect(reason.length).toBeGreaterThan(0);
    }
  });
});

describe('test-free-shards: sharding', () => {
  test('stableHash is deterministic', () => {
    expect(stableHash('foo.test.ts')).toBe(stableHash('foo.test.ts'));
    expect(stableHash('foo.test.ts')).not.toBe(stableHash('bar.test.ts'));
  });

  test('assignFilesToShards partitions every file across exactly shardCount shards', () => {
    const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts', 'e.test.ts'];
    const shards = assignFilesToShards(files, 3);
    expect(shards.length).toBe(3);
    expect(shards.flat().sort()).toEqual([...files].sort());
  });

  test('empty shards are preserved so indices stay stable for a CI matrix', () => {
    // 2 files can never occupy 10 shards — the rest MUST be present and empty,
    // not filtered out (filtering renumbered every later shard by occupancy).
    const files = ['a.test.ts', 'b.test.ts'];
    const shards = assignFilesToShards(files, 10);
    expect(shards.length).toBe(10);
    expect(shards.flat().sort()).toEqual([...files].sort());
    expect(shards.some((s) => s.length === 0)).toBe(true);
  });

  test("a file's shard index depends only on its own path — other files never renumber it", () => {
    const target = 'test/target.test.ts';
    const expected = stableHash(target) % 7;
    const alone = assignFilesToShards([target], 7);
    const crowded = assignFilesToShards(
      [target, 'test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts', 'test/d.test.ts', 'browse/test/e.test.ts'],
      7,
    );
    expect(alone.findIndex((s) => s.includes(target))).toBe(expected);
    expect(crowded.findIndex((s) => s.includes(target))).toBe(expected);
  });

  test('assignFilesToShards rejects invalid shard counts', () => {
    expect(() => assignFilesToShards(['a.test.ts'], 0)).toThrow();
    expect(() => assignFilesToShards(['a.test.ts'], -1)).toThrow();
  });

  test('shards are stable across runs (same files always land in same shard)', () => {
    const files = ['x.test.ts', 'y.test.ts', 'z.test.ts'];
    const a = assignFilesToShards(files, 5);
    const b = assignFilesToShards(files, 5);
    expect(a).toEqual(b);
  });
});

describe('test-free-shards: shard args', () => {
  test('resolves exact absolute selectors (no substring shard bleed) and pins the per-test timeout', () => {
    const args = buildShardArgs(['test/foo.test.ts'], { rootDir: ROOT });
    expect(args[0]).toBe('test');
    expect(args[1]).toBe(path.resolve(ROOT, 'test/foo.test.ts'));
    expect(args).toContain(`--timeout=${FREE_TEST_TIMEOUT_MS}`);
    expect(args).toContain('--max-concurrency=1');
    expect(args).not.toContain('--parallel');
  });

  test('parallel mode swaps serial max-concurrency for --parallel', () => {
    const args = buildShardArgs(['test/foo.test.ts'], { rootDir: ROOT, parallel: true });
    expect(args).toContain('--parallel');
    expect(args).not.toContain('--max-concurrency=1');
  });

  test('per-test timeout matches the 30s the package.json test script used before the repoint', () => {
    expect(FREE_TEST_TIMEOUT_MS).toBe(30_000);
  });
});

describe('test-free-shards: strict shard execution', () => {
  // Fake command seam, same pattern as test/paid-shards.test.ts: each "file"
  // label selects a child command. Unlike the paid runner, runFreeShard
  // enforces the terminal-summary file count on injected commands too, so
  // fake PASSING commands must print a synthetic bun summary line.
  const SUMMARY_1 = 'Ran 3 tests across 1 files. [12.00ms]';
  const BUSY_LOOP = 'const end = Date.now() + 600000; while (Date.now() < end) {}';
  const FAIL_LINE = '(fa' + 'il) planted failure [0.10ms]'; // split so this source file never contains a raw bun fail line

  const commandFor = (files: string[]) => {
    const mode = files[0];
    if (mode === 'spin') return { command: process.execPath, args: ['-e', BUSY_LOOP] };
    if (mode === 'no-summary') return { command: process.execPath, args: ['-e', 'console.log("ok")'] };
    if (mode === 'fail-exit') {
      return { command: process.execPath, args: ['-e', `console.log(${JSON.stringify(SUMMARY_1)}); process.exit(3)`] };
    }
    if (mode === 'fail-line-exit-zero') {
      return { command: process.execPath, args: ['-e', `console.log(${JSON.stringify(FAIL_LINE)}); console.log(${JSON.stringify(SUMMARY_1)})`] };
    }
    if (mode === 'wrong-file-count') {
      return { command: process.execPath, args: ['-e', 'console.log("Ran 3 tests across 4 files. [12.00ms]")'] };
    }
    return { command: process.execPath, args: ['-e', `console.log(${JSON.stringify(SUMMARY_1)})`] };
  };

  test('exit 0 WITHOUT bun\'s terminal summary is a FAILURE (anti-truncation backstop)', async () => {
    const outcome = await runFreeShard(['no-summary'], 1, 1, { commandFor, quiet: true, log: () => {} });
    expect(outcome.status).toBe('failed');
    expect(outcome.exitCode).toBe(0);
  });

  test('exit 0 WITH the terminal summary passes, and the per-shard epilogue line is printed', async () => {
    const lines: string[] = [];
    const outcome = await runFreeShard(['pass'], 1, 1, { commandFor, quiet: true, log: (l) => lines.push(l) });
    expect(outcome.status).toBe('passed');
    expect(lines.some((l) => /^\[test:free\] shard 1\/1: 1 files, \d+s, pass$/.test(l))).toBe(true);
  });

  test('a non-zero exit stays a failure even when the summary is present', async () => {
    const outcome = await runFreeShard(['fail-exit'], 1, 1, { commandFor, quiet: true, log: () => {} });
    expect(outcome.status).toBe('failed');
    expect(outcome.exitCode).toBe(3);
  });

  test('a printed (fail) result line is a failure even on exit 0 (bun exit-code bug class)', async () => {
    const outcome = await runFreeShard(['fail-line-exit-zero'], 1, 1, { commandFor, quiet: true, log: () => {} });
    expect(outcome.status).toBe('failed');
    expect(outcome.exitCode).toBe(0);
  });

  test('a summary reporting the wrong file count is a failure (partial execution)', async () => {
    const outcome = await runFreeShard(['wrong-file-count'], 1, 1, { commandFor, quiet: true, log: () => {} });
    expect(outcome.status).toBe('failed');
  });

  test('a spinning shard is killed at the wall-clock deadline and reported timed-out, distinct from failed', async () => {
    const lines: string[] = [];
    const outcome = await runFreeShard(['spin'], 1, 1, {
      commandFor, quiet: true, wallTimeoutMs: 1_200, log: (l) => lines.push(l),
    });
    expect(outcome.status).toBe('timed-out');
    expect(outcome.status).not.toBe('failed');
    // Killed at the deadline, not left to burn the full 600s busy loop.
    expect(outcome.elapsedMs).toBeLessThan(30_000);
    expect(outcome.groupPid).toBeGreaterThan(0);
    if (process.platform !== 'win32') {
      expect(() => process.kill(outcome.groupPid as number, 0)).toThrow();
    }
    expect(lines.some((l) => /^\[test:free\] shard 1\/1: 1 files, \d+s, timed-out$/.test(l))).toBe(true);
  }, 30_000);

  test('an empty shard is a fast no-op success and never spawns (stable CI-matrix indices)', async () => {
    const lines: string[] = [];
    const outcome = await runFreeShard([], 7, 20, {
      commandFor: () => { throw new Error('an empty shard must not spawn a child'); },
      log: (l) => lines.push(l),
    });
    expect(outcome.status).toBe('passed');
    // Mutation-caught gap: bun strips types at runtime, so a missing
    // failingFiles here feeds undefined into the flaky-retry flatMap.
    expect(outcome.failingFiles).toEqual([]);
    expect(outcome.unattributedFailures).toBe(0);
    expect(lines.some((l) => /^\[test:free\] shard 7\/20: 0 files, 0s, pass$/.test(l))).toBe(true);
  });

  test('the log-file path is announced once at start and the PASS epilogue repeats it', async () => {
    const lines: string[] = [];
    const outcome = await runFreeShard(['pass'], 1, 1, { commandFor, quiet: true, log: (l) => lines.push(l) });
    expect(outcome.status).toBe('passed');
    const announced = lines.filter((l) => /^\[test:free\] full log: .+gstack-free-test-.+\.log$/.test(l));
    expect(announced.length).toBe(1);
    // PASS epilogue carries the counts from the terminal summary + the log path.
    expect(lines.some((l) => /^\[test:free\] PASS — 3 tests, 1 files, \d+s\. Full log: .+\.log$/.test(l))).toBe(true);
  });

  test('spawned shard gets throwaway TMPDIR but NEVER an injected GSTACK_HOME', async () => {
    // GSTACK_HOME injection was tried and reverted: one shared scratch home
    // per invocation made 6,900 tests share MUTABLE state — config tests
    // wrote keys that relink/update-check tests then read (12 measured
    // cross-contamination failures). This pin keeps the regression out.
    const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'free-shard-env-'));
    const dump = path.join(captureDir, 'env.json');
    try {
      const script =
        `const fs = require("fs");`
        + `fs.writeFileSync(${JSON.stringify(dump)}, JSON.stringify({`
        + `  home: process.env.GSTACK_HOME ?? null, tmp: process.env.TMPDIR,`
        + `  tmpExists: fs.existsSync(process.env.TMPDIR || "") }));`
        + `console.log(${JSON.stringify(SUMMARY_1)});`;
      const outcome = await runFreeShard(['env-dump'], 1, 1, {
        commandFor: () => ({ command: process.execPath, args: ['-e', script] }),
        quiet: true,
        log: () => {},
      });
      expect(outcome.status).toBe('passed');
      const seen = JSON.parse(fs.readFileSync(dump, 'utf8'));
      // GSTACK_HOME passes through untouched (whatever the parent had, incl. unset).
      expect(seen.home).toBe(process.env.GSTACK_HOME ?? null);
      // TMPDIR is a per-shard throwaway, cleaned up once the shard finishes.
      expect(seen.tmp).toContain('gstack-free-shard-');
      expect(seen.tmpExists).toBe(true);
      expect(seen.tmp).not.toBe(process.env.TMPDIR ?? '');
      expect(fs.existsSync(seen.tmp)).toBe(false);
    } finally {
      fs.rmSync(captureDir, { recursive: true, force: true });
    }
  });
});

describe('test-free-shards: output contract (log capture, quiet console, failure epilogue)', () => {
  // Convention from the block above: never write a raw bun fail line into this
  // source file — build it at runtime so a printed source excerpt can't trip
  // the strict classifier.
  const FAIL_WORD = '(fa' + 'il)';
  const failLine = (name: string) => `${FAIL_WORD} ${name} [0.10ms]`;
  const SUMMARY_1 = 'Ran 3 tests across 1 files. [12.00ms]';

  /** Fake child that prints the given lines (stdout, then stderr) and exits. */
  const commandPrinting = (stdoutLines: string[], stderrLines: string[] = [], exitCode = 0) => () => ({
    command: process.execPath,
    args: ['-e',
      stdoutLines.map((l) => `console.log(${JSON.stringify(l)});`).join('')
      + stderrLines.map((l) => `console.error(${JSON.stringify(l)});`).join('')
      + (exitCode !== 0 ? `process.exit(${exitCode});` : ''),
    ],
  });

  test('failure epilogue names the failing test, attributed to its file-chunk header', async () => {
    const lines: string[] = [];
    const commandFor = commandPrinting(['test/planted.test.ts:', failLine('planted failure'), SUMMARY_1]);
    const outcome = await runFreeShard(['planted'], 1, 1, { commandFor, quiet: true, log: (l) => lines.push(l) });
    expect(outcome.status).toBe('failed');
    expect(lines.some((l) =>
      /^\[test:free\] FAIL — 1 failing test\(s\) in 1 file\(s\), 0 crashed worker\(s\)\. Full log: .+\.log$/.test(l),
    )).toBe(true);
    expect(lines).toContain('  ✗ test/planted.test.ts — planted failure');
  });

  test('crash markers surface in the epilogue as crashed+retried workers', async () => {
    const lines: string[] = [];
    const commandFor = commandPrinting([
      'test/crashy.test.ts:',
      '⟳ crashed running test/crashy.test.ts, retrying',
      'test/crashy.test.ts:',
      '✗ test/crashy.test.ts (crashed: exited)',
      'Ran 0 tests across 1 files. [12.00ms]',
    ], [], 1);
    const outcome = await runFreeShard(['crashy'], 1, 1, { commandFor, quiet: true, log: (l) => lines.push(l) });
    expect(outcome.status).toBe('failed');
    expect(lines.some((l) =>
      /^\[test:free\] FAIL — 0 failing test\(s\) in 0 file\(s\), 1 crashed worker\(s\)\. Full log: /.test(l),
    )).toBe(true);
    expect(lines).toContain('  ⚠ crashed+retried: test/crashy.test.ts');
  });

  test('default console is quiet: noise stays in the log; fail/error/summary lines pass through', async () => {
    const consoleOut: string[] = [];
    const commandFor = commandPrinting([
      'PASSING-NOISE gitleaks ascii art',
      'test/noisy.test.ts:',
      failLine('quiet mode failure'),
      'error: expect(received).toBe(expected)',
      'Ran 1 tests across 1 files. [1.00ms]',
    ], ['telemetry stderr spam']);
    const outcome = await runFreeShard(['noisy'], 1, 1, {
      commandFor, consoleWrite: (t) => consoleOut.push(t), log: () => {},
    });
    expect(outcome.status).toBe('failed');
    const joined = consoleOut.join('');
    expect(joined).toContain(failLine('quiet mode failure'));
    expect(joined).toContain('error: expect(received).toBe(expected)');
    expect(joined).toContain('Ran 1 tests across 1 files.');
    expect(joined).not.toContain('PASSING-NOISE');
    expect(joined).not.toContain('telemetry stderr spam');
    expect(joined).not.toContain('test/noisy.test.ts:'); // headers feed the epilogue, not the console
  });

  test('--verbose restores the full firehose to the console', async () => {
    const consoleOut: string[] = [];
    const commandFor = commandPrinting(
      ['PASSING-NOISE gitleaks ascii art', SUMMARY_1],
      ['telemetry stderr spam'],
    );
    const outcome = await runFreeShard(['pass'], 1, 1, {
      commandFor, verbose: true, consoleWrite: (t) => consoleOut.push(t), log: () => {},
    });
    expect(outcome.status).toBe('passed');
    const joined = consoleOut.join('');
    expect(joined).toContain('PASSING-NOISE gitleaks ascii art');
    expect(joined).toContain('telemetry stderr spam');
  });

  test('quiet suppresses the console entirely, even with an injected sink', async () => {
    const consoleOut: string[] = [];
    const commandFor = commandPrinting(['PASSING-NOISE', failLine('hidden'), SUMMARY_1]);
    await runFreeShard(['pass'], 1, 1, {
      commandFor, quiet: true, consoleWrite: (t) => consoleOut.push(t), log: () => {},
    });
    expect(consoleOut).toEqual([]);
  });

  test('the full child stream lands in the per-run log file, including console-filtered noise', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'free-log-'));
    const logFilePath = path.join(dir, 'run.log');
    try {
      const lines: string[] = [];
      const commandFor = commandPrinting(['stdout NOISE-A', SUMMARY_1], ['stderr NOISE-B']);
      const outcome = await runFreeShard(['pass'], 1, 1, { commandFor, quiet: true, logFilePath, log: (l) => lines.push(l) });
      expect(outcome.status).toBe('passed');
      expect(lines).toContain(`[test:free] full log: ${logFilePath}`);
      const logged = fs.readFileSync(logFilePath, 'utf8');
      expect(logged).toContain('stdout NOISE-A');
      expect(logged).toContain('stderr NOISE-B');
      expect(logged).toContain('Ran 3 tests across 1 files.');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('colored fail lines are attributed after ANSI stripping (a prior grep missed them)', async () => {
    const lines: string[] = [];
    const colored = `\u001B[31m${failLine('colored failure')}\u001B[0m`;
    const commandFor = commandPrinting(['test/colored.test.ts:', colored, 'Ran 1 tests across 1 files. [1.00ms]']);
    const outcome = await runFreeShard(['colored'], 1, 1, { commandFor, quiet: true, log: (l) => lines.push(l) });
    expect(outcome.status).toBe('failed');
    expect(lines).toContain('  ✗ test/colored.test.ts — colored failure');
  });

  test('wall-timeout epilogue lists wedge suspects: header seen, no results, no summary', async () => {
    const lines: string[] = [];
    const commandFor = () => ({
      command: process.execPath,
      args: ['-e', 'console.log("test/wedged.test.ts:");console.log("wedged noise");setTimeout(() => {}, 600000);'],
    });
    const outcome = await runFreeShard(['wedged'], 1, 1, {
      commandFor, quiet: true, wallTimeoutMs: 1_500, log: (l) => lines.push(l),
    });
    expect(outcome.status).toBe('timed-out');
    expect(lines).toContain('  ⏱ in flight at kill: test/wedged.test.ts');
    // The epilogue headline shape stays stable across statuses.
    expect(lines.some((l) => l.startsWith('[test:free] FAIL — '))).toBe(true);
  }, 30_000);

  test('timeout with no observable header falls back to the buffered-parallel explanation', () => {
    const reporter = new FreeRunReporter(['test/a.test.ts', 'test/b.test.ts']);
    reporter.end();
    const lines = buildRunEpilogue('timed-out', reporter.report(), 5_000, '/tmp/x.log');
    expect(lines.some((l) => l.includes('in flight at kill: unknown'))).toBe(true);
    expect(lines.some((l) => l.includes('2 planned file(s) produced no output'))).toBe(true);
  });

  test('duplicate fail lines dedupe; pre-header failures are labeled unattributed', () => {
    const reporter = new FreeRunReporter(['test/a.test.ts']);
    reporter.write(`${failLine('early unattributed')}\n`, 'stderr');
    reporter.write('test/a.test.ts:\n', 'stderr');
    reporter.write(`${failLine('dup')}\n${failLine('dup')}\n`, 'stderr');
    reporter.end();
    const report = reporter.report();
    expect(report.failures).toEqual([
      { file: null, testName: 'early unattributed' },
      { file: 'test/a.test.ts', testName: 'dup' },
    ]);
    const lines = buildRunEpilogue('failed', report, 1_000, '/tmp/x.log');
    expect(lines).toContain('  ✗ (unattributed) — early unattributed');
    expect(lines).toContain('  ✗ test/a.test.ts — dup');
    expect(lines.some((l) => l.includes('2 failing test(s) in 2 file(s)'))).toBe(true);
  });

  test("a later file's header ends the previous chunk — completed noisy files are not wedge suspects", () => {
    const reporter = new FreeRunReporter(['test/done.test.ts', 'test/hung.test.ts']);
    reporter.write('test/done.test.ts:\n', 'stderr');
    reporter.write('noise from the completed file\n', 'stderr');
    reporter.write('test/hung.test.ts:\n', 'stderr');
    reporter.write('noise before the hang\n', 'stderr');
    reporter.end();
    // No terminal summary: only the still-open chunk is in flight.
    expect(reporter.report().inFlight).toEqual(['test/hung.test.ts']);
  });

  test('../-prefixed printed paths canonicalize to planned relative paths (symlinked cwd)', () => {
    const reporter = new FreeRunReporter(['browse/test/x.test.ts']);
    reporter.write('../../../work/repo/browse/test/x.test.ts:\n', 'stderr');
    reporter.write(`${failLine('boom')}\n`, 'stderr');
    reporter.end();
    expect(reporter.report().failures[0]).toEqual({ file: 'browse/test/x.test.ts', testName: 'boom' });
  });
});

describe('test-free-shards: GitHub Actions log-group attribution', () => {
  const failLine = (name: string) => `(fail) ${name} [1.00ms]`;
  // On GHA (GITHUB_ACTIONS=1) bun wraps each file's section in ::group::.
  // Unstripped, the real header fails FILE_HEADER_RE, failures attribute to
  // the PREVIOUS file, and the terminal recap's re-printed (fail) lines land
  // under a phantom second file — the first Linux run reported 5 real
  // failures as 10 across 2 files.
  test('::group::-wrapped headers attribute failures to the right file, once', () => {
    const reporter = new FreeRunReporter(['test/a.test.ts', 'test/b.test.ts']);
    reporter.write('::group::test/a.test.ts:\n', 'stderr');
    reporter.write('::endgroup::\n', 'stderr');
    reporter.write('::group::test/b.test.ts:\n', 'stderr');
    reporter.write(`${failLine('planted')}\n`, 'stderr');
    reporter.write('::endgroup::\n', 'stderr');
    // Terminal recap re-prints the failing file header + result line.
    reporter.write('1 tests failed:\n', 'stderr');
    reporter.write('::group::test/b.test.ts:\n', 'stderr');
    reporter.write(`${failLine('planted')}\n`, 'stderr');
    reporter.end();
    expect(reporter.report().failures).toEqual([{ file: 'test/b.test.ts', testName: 'planted' }]);
  });

  test('headerless recap re-prints do not invent a phantom failing file', () => {
    // Round-3 CI shape: bun's recap prints "N tests failed:" then the (fail)
    // lines with NO file headers — the stale currentFile (an innocent file)
    // was charged with the previous file's failures.
    const reporter = new FreeRunReporter(['test/a.test.ts', 'test/b.test.ts']);
    reporter.write('::group::test/a.test.ts:\n', 'stderr');
    reporter.write(`${failLine('planted')}\n`, 'stderr');
    reporter.write('::endgroup::\n', 'stderr');
    reporter.write('::group::test/b.test.ts:\n', 'stderr');
    reporter.write('(pass-ish output, no failures here)\n', 'stderr');
    reporter.write('2 tests failed:\n', 'stderr');
    reporter.write(`${failLine('planted')}\n`, 'stderr');
    reporter.write(`${failLine('planted')}\n`, 'stderr');
    reporter.end();
    expect(reporter.report().failures).toEqual([{ file: 'test/a.test.ts', testName: 'planted' }]);
  });
});

describe('test-free-shards: curated-list census pins', () => {
  // A renamed test file must FAIL here, not silently drop its serialization
  // (a phantom TREE_MUTATING key means the reader races regenerating shards
  // again) or its serial-child quarantine (WORKER_HOSTILE).
  test('every TREE_MUTATING and WORKER_HOSTILE key names a real free test file', () => {
    const census = new Set(collectFreeTestFiles(ROOT));
    const stale = [...Object.keys(TREE_MUTATING), ...Object.keys(WORKER_HOSTILE)]
      .filter((key) => !census.has(key));
    expect(stale).toEqual([]);
  });

  test('every KNOWN_WINDOWS_INCOMPATIBLE entry names a real free test file', () => {
    const census = new Set(collectFreeTestFiles(ROOT));
    const stale = KNOWN_WINDOWS_INCOMPATIBLE.map((e) => e.file).filter((f) => !census.has(f));
    expect(stale).toEqual([]);
  });

  test('every TEST_ROOTS entry exists on disk and contributes at least one test file', () => {
    const files = collectFreeTestFiles(ROOT);
    for (const root of TEST_ROOTS) {
      expect(fs.existsSync(path.join(ROOT, root))).toBe(true);
      expect(files.some((f) => f.startsWith(`${root}/`))).toBe(true);
    }
  });
});

describe('test-free-shards: wall-timeout scaling', () => {
  test('typical local shard keeps the 6-minute floor', () => {
    expect(wallTimeoutForShard(70)).toBe(DEFAULT_WALL_TIMEOUT_MS);
  });

  test('oversized shards (jobs=1 machines, Windows lane) scale linearly past the floor', () => {
    expect(wallTimeoutForShard(130)).toBe(130 * PER_FILE_WALL_MS);
    expect(wallTimeoutForShard(420)).toBe(420 * PER_FILE_WALL_MS);
  });

  test('an explicit base above the scaled value wins', () => {
    expect(wallTimeoutForShard(10, 10 * 60_000)).toBe(10 * 60_000);
  });
});


describe('test-free-shards: duration-aware packing (full-suite LPT)', () => {
  const files = ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts', 'test/d.test.ts'];

  test('LPT balances by cost, not count', () => {
    const durations = {
      'test/a.test.ts': 90_000, // one giant file
      'test/b.test.ts': 30_000,
      'test/c.test.ts': 30_000,
      'test/d.test.ts': 30_000,
    };
    const { shards, predictedMs } = packShardsByDuration(files, 2, durations);
    // The giant file gets its own shard; the three smalls share the other.
    expect(shards.map((s) => s.length).sort()).toEqual([1, 3]);
    expect(Math.max(...predictedMs)).toBe(90_000);
  });

  test('deterministic for identical inputs', () => {
    const durations = { 'test/a.test.ts': 5, 'test/b.test.ts': 5, 'test/c.test.ts': 5, 'test/d.test.ts': 5 };
    const one = packShardsByDuration(files, 3, durations);
    const two = packShardsByDuration([...files].reverse(), 3, durations);
    expect(one.shards).toEqual(two.shards);
  });

  test('unknown files get 75th-percentile pessimism (placed early, never the tail)', () => {
    const durations = {
      'test/a.test.ts': 1_000,
      'test/b.test.ts': 2_000,
      'test/c.test.ts': 100_000,
      // test/d.test.ts unrecorded → p75 of known = 100_000 (pessimistic)
    };
    const { shards } = packShardsByDuration(files, 2, durations);
    // The unknown must NOT be packed as if free: it lands opposite the
    // 100s file, not stacked onto it.
    const shardOfC = shards.findIndex((s) => s.includes('test/c.test.ts'));
    const shardOfD = shards.findIndex((s) => s.includes('test/d.test.ts'));
    expect(shardOfC).not.toBe(shardOfD);
  });

  test('every file lands in exactly one shard', () => {
    const { shards } = packShardsByDuration(files, 3, {});
    expect(shards.flat().sort()).toEqual([...files].sort());
  });

  test('invalid shard count throws', () => {
    expect(() => packShardsByDuration(files, 0, {})).toThrow();
  });

  test('corrupt seed falls back to null (hash sharding), never throws', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durations-seed-'));
    const seedPath = path.join(dir, 'seed.json');
    fs.writeFileSync(seedPath, '{ definitely not json');
    const prev = process.env.GSTACK_FREE_TEST_DURATIONS;
    process.env.GSTACK_FREE_TEST_DURATIONS = seedPath;
    try {
      expect(loadFreeTestDurations()).toBeNull();
      // Missing file: silent null (fresh checkouts are normal).
      process.env.GSTACK_FREE_TEST_DURATIONS = path.join(dir, 'missing.json');
      expect(loadFreeTestDurations()).toBeNull();
      // Valid seed round-trips, non-numeric entries dropped.
      fs.writeFileSync(seedPath, JSON.stringify({ version: 1, durations: { 'test/a.test.ts': 42, bad: 'nope' } }));
      process.env.GSTACK_FREE_TEST_DURATIONS = seedPath;
      expect(loadFreeTestDurations()).toEqual({ 'test/a.test.ts': 42 });
    } finally {
      if (prev === undefined) delete process.env.GSTACK_FREE_TEST_DURATIONS;
      else process.env.GSTACK_FREE_TEST_DURATIONS = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('packed shards get duration-aware walls (count heuristic is wrong under LPT)', () => {
    // A packed shard predicted at 120s must get a 360s wall even though its
    // file COUNT would produce only the 6-minute base under the old formula.
    expect(wallTimeoutForPackedShard(120_000)).toBe(Math.max(WALL_BASE_MS, 360_000));
    // Tiny prediction: base still floors it.
    expect(wallTimeoutForPackedShard(1_000)).toBe(WALL_BASE_MS);
  });

  test('packed walls never undercut the per-file floor (predictions do not transfer across machines)', () => {
    // The duration seed is recorded on fast CI; a syscall-supervised sandbox
    // replays the same files 2-4x slower. A 253-file shard predicted at ~242s
    // got wall-killed at predicted×3 = 725s while genuinely progressing —
    // the count-based floor (253 × 5s = 1265s) the runner always guaranteed
    // must survive duration packing. Looser is allowed, tighter is not.
    expect(wallTimeoutForPackedShard(242_000, WALL_BASE_MS, 253)).toBe(253 * 5_000);
    // When the prediction is the larger bound, it still wins.
    expect(wallTimeoutForPackedShard(600_000, WALL_BASE_MS, 10)).toBe(1_800_000);
  });
});
